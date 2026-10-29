import { assertEquals } from "@std/assert";
import {
  commandWithFinalWorkingDirectoryMarker,
  cwdMarkerForOutput,
  extractFinalWorkingDirectory,
} from "../src/tools/shell-cwd.ts";

Deno.test("cwdMarkerForOutput builds namespaced output markers", () => {
  assertEquals(
    cwdMarkerForOutput("__CF_HARNESS_CWD__", "run-1:bash:1"),
    "__CF_HARNESS_CWD__run-1:bash:1__",
  );
});

Deno.test("commandWithFinalWorkingDirectoryMarker wraps commands with a cwd trap", () => {
  assertEquals(
    commandWithFinalWorkingDirectoryMarker("pwd", "__MARKER__"),
    [
      '__cf_harness_cwd_marker="__MARKER__"',
      'trap \'__cf_harness_status=$?; trap - EXIT; { printf "%s%s" "$__cf_harness_cwd_marker" "$(pwd)" || true; }; exit "$__cf_harness_status"\' EXIT',
      "pwd",
    ].join("\n"),
  );
});

Deno.test("extractFinalWorkingDirectory leaves stdout untouched without a marker", () => {
  assertEquals(
    extractFinalWorkingDirectory("plain output\n", "__MARKER__"),
    { stdout: "plain output\n" },
  );
});

Deno.test("extractFinalWorkingDirectory uses the last marker occurrence", () => {
  assertEquals(
    extractFinalWorkingDirectory(
      "user output __MARKER__ still output\n__MARKER__/workspace/repo",
      "__MARKER__",
    ),
    {
      stdout: "user output __MARKER__ still output\n",
      cwd: "/workspace/repo",
    },
  );
});
