/**
 * `grantSpaceAccess()` and `revokeSpaceAccess()`, the handler calls that change
 * a space's access list, and `commitSpaceAccessChanges()`, which the runner
 * calls to commit what a handler run staged.
 * `docs/features/space-access-changes.md` describes the whole arrangement.
 *
 * A call validates what it can know on its own and stages the change on the
 * handler's frame. The runner then commits each space's staged changes as a
 * commit of its own, the only kind the memory server admits for an access
 * list, before the handler's transaction commits. The actor keeps `OWNER`
 * throughout, since no call may change the actor's own entry, so the ordering
 * never costs the handler its own writes.
 */

import type { SpaceGrantLevel } from "@commonfabric/api";
import { debugStr } from "@commonfabric/data-model";
import { isWellFormedDID } from "@commonfabric/identity/did";
import {
  type ACL,
  aclDocId,
  hasConcreteOwner,
  sameAcl,
} from "@commonfabric/memory/acl";
import type { MemorySpace, URI } from "@commonfabric/memory/interface";

import { validateStoredAcl, writeAcl } from "../acl-manager.ts";
import { spaceReaderRole } from "../cfc/space-membership.ts";
import type { Runtime } from "../runtime.ts";
import { RetryImmediately } from "../scheduler/retry-immediately.ts";
import { isRetryableCommitRejection } from "../storage/rejection.ts";
import { topFrame } from "./frame-context.ts";
import { spaceOfTarget } from "./space-access.ts";
import type { Frame, SpaceAccessChange } from "./types.ts";

/** The levels `grantSpaceAccess()` takes. */
const GRANT_LEVELS: ReadonlySet<unknown> = new Set<SpaceGrantLevel>([
  "READ",
  "WRITE",
  "OWNER",
]);

/**
 * Sets `principal`'s entry in the access list of the space `target`'s value
 * lives in to exactly `level`. See {@link stageChange} for what is checked
 * when, and `docs/features/space-access-changes.md` for the whole contract.
 *
 * @throws Error on every refusal, which drops the handler's transaction.
 */
export function grantSpaceAccess(
  target: unknown,
  principal: unknown,
  level: unknown,
): void {
  if (!GRANT_LEVELS.has(level)) {
    throw new Error(
      "`grantSpaceAccess()` takes a level of `READ`, `WRITE` or `OWNER`; " +
        debugStr`got $quote${level}.`,
    );
  }
  stageChange(
    "grantSpaceAccess()",
    target,
    principal,
    level as SpaceGrantLevel,
  );
}

/**
 * Removes `principal`'s entry from the access list of the space `target`'s
 * value lives in. See {@link stageChange} for what is checked when.
 *
 * @throws Error on every refusal, which drops the handler's transaction.
 */
export function revokeSpaceAccess(target: unknown, principal: unknown): void {
  stageChange("revokeSpaceAccess()", target, principal, undefined);
}

/**
 * Commits the access-list changes the handler run of `frame` staged, one
 * commit per space, each holding the space's changes applied in call order to
 * the list as the memory server last confirmed it. A space whose changes
 * leave its list as it was sends nothing, since writing the value a document
 * already holds changes nothing. The runner calls this after the handler body
 * returns and before the handler's own transaction commits.
 *
 * Each commit reads the list it replaces, so a concurrent change to the list
 * makes it conflict; that throws `RetryImmediately`, and the handler runs
 * again against the list as it now stands.
 *
 * @throws Error when the actor holds no `OWNER` in a space, when a change
 *   would leave a space with no concrete `OWNER`, or when the memory server
 *   refuses a commit, which fails the handler run. Changes already committed
 *   for another space stand.
 */
export async function commitSpaceAccessChanges(frame: Frame): Promise<void> {
  const pending = frame.pendingSpaceAccessChanges;
  const runtime = frame.runtime;
  if (pending === undefined || runtime === undefined) return;
  frame.pendingSpaceAccessChanges = undefined;
  for (const [space, changes] of pending) {
    await runtime.getCellFromLink(aclLink(space)).sync();
    const tx = runtime.edit();
    tx.tx.immediate = true;
    try {
      writeAcl(tx, space, (current) => applyChanges(space, current, changes));
    } catch (error) {
      tx.abort(error);
      throw error;
    }
    runtime.prepareTxForCommit(tx);
    const { error } = await tx.commit();
    if (error === undefined) continue;
    if (isRetryableCommitRejection(error)) {
      await runtime.awaitCommitRetryReadiness(error);
      throw new RetryImmediately(
        `The access list of ${space} changed while a handler changed it`,
      );
    }
    throw new Error(
      `The memory server refused the change to the access list of ${space}: ` +
        error.message,
      { cause: error },
    );
  }
}

