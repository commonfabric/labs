import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { fabricFromRealmValue } from "@commonfabric/data-model/codecs";
import { firstHandshakeFailedError } from "@commonfabric/memory/v2/client";
import { CompilerStackLoadError } from "@commonfabric/runner";

import { NotificationType, RuntimeErrorCode } from "@/protocol/mod.ts";
import {
  postContextualRuntimeError,
  postRuntimeError,
  runtimeErrorCode,
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

  it("returns `SpaceUnreachable` for a space whose first connection never completed a handshake", () => {
    const unreachable = firstHandshakeFailedError(
      3,
      "wss://memory.test/",
      new Error("connection refused"),
    );
    expect(runtimeErrorCode(unreachable)).toBe(
      RuntimeErrorCode.SpaceUnreachable,
    );
    expect(runtimeErrorCode(new Error("connection refused"))).toBe(undefined);
  });

  it("returns no code for an authorization denial no storage manager reported as a space's refusal", () => {
    // The memory server's refusal of one operation, which leaves the space
    // readable, and a denial it marked `retriable`, which a fresh handshake
    // heals. Neither says the space is gone.
    const denial = (message: string, marks: object = {}) =>
      Object.assign(new Error(message), {
        name: "AuthorizationError",
        ...marks,
      });

    expect(runtimeErrorCode(
      denial("Only the original acting user may resolve this event"),
    )).toBe(undefined);
    expect(runtimeErrorCode(
      denial("Principal P lacks WRITE on space S", {
        permanentEvidence: true,
        aclRevision: 1,
      }),
    )).toBe(undefined);
    expect(runtimeErrorCode(
      denial("memory authentication lease has run out", { retriable: true }),
    )).toBe(undefined);
  });
});
