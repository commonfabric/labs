/**
 * How a FabriChat manager's readers of its rooms' rosters, which its people
 * are drawn from, follow the rooms it lists: each reader stays with its room,
 * so a room listed, forgotten, or listed again starts or stops its own reader
 * and leaves every other reader as it was.
 */

import { expect } from "@std/expect";
import { fromFileUrl } from "@std/path";

import { createSession, Identity } from "@commonfabric/identity";
import { type Cell, Runtime } from "@commonfabric/runner";
import {
  markRendererTrustedEvent,
  reviewedActionProvenance,
} from "@commonfabric/runner/cfc";
import { PatternsRoute } from "@commonfabric/runner/patterns-route.deno";
import {
  EmulatedStorageManager,
  newLoopbackServer,
} from "@commonfabric/runner/storage/cache.deno";
import {
  afterAll,
  beforeAll,
  describe,
  it,
} from "@commonfabric/test-support/test";
import { PiecesController } from "../src/ops/pieces-controller.ts";

const owner = await Identity.fromPassphrase("FabriChat room rosters owner");
const member = await Identity.fromPassphrase("FabriChat room rosters member");

const PATTERNS = fromFileUrl(new URL("../../../patterns/", import.meta.url));

/** How many group rooms the owner lists before adding one more. */
const LISTED = 3;

/** What a request's outcome holds, as far as these tests read it. */
const outcomeSchema = {
  type: "object",
  properties: {
    entry: {
      type: "object",
      properties: { room: { asCell: ["cell"] } },
    },
  },
} as const;

/** What the tests read of the manager's rooms: each one's link and revision. */
const roomsSchema = {
  type: "array",
  items: {
    type: "object",
    properties: {
      room: { type: "unknown", asCell: ["cell"] },
      revision: { type: "string" },
    },
  },
} as const;

/** What the tests read of the manager's people: who they are. */
const peopleSchema = {
  type: "object",
  additionalProperties: {
    type: "array",
    items: { type: "unknown", asCell: ["cell"] },
  },
} as const;

/** `event` as the renderer delivers a click on `surface`'s `action`. */
const trusted = (
  event: Record<string, unknown>,
  surface: string,
  action: string,
): Record<string, unknown> => {
  const click = {
    type: "click",
    ...event,
    provenance: reviewedActionProvenance("dom", { surface, action }),
  };
  markRendererTrustedEvent(click);
  return click;
};

/** Sends `event` to `piece`'s `stream`, and waits for what it does. */
const send = async (
  runtime: Runtime,
  piece: Cell<unknown>,
  stream: readonly string[],
  event: unknown,
): Promise<void> => {
  const tx = runtime.edit();
  let target: Cell<unknown> = piece.withTx(tx);
  for (const key of stream) target = target.key(key);
  target.send(event);
  runtime.prepareTxForCommit(tx);
  expect((await tx.commit().settled).error).toBeUndefined();
  await runtime.idle();
};

/** A runtime of `identity`'s on `server`, with its Home brought up. */
const homeOf = async (
  server: ReturnType<typeof newLoopbackServer>,
  apiUrl: URL,
  identity: Identity,
) => {
  const storage = EmulatedStorageManager.connectTo(server, { as: identity });
  const runtime = new Runtime({ apiUrl, storageManager: storage });
  const home = (await new PiecesController(
    createSession({ identity, spaceDid: identity.did() }),
    runtime,
  ).ensureDefaultPattern()).getCell();
  await runtime.idle();
  await home.pull();
  return { storage, runtime, home };
};

