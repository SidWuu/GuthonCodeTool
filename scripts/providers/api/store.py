"""Single API checkout, private common ancestor, guarded writes and durable receipts."""

from __future__ import annotations
from contextlib import closing
import difflib
import hashlib
import json
from pathlib import Path, PurePosixPath
import sqlite3
import uuid
from common.persistence import atomic_bytes, atomic_text, file_lock
from .client import ApiError
from .workspace import in_scope, settings, active_scope
from .editor_state import assert_writable


def digest(content):
    return hashlib.sha256(content.encode("utf-8")).hexdigest()


def merge(base, local, remote):
    if local == base or local == remote:
        return remote
    if remote == base:
        return local
    original = base.splitlines(keepends=True)
    edits = []
    for text in (local, remote):
        lines = text.splitlines(keepends=True)
        for tag, a, b, c, d in difflib.SequenceMatcher(
            None, original, lines, autojunk=False
        ).get_opcodes():
            candidate = (a, b, lines[c:d])
            if tag != "equal" and candidate not in edits:
                edits.append(candidate)
    edits.sort(key=lambda x: (x[0], x[1]))
    if any(
        right[0] < left[1] or right[0] == left[0]
        for left, right in zip(edits, edits[1:])
    ):
        return None
    result = []
    cursor = 0
    for start, end, lines in edits:
        result.extend(original[cursor:start])
        result.extend(lines)
        cursor = end
    result.extend(original[cursor:])
    return "".join(result)


