/**
 * `noticeSpaceAccess()`, the handler call that tells a member of a space about
 * a cell there, by a message to the member's DID inbox sent once the handler's
 * commit is accepted. `docs/features/space-access-notices.md` describes the
 * whole arrangement.
 */

import { debugStr, hashStringOf } from "@commonfabric/data-model";
import { isWellFormedDID } from "@commonfabric/identity/did";
import type { ACL } from "@commonfabric/memory/acl";
import type { DID, MemorySpace, URI } from "@commonfabric/memory/interface";

import { spaceReaderRole } from "../cfc/space-membership.ts";
import { InboxClient } from "../inbox.ts";
import type { Runtime } from "../runtime.ts";
import { eventKey } from "./event-key.ts";
import { linkOfTarget } from "./space-access.ts";
import { catchUpAcl, handlerFrame, knownAcl } from "./space-access-change.ts";

/** The `type` of the payload a space-access notice carries. */
export const SPACE_ACCESS_NOTICE_TYPE = "space-access-notice";

/**
 * The payload of a space-access notice, as its recipient's inbox holds it. It
 * names a document and the space it is in, and nothing else. The recipient
 * trusts none of it: the inbox verifies only who sent it.
 */
export type SpaceAccessNotice = {
  /** Always {@link SPACE_ACCESS_NOTICE_TYPE}. */
  readonly type: typeof SPACE_ACCESS_NOTICE_TYPE;

  /** The version of this shape. */
  readonly v: 1;

  /** The space the entry is in. */
  readonly space: MemorySpace;

  /** The id of the document the notice points at, in `space`. */
  readonly entry: URI;
};

/**
 * Tells `principal`, a member of the space `entry`'s value lives in, about
 * `entry`: once the running handler's commit is accepted, sends a
 * {@link SpaceAccessNotice} naming the space and `entry`'s document to
 * `principal`'s DID inbox, at the host this runtime's `apiUrl` names, signed as
 * the event's actor. On a client runtime the actor is the runtime's own
 * identity, which is the identity that signs.
 *
 * The actor must hold `OWNER` in the space, and `principal` must have an entry
 * of its own in the space's access list: an entry for `"*"` does not count.
 * Both are checked just before the notice is sent, against the list caught up
 * with the memory server, after any change the handler made to it has
 * committed. A notice is best-effort, so neither is checked at the call, where
 * the list this runtime holds may be behind the server's and a refusal would
 * cost the handler its whole transaction. A refusal at the send, like any
 * failure to send, is logged and nothing retries it, so a notice may not
 * arrive.
 *
 * Notices are idempotent per event: the inbox operation id is derived from
 * `eventKey()`, `principal` and the payload, so a run of the same event again
 * sends a message the inbox already holds, and the inbox keeps the first.
 *
 * @throws Error when called anywhere but in a handler, on a serving runtime,
 *   for a `principal` that is not a DID in DID Core syntax (`"*"` among them),
 *   and for an `entry` that is not a cell at the root of a document in the
 *   space's own scope.
 */
export function noticeSpaceAccess(principal: unknown, entry: unknown): void {
  const call = "noticeSpaceAccess()";
  const { runtime, tx } = handlerFrame(call);
  if (runtime.servingPosture) {
    throw new Error(
      `\`${call}\` is not available on a serving runtime, which cannot sign ` +
        "a request as the event's actor.",
    );
  }
  const key = eventKey();
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
  const link = linkOfTarget(entry, call);
  if (link.scope !== "space" || link.path.length > 0) {
    throw new Error(
      `\`${call}\` takes as its entry a cell at the root of a document in ` +
        "the space's own scope.",
    );
  }
  const space = link.space;

  const payload: SpaceAccessNotice = {
    type: SPACE_ACCESS_NOTICE_TYPE,
    v: 1,
    space,
    entry: link.id,
  };
  const operationId = `notice-${
    hashStringOf({ eventKey: key, principal, payload })
  }`;
  tx.enqueuePostCommitEffect({
    id: `noticeSpaceAccess:${operationId}`,
    kind: "noticeSpaceAccess",
    flush: () => sendNotice(runtime, actor, principal, operationId, payload),
  });
}

/**
 * Helper for {@link noticeSpaceAccess}, which checks, against the access list
 * of `space` caught up with the memory server, that the notice may be sent,
 * and sends it. Runs after the handler's commit is accepted, and so after any
 * access-list change the handler made has committed: the list it reads holds
 * those changes.
 *
 * @throws Error on a refusal, and on any failure to send.
 */
async function sendNotice(
  runtime: Runtime,
  actor: DID,
  principal: DID,
  operationId: string,
  payload: SpaceAccessNotice,
): Promise<void> {
  await catchUpAcl(runtime, payload.space);
  checkNotice(
    payload.space,
    knownAcl(runtime, payload.space) ?? null,
    actor,
    principal,
  );
  const client = new InboxClient({
    host: runtime.apiUrl.toString(),
    signer: runtime.storageManager.as,
    fetch: (input, init) => runtime.fetch(input, init),
  });
  await client.send({ recipientDid: principal, operationId, payload });
}

/**
 * Helper for {@link sendNotice}, which checks
 * that `actor` holds `OWNER` in `acl`, the access list of `space` (`null` when
 * the space has none), and that `principal` has an entry of its own there.
 *
 * @throws Error when either does not hold.
 */
function checkNotice(
  space: MemorySpace,
  acl: ACL | null,
  actor: DID,
  principal: DID,
): void {
  if (acl === null || spaceReaderRole(acl, actor) !== "owner") {
    throw new Error(
      `Telling a member of ${space} about it requires \`OWNER\` there, which ` +
        `${actor} does not hold.`,
    );
  }
  if (!Object.hasOwn(acl, principal)) {
    throw new Error(
      `${principal} has no entry of its own in the access list of ${space}, ` +
        "so it cannot be told about the space.",
    );
  }
}
