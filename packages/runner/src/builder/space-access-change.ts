/**
 * `grantSpaceAccess()`, `revokeSpaceAccess()` and `leaveSpace()`, the handler
 * calls that change a space's access list, and `commitSpaceAccessChanges()`,
 * which the runner calls to commit what a handler run granted and revoked.
 * `docs/features/space-access-changes.md` describes the whole arrangement.
 *
 * A call validates what it can know on its own and stages the change on the
 * handler's frame. Each space's change then commits as a commit of its own,
 * the only kind the memory server admits for an access list. Grants and
 * revokes commit before the handler's transaction does: the actor keeps
 * `OWNER` through them, since neither may change the actor's own entry, so
 * the ordering never costs the handler its own writes. A leave commits after
 * it, from the transaction's post-commit effects, since the actor can no
 * longer write to the space once its entry is gone.
 */

import type { DID, SpaceGrantLevel } from "@commonfabric/api";
import { debugStr } from "@commonfabric/data-model";
import { isWellFormedDID } from "@commonfabric/identity/did";
import {
  type ACL,
  aclDocId,
  ANYONE_USER,
  hasConcreteOwner,
} from "@commonfabric/memory/acl";
import type { MemorySpace, URI } from "@commonfabric/memory/interface";
import { isObjectNotArray } from "@commonfabric/utils/types";

import { validateStoredAcl, writeAcl } from "../acl-manager.ts";
import { spaceReaderRole } from "../cfc/space-membership.ts";
import type { Runtime } from "../runtime.ts";
import { RetryImmediately } from "../scheduler/retry-immediately.ts";
import type { Action } from "../scheduler/types.ts";
import type { IExtendedStorageTransaction } from "../storage/interface.ts";
import { isStaleReadConflict } from "../storage/rejection.ts";
import { topFrame } from "./frame-context.ts";
import { spaceOfTarget } from "./space-access.ts";
import type { Frame, SpaceAccessChange, SpaceLeave } from "./types.ts";

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
 * @throws Error on every refusal, before anything is staged.
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
 * @throws Error on every refusal, before anything is staged.
 */
export function revokeSpaceAccess(target: unknown, principal: unknown): void {
  stageChange("revokeSpaceAccess()", target, principal, undefined);
}

/**
 * Removes the acting principal's own entry from the access list of the space
 * `target`'s value lives in, making the first of `options.successors` holding
 * an entry `OWNER` when the actor is the last concrete `OWNER`. Unlike the
 * other two calls it needs no trusted gesture, since it acts on the actor
 * alone and exposes nothing.
 *
 * Checked here, whatever the access list holds: that the call runs in a
 * handler on a client runtime, that `target` is a cell in a space other than
 * the actor's Home space, and that each successor is a DID other than the
 * space's own and the actor's. When this runtime already holds the list, the
 * list's `"*"` entry and the survival of a concrete `OWNER` are checked here as
 * well; {@link commitSpaceLeave} checks both again against the list it
 * replaces. Whether the actor holds an entry to remove is decided there.
 *
 * The leave commits from a post-commit effect of the handler's transaction,
 * so it is sent only once the handler's own writes commit, and not at all
 * when they never do. A later call for the same space in the same run takes
 * the place of an earlier one.
 *
 * @throws Error on every refusal, before anything is staged.
 */
export function leaveSpace(target: unknown, options?: unknown): void {
  const call = "leaveSpace()";
  const { frame, runtime, tx, space, actor } = handlerCall(call, target);
  const leave: SpaceLeave = {
    actor,
    successors: successorsOf(call, options, space, actor),
  };
  const current = knownAcl(runtime, space);
  if (current !== undefined) applyLeave(space, current, leave);
  const leaves = frame.pendingSpaceLeaves ??= new Map();
  if (!leaves.has(space)) {
    // The scheduler sets this to the handler's action before a dispatched
    // run, so the error below is reported against the handler.
    const action = tx.tx.sourceAction as Action | undefined;
    tx.enqueuePostCommitEffect({
      id: `leaveSpace:${space}`,
      kind: "leaveSpace",
      flush: async () => {
        try {
          await commitSpaceLeave(runtime, space, leaves.get(space)!);
        } catch (error) {
          // The handler's own writes have committed, so the run cannot fail
          // any more; the error goes where the run's own would have.
          if (action === undefined) throw error;
          runtime.scheduler.reportError(error as Error, action);
        }
      },
    });
  }
  leaves.set(space, leave);
}

/**
 * Commits the access-list changes the handler run of `frame` staged, one
 * commit per space, each holding the space's changes applied in call order to
 * the list as this runtime holds it once it has caught up with the memory
 * server. This is where a change that leaves the list as it was is found out:
 * that space sends nothing, since writing the value a document already holds
 * changes nothing. A change that lands at the server after that catch-up is
 * ordered after this one. The runner calls this after the handler body returns
 * and before the handler's own transaction commits.
 *
 * Each commit reads the list it replaces, so a concurrent change to the list
 * makes it conflict. The memory server's refusal of a stale read throws
 * `RetryImmediately`, and the handler runs again against the list as it now
 * stands. Every other failure fails the handler run, and nothing retries it.
 *
 * @throws Error when the actor holds no `OWNER` in a space, when a change
 *   would leave a space with no concrete `OWNER`, or when a commit fails for
 *   any reason but a stale read, which fails the handler run. Changes already
 *   committed for another space stand.
 */
