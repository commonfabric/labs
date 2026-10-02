import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { CompilerStackLoadError } from "@commonfabric/runner";

import { RuntimeErrorCode } from "@/protocol/mod.ts";
import { runtimeErrorReport } from "@/backends/runtime-error.ts";

describe("runtime error reports", () => {
  it("classifies compiler-load failures, and carries the pattern context", () => {
    const compilerError = Object.assign(
      new CompilerStackLoadError(new TypeError("chunk fetch failed")),
      {
        pieceId: "piece-1",
        space: "did:key:space-1",
        patternId: "pattern-1",
        spellId: "spell-1",
      },
    );

    expect(runtimeErrorReport(compilerError)).toEqual({
      message: "Failed to load the compiler stack",
      code: RuntimeErrorCode.CompilerStackLoadFailed,
      pieceId: "piece-1",
      space: "did:key:space-1",
      patternId: "pattern-1",
      spellId: "spell-1",
      stackTrace: compilerError.stack,
    });
  });

  it("reports an ordinary error by its message and stack alone", () => {
    const ordinaryError = new Error("ordinary runtime error");

    expect(runtimeErrorReport(ordinaryError)).toEqual({
      message: "ordinary runtime error",
      stackTrace: ordinaryError.stack,
    });
  });
});