/**
 * Helper for {@link grantSpaceAccess} and {@link revokeSpaceAccess}, which
 * checks a change and stages it on the running handler's frame, setting
 * `principal`'s entry to `level`, or removing it when `level` is `undefined`.
 * `call` names the call, for errors.
 *
 * Checked here, whatever the access list holds: that the call runs in a
 * handler on a client runtime, for an event that is a trusted gesture, that
 * `target` is a cell, and that `principal` is a DID other than `"*"`, the
 * space's own and the actor's. When this runtime already holds the list, the
 * actor's `OWNER` and the survival of a concrete `OWNER` are checked here as
 * well, so a refusal throws from the call; {@link commitSpaceAccessChanges}
 * checks both again against the list it replaces. A change that would leave
 * the list as it is stages nothing.
 */
function stageChange(
  call: string,
  target: unknown,
  principal: unknown,
  level: SpaceGrantLevel | undefined,
): void {
  const frame = topFrame();
  const runtime = frame?.runtime;
  const tx = frame?.tx;
  if (
    frame?.frameKind !== "handler" || runtime === undefined || tx === undefined
  ) {
    throw new Error(
      `\`${call}\` is available only in a handler, not in a pattern body, ` +
        "a `computed()`, or a `lift()`.",
    );
  }
  if (runtime.servingPosture) {
    throw new Error(
      `\`${call}\` is not available on a serving runtime, which cannot yet ` +
        "check that the event's actor holds `OWNER` in the space.",
    );
  }
  if (frame.trustedGesture !== true) {
    throw new Error(
      `\`${call}\` requires the handler's event to be a trusted gesture.`,
    );
  }
  const space = spaceOfTarget(target, call);
  const actor = runtime.actingPrincipalFor(tx);
  if (actor === undefined) {
    throw new Error(`\`${call}\` requires an event with an actor.`);
  }
  if (!isWellFormedDID(principal)) {
    throw new Error(
      `\`${call}\` takes a principal's DID, never \`*\`; ` +
        debugStr`got $quote${principal}.`,
    );
  }
  if (principal === space) {
    throw new Error(
      `\`${call}\` cannot change the entry of the space's own DID.`,
    );
  }
  if (principal === actor) {
    throw new Error(
      `\`${call}\` cannot change the entry of the principal it acts for.`,
    );
  }

  const change: SpaceAccessChange = { principal, level, actor };
  const staged = frame.pendingSpaceAccessChanges?.get(space) ?? [];
  const current = knownAcl(runtime, space);
  if (current !== undefined) {
    const before = applyChanges(space, current, staged);
    const after = applyChanges(space, current, [...staged, change]);
    if (sameAcl(before, after)) return;
  }
  (frame.pendingSpaceAccessChanges ??= new Map()).set(space, [
    ...staged,
    change,
  ]);
}

/**
 * Helper for {@link stageChange} and {@link commitSpaceAccessChanges}, which
 * returns `current`, the access list of `space`, with `changes` applied in
 * order. `current` is `null` when the space has no list.
 *
 * @throws Error when a change's actor holds no `OWNER` in the list it
 *   changes, or when a change would leave no concrete `OWNER`.
 */
function applyChanges(
  space: MemorySpace,
  current: ACL | null,
  changes: readonly SpaceAccessChange[],
): ACL {
  let acl: ACL | null = current;
  for (const { principal, level, actor } of changes) {
    if (acl === null || spaceReaderRole(acl, actor) !== "owner") {
      throw new Error(
        `Changing the access list of ${space} requires \`OWNER\` there, ` +
          `which ${actor} does not hold.`,
      );
    }
    const { [principal]: _removed, ...rest } = acl;
    const next: ACL = level === undefined
      ? rest
      : { ...rest, [principal]: level };
    if (!hasConcreteOwner(next)) {
      throw new Error(
        `Changing the entry of ${principal} would leave the access list of ` +
          `${space} with no concrete \`OWNER\`.`,
      );
    }
    acl = next;
  }
  return acl ?? {};
}

/**
 * Helper for {@link stageChange}, which returns the access list of `space` as
 * this runtime holds it, or `undefined` when it holds none. The read is
 * outside the handler's transaction, so that committing the change does not
 * make the handler's own commit conflict with it.
 */
function knownAcl(runtime: Runtime, space: MemorySpace): ACL | undefined {
  const tx = runtime.edit();
  try {
    const envelope = tx.readOrThrow({
      ...aclLink(space),
      type: "application/json",
    }) as { readonly value?: unknown } | undefined;
    return validateStoredAcl(envelope?.value) ?? undefined;
  } finally {
    tx.abort();
  }
}

/** Returns the link to the access-list document of `space`. */
function aclLink(
  space: MemorySpace,
): { space: MemorySpace; id: URI; path: [] } {
  return { space, id: aclDocId(space) as URI, path: [] };
}
