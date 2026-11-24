import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";

import {
  classifyFileToolShellFailure,
  classifyPathResolutionError,
  createStructuredFileToolErrorOutput,
  detailFromShellFailure,
  isStructuredFileToolErrorOutput,
  type StructuredFileToolErrorCode,
} from "../../src/tools/file-errors.ts";
import { createToolsSmallContext } from "../support/tools-small-context.ts";

const shellFailure = (exitCode: number, stderr = "", stdout = "") => ({
  exitCode,
  stderr,
  stdout,
});

describe("file-errors", () => {
  describe("createStructuredFileToolErrorOutput()", () => {
    const errorFor = (
      code: StructuredFileToolErrorCode,
      detail?: string,
    ) =>
      createStructuredFileToolErrorOutput(
        createToolsSmallContext(),
        "read_file",
        { outputId: "out-1", path: "/workspace/a.txt", code, detail },
      ).error;

    it("returns a message naming the path for each code", () => {
      expect(errorFor("file_not_found").message).toBe(
        "file not found: /workspace/a.txt",
      );
      expect(errorFor("not_a_file").message).toBe(
        "not a file: /workspace/a.txt",
      );
      expect(errorFor("permission_denied").message).toBe(
        "permission denied: /workspace/a.txt",
      );
      expect(errorFor("path_outside_workspace").message).toBe(
        "path outside workspace: /workspace/a.txt",
      );
    });

    it("returns a message carrying the detail for an edit conflict or an unknown failure, and omits an empty detail", () => {
      expect(errorFor("edit_conflict", "digest moved")).toEqual({
        type: "cf-harness.structured-file-tool-error",
        code: "edit_conflict",
        message: "edit conflict for /workspace/a.txt: digest moved",
        path: "/workspace/a.txt",
        detail: "digest moved",
      });
      expect(errorFor("edit_conflict", "")).toEqual({
        type: "cf-harness.structured-file-tool-error",
        code: "edit_conflict",
        message: "edit conflict for /workspace/a.txt",
        path: "/workspace/a.txt",
      });
      expect(errorFor("unknown", "disk on fire").message).toBe(
        "file tool failed for /workspace/a.txt: disk on fire",
      );
      expect(errorFor("unknown").message).toBe(
        "file tool failed for /workspace/a.txt",
      );
    });

    it("returns an output id from the context when none is given, and the exit code when one is", () => {
      const output = createStructuredFileToolErrorOutput(
        createToolsSmallContext(),
        "view_image",
        { path: "/workspace/a.png", code: "file_not_found", exitCode: 10 },
      );
      expect(output.outputId).toMatch(/view_image/);
      expect(output.ok).toBe(false);
      expect(output.error.exitCode).toBe(10);
    });
  });

  describe("isStructuredFileToolErrorOutput()", () => {
    it("returns true for a structured file tool error and false for anything else", () => {
      const output = createStructuredFileToolErrorOutput(
        createToolsSmallContext(),
        "write_file",
        { path: "/workspace/a.txt", code: "unknown" },
      );
      expect(isStructuredFileToolErrorOutput(output)).toBe(true);
      expect(
        isStructuredFileToolErrorOutput({
          ...output,
          error: { ...output.error, type: "other" },
        }),
      ).toBe(false);
      expect(isStructuredFileToolErrorOutput({ ...output, ok: true })).toBe(
        false,
      );
      expect(isStructuredFileToolErrorOutput("file not found")).toBe(false);
    });
  });

  describe("detailFromShellFailure()", () => {
    it("returns stderr, then stdout, then the exit code, whichever first says something", () => {
      expect(detailFromShellFailure(shellFailure(1, " oops\n", "out"))).toBe(
        "oops",
      );
      expect(detailFromShellFailure(shellFailure(1, " \n", " out\n"))).toBe(
        "out",
      );
      expect(detailFromShellFailure(shellFailure(7))).toBe(
        "shell exited with code 7",
      );
    });
  });

  describe("classifyFileToolShellFailure()", () => {
    it("returns file_not_found for exit code 10 or a missing-file message", () => {
      expect(classifyFileToolShellFailure(shellFailure(10))).toBe(
        "file_not_found",
      );
      expect(
        classifyFileToolShellFailure(
          shellFailure(1, "cat: x: No such file or directory"),
        ),
      ).toBe("file_not_found");
    });

    it("returns not_a_file for exit code 11 or a directory message", () => {
      expect(classifyFileToolShellFailure(shellFailure(11))).toBe(
        "not_a_file",
      );
      expect(
        classifyFileToolShellFailure(shellFailure(1, "", "x: Is a directory")),
      ).toBe("not_a_file");
    });

    it("returns permission_denied for exit code 13 or a permission message", () => {
      expect(classifyFileToolShellFailure(shellFailure(13))).toBe(
        "permission_denied",
      );
      expect(
        classifyFileToolShellFailure(shellFailure(1, "x: Permission denied")),
      ).toBe("permission_denied");
    });

    it("returns unknown for any other failure", () => {
      expect(classifyFileToolShellFailure(shellFailure(1, "disk full"))).toBe(
        "unknown",
      );
    });
  });

  describe("classifyPathResolutionError()", () => {
    it("returns path_outside_workspace for a workspace escape and unknown otherwise", () => {
      expect(
        classifyPathResolutionError(
          new Error("Path escapes workspace root: /etc"),
        ),
      ).toBe("path_outside_workspace");
      expect(classifyPathResolutionError(new Error("bad path"))).toBe(
        "unknown",
      );
    });
  });
});