export async function commitSpaceAccessChanges(frame: Frame): Promise<void> {
  const pending = frame.pendingSpaceAccessChanges;
  const runtime = frame.runtime;
  if (pending === undefined || runtime === undefined) return;
  frame.pendingSpaceAccessChanges = undefined;
  for (const [space, changes] of pending) {
    await catchUpWithAcl(runtime, space);
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
    if (isStaleReadConflict(error)) {
      await runtime.awaitCommitRetryReadiness(error);
      throw new RetryImmediately(
        `The access list of ${space} changed while a handler changed it`,
      );
    }
    throw new Error(
      `The change to the access list of ${space} did not commit: ` +
        error.message,
      { cause: error },
    );
  }
}

/**
 * Commits `leave`, a leave of `space` a handler run staged, as one commit
 * holding the list as this runtime holds it once it has caught up with the
 * memory server, less the actor's entry. When the actor holds no entry there,
 * nothing is sent. Called from a post-commit effect of the handler's
 * transaction, once the handler's own writes have committed.
 *
 * The commit reads the list it replaces, so a concurrent change to the list
 * makes it conflict. Nothing runs it again: the handler's writes have
 * committed, and the event is spent. Leaving again repairs it.
 *
 * @throws Error when the list has a `"*"` entry, when the leave would leave the
 *   list with no concrete `OWNER`, or when the commit fails.
 */
