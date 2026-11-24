import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { createSession, Identity } from "@commonfabric/identity";
import { getLogger } from "@commonfabric/logger";
import { type Cell, Runtime, type RuntimeProgram } from "@commonfabric/runner";
import { StorageManager } from "@commonfabric/runner/storage/cache.deno";
import {
  adoptCatalogRoomsOf,
  ADOPTION_BATCH_SIZE,
  adoptionRequestId,
} from "../../src/ops/adopt-catalog-rooms.ts";
import { PiecesController } from "../../src/ops/pieces-controller.ts";
import { installCustomRoot } from "../install-custom-root.ts";

const identity = await Identity.fromPassphrase("adopt catalog rooms owner");
const logger = getLogger("piece.adopt-catalog-rooms");

const NAMES = [
  ...Array.from({ length: ADOPTION_BATCH_SIZE + 2 }, (_, i) => `room-${i}`),
  "deleted",
  "decided",
  "new",
  "failing",
  "fine",
  "room",
  "member",
  "contained",
];
const SPACES = new Map(
  await Promise.all(
    NAMES.map(async (name) =>
      [name, (await Identity.fromPassphrase(`adopt ${name}`)).did()] as const
    ),
  ),
);

/** A space the catalog lists, which declares no room on this host. */
const spaceOf = (name: string) => SPACES.get(name)!;

/**
 * A Home reduced to its chat manager: the catalog it is seeded with, an empty
 * membership list, and a `joinRoom` that records each request's outcome under
 * its id, as the real manager does, and throws for the revision `broken`.
 */
function homeProgram(
  entries: Record<string, { state: string; revision: string }>,
  outcomes: Record<string, { status: string }> = {},
  { withJoinRoom = true }: { withJoinRoom?: boolean } = {},
): RuntimeProgram {
  return {
    main: "/home.tsx",
    files: [{
      name: "/home.tsx",
      contents: `
import { type Cell, handler, pattern, Writable } from "commonfabric";
type Outcome = { status: string };
const joinRoom = handler<
  { requestId?: string; room?: Cell<unknown> },
  { requests: Writable<Record<string, Outcome>>; sent: Writable<string[]> }
>((event, { requests, sent }) => {
  const requestId = event.requestId ?? "";
  if (requestId.includes('"broken"')) throw new Error("join refused");
  requests.key(requestId).set({
    status: event.room === undefined ? "refused" : "joined",
  });
  sent.push(requestId);
});
export default pattern(() => {
  const sharedSpaceCatalog = new Writable(${
        JSON.stringify({
          entries: Object.fromEntries(
            Object.entries(entries).map((
              [space, entry],
            ) => [space, { space, ...entry }]),
          ),
        })
      }).for("sharedSpaceCatalog");
  const roomMembership = new Writable<unknown[]>([]).for("roomMembership");
  const requests = new Writable<Record<string, Outcome>>(${
        JSON.stringify(outcomes)
      }).for("requests");
  const sent = new Writable<string[]>([]).for("sent");
  return {
    sent,
    chatManager: {
      sharedSpaceCatalog,
      roomMembership,
      requests,
      ${withJoinRoom ? "joinRoom: joinRoom({ requests, sent })," : ""}
    },
  };
});`,
    }],
  };
}

