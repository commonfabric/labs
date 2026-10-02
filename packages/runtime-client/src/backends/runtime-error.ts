import {
  CompilerStackLoadError,
  SpaceNotFoundError,
} from "@commonfabric/runner";
import { type ErrorReport, RuntimeErrorCode } from "@/protocol/mod.ts";

/** The code a runtime error crosses to the client with, if it has one. */
export function runtimeErrorCode(error: unknown): RuntimeErrorCode | undefined {
  return error instanceof CompilerStackLoadError
    ? RuntimeErrorCode.CompilerStackLoadFailed
    : error instanceof SpaceNotFoundError
    ? RuntimeErrorCode.SpaceNotFound
    : undefined;
}

/**
 * What a host is told of `error`: its message, code, stack, and whatever
 * pattern context it carries. The host-read gate decides what of it crosses
 * (`HostReadGate.error()`).
 */
export function runtimeErrorReport(
  error: ContextualRuntimeError,
): Omit<ErrorReport, "type"> {
  const code = runtimeErrorCode(error);
  return {
    message: error.message,
    ...(code ? { code } : {}),
    ...(error.stack === undefined ? {} : { stackTrace: error.stack }),
    ...(error.pieceId === undefined ? {} : { pieceId: error.pieceId }),
    ...(error.space === undefined ? {} : { space: error.space }),
    ...(error.patternId === undefined ? {} : { patternId: error.patternId }),
    ...(error.spellId === undefined ? {} : { spellId: error.spellId }),
  };
}

type ContextualRuntimeError = Error & {
  pieceId?: string;
  space?: string;
  patternId?: string;
  spellId?: string;
};
