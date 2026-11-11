/**
 * Adopting the FabriChat rooms Home's shared-space catalog lists without a
 * membership in Home's chat manager, as a catalog kept before the manager
 * recorded memberships, or holding a container nobody has joined the chat
 * of, lists them. The manager lists a room by its membership alone, which
 * reads no room, so the host records each such membership once, a few rooms
 * at a time, by the `joinRoom` a visit to the room sends. Once every room the
 * catalog lists is adopted, adopting reads nothing in any room's space.
 */

import type { JSONSchema } from "@commonfabric/api";
import type { DID } from "@commonfabric/identity";
import {
  type Cell,
  type Runtime,
  sendEvent,
  transactionFailureMessage,
} from "@commonfabric/runner";
import { isObjectNotArray } from "@commonfabric/js-values/types";
import { visitedRoomOf } from "./join-visited-room.ts";

/** How many rooms one pass adopts before it releases what it read. */
export const ADOPTION_BATCH_SIZE = 5;

/** A link that declares nothing of what it reaches, so reading it reads none. */
const HANDLE_SCHEMA = {
  type: "unknown",
  asCell: ["cell"],
} as const satisfies JSONSchema;

/** What adopting reads of the catalog. */
const catalogSchema = {
  type: "object",
  properties: {
    entries: {
      type: "object",
      additionalProperties: {
        type: "object",
        properties: {
          space: { type: "string" },
          kind: { type: "string" },
          state: { type: "string" },
          revision: { type: "string" },
        },
      },
    },
  },
} as const satisfies JSONSchema;

/** What adopting reads of the manager's memberships. */
const membershipSchema = {
  type: "array",
  items: {
    type: "object",
    properties: { room: HANDLE_SCHEMA, container: HANDLE_SCHEMA },
  },
} as const satisfies JSONSchema;

/** What adopting reads of a request's outcome. */
const outcomeSchema = {
  type: "object",
  properties: { status: { type: "string" } },
} as const satisfies JSONSchema;

/** A saved catalog entry no membership covers. */
interface Unadopted {
  /** The space the entry lists. */
  space: DID;

  /** The request id the adoption of this entry, at its revision, is made under. */
  requestId: string;
}

/**
 * The `requestId` the adoption of the catalog's entry for `space`, at
 * `revision`, is made under, so that the manager records its outcome once for
 * each revision of the entry, and an entry whose adoption the manager
 * refused is not tried again until the entry changes.
 */
export const adoptionRequestId = (space: string, revision: string): string =>
  JSON.stringify(["adoptCatalogRoom", space, revision]);

/**
 * The saved entries of `home`'s catalog that no membership in its chat
 * manager covers, by the room's space or its container's, and whose adoption
 * at the entry's revision the manager has no outcome for.
 */
async function unadoptedEntries(home: Cell<unknown>): Promise<Unadopted[]> {
  const manager = home.key("chatManager");
  const catalog = manager.key("sharedSpaceCatalog").asSchema(catalogSchema);
  const memberships = manager.key("roomMembership").asSchema(membershipSchema);
  await Promise.all([catalog.pull(), memberships.pull()]);
  const covered = new Set<string>();
  for (const membership of memberships.get() ?? []) {
    for (const handle of [membership?.room, membership?.container]) {
      const space = (handle as Cell<unknown> | undefined)?.space;
      if (space !== undefined) covered.add(space);
    }
  }
  const entries = catalog.get()?.entries;
  if (!isObjectNotArray(entries)) return [];
  const found: Unadopted[] = [];
  for (const entry of Object.values(entries)) {
    if (
      entry?.state !== "saved" || typeof entry.space !== "string" ||
      typeof entry.revision !== "string" || covered.has(entry.space)
    ) continue;
    const requestId = adoptionRequestId(entry.space, entry.revision);
    const outcome = manager.key("requests").key(requestId).asSchema(
      outcomeSchema,
    );
    await outcome.pull();
    if (outcome.get()?.status !== undefined) continue;
    found.push({ space: entry.space as DID, requestId });
  }
  return found;
}

/**
 * Sends the manager's `joinRoom` for the room `entry`'s space declares, under
 * the entry's adoption request id, and resolves once the manager's handling
 * of it has committed. A space that declares no room has the manager refuse
 * its root, which records the refusal under that id. A space vetting refuses
 * gets nothing sent, and is tried again by a later adoption.
 */
async function adopt(
  runtime: Runtime,
  joinRoom: Cell<unknown>,
  identity: DID,
  entry: Unadopted,
): Promise<void> {
  const visited = await visitedRoomOf(runtime, identity, entry.space);
  const event = "room" in visited
    ? { requestId: entry.requestId, ...visited }
    : "root" in visited
    ? { requestId: entry.requestId, room: visited.root }
    : undefined;
  if (event === undefined) return;
  await new Promise<void>((resolve, reject) =>
    sendEvent(joinRoom, event, (tx) => {
      const status = tx.status();
      if (status.status === "error") {
        reject(new Error(transactionFailureMessage(status.error)));
      } else resolve();
    })
  );
}

/**
 * Has the chat manager of `home`, the Home of `identity`, record a membership
 * of each room its catalog lists saved with none, so that the manager lists
 * it, as a visit to the room would. It adopts `ADOPTION_BATCH_SIZE` entries at
 * a time, and asks the runtime to release the documents nothing reads after
 * each batch, so what it holds at once is bounded by the batch rather than by
 * the catalog. An entry is adopted once for each revision of it: its outcome,
 * a membership or a refusal, is recorded under its adoption request id.
 *
 * Resolves once no saved entry is left unadopted, other than those vetting
 * refuses, which a later adoption tries again, or once `signal` aborts or the
 * runtime begins disposal, after the batch under way. Does nothing for a Home
 * whose chat manager has no `joinRoom`.
 *
 * @throws When reading Home's records fails, when vetting a space fails other
 *   than by a refusal of access, or when the manager's handling of an
 *   adoption fails.
 */
export async function adoptCatalogRoomsOf(
  runtime: Runtime,
  home: Cell<unknown>,
  identity: DID,
  signal?: AbortSignal,
): Promise<void> {
  const joinRoom = home.key("chatManager").key("joinRoom");
  if (joinRoom.getRaw() === undefined) return;
  const tried = new Set<string>();
  while (!signal?.aborted && !runtime.writeTeardownSignal.aborted) {
    const batch = (await unadoptedEntries(home))
      .filter((entry) => !tried.has(entry.requestId))
      .slice(0, ADOPTION_BATCH_SIZE);
    if (batch.length === 0) return;
    for (const entry of batch) {
      tried.add(entry.requestId);
      await adopt(runtime, joinRoom, identity, entry);
    }
    await runtime.idle();
    await runtime.releaseUnreadDocuments();
  }
}
