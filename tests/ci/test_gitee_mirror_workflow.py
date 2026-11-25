"""Checks for the release-dispatched Gitee mirror's write boundary."""

from contextlib import nullcontext, redirect_stderr, redirect_stdout
from io import StringIO
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

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

    def run_sync(self, published_sha, *options):
        self.notes.write_text(f"Fixture notes\n\n<!-- guthon-release-source: {published_sha} -->\n", encoding="utf-8")
        return sync.main([
            "--tag", "v1.2.3", "--release-dir", str(self.release_dir), "--notes-file", str(self.notes),
            "--expected-source-sha", self.source_sha, *options,
        ])

    def test_automated_sync_keeps_existing_attachments_on_quota_error(self):
        self.assertEqual(self.run_sync(self.source_sha, "--no-quota-cleanup"), 0)
        self.mirror.assert_called_once()
        self.assertIsNone(self.mirror.call_args.kwargs["quota_cleanup"])

    def test_superseded_release_stops_before_contacting_gitee(self):
        self.assertEqual(self.run_sync("2" * 40, "--no-quota-cleanup"), 1)
        self.assertIn("GitHub 发行来源与触发镜像的提交不一致", self.errors.getvalue())
        self.client.assert_not_called()
        self.mirror.assert_not_called()

    def test_readback_uses_the_same_source_without_a_write_token(self):
        self.assertEqual(self.run_sync(self.source_sha, "--verify-only"), 0)
        self.client.assert_called_once()
        self.assertEqual(self.client.call_args.args[2], "")
        self.assertTrue(self.mirror.call_args.kwargs["verify_only"])