export async function commitSpaceLeave(
  runtime: Runtime,
  space: MemorySpace,
  leave: SpaceLeave,
): Promise<void> {
  await catchUpWithAcl(runtime, space);
  const tx = runtime.edit();
  tx.tx.immediate = true;
  try {
    const next = applyLeave(space, readAcl(tx, space), leave);
    if (next === undefined) {
      tx.abort();
      return;
    }
    writeAcl(tx, space, () => next);
  } catch (error) {
    tx.abort(error);
    throw error;
  }
  runtime.prepareTxForCommit(tx);
  const { error } = await tx.commit();
  if (error !== undefined) {
    throw new Error(
      `Leaving ${space} did not commit: ${error.message}`,
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
 * Checked here, whatever the access list holds: what {@link handlerCall}
 * checks, that the event is a trusted gesture, and that `principal` is a DID
 * other than `"*"`, the space's own and the actor's. When this runtime already
 * holds the list, the actor's `OWNER` and the survival of a concrete `OWNER`
 * are checked here as well, so a refusal throws from the call;
 * {@link commitSpaceAccessChanges} checks both again against the list it
 * replaces. A refusal throws before anything is staged, so a handler that
 * catches it has staged nothing for that call. Whether a change leaves the
 * list as it is is not decided here, since the list this runtime holds may be
 * stale; the commit decides it.
 *
 * A service DID or a delegating DID as `principal` is not refused: the memory
 * server's configuration names those, and nothing hands them to a runtime.
 */
function stageChange(
  call: string,
  target: unknown,
  principal: unknown,
  level: SpaceGrantLevel | undefined,
): void {
  const { frame, runtime, space, actor } = handlerCall(call, target, true);
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
  if (current !== undefined) applyChanges(space, current, [...staged, change]);
  (frame.pendingSpaceAccessChanges ??= new Map()).set(space, [
    ...staged,
    change,
  ]);
}

/**
 * Helper for {@link stageChange} and {@link leaveSpace}, which checks what
 * every call changing an access list requires and returns what it found:
 * that the call runs in a handler on a client runtime, for an event that is a
 * trusted gesture when `gesture` is `true`, with an actor, and that `target`
 * is a cell in a space other than the actor's Home space, whose DID is the
 * actor's own. `call` names the call, for errors.
 *
 * Refusing the actor's Home space keeps one click from exposing everything a
 * user keeps there, and keeps a user from leaving their own Home. Every other
 * space the actor holds `OWNER` in stays reachable, with the trusted gesture
 * as the only bar between a pattern and its list.
 *
 * @throws Error on every refusal.
 */
function handlerCall(
  call: string,
  target: unknown,
  gesture = false,
): {
  frame: Frame;
  runtime: Runtime;
  tx: IExtendedStorageTransaction;
  space: MemorySpace;
  actor: DID;
} {
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
      `\`${call}\` is not available on a serving runtime, where the memory ` +
        "server cannot yet check the event's actor against the space's " +
        "access list.",
    );
  }
  if (gesture && frame.trustedGesture !== true) {
    throw new Error(
      `\`${call}\` requires the handler's event to be a trusted gesture.`,
    );
  }
  const space = spaceOfTarget(target, call);
  const actor = runtime.actingPrincipalFor(tx);
  if (actor === undefined) {
    throw new Error(`\`${call}\` requires an event with an actor.`);
  }
  if (space === actor) {
    throw new Error(
      `\`${call}\` cannot change the access list of the Home space of the ` +
        "principal it acts for.",
    );
  }
  return { frame, runtime, tx, space, actor };
}

/**
 * Helper for {@link leaveSpace}, which returns the successors `options`
 * names, or none when it names none. `call` names the call, for errors.
 *
 * @throws Error when `options` is neither `undefined` nor an object, when its
 *   `successors` is neither `undefined` nor an array of DIDs, or when a
 *   successor is the space's own DID or `actor`.
 */
function successorsOf(
  call: string,
  options: unknown,
  space: MemorySpace,
  actor: DID,
): readonly DID[] {
  if (options === undefined) return [];
  if (!isObjectNotArray(options)) {
    throw new Error(
      `\`${call}\` takes an object as its options; ` +
        debugStr`got $quote${options}.`,
    );
  }
  const successors = options.successors;
  if (successors === undefined) return [];
  if (!Array.isArray(successors)) {
    throw new Error(
      `\`${call}\` takes its successors as an array of DIDs; ` +
        debugStr`got $quote${successors}.`,
    );
  }
  for (const successor of successors) {
    if (!isWellFormedDID(successor)) {
      throw new Error(
        `\`${call}\` takes its successors as DIDs, never \`*\`; ` +
          debugStr`got $quote${successor}.`,
      );
    }
    if (successor === space || successor === actor) {
      throw new Error(
        `\`${call}\` cannot name the space's own DID, or the principal it ` +
          "acts for, as a successor.",
      );
    }
  }
  return [...successors];
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
 * Helper for {@link leaveSpace} and {@link commitSpaceLeave}, which returns
 * `current`, the access list of `space`, less the entry of `leave`'s actor,
 * with the first of its successors holding an entry made `OWNER` when that
 * actor was the last concrete `OWNER`. Returns `undefined` when there is
 * nothing to leave: `current` is `null`, which is how a space with no list
 * reads, or holds no entry for the actor.
 *
 * @throws Error when `current` has a `"*"` entry, which would go on granting
 *   the actor access, or when the actor is the last concrete `OWNER` and no
 *   successor holds an entry.
 */
function applyLeave(
  space: MemorySpace,
  current: ACL | null,
  { actor, successors }: SpaceLeave,
): ACL | undefined {
  if (current === null) return undefined;
  if (current[ANYONE_USER] !== undefined) {
    throw new Error(
      `Leaving ${space} is refused: its access list has a \`"*"\` entry, ` +
        `which would go on granting ${actor} access.`,
    );
  }
  if (current[actor] === undefined) return undefined;
  const { [actor]: _removed, ...rest } = current;
  if (hasConcreteOwner(rest)) return rest;
  const successor = successors.find((principal) =>
    rest[principal] !== undefined
  );
  if (successor === undefined) {
    throw new Error(
      `Leaving ${space} would leave its access list with no concrete ` +
        "`OWNER`, and no successor named holds an entry there.",
    );
  }
  return { ...rest, [successor]: "OWNER" };
}

/**
 * Helper for {@link stageChange} and {@link leaveSpace}, which returns the
 * access list of `space` as this runtime holds it, or `undefined` when it
 * holds none. The read is outside the handler's transaction, so that
 * committing the change does not make the handler's own commit conflict with
 * it.
 */
function knownAcl(runtime: Runtime, space: MemorySpace): ACL | undefined {
  const tx = runtime.edit();
  try {
    return readAcl(tx, space) ?? undefined;
  } finally {
    tx.abort();
  }
}

/**
 * Returns the access list of `space` as `tx` reads it, or `null` when the
 * space has none.
 */
function readAcl(tx: IExtendedStorageTransaction, space: MemorySpace) {
  const envelope = tx.readOrThrow({
    ...aclLink(space),
    type: "application/json",
  }) as { readonly value?: unknown } | undefined;
  return validateStoredAcl(envelope?.value);
}

/**
 * Loads the access list of `space` into `runtime` and catches up with the
 * memory server, so that a change is decided against the server's list as of
 * then. Loading the list alone can leave a replica that already holds it
 * behind the memory server; the round trip after it returns once every update
 * the server had sent is applied.
 */
async function catchUpWithAcl(
  runtime: Runtime,
  space: MemorySpace,
): Promise<void> {
  await runtime.getCellFromLink(aclLink(space)).sync();
  await runtime.storageManager.open(space).pullToServerHead?.();
}

/** Returns the link to the access-list document of `space`. */
function aclLink(
  space: MemorySpace,
): { space: MemorySpace; id: URI; path: [] } {
  return { space, id: aclDocId(space) as URI, path: [] };
}
