"""Checks for the release-dispatched Gitee mirror's write boundary."""

from contextlib import nullcontext, redirect_stderr, redirect_stdout
from io import StringIO
from pathlib import Path
import shlex
import tempfile
import unittest
from unittest.mock import Mock, patch

import yaml

import sync_release_to_gitee as sync


class GiteeMirrorWorkflowTest(unittest.TestCase):
    source_sha = "1" * 40

    def setUp(self):
        root = Path(self.enterContext(tempfile.TemporaryDirectory()))
        self.release_dir = root / "release"
        self.release_dir.mkdir()
        for name in sync.INSTALLER_ASSETS:
            (self.release_dir / name).write_bytes(b"fixture")
        self.notes = root / "notes.md"
        self.client = self.enterContext(patch.object(sync, "GiteeClient"))
        self.mirror = self.enterContext(patch.object(sync, "mirror"))
        self.enterContext(patch.object(sync, "verify_assets", return_value={"fixture": "hash"}))
        self.enterContext(patch.object(sync, "load_token", return_value="fixture"))
        self.enterContext(patch.object(sync, "mirror_lock", return_value=nullcontext()))
        self.enterContext(patch.object(sync.shutil, "which", return_value="/fixture/tool"))
        self.enterContext(redirect_stdout(StringIO()))
        self.errors = StringIO()
        self.enterContext(redirect_stderr(self.errors))

    def run_sync(self, published_sha, *arguments):
        self.notes.write_text(f"Fixture notes\n\n<!-- guthon-release-source: {published_sha} -->\n", encoding="utf-8")
        return sync.main(["--release-dir", str(self.release_dir), "--notes-file", str(self.notes), *arguments])

    def run_workflow_step(self, step_name, published_sha, *options):
        workflow = sync.ROOT / ".github" / "workflows" / "sync-gitee-release.yml"
        steps = yaml.safe_load(workflow.read_text(encoding="utf-8"))["jobs"]["sync"]["steps"]
        run = next(step["run"] for step in steps if step.get("name") == step_name)
        command = next(line for line in run.replace("\\\n", " ").splitlines()
                       if line.startswith("python scripts/sync_release_to_gitee.py "))
        arguments = shlex.split(command)[2:]
        variables = {
            "$RELEASE_TAG": "v1.2.3", "$EXPECTED_SOURCE_SHA": self.source_sha,
            "$GITHUB_REPOSITORY": sync.GITHUB_MIRROR_SOURCE,
            "$GITEE_OWNER/$GITEE_REPO": sync.GITEE_MIRROR_TARGET,
        }
        return self.run_sync(published_sha, *(variables.get(arg, arg) for arg in arguments), *options)

    def test_automated_sync_passes_the_existing_retention_rule(self):
        self.assertEqual(self.run_workflow_step("Sync signed release to Gitee", self.source_sha), 0)
        self.mirror.assert_called_once()
        with patch.object(sync, "prune_attachments") as prune:
            self.mirror.call_args.kwargs["quota_cleanup"](1234)
        prune.assert_called_once_with(self.client.return_value, sync.GITHUB_MIRROR_SOURCE, "v1.2.3", bytes_needed=1234)

    def test_explicit_opt_out_keeps_existing_attachments_on_quota_error(self):
        self.assertEqual(self.run_workflow_step("Sync signed release to Gitee", self.source_sha, "--no-quota-cleanup"), 0)
        self.mirror.assert_called_once()
        self.assertIsNone(self.mirror.call_args.kwargs["quota_cleanup"])

    def test_superseded_release_stops_before_contacting_gitee(self):
        self.assertEqual(self.run_workflow_step("Sync signed release to Gitee", "2" * 40), 1)
        self.assertIn("GitHub 发行来源与触发镜像的提交不一致", self.errors.getvalue())
        self.client.assert_not_called()
        self.mirror.assert_not_called()

    def test_readback_uses_the_same_source_without_a_write_token(self):
        self.assertEqual(self.run_workflow_step("Read back and verify all Gitee assets", self.source_sha), 0)
        self.client.assert_called_once()
        self.assertEqual(self.client.call_args.args[2], "")
        self.assertTrue(self.mirror.call_args.kwargs["verify_only"])
        self.assertIsNone(self.mirror.call_args.kwargs["quota_cleanup"])


class GiteeQuotaRetryTest(unittest.TestCase):
    def test_quota_after_timeout_recovers_only_if_the_attachment_is_still_missing(self):
        root = Path(self.enterContext(tempfile.TemporaryDirectory()))
        file = root / "guthon-testing.zip"
        file.write_bytes(b"fixture")
        digest = sync.file_hash(file)
        self.enterContext(patch.object(sync.time, "sleep"))
        self.enterContext(redirect_stdout(StringIO()))

        for arrived_after_timeout in (False, True):
            with self.subTest(arrived_after_timeout=arrived_after_timeout):
                client = Mock()
                cleanup = Mock()
                empty = {"id": 123, "body": "Fixture notes", "assets": []}
                complete = {**empty, "assets": [{"name": file.name}]}
                results = iter([sync.TransferError("timeout"), sync.AttachmentQuotaError("quota"), None])
                client.release.return_value = empty
                client.download_hash.return_value = digest

                def upload(*args, **kwargs):
                    result = next(results)
                    if result is None or isinstance(result, sync.AttachmentQuotaError) and arrived_after_timeout:
                        client.release.return_value = complete
                    if result is not None:
                        raise result

                client.json_request.side_effect = upload
                sync.mirror(client, "v1.2.3", root, {file.name: digest}, "Fixture notes", quota_cleanup=cleanup)

                call_names = [call[0] for call in client.method_calls]
                self.assertEqual(call_names[:5], ["release", "release", "json_request", "release", "json_request"])
                client.download_hash.assert_called_once_with(complete["assets"][0], file)
                if arrived_after_timeout:
                    self.assertEqual(client.json_request.call_count, 2)
                    cleanup.assert_not_called()
                else:
                    self.assertEqual(client.json_request.call_count, 3)
                    cleanup.assert_called_once_with(file.stat().st_size)
