"""Validate the PyInstaller invocation and both delivered launcher layouts."""

import json
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch

import build_guthon_tool
from check_release_smoke import resolve_entry


class PackagingLayoutTest(unittest.TestCase):
    def test_builder_requests_the_platform_layout_and_keeps_build_identity(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary).resolve()
            with (patch.dict("os.environ", {"GUTHON_BUILD_OUTPUT_ROOT": str(root)}),
                  patch.object(build_guthon_tool, "find_spec", return_value=object()),
                  patch.object(build_guthon_tool.subprocess, "run") as package):
                self.assertEqual(0, build_guthon_tool.main())
            invocation = package.call_args.args[0]
            expected = "--onedir" if sys.platform == "darwin" else "--onefile"
            self.assertEqual([expected], [flag for flag in invocation if flag in {"--onedir", "--onefile"}])
            self.assertEqual(str(root / "dist"), invocation[invocation.index("--distpath") + 1])
            self.assertIn(str(root / "BUILD_INFO.json"), "\n".join(invocation))
            identity = json.loads((root / "BUILD_INFO.json").read_text(encoding="utf-8"))
            self.assertRegex(identity["buildId"], r"^sha256:[a-f0-9]{64}$")

    def test_smoke_accepts_a_current_launcher_and_a_previous_macos_archive(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            executable = root / "GuthonCodeTool.exe"
            executable.touch()
            self.assertEqual(executable, resolve_entry(executable))
            bundle = root / "previous-macos"
            bundle.mkdir()
            previous = bundle / "GuthonCodeTool"
            previous.touch()
            self.assertEqual(previous, resolve_entry(bundle))
