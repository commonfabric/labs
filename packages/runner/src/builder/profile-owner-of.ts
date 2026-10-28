/**
 * `profileOwnerOf()`, which pattern code calls to ask whose own profile a
 * profile is, by the rule `profileOwnerAt()` states.
 */

import type { DID } from "@commonfabric/api";

import type { NormalizedFullLink } from "../link-types.ts";
import { profileOwnerAt } from "../profile-owner.ts";
import { withdrawHandlerWhileLoading } from "../scheduler/handler-load-wait.ts";
import { topFrame } from "./frame-context.ts";
import { cellOfTarget } from "./space-access.ts";

/**
 * Returns the person whose own profile `target` is, by the rule every reader
 * of which profiles are a person's applies (`profileOwnerAt()`), or
 * `undefined` when it is no one's, and for a `target` passed as `undefined`.
 * In a reactive computation the result updates when the profile's label or
 * its name changes, or a document it reads arrives. In a handler, a document
 * it reads that is still loading withdraws the handler, which runs again once
 * it arrives.
 *
 * @throws If called outside a handler or a reactive computation, with a
 *   `target` that is neither a cell nor `undefined`, or when a label is stored
 *   in a form this build cannot interpret or a read of it fails.
 */
export function profileOwnerOf(target: unknown): DID | undefined {
  const name = "profileOwnerOf(target)";
  const frame = topFrame();
  if (frame?.frameKind !== "lift" && frame?.frameKind !== "handler") {
    throw new Error(
      `\`${name}\` can only be called from a handler or a reactive computation.`,
    );
  }
  const { runtime, tx } = frame;
  if (runtime === undefined || tx === undefined) {
    throw new Error(`\`${name}\` requires an executing runtime.`);
  }
  if (target === undefined) return undefined;
  // In a handler, each document the rule reads that is still loading
  // withdraws the handler, which runs again once it arrives.
  const visit = frame.frameKind === "handler"
    ? (document: NormalizedFullLink) =>
      withdrawHandlerWhileLoading(
        runtime,
        tx,
        document,
        `the profile document \`${document.id}\` was read while it was still loading`,
      )
    : undefined;
  return profileOwnerAt(
    runtime,
    tx,
    cellOfTarget(target, name).withTx(tx),
    visit,
  );
}
