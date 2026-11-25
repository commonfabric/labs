import { expect } from "@std/expect";

import type {
  CfcSandboxDiagnostic,
  CfcSandboxExitCodeObservation,
  CfcSandboxResult,
  CfcStreamObservation,
} from "@commonfabric/runner/cfc";
import { describe, it } from "@commonfabric/test-support/test";

import {
  type EditFileTextEdit,
  editFileTool,
  type EditFileToolOutput,
  type EditFileToolSuccessOutput,
  isEditFileToolSuccessOutput,
} from "../../src/tools/edit-file.ts";
import type { StructuredFileToolErrorOutput } from "../../src/tools/file-errors.ts";
import type { SandboxCommandResult } from "../../src/sandbox/types.ts";
import {
  createToolsSmallContext,
  ScriptedSandbox,
} from "../support/tools-small-context.ts";

const PUBLIC = { confidentiality: ["public"] };
const SECRET = { confidentiality: ["secret"] };

const ok = (stdout: string, cfcResult?: CfcSandboxResult) => ({
  stdout,
  stderr: "",
  exitCode: 0,
  ...(cfcResult !== undefined ? { cfcResult } : {}),
});

const sha256 = async (text: string): Promise<string> => {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(text),
  );
  return `sha256:${
    [...new Uint8Array(digest)].map((byte) =>
      byte.toString(16).padStart(2, "0")
    ).join("")
  }`;
};

const runEdit = async (
  results: SandboxCommandResult[],
  edits: EditFileTextEdit[],
  options: { path?: string; artifactRootHostPath?: string } = {},
): Promise<{ output: EditFileToolOutput; sandbox: ScriptedSandbox }> => {
  const sandbox = new ScriptedSandbox(results);
  const output = await editFileTool.invoke(
    createToolsSmallContext({
      sandbox,
      artifactRootHostPath: options.artifactRootHostPath,
    }),
    { path: options.path ?? "notes.txt", edits },
  );
  return { output, sandbox };
};

/** Runs an edit whose read, write, and verification all succeed. */
const successfulEdit = async (
  oldContent: string,
  newContent: string,
  edits: EditFileTextEdit[],
  cfc: { read?: CfcSandboxResult; verify?: CfcSandboxResult } = {},
): Promise<EditFileToolSuccessOutput> => {
  const { output } = await runEdit(
    [ok(oldContent, cfc.read), ok(""), ok(newContent, cfc.verify)],
    edits,
  );
  if (!isEditFileToolSuccessOutput(output)) {
    throw new Error(
      `expected a successful edit, got ${JSON.stringify(output)}`,
    );
  }
  return output;
};

const expectFileError = (
  output: EditFileToolOutput,
): StructuredFileToolErrorOutput["error"] => {
  if (isEditFileToolSuccessOutput(output)) {
    throw new Error("expected an edit_file error output");
  }
  return output.error;
};

const cfcResult = (
  stdout: CfcStreamObservation,
  options: {
    exitCode?: CfcSandboxExitCodeObservation;
    diagnostics?: CfcSandboxDiagnostic[];
  } = {},
): CfcSandboxResult => ({
  version: 1,
  stdout,
  stderr: {
    channel: "stderr",
    policy: "observed",
    label: PUBLIC,
    segments: [],
  },
  exitCode: options.exitCode ?? { policy: "observed", label: PUBLIC, value: 0 },
  ...(options.diagnostics !== undefined
    ? { diagnostics: options.diagnostics }
    : {}),
});

const observedStdout = (
  text: string,
  label = PUBLIC,
): CfcStreamObservation => ({
  channel: "stdout",
  policy: "observed",
  label,
  segments: [{ text, label }],
});

