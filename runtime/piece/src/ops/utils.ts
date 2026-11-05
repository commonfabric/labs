import { toCompactDebugString } from "@commonfabric/data-model";
import {
  compileAndSavePattern,
  isCfcEnforcementRejection,
  type RuntimeProgram,
} from "@commonfabric/runner";
import type { PiecesController } from "./pieces-controller.ts";

export async function compileProgram(
  pieces: PiecesController,
  program: RuntimeProgram | string,
) {
  const pattern = await compileAndSavePattern(
    pieces.runtime,
    program,
    {
      space: pieces.getSpace(),
    },
  );
  return pattern;
}

/**
 * The `Error` to throw for a failed commit.
 *
 * A commit reports failure as a `Result` error — a plain object carrying
 * `name` and `message`, not an `Error` — and throwing it as it stands leaves
 * every caller holding something that fails `instanceof Error`, has no stack,
 * and renders as `[object Object]`. Cliffy's own handler replaces such a throw
 * with `[non-error-thrown] [object Object]` before `cf` can render it, so a
 * commit conflict reaches an operator with its reason already discarded.
 *
 * An error that is already an `Error` passes through untouched, whether it
 * arrives as the Result's `reason` or as the Result itself — an
 * `IPreconditionFailedError` is one of those, and wrapping it would put its
 * `precondition` out of a caller's reach behind `cause`. A CFC refusal is the
 * one Result whose `reason` is not the failure: the message says what refused,
 * and the reason is a marker classifying the refusal,
 * `cfc-refusal-not-a-verdict` among them, which returned on its own would tell
 * an operator nothing. Such a Result is wrapped like a reason-less one, its
 * marker still on `cause.reason`. Only a plain Result is wrapped: its `name`
 * and `message` become the error's, and the Result itself is kept on `cause`
 * so a caller that wants the conflict's own fields — which documents
 * conflicted, at which sequence — still has them.
 *
 * A Result carrying no `message` is rendered with `toCompactDebugString` rather
 * than `JSON.stringify`, which would be this defect again one level down: it
 * renders most non-plain objects as `{}`, and throws outright on a circular
 * one — inside the path that exists to make a failure legible.
 */
export function commitFailure(error: object): Error {
  if (error instanceof Error) return error;
  if (
    "reason" in error && error.reason instanceof Error &&
    !isCfcEnforcementRejection(error as { message?: string })
  ) {
    return error.reason;
  }
  const named = error as { name?: unknown; message?: unknown };
  const message = typeof named.message === "string"
    ? named.message
    : toCompactDebugString(error);
  const wrapped = new Error(message, { cause: error });
  if (typeof named.name === "string") wrapped.name = named.name;
  return wrapped;
}
