import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { fabricFromRealmValue } from "@commonfabric/data-model/codecs";
import { CompilerStackLoadError } from "@commonfabric/runner";

import { NotificationType, RuntimeErrorCode } from "@/protocol/mod.ts";
import {
  postContextualRuntimeError,
  postRuntimeError,
} from "@/backends/runtime-error.ts";

describe("runtime error notifications", () => {
  it("classifies compiler-load failures in contextual and renderer errors", () => {
    const posted: unknown[] = [];
    const originalPostMessage =
      (globalThis as { postMessage?: unknown }).postMessage;
    // Decoded as the client's transport decodes it: `postToClient()` encodes
    // the envelope, so what a raw capture sees is the encoding.
    (globalThis as { postMessage: (message: unknown) => void }).postMessage = (
      message,
    ) => posted.push(fabricFromRealmValue(message as never));

    try {
      const compilerError = Object.assign(
        new CompilerStackLoadError(new TypeError("chunk fetch failed")),
        {
          pieceId: "piece-1",
          space: "did:key:space-1",
          patternId: "pattern-1",
          spellId: "spell-1",
        },
      );

      postContextualRuntimeError(compilerError);
      expect(posted[0]).toEqual({
        type: NotificationType.ErrorReport,
        message: "Failed to load the compiler stack",
        code: RuntimeErrorCode.CompilerStackLoadFailed,
        pieceId: "piece-1",
        space: "did:key:space-1",
        patternId: "pattern-1",
        spellId: "spell-1",
        stackTrace: compilerError.stack,
      });

      postRuntimeError(compilerError);
      expect(posted[1]).toEqual({
        type: NotificationType.ErrorReport,
        message: "Failed to load the compiler stack",
        code: RuntimeErrorCode.CompilerStackLoadFailed,
        pieceId: "piece-1",
        space: "did:key:space-1",
        patternId: "pattern-1",
        spellId: "spell-1",
        stackTrace: compilerError.stack,
      });

      const ordinaryError = new Error("ordinary runtime error");
      postRuntimeError(ordinaryError);
      expect(posted[2]).toEqual({
        type: NotificationType.ErrorReport,
        message: "ordinary runtime error",
        stackTrace: ordinaryError.stack,
      });
    } finally {
      if (originalPostMessage === undefined) {
        delete (globalThis as { postMessage?: unknown }).postMessage;
      } else {
        (globalThis as { postMessage?: unknown }).postMessage =
          originalPostMessage;
      }
    }
  });
});