describe("fabrichat-room-rosters", () => {
  let server: ReturnType<typeof newLoopbackServer>;
  let http: Deno.HttpServer<Deno.NetAddr>;
  let owners: Awaited<ReturnType<typeof homeOf>>;
  let members: Awaited<ReturnType<typeof homeOf>>;
  let profile: Cell<unknown>;
  let cancelPeople: () => void;
  const rooms: Cell<unknown>[] = [];
  /** A room the catalog lists from before the others, with no membership. */
  let unadopted: Cell<unknown>;

  /** Creates a group naming the member by profile, and returns its room. */
  const createGroup = async (requestId: string): Promise<Cell<unknown>> => {
    await send(
      owners.runtime,
      owners.home,
      ["chatManager", "createGroup"],
      trusted(
        { requestId, title: requestId, members: [], profiles: [profile] },
        "ChatStartSurface",
        "ChatStart",
      ),
    );
    const outcome = await owners.home.key("chatManager").key("requests")
      .key(requestId).asSchema(outcomeSchema).pull() as {
        entry?: { room?: Cell<unknown> };
      };
    return outcome.entry!.room!;
  };

  /**
   * How many times each of the owner's readers of a room's roster has run,
   * by the room it reads, as the scheduler records each action's reads.
   */
  const readerRuns = (): Map<string, number> => {
    const runs = new Map<string, number>();
    for (const node of owners.runtime.scheduler.getGraphSnapshot().nodes) {
      const room = [...rooms, unadopted].find((each) =>
        (node.reads ?? []).some((read) =>
          read.startsWith(`${each.space}/`) && read.includes("/roster")
        )
      );
      if (room === undefined) continue;
      runs.set(
        room.space,
        (runs.get(room.space) ?? 0) + (node.stats?.runCount ?? 0),
      );
    }
    return runs;
  };

  beforeAll(async () => {
    server = newLoopbackServer();
    const route = new PatternsRoute(PATTERNS);
    http = Deno.serve(
      { hostname: "127.0.0.1", port: 0, onListen() {} },
      async (request) =>
        await route.serve(request) ??
          new Response("Not found", { status: 404 }),
    );
    const apiUrl = new URL(`http://127.0.0.1:${http.addr.port}`);
    owners = await homeOf(server, apiUrl, owner);
    members = await homeOf(server, apiUrl, member);
    for (
      const [{ runtime, home }, name] of [
        [owners, "Rosters owner"],
        [members, "Rosters member"],
      ] as const
    ) {
      await send(
        runtime,
        home,
        ["createProfile"],
        trusted(
          { target: { value: name } },
          "ProfileCreateSurface",
          "CreateProfile",
        ),
      );
    }
    await members.storage.synced();
    profile = owners.runtime.getCellFromLink(
      members.home.key("profiles").key(0).resolveAsCell()
        .getAsNormalizedFullLink(),
    );
    // Something reading the people, once the session has asked for them, is
    // what runs the readers.
    await send(
      owners.runtime,
      owners.home,
      ["chatManager", "askForPeople"],
      {},
    );
    cancelPeople = owners.home.key("chatManager").key("people").asSchema(
      peopleSchema,
    ).sink(() => {});
    // The first room's membership is dropped, so that the catalog lists it,
    // from before the others, with no membership, as a catalog kept before
    // the manager recorded memberships does; adopting it lists it again,
    // keeping the time its catalog entry lists it from.
    unadopted = await createGroup("g-unadopted");
    for (let i = 0; i < LISTED; i++) rooms.push(await createGroup(`g-${i}`));
    {
      const stored = owners.home.key("chatManager").key("roomMembership")
        .resolveAsCell();
      const values = await stored.asSchema(
        {
          type: "array",
          items: {
            type: "object",
            properties: { room: { type: "unknown", asCell: ["cell"] } },
          },
        } as const,
      ).pull() as { room?: Cell<unknown> }[];
      const index = values.findIndex((each) =>
        each.room?.space === unadopted.space
      );
      const raw = stored.getRaw() as unknown[];
      const tx = owners.runtime.edit();
      stored.withTx(tx).setRaw(raw.filter((_, at) => at !== index) as never);
      expect((await tx.commit().settled).error).toBeUndefined();
    }
    await owners.runtime.idle();
  });

  afterAll(async () => {
    cancelPeople?.();
    for (const side of [members, owners]) {
      await side?.runtime.dispose();
      await side?.storage.close();
    }
    await server?.close();
    await http?.shutdown();
  });

  it("runs only the newly listed room's reader when another room is listed", async () => {
    const before = readerRuns();
    for (const room of rooms) expect(before.get(room.space)).toBeGreaterThan(0);

    rooms.push(await createGroup("g-added"));
    await owners.runtime.idle();

    const after = readerRuns();
    const added = rooms[rooms.length - 1].space;
    expect(after.get(added)).toBeGreaterThan(0);
    for (const [space, runs] of before) expect(after.get(space)).toBe(runs);
  });

  it("runs only an adopted room's reader when a room listed from before the others is adopted", async () => {
    // The room's reader from before its membership was dropped keeps the
    // runs it made; what adopting it adds is what counts.
    const before = readerRuns();

    await send(owners.runtime, owners.home, ["chatManager", "joinRoom"], {
      requestId: "adopt-unadopted",
      room: owners.runtime.getCellFromLink(
        unadopted.getAsNormalizedFullLink(),
      ),
    });
    await owners.runtime.idle();

    const after = readerRuns();
    expect(after.get(unadopted.space)).toBeGreaterThan(
      before.get(unadopted.space) ?? 0,
    );
    for (const [space, runs] of before) {
      if (space !== unadopted.space) expect(after.get(space)).toBe(runs);
    }
  });

  it("runs no other room's reader when a room is forgotten, or listed again", async () => {
    const forgotten = rooms[1];
    const room = () =>
      owners.runtime.getCellFromLink(forgotten.getAsNormalizedFullLink());
    const listed = async () =>
      await owners.home.key("chatManager").key("rooms").asSchema(roomsSchema)
        .pull() as { room?: Cell<unknown>; revision?: string }[];
    const revision = (await listed()).find((each) =>
      each.room?.space === forgotten.space
    )?.revision;
    expect(revision).toBeDefined();
    const before = readerRuns();

    await send(owners.runtime, owners.home, ["chatManager", "forget"], {
      requestId: "forget-one",
      room: room(),
      revision,
    });
    expect((await listed()).map((each) => each.room?.space)).not.toContain(
      forgotten.space,
    );
    const afterForget = readerRuns();
    for (const [space, runs] of before) {
      if (space !== forgotten.space) expect(afterForget.get(space)).toBe(runs);
    }

    await send(owners.runtime, owners.home, ["chatManager", "joinRoom"], {
      requestId: "list-again",
      room: room(),
    });
    const afterListing = readerRuns();
    expect(afterListing.get(forgotten.space)).toBeGreaterThan(
      afterForget.get(forgotten.space) ?? 0,
    );
    for (const [space, runs] of afterForget) {
      if (space !== forgotten.space) expect(afterListing.get(space)).toBe(runs);
    }
  });

  it("lists a person's profiles newest room first", async () => {
    await send(
      members.runtime,
      members.home,
      ["createProfile"],
      trusted(
        { target: { value: "Rosters member, again" } },
        "ProfileCreateSurface",
        "CreateProfile",
      ),
    );
    await members.storage.synced();
    const second = owners.runtime.getCellFromLink(
      members.home.key("profiles").key(1).resolveAsCell()
        .getAsNormalizedFullLink(),
    );
    const requestId = "g-second-profile";
    await send(
      owners.runtime,
      owners.home,
      ["chatManager", "createGroup"],
      trusted(
        { requestId, title: requestId, members: [], profiles: [second] },
        "ChatStartSurface",
        "ChatStart",
      ),
    );
    await owners.runtime.idle();

    const people = await owners.home.key("chatManager").key("people")
      .asSchema(peopleSchema).pull() as Record<string, Cell<unknown>[]>;
    const ids = (people[member.did()] ?? []).map((each) =>
      each.getAsNormalizedFullLink().id
    );
    expect(ids).toEqual([
      second.getAsNormalizedFullLink().id,
      profile.getAsNormalizedFullLink().id,
    ]);
  });

  it("lists the member among the people, drawn from every listed room", async () => {
    const people = await owners.home.key("chatManager").key("people")
      .asSchema(peopleSchema).pull() as Record<string, unknown[]>;

    expect(Object.keys(people)).toEqual([member.did()]);
  });
});