class ApiStore:
    def __init__(self, workspace):
        self.workspace = workspace
        self.root = Path(workspace["providerSourceRoot"]).resolve()
        self.directory = workspace["contextDir"] / "api"
        self.path = self.directory / "baseline.db"
        self._verify_binding()

    def _verify_binding(self, *, create=False):
        identity_path = self.directory / "identity.json"
        expected = {
            "workspaceKey": self.workspace["workspaceKey"],
            "serverUrl": settings(self.workspace)["serverUrl"],
        }
        if identity_path.is_file():
            if json.loads(identity_path.read_text(encoding="utf-8")) != expected:
                raise ApiError(
                    "API_PROJECT_IDENTITY_MISMATCH",
                    "checkout基线不属于当前平台地址，未继续读取或写入",
                )
        elif self.path.exists():
            raise ApiError(
                "API_PROJECT_IDENTITY_MISSING",
                "已有基线缺少平台身份记录，请使用明确迁移材料重新建立",
            )
        elif create:
            if not expected["serverUrl"]:
                raise ApiError("API_CONFIG_REQUIRED", "请先配置当前项目平台地址")
            atomic_text(identity_path, json.dumps(expected, ensure_ascii=False) + "\n")

    def _path(self, path):
        if (
            not isinstance(path, str)
            or "\\" in path
            or ":" in path
            or any(ord(c) < 32 for c in path)
            or any(p in {"", ".", ".."} for p in path.split("/"))
            or PurePosixPath(path).is_absolute()
        ):
            raise ApiError("API_SOURCE_PATH_INVALID", "无效的checkout相对路径")
        target = self.root / path
        if not target.resolve().is_relative_to(self.root):
            raise ApiError("API_SOURCE_PATH_INVALID", "checkout路径越界")
        return target

    def _rows(self):
        self._verify_binding()
        if not self.path.is_file():
            return []
        with closing(sqlite3.connect(self.path)) as conn:
            return [
                {
                    "path": p,
                    "baseContent": text,
                    "metadata": json.loads(meta),
                    "readonly": bool(ro),
                }
                for p, text, meta, ro in conn.execute(
                    "SELECT path,content,metadata,readonly FROM source ORDER BY path"
                )
            ]

    def _record(self, path, *, require_scope=True):
        self._verify_binding()
        self._path(path)
        if not self.path.is_file():
            raise ApiError("API_SOURCE_NOT_FOUND", "源码不在API受管目录中：" + path)
        with closing(sqlite3.connect(self.path)) as conn:
            row = conn.execute(
                "SELECT path,content,metadata,readonly FROM source WHERE path=?",
                (path,),
            ).fetchone()
        if row is None:
            raise ApiError("API_SOURCE_NOT_FOUND", "源码不在API受管目录中：" + path)
        item = {
            "path": row[0],
            "baseContent": row[1],
            "metadata": json.loads(row[2]),
            "readonly": bool(row[3]),
        }
        if require_scope and not in_scope(self.workspace, path, item["metadata"]):
            raise ApiError(
                "API_SOURCE_OUT_OF_SCOPE", "对象不在当前子系统/共享数据源范围内"
            )
        return item

    def paths(self):
        """Authorized registered paths only; no checkout body reads."""
        self._verify_binding()
        if not self.path.is_file():
            return []
        with closing(sqlite3.connect(self.path)) as conn:
            rows = conn.execute(
                "SELECT path,metadata FROM source ORDER BY path"
            ).fetchall()
        return [
            path
            for path, meta in rows
            if not json.loads(meta).get("remoteDeleted")
            and in_scope(self.workspace, path, json.loads(meta))
        ]

    def related(self, kind, metadata, identity_keys):
        """Resolve an inherited companion from metadata without scanning source bodies."""
        self._verify_binding()
        if not self.path.is_file():
            return []
        with closing(sqlite3.connect(self.path)) as conn:
            rows = conn.execute("SELECT path,metadata,readonly FROM source").fetchall()
        result = []
        for path, raw, readonly in rows:
            candidate = json.loads(raw)
            if (
                candidate.get("sourceType") == kind
                and not candidate.get("remoteDeleted")
                and all(
                    candidate.get(key) == metadata.get(key) for key in identity_keys
                )
                and in_scope(self.workspace, path, candidate)
            ):
                result.append(
                    {"path": path, "metadata": candidate, "readonly": bool(readonly)}
                )
        return result

    def objects(self):
        result = []
        for item in self._rows():
            if (
                not item["metadata"].get("remoteDeleted")
                and in_scope(self.workspace, item["path"], item["metadata"])
                and self._path(item["path"]).is_file()
            ):
                current = self.read(item["path"])
                result.append({**current, "baseContent": item["baseContent"]})
        return result

    def read(self, path):
        item = self._record(path)
        target = self._path(path)
        if not target.is_file():
            raise ApiError("API_SOURCE_MISSING", "本地源码文件已不存在")
        raw = target.read_bytes()
        try:
            content = raw.decode("utf-8")
        except UnicodeDecodeError as error:
            raise ApiError("API_SOURCE_ENCODING", "API源码必须保留UTF-8编码") from error
        return {
            "path": path,
            "sourcePath": path,
            "content": content,
            "sourceHash": hashlib.sha256(raw).hexdigest(),
            "metadata": item["metadata"],
            "readonly": item["readonly"],
            "baseHash": digest(item["baseContent"]),
        }

    def status(self):
        self._verify_binding()
        if not self.path.is_file():
            return []
        with closing(sqlite3.connect(self.path)) as conn:
            rows = conn.execute("SELECT path,metadata,readonly FROM source ORDER BY path").fetchall()
        scope = active_scope(self.workspace)
        result = []
        for path, raw_meta, readonly in rows:
            meta = json.loads(raw_meta)
            target = self._path(path)
            current = target.read_bytes().decode("utf-8") if target.is_file() else None
            current_hash = digest(current) if current is not None else None
            base_hash = meta.get("remoteHash") or digest(self.baseline(path))
            active = in_scope(self.workspace, path, meta, scope=scope)
            state = (
                "CONFLICT"
                if self._conflict_path(path).is_file()
                else "REMOTE_DELETED"
                if meta.get("remoteDeleted")
                else "MISSING"
                if current is None
                else "CLEAN"
                if current_hash == base_hash
                else "MODIFIED"
            )
            result.append(
                {
                    "path": path,
                    "metadata": meta,
                    "readonly": bool(readonly),
                    "sourceType": meta["sourceType"],
                    "state": state,
                    "status": state,
                    "inScope": active,
                    "sourceHash": current_hash,
                    "baseHash": base_hash,
                }
            )
        return result

    def baseline(self, path):
        return self._record(path)["baseContent"]

    def _conflict_path(self, path):
        return self.directory / "conflicts" / (digest(path) + ".json")

    def conflict(self, path):
        item = self.read(path)
        try:
            record = json.loads(self._conflict_path(path).read_text(encoding="utf-8"))
        except FileNotFoundError as error:
            raise ApiError(
                "API_CONFLICT_NOT_FOUND", "此源码没有待解决的API冲突"
            ) from error
        return {**record, "local": item["content"], "sourceHash": item["sourceHash"]}

    def resolve_conflict(
        self, path, choice, expected_hash, content=None, *, editor_token=None
    ):
        with file_lock(self.directory / "source.lock"):
            record = self.conflict(path)
            current = self.read(path)
            assert_writable(self.workspace, [path], editor_token)
            if current["readonly"] and choice != "remote":
                raise ApiError("API_SOURCE_READONLY", "继承内容只能明确恢复远端原文")
            if current["sourceHash"] != expected_hash:
                raise ApiError("API_SOURCE_STALE", "冲突选择后本地源码变化")
            if choice == "local":
                candidate = current["content"]
            elif choice == "remote":
                candidate = record["remote"]
            elif choice == "manual" and isinstance(content, str):
                candidate = content
            else:
                raise ApiError("API_INPUT_INVALID", "冲突选择必须是local/remote/manual")
            from .content import validate_candidate

            validate_candidate(
                path, current["metadata"], self.baseline(path), candidate
            )
            operation = {
                "operationId": uuid.uuid4().hex,
                "kind": "resolve-conflict",
                "path": path,
                "stage": "PREPARED",
                "beforeHash": expected_hash,
                "afterHash": digest(candidate),
            }
            atomic_text(
                self.directory / "operations" / operation["operationId"] / "before.txt",
                current["content"],
            )
            self._receipt(operation)
            atomic_bytes(self._path(path), candidate.encode())
            if current["readonly"]:
                self._path(path).chmod(0o400)
            with closing(sqlite3.connect(self.path)) as conn:
                conn.execute(
                    "UPDATE source SET content=?,metadata=? WHERE path=?",
                    (
                        record["remote"],
                        json.dumps(record["metadata"], ensure_ascii=False),
                        path,
                    ),
                )
                conn.commit()
            self._conflict_path(path).unlink()
            operation["stage"] = "LOCAL_WRITE_VERIFIED"
            self._receipt(operation)
            return {
                **self.read(path),
                "operationId": operation["operationId"],
                "uploadState": "NOT_PERFORMED",
            }

    def _receipt(self, record):
        atomic_text(
            self.directory / "operations" / record["operationId"] / "record.json",
            json.dumps(record, ensure_ascii=False, indent=2) + "\n",
        )

    def write(self, path, content, expected_hash, *, editor_token=None):
        if not isinstance(content, str) or len(content.encode()) > 8 * 1024 * 1024:
            raise ApiError("API_INPUT_INVALID", "源码内容无效或超出编辑预算")
        with file_lock(self.directory / "source.lock"):
            current = self.read(path)
            assert_writable(self.workspace, [path], editor_token)
            if current["readonly"]:
                raise ApiError("API_SOURCE_READONLY", "继承/受管资料不可修改")
            if current["sourceHash"] != expected_hash:
                raise ApiError("API_SOURCE_STALE", "源码已变化，未应用旧编辑")
            from .content import validate_candidate

            validate_candidate(path, current["metadata"], self.baseline(path), content)
            operation = {
                "operationId": uuid.uuid4().hex,
                "kind": "local-write",
                "path": path,
                "beforeHash": expected_hash,
                "afterHash": digest(content),
                "stage": "PREPARED",
            }
            directory = self.directory / "operations" / operation["operationId"]
            atomic_text(directory / "before.txt", current["content"])
            atomic_text(directory / "after.txt", content)
            self._receipt(operation)
            if self.read(path)["sourceHash"] != expected_hash:
                raise ApiError("API_SOURCE_STALE", "发布前源码已变化")
            atomic_bytes(self._path(path), content.encode())
            operation["stage"] = "LOCAL_WRITE_VERIFIED"
            self._receipt(operation)
            return {**self.read(path), "operationId": operation["operationId"]}

    def revert(self, path, expected_hash, *, editor_token=None):
        return self.write(
            path, self.baseline(path), expected_hash, editor_token=editor_token
        )

    def diff(self, path):
        item = self.read(path)
        base = self.baseline(path)
        return {
            "path": path,
            "before": base,
            "after": item["content"],
            "sourceHash": item["sourceHash"],
            "baseHash": digest(base),
            "diff": "".join(
                difflib.unified_diff(
                    base.splitlines(keepends=True),
                    item["content"].splitlines(keepends=True),
                    fromfile="remote-baseline",
                    tofile="checkout",
                )
            ),
        }

    def history(self, limit=20):
        if type(limit) is not int or not 1 <= limit <= 100:
            raise ApiError("API_INPUT_INVALID", "历史条数必须在1至100之间")
        root = self.directory / "operations"
        if not root.is_dir():
            return []
        files = sorted(
            root.glob("*/record.json"), key=lambda p: p.stat().st_mtime_ns, reverse=True
        )
        return [json.loads(p.read_text(encoding="utf-8")) for p in files[:limit]]

    def operation(self, identifier):
        if not isinstance(identifier, str) or not identifier.isalnum():
            raise ApiError("API_INPUT_INVALID", "操作编号无效")
        return json.loads(
            (self.directory / "operations" / identifier / "record.json").read_text(
                encoding="utf-8"
            )
        )

    def publish(self, files, *, scope=None, authoritative=False, uploaded_content=None):
        self._verify_binding(create=True)
        self.directory.mkdir(parents=True, exist_ok=True)
        paths = [x.path for x in files]
        if len({p.casefold() for p in paths}) != len(paths):
            raise ApiError("API_IDENTITY_AMBIGUOUS", "源码映射到重复路径")
        assert_writable(self.workspace, paths)
        operation = {
            "operationId": uuid.uuid4().hex,
            "kind": "refresh",
            "stage": "PREPARED",
            "paths": paths,
            "applied": [],
            "conflicts": [],
        }
        self._receipt(operation)
        updated = []
        preserved = []
        deleted = []
        with file_lock(self.directory / "source.lock"):
            with closing(sqlite3.connect(self.path)) as conn:
                conn.execute(
                    "CREATE TABLE IF NOT EXISTS source(path TEXT PRIMARY KEY,content TEXT NOT NULL,metadata TEXT NOT NULL,readonly INTEGER NOT NULL)"
                )
                for item in files:
                    target = self._path(item.path)
                    meta = {
                        **item.metadata,
                        "sourceType": item.kind,
                        "remoteHash": digest(item.content),
                    }
                    if not in_scope(self.workspace, item.path, meta):
                        raise ApiError(
                            "API_SOURCE_OUT_OF_SCOPE", "远程响应含超出当前范围的对象"
                        )
                    row = conn.execute(
                        "SELECT content,metadata FROM source WHERE path=?", (item.path,)
                    ).fetchone()
                    local = (
                        target.read_bytes().decode("utf-8")
                        if target.is_file()
                        else None
                    )
                    # A verified upload has accepted the submitted text. Server
                    # normalization must merge against that text, preserving any
                    # local edits made while the request was in flight.
                    ancestor = (
                        uploaded_content[item.path]
                        if uploaded_content and item.path in uploaded_content
                        else row[0] if row else None
                    )
                    candidate = (
                        item.content
                        if local is None
                        else merge(ancestor, local, item.content)
                        if row
                        else item.content
                        if local == item.content
                        else None
                    )
                    unknown_ancestor = bool(
                        row and json.loads(row[1]).get("untrackedConflict")
                    )
                    if (
                        candidate is None
                        or unknown_ancestor
                        and local != item.content
                        or item.readonly
                        and row
                        and local not in (None, row[0], item.content)
                    ):
                        atomic_text(
                            self._conflict_path(item.path),
                            json.dumps(
                                {
                                    "path": item.path,
                                    "base": ancestor,
                                    "remote": item.content,
                                    "metadata": meta,
                                    "remoteHash": digest(item.content),
                                },
                                ensure_ascii=False,
                            )
                            + "\n",
                        )
                        if row is None:
                            conn.execute(
                                "INSERT INTO source VALUES(?,?,?,?)",
                                (
                                    item.path,
                                    item.content,
                                    json.dumps(
                                        {**meta, "untrackedConflict": True},
                                        ensure_ascii=False,
                                    ),
                                    int(item.readonly),
                                ),
                            )
                            conn.commit()
                        operation["conflicts"].append(
                            {
                                "path": item.path,
                                "reason": "本地和远端冲突，保留本地及共同基线",
                            }
                        )
                        continue
                    current = (
                        target.read_bytes().decode("utf-8")
                        if target.is_file()
                        else None
                    )
                    if current != local:
                        raise ApiError("API_SOURCE_STALE", "更新发布前源码已变化")
                    before = (
                        self.directory
                        / "operations"
                        / operation["operationId"]
                        / (
                            "before-"
                            + hashlib.sha256(item.path.encode()).hexdigest()
                            + ".txt"
                        )
                    )
                    if local is not None and candidate != local:
                        atomic_text(before, local)
                    operation["current"] = {
                        "path": item.path,
                        "beforeHash": digest(local) if local is not None else None,
                        "afterHash": digest(candidate),
                        "remoteHash": digest(item.content),
                    }
                    self._receipt(operation)
                    assert_writable(self.workspace, [item.path])
                    if candidate != local:
                        if target.exists() and item.readonly:
                            target.chmod(0o600)
                        atomic_bytes(target, candidate.encode())
                        if item.readonly:
                            target.chmod(0o400)
                        updated.append(item.path)
                    else:
                        preserved.append(item.path)
                    conflict_path = self._conflict_path(item.path)
                    if conflict_path.is_file():
                        conflict_path.unlink()
                    conn.execute(
                        "INSERT OR REPLACE INTO source VALUES(?,?,?,?)",
                        (
                            item.path,
                            item.content,
                            json.dumps(meta, ensure_ascii=False),
                            int(item.readonly),
                        ),
                    )
                    conn.commit()
                    operation["applied"].append(item.path)
                    operation["current"] = None
                    self._receipt(operation)
                if authoritative:
                    incoming = set(paths)
                    for path, text, rawmeta, ro in conn.execute(
                        "SELECT path,content,metadata,readonly FROM source"
                    ).fetchall():
                        meta = json.loads(rawmeta)
                        if path in incoming or not in_scope(self.workspace, path, meta):
                            continue
                        target = self._path(path)
                        local = (
                            target.read_bytes().decode("utf-8")
                            if target.is_file()
                            else None
                        )
                        assert_writable(self.workspace, [path])
                        if local is not None and local != text:
                            meta["remoteDeleted"] = True
                            conn.execute(
                                "UPDATE source SET metadata=? WHERE path=?",
                                (json.dumps(meta, ensure_ascii=False), path),
                            )
                            conn.commit()
                            operation["conflicts"].append(
                                {
                                    "path": path,
                                    "reason": "远端已删除且本地有改动，未删除本地",
                                }
                            )
                            continue
                        if target.is_file():
                            atomic_text(
                                self.directory
                                / "operations"
                                / operation["operationId"]
                                / (
                                    "deleted-"
                                    + hashlib.sha256(path.encode()).hexdigest()
                                    + ".txt"
                                ),
                                local,
                            )
                            target.unlink()
                        conn.execute("DELETE FROM source WHERE path=?", (path,))
                        conn.commit()
                        deleted.append(path)
        operation["stage"] = (
            "CONFLICT" if operation["conflicts"] else "LOCAL_REFRESH_VERIFIED"
        )
        self._receipt(operation)
        return {
            "updated": updated,
            "preserved": preserved,
            "deleted": deleted,
            "conflicts": operation["conflicts"],
            "complete": not operation["conflicts"],
            "operationId": operation["operationId"],
            "scope": scope,
            "uploadState": "NOT_PERFORMED",
        }