describe("adopt-catalog-rooms", () => {
  let storage: ReturnType<typeof StorageManager.emulate>;
  let runtime: Runtime;
  let controller: PiecesController;

  beforeEach(async () => {
    storage = StorageManager.emulate({ as: identity });
    runtime = new Runtime({
      apiUrl: new URL("https://home.example"),
      storageManager: storage,
      experimental: { serverExecution: false },
    });
    controller = new PiecesController(
      createSession({ identity, spaceDid: identity.did() }),
      runtime,
    );
    await controller.synced();
  });

  afterEach(async () => {
    await runtime.dispose();
    await storage.close();
  });

  /** The request ids `home`'s `joinRoom` was sent and handled, sorted. */
  const sent = async (home: Cell<unknown>): Promise<string[]> => {
    await runtime.idle();
    const ids = await home.key("sent").asSchema(
      { type: "array", items: { type: "string" } } as const,
    ).pull();
    return [...(ids ?? [])].sort();
  };

  const saved = (revision: string) => ({ state: "saved", revision });

  /** How many adoptions have failed in this process, as logged. */
  const failures = () => logger.countsByKey["adoption-failed"]?.warn ?? 0;

  describe("adoptCatalogRoomsOf()", () => {
    it("sends one adoption for each saved entry, across batches, under the entry's revision", async () => {
      const names = Array.from(
        { length: ADOPTION_BATCH_SIZE + 2 },
        (_, i) => `room-${i}`,
      );
      const home = await installCustomRoot(
        runtime,
        controller,
        homeProgram(
          Object.fromEntries(names.map((name) => [spaceOf(name), saved("1")])),
        ),
      );

      await adoptCatalogRoomsOf(runtime, home, identity.did());

      expect(await sent(home)).toEqual(
        names.map((name) => adoptionRequestId(spaceOf(name), "1")).sort(),
      );
    });

    it("sends nothing for an entry that is not saved, or whose adoption has an outcome", async () => {
      const home = await installCustomRoot(
        runtime,
        controller,
        homeProgram(
          {
            [spaceOf("deleted")]: { state: "deleted", revision: "1" },
            [spaceOf("decided")]: saved("1"),
            [spaceOf("new")]: saved("2"),
          },
          {
            [adoptionRequestId(spaceOf("decided"), "1")]: {
              status: "refused",
            },
          },
        ),
      );

      await adoptCatalogRoomsOf(runtime, home, identity.did());

      expect(await sent(home)).toEqual([
        adoptionRequestId(spaceOf("new"), "2"),
      ]);
    });

    it("sends nothing for an entry whose space a membership's room or container is in", async () => {
      const home = await installCustomRoot(
        runtime,
        controller,
        homeProgram({
          [spaceOf("member")]: saved("1"),
          [spaceOf("contained")]: saved("1"),
          [spaceOf("new")]: saved("1"),
        }),
      );
      const { error } = await runtime.editWithRetry((tx) => {
        home.key("chatManager").key("roomMembership").withTx(tx).set([
          { room: runtime.getCell(spaceOf("member"), "room") },
          {
            room: runtime.getCell(identity.did(), "elsewhere"),
            container: runtime.getCell(spaceOf("contained"), "root"),
          },
        ]);
      });
      expect(error).toBeUndefined();

      await adoptCatalogRoomsOf(runtime, home, identity.did());

      expect(await sent(home)).toEqual([
        adoptionRequestId(spaceOf("new"), "1"),
      ]);
    });

    it("goes on past an entry whose handling fails, which stays unadopted", async () => {
      const home = await installCustomRoot(
        runtime,
        controller,
        homeProgram({
          [spaceOf("failing")]: saved("broken"),
          [spaceOf("fine")]: saved("1"),
        }),
      );
      const failedBefore = failures();

      await adoptCatalogRoomsOf(runtime, home, identity.did());

      expect(await sent(home)).toEqual([
        adoptionRequestId(spaceOf("fine"), "1"),
      ]);
      expect(failures()).toBe(failedBefore + 1);
      const outcome = await home.key("chatManager").key("requests").key(
        adoptionRequestId(spaceOf("failing"), "broken"),
      ).pull();
      expect(outcome).toBeUndefined();
    });

    it("sends nothing once its signal has aborted", async () => {
      const home = await installCustomRoot(
        runtime,
        controller,
        homeProgram({ [spaceOf("room")]: saved("1") }),
      );
      const stopped = new AbortController();
      stopped.abort();

      await adoptCatalogRoomsOf(runtime, home, identity.did(), stopped.signal);

      expect(await sent(home)).toEqual([]);
    });

    it("does nothing for a Home whose chat manager has no `joinRoom`", async () => {
      // An entry it tried would be sent to a `joinRoom` that is no stream,
      // which fails, and that failure is logged.

      const home = await installCustomRoot(
        runtime,
        controller,
        homeProgram({ [spaceOf("room")]: saved("1") }, {}, {
          withJoinRoom: false,
        }),
      );
      const failedBefore = failures();

      await adoptCatalogRoomsOf(runtime, home, identity.did());

      expect(failures()).toBe(failedBefore);
    });
  });

  describe("PiecesController.adoptCatalogRooms()", () => {
    it("adopts through the Home the identity has", async () => {
      const home = await installCustomRoot(
        runtime,
        controller,
        homeProgram({ [spaceOf("room")]: saved("1") }),
      );

      await controller.adoptCatalogRooms();

      expect(await sent(home)).toEqual([
        adoptionRequestId(spaceOf("room"), "1"),
      ]);
    });

    it("throws on a controller over a space other than the identity's Home", async () => {
      const other = new PiecesController(
        createSession({ identity, spaceDid: await runtime.createSpace() }),
        runtime,
      );

      await expect(other.adoptCatalogRooms()).rejects.toThrow(
        "Only a controller over the identity's Home space can adopt its catalog's rooms",
      );
    });
  });
});
