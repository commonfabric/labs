/**
 * Adopting the FabriChat rooms Home's shared-space catalog lists without a
 * membership in Home's chat manager, as a catalog kept before the manager
 * recorded memberships, or holding a container nobody has joined the chat
 * of, lists them. The manager lists a room by its membership alone, which
 * reads no room, so the host records each such membership once, a few rooms
 * at a time, by the `joinRoom` a visit to the room sends. The manager's
 * handling of that join adds the user to the room's roster, which starts the
 * room's piece on this runtime; adopting stops each piece its joins started,
 * once they have been handled. Once every room the catalog lists is adopted,
 * adopting reads nothing in any room's space.
 */

import type { JSONSchema } from "@commonfabric/api";
import type { DID } from "@commonfabric/identity";
import {
  type Cell,
  type Runtime,
  sendEvent,
  transactionFailureMessage,
} from "@commonfabric/runner";
import { getLogger } from "@commonfabric/logger";
import { isObjectNotArray } from "@commonfabric/js-values/types";
import { visitedRoomOf } from "./join-visited-room.ts";

const logger = getLogger("piece.adopt-catalog-rooms");

/**
 * How many rooms one pass adopts before it stops the pieces it started and
 * releases what it read.
 */
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
 * of it has committed, with the space of the room it named, if it named one.
 * A space that declares no room, or that vetting refuses, is sent a
 * `joinRoom` naming no room, which the manager refuses, reading nothing, and
 * records under that id, so that the entry is not tried again until it
 * changes; a visit to it still joins it.
 */
async function adopt(
  runtime: Runtime,
  joinRoom: Cell<unknown>,
  identity: DID,
  entry: Unadopted,
): Promise<string | undefined> {
  const visited = await visitedRoomOf(runtime, identity, entry.space);
  const event = "room" in visited
    ? { requestId: entry.requestId, ...visited }
    : { requestId: entry.requestId };
  await new Promise<void>((resolve, reject) =>
    sendEvent(joinRoom, event, (tx) => {
      const status = tx.status();
      if (status.status === "error") {
        reject(new Error(transactionFailureMessage(status.error)));
      } else resolve();
    })
  );
  return "room" in visited ? visited.room.space : undefined;
}

/**
 * Stops each piece in one of `spaces` whose registration an event's delivery
 * installed after `mark`, a value of `Runner.eventStartMark`, and that
 * nothing else has asked for since, as `Runner.releaseEventStart()` does,
 * and returns how many it stopped. The pieces a batch's joins start are the
 * rooms they join, and the pieces in the same space the rooms' inputs come
 * from; the scheduler is idle by then, so the joins have been handled.
 */
function stopStartedPieces(
  runtime: Runtime,
  mark: number,
  spaces: ReadonlySet<string>,
): number {
  let stopped = 0;
  for (const link of runtime.runner.eventStartsSince(mark)) {
    if (!spaces.has(link.space)) continue;
    if (runtime.runner.releaseEventStart(runtime.getCellFromLink(link))) {
      stopped++;
    }
  }
  return stopped;
}

/**
 * Has the chat manager of `home`, the Home of `identity`, record a membership
 * of each room its catalog lists saved with none, so that the manager lists
 * it, as a visit to the room would. It adopts `ADOPTION_BATCH_SIZE` entries at
 * a time. Once the scheduler is idle after a batch, it stops each piece an
 * event's delivery started during the batch in the space of a room the batch
 * joined, which is where its joins start the rooms' pieces, and asks the runtime to release the documents nothing reads, so
 * what it holds at once is bounded by the batch rather than by the catalog.
 * A piece that was running before the batch, or that something other than an
 * event's delivery has started or taken as a child since, keeps running. An
 * entry is adopted once for each revision of it: its outcome, a membership or
 * a refusal, is recorded under its adoption request id.
 *
 * Resolves once every saved entry has been tried, or once `signal` aborts
 * or the runtime begins disposal, after the batch under way, with how many
 * pieces it stopped. An entry whose vetting or handling fails, other than by
 * a refusal, is logged and tried again by a later adoption, and holds back no
 * other entry. Does nothing for a Home whose chat manager has no `joinRoom`.
 *
 * @throws When reading Home's records fails.
 */
export async function adoptCatalogRoomsOf(
  runtime: Runtime,
  home: Cell<unknown>,
  identity: DID,
  signal?: AbortSignal,
): Promise<number> {
  const joinRoom = home.key("chatManager").key("joinRoom");
  if (joinRoom.getRaw() === undefined) return 0;
  const tried = new Set<string>();
  let stopped = 0;
  while (!signal?.aborted && !runtime.writeTeardownSignal.aborted) {
    const batch = (await unadoptedEntries(home))
      .filter((entry) => !tried.has(entry.requestId))
      .slice(0, ADOPTION_BATCH_SIZE);
    if (batch.length === 0) break;
    const mark = runtime.runner.eventStartMark;
    const spaces = new Set<string>();
    for (const entry of batch) {
      tried.add(entry.requestId);
      try {
        const room = await adopt(runtime, joinRoom, identity, entry);
        if (room !== undefined) spaces.add(room);
      } catch (error) {
        // One entry that can't be adopted holds back no other; this one is
        // tried again by a later adoption.
        logger.warn("adoption-failed", () => [
          `Adopting the catalog's entry for ${entry.space}:`,
          error,
        ]);
      }
    }
    await runtime.idle();
    stopped += stopStartedPieces(runtime, mark, spaces);
    await runtime.releaseUnreadDocuments();
  }
  return stopped;
}