describe("edit-file", () => {
  describe("edit validation", () => {
    const conflictFor = async (
      content: string,
      edits: EditFileTextEdit[],
    ) => {
      const { output, sandbox } = await runEdit([ok(content)], edits);
      // A rejected edit never reaches the write.
      expect(sandbox.shellRequests).toHaveLength(1);
      const error = expectFileError(output);
      expect(error.code).toBe("edit_conflict");
      return error.detail;
    };

    it("returns an edit conflict when the edit list is empty", async () => {
      expect(await conflictFor("a\n", [])).toBe(
        "edit_file edits must include at least one edit",
      );
    });

    it("returns an edit conflict naming the edit whose oldText is empty", async () => {
      expect(
        await conflictFor("a\n", [
          { oldText: "a", newText: "b" },
          { oldText: "", newText: "c" },
        ]),
      ).toBe("edit 2 oldText must be non-empty");
    });

    it("returns an edit conflict when expectedReplacements is not a positive integer", async () => {
      for (const expectedReplacements of [0, -1, 1.5]) {
        expect(
          await conflictFor("a a\n", [{
            oldText: "a",
            newText: "b",
            replaceAll: true,
            expectedReplacements,
          }]),
        ).toBe("edit 1 expectedReplacements must be a positive integer");
      }
    });

    it("returns an edit conflict when expectedReplacements above one comes without replaceAll", async () => {
      expect(
        await conflictFor("a a\n", [{
          oldText: "a",
          newText: "b",
          expectedReplacements: 2,
        }]),
      ).toBe(
        "edit 1 expectedReplacements greater than 1 requires replaceAll=true",
      );
    });

    it("returns an edit conflict when the match count differs from expectedReplacements", async () => {
      expect(
        await conflictFor("a a a\n", [{
          oldText: "a",
          newText: "b",
          replaceAll: true,
          expectedReplacements: 2,
        }]),
      ).toBe("edit 1 expected 2 replacement(s) but found 3");
    });

    it("returns an edit conflict when oldText is absent", async () => {
      expect(await conflictFor("a\n", [{ oldText: "z", newText: "y" }])).toBe(
        "edit 1 oldText was not found",
      );
    });

    it("returns one replacement when expectedReplacements is one and oldText matches once", async () => {
      const output = await successfulEdit("a b\n", "x b\n", [{
        oldText: "a",
        newText: "x",
        expectedReplacements: 1,
      }]);
      expect(output.replacements).toBe(1);
    });
  });

  describe("diff", () => {
    it("returns an empty diff when the edit leaves the content unchanged", async () => {
      const output = await successfulEdit("same\n", "same\n", [{
        oldText: "same",
        newText: "same",
      }]);
      expect(output.diff).toBe("");
      expect(output.newDigest).toBe(output.oldDigest);
    });

    it("returns a diff that deletes every line when the edit empties the file", async () => {
      const output = await successfulEdit("gone\n", "", [{
        oldText: "gone\n",
        newText: "",
      }]);
      expect(output.diff).toBe(
        "--- /workspace/notes.txt\n+++ /workspace/notes.txt\n@@ -1,1 +0,0 @@\n-gone\n",
      );
      expect(output.newSizeBytes).toBe(0);
    });

    it("returns one hunk for edits whose context overlaps and separate hunks for edits that do not", async () => {
      const lines = Array.from({ length: 20 }, (_, index) => `line ${index}`);
      const before = `${lines.join("\n")}\n`;
      const near = await successfulEdit(
        before,
        before.replace("line 5\n", "five\n").replace("line 9\n", "nine\n"),
        [{ oldText: "line 5\n", newText: "five\n" }, {
          oldText: "line 9\n",
          newText: "nine\n",
        }],
      );
      expect(near.diff.match(/^@@/gm)).toHaveLength(1);
      expect(near.diff).toContain("@@ -3,11 +3,11 @@");
      expect(near.diff).toContain(" line 7\n");

      const far = await successfulEdit(
        before,
        before.replace("line 2\n", "two\n").replace("line 17\n", "seventeen\n"),
        [{ oldText: "line 2\n", newText: "two\n" }, {
          oldText: "line 17\n",
          newText: "seventeen\n",
        }],
      );
      expect(far.diff.match(/^@@/gm)).toHaveLength(2);
    });
  });

  describe("path checks", () => {
    it("returns path_outside_workspace without running a command for a path that escapes the workspace", async () => {
      const { output, sandbox } = await runEdit([], [{
        oldText: "a",
        newText: "b",
      }], { path: "../etc/passwd" });
      expect(sandbox.shellRequests).toHaveLength(0);
      expect(expectFileError(output)).toMatchObject({
        code: "path_outside_workspace",
        path: "../etc/passwd",
      });
    });

    it("returns permission_denied without running a command for a path inside the artifact root", async () => {
      const { output, sandbox } = await runEdit([], [{
        oldText: "a",
        newText: "b",
      }], {
        path: "artifacts/run.json",
        artifactRootHostPath: "/tmp/cf-harness-workspace/artifacts",
      });
      expect(sandbox.shellRequests).toHaveLength(0);
      expect(expectFileError(output)).toMatchObject({
        code: "permission_denied",
        path: "/workspace/artifacts/run.json",
      });
    });
  });

  describe("write and verification failures", () => {
    it("returns the classified read failure with its exit code, without writing", async () => {
      const { output, sandbox } = await runEdit(
        [{
          stdout: "",
          stderr: "not a file: /workspace/notes.txt",
          exitCode: 11,
        }],
        [{ oldText: "a", newText: "b" }],
      );
      expect(sandbox.shellRequests).toHaveLength(1);
      expect(expectFileError(output)).toMatchObject({
        code: "not_a_file",
        detail: "not a file: /workspace/notes.txt",
        exitCode: 11,
      });
    });

    it("returns the classified write failure with its exit code", async () => {
      const { output, sandbox } = await runEdit(
        [ok("a\n"), { stdout: "", stderr: "Permission denied", exitCode: 1 }],
        [{ oldText: "a", newText: "b" }],
      );
      expect(sandbox.shellRequests).toHaveLength(2);
      expect(sandbox.shellRequests[1]?.stdinText).toBe("b\n");
      expect(expectFileError(output)).toMatchObject({
        code: "permission_denied",
        detail: "Permission denied",
        exitCode: 1,
      });
    });

    it("returns the classified verification read failure with its exit code", async () => {
      const { output } = await runEdit(
        [
          ok("a\n"),
          ok(""),
          { stdout: "", stderr: "file not found: x", exitCode: 10 },
        ],
        [{ oldText: "a", newText: "b" }],
      );
      expect(expectFileError(output)).toMatchObject({
        code: "file_not_found",
        exitCode: 10,
      });
    });

    it("returns an edit conflict naming both digests when the file reads back different from what was written", async () => {
      const { output } = await runEdit(
        [ok("a\n"), ok(""), ok("someone else\n")],
        [{ oldText: "a", newText: "b" }],
      );
      expect(expectFileError(output)).toMatchObject({
        code: "edit_conflict",
        detail: `post-write verification failed: expected ${await sha256(
          "b\n",
        )} but observed ${await sha256("someone else\n")}`,
      });
    });
  });

  describe("CFC result", () => {
    const edit = [{ oldText: "a", newText: "b" }];

    it("returns an observed diff carrying the labels of both reads", async () => {
      const output = await successfulEdit("a\n", "b\n", edit, {
        read: cfcResult(observedStdout("a\n", SECRET)),
        verify: cfcResult(observedStdout("b\n")),
      });
      expect(output.cfcResult?.stdout).toMatchObject({
        policy: "observed",
        segments: [{ text: output.diff }],
      });
      expect(output.cfcResult?.stdout.label.confidentiality).toEqual(
        expect.arrayContaining(["secret"]),
      );
      expect(output.cfcResult?.exitCode).toMatchObject({
        policy: "observed",
        value: 0,
      });
      expect(output.cfcResult?.diagnostics).toBeUndefined();
    });

    // Distinct atoms for each read, so that a label holding both shows the
    // two were joined. Neither is the `public` atom the stderr and exit status
    // carry.
    const READ_SECRET = { confidentiality: ["read-secret"] };
    const VERIFY_SECRET = { confidentiality: ["verify-secret"] };

    it("returns a denied diff labeled with both reads when either read was denied", async () => {
      for (
        const cfc of [
          {
            read: cfcResult({
              channel: "stdout",
              policy: "denied",
              label: READ_SECRET,
            }),
            verify: cfcResult(observedStdout("b\n", VERIFY_SECRET)),
          },
          {
            read: cfcResult(observedStdout("a\n", READ_SECRET)),
            verify: cfcResult({
              channel: "stdout",
              policy: "denied",
              label: VERIFY_SECRET,
            }),
          },
        ]
      ) {
        const output = await successfulEdit("a\n", "b\n", edit, cfc);
        expect(output.cfcResult?.stdout).toMatchObject({
          policy: "denied",
          reason:
            "edit_file diff includes content that was not released by CFC policy",
        });
        const confidentiality = output.cfcResult?.stdout.label.confidentiality;
        expect(confidentiality).toEqual(
          expect.arrayContaining(["read-secret", "verify-secret"]),
        );
        expect(confidentiality).not.toContain("public");
      }
    });

    it("returns an opaque diff labeled with both reads when either read was opaque", async () => {
      for (
        const cfc of [
          {
            read: cfcResult({
              channel: "stdout",
              policy: "opaque",
              label: READ_SECRET,
              byteLength: 2,
            }),
            verify: cfcResult({
              channel: "stdout",
              policy: "opaque",
              label: VERIFY_SECRET,
              byteLength: 3,
            }),
          },
          {
            read: cfcResult(observedStdout("a\n", READ_SECRET)),
            verify: cfcResult({
              channel: "stdout",
              policy: "opaque",
              label: VERIFY_SECRET,
            }),
          },
        ]
      ) {
        const output = await successfulEdit("a\n", "b\n", edit, cfc);
        expect(output.cfcResult?.stdout.policy).toBe("opaque");
        const confidentiality = output.cfcResult?.stdout.label.confidentiality;
        expect(confidentiality).toEqual(
          expect.arrayContaining(["read-secret", "verify-secret"]),
        );
        expect(confidentiality).not.toContain("public");
      }
    });

    it("returns a denied or opaque exit status when either read's exit status was", async () => {
      const denied = await successfulEdit("a\n", "b\n", edit, {
        read: cfcResult(observedStdout("a\n"), {
          exitCode: { policy: "denied", label: SECRET },
        }),
        verify: cfcResult(observedStdout("b\n")),
      });
      expect(denied.cfcResult?.exitCode).toMatchObject({
        policy: "denied",
        reason: "edit_file exit status was not released by CFC policy",
      });

      const opaque = await successfulEdit("a\n", "b\n", edit, {
        read: cfcResult(observedStdout("a\n")),
        verify: cfcResult(observedStdout("b\n"), {
          exitCode: { policy: "opaque", label: SECRET },
        }),
      });
      expect(opaque.cfcResult?.exitCode?.policy).toBe("opaque");
    });

    it("returns the diagnostics of both reads in order", async () => {
      const diagnostic = (code: string): CfcSandboxDiagnostic => ({
        level: "warning",
        code,
        message: code,
      });
      const output = await successfulEdit("a\n", "b\n", edit, {
        read: cfcResult(observedStdout("a\n"), {
          diagnostics: [diagnostic("read")],
        }),
        verify: cfcResult(observedStdout("b\n")),
      });
      expect(output.cfcResult?.diagnostics?.map((entry) => entry.code))
        .toEqual(["read"]);

      const both = await successfulEdit("a\n", "b\n", edit, {
        read: cfcResult(observedStdout("a\n"), {
          diagnostics: [diagnostic("read")],
        }),
        verify: cfcResult(observedStdout("b\n"), {
          diagnostics: [diagnostic("verify")],
        }),
      });
      expect(both.cfcResult?.diagnostics?.map((entry) => entry.code))
        .toEqual(["read", "verify"]);
    });
  });
});
