/**
 * The real FabriChat manager, creating rooms in spaces of their own. A room is
 * created with `inSpace()`, a cross-space commit, which works in this lane and
 * not in the pattern-unit one; `packages/patterns/fabrichat/manager.test.tsx`
 * covers the manager's refusals there.
 */

import { expect } from "@std/expect";
import { fromFileUrl } from "@std/path";
import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";

import { Identity } from "@commonfabric/identity";
import * as MemoryV2Server from "@commonfabric/memory/v2/server";

import type { RuntimeProgram } from "../src/harness/types.ts";
import { Runtime } from "../src/runtime.ts";
import { EmulatedStorageManager } from "../src/storage/v2-emulate.ts";
import { newSharedServer } from "./memory-v2-test-utils.ts";

const signer = await Identity.fromPassphrase("fabrichat-manager");
const home = signer.did();

const BOB = "did:key:z6MkBob";
const CAROL = "did:key:z6MkCarol";

const fabrichatDir = fromFileUrl(
  new URL("../../patterns/fabrichat/", import.meta.url),
);
const read = (name: string) => Deno.readTextFileSync(fabrichatDir + name);

// The manager's core, given a profile of its own: `#profile` resolves nothing
// here, and a manager starts no chat without one.
const WRAPPER_SRC = [
  "import { FabriChatManagerCore } from './manager.tsx';",
  "import { pattern, Writable } from 'commonfabric';",
  "",
  "export default pattern(() => {",
  "  const profile = new Writable({ name: 'Tester' }).for('profile');",
  "  return FabriChatManagerCore({ myProfile: profile });",
  "});",
].join("\n");

const PROGRAM: RuntimeProgram = {
  main: "/main.tsx",
  files: [
    { name: "/main.tsx", contents: WRAPPER_SRC },
    ...["manager.tsx", "room.tsx", "schemas.tsx", "logic.ts"].map((name) => ({
      name: `/${name}`,
      contents: read(name),
    })),
  ],
};

const RESULT_CAUSE = "fabrichat manager";

// Reads an index entry with its room as a link, not a copy.
const entryListSchema = {
  type: "array",
  items: {
    type: "object",
    properties: {
      room: { type: "unknown", asCell: ["cell"] },
      kind: { type: "string" },
      counterpart: { type: "string" },
    },
  },
  // deno-lint-ignore no-explicit-any
} as any;

// Reads what a room says about itself, and how many messages it holds.
const roomSchema = {
  type: "object",
  properties: {
    about: {
      type: "object",
      properties: { kind: { type: "string" }, title: { type: "string" } },
    },
    messages: {
      type: "object",
      properties: { count: { type: "number" } },
    },
  },
  // deno-lint-ignore no-explicit-any
} as any;

describe("fabrichat-manager", () => {
  let server: MemoryV2Server.Server;
  let storageManager: EmulatedStorageManager;
  let runtime: Runtime;

  beforeEach(() => {
    server = newSharedServer();
    storageManager = EmulatedStorageManager.connectTo(server, { as: signer });
    runtime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager,
    });
  });

  afterEach(async () => {
    // Let the rooms the tests created finish starting before the replicas
    // close under them.
    await runtime?.idle();
    await storageManager?.synced();
    await runtime?.dispose();
    await storageManager?.close();
    await server?.close();
  });

  // Starts the manager, and returns a way to send it an event and wait for
  // the event's effect.
  const startManager = async () => {
    const tx = runtime.edit();
    const pattern = await runtime.patternManager.compilePattern(PROGRAM, {
      space: home,
      tx,
    });
    const resultCell = runtime.getCell<Record<string, unknown>>(
      home,
      RESULT_CAUSE,
      undefined,
      tx,
    );
    // deno-lint-ignore no-explicit-any
    const manager = runtime.run(tx, pattern as any, {}, resultCell);
    runtime.prepareTxForCommit(tx);
    expect((await tx.commit()).error).toBeUndefined();
    await manager.pull();
    const send = async (stream: string, event: Record<string, unknown>) => {
      const sendTx = runtime.edit();
      manager.withTx(sendTx).key(stream).send(event);
      expect((await sendTx.commit()).error).toBeUndefined();
      await runtime.idle();
      await manager.pull();
    };
    const rooms = () =>
      // deno-lint-ignore no-explicit-any
      manager.key("rooms").asSchema(entryListSchema).get() as any[];
    return { manager, send, rooms };
  };

  it("creates a direct room in a space of its own, and finds it again", async () => {
    const { manager, send, rooms } = await startManager();

    await send("openDirect", { requestId: "d-1", counterpart: BOB });
    expect(rooms().length).toBe(1);
    const room = rooms()[0].room;
    expect(room.getAsNormalizedFullLink().space).not.toBe(home);
    expect(rooms()[0].counterpart).toBe(BOB);
    // deno-lint-ignore no-explicit-any
    const notices = manager.key("outgoingNotices").get() as any[];
    expect(notices.map((notice) => notice.recipient)).toEqual([BOB]);

    // The conversation with one person is always the same room.
    await send("openDirect", { requestId: "d-2", counterpart: BOB });
    expect(rooms().length).toBe(1);

    // Forgetting it keeps it in `direct`; finding it again puts it back.
    await send("forget", { requestId: "f-1", room });
    expect(rooms().length).toBe(0);
    await send("openDirect", { requestId: "d-3", counterpart: BOB });
    expect(rooms().length).toBe(1);
    expect(rooms()[0].room.equals(room)).toBe(true);
  });

  it("creates a group room that states its title", async () => {
    const { manager, send, rooms } = await startManager();

    await send("createGroup", {
      requestId: "g-1",
      title: "Team",
      members: [CAROL, CAROL, "junk"],
    });
    expect(rooms().length).toBe(1);
    // deno-lint-ignore no-explicit-any
    const notices = manager.key("outgoingNotices").get() as any[];
    expect(notices.map((notice) => notice.recipient)).toEqual([CAROL]);

    const roomCell = runtime.getCellFromLink(
      rooms()[0].room.getAsNormalizedFullLink(),
    );
    await roomCell.sync();
    await runtime.idle();
    const room = roomCell.asSchema(roomSchema).get();
    expect(room.about).toEqual({ kind: "group", title: "Team" });
    expect(room.messages.count).toBe(0);

    // A request already decided changes nothing when it arrives again.
    await send("createGroup", { requestId: "g-1", title: "Team", members: [] });
    expect(rooms().length).toBe(1);
  });
  it("accepts a group room it was admitted to", async () => {
    const { manager, send, rooms } = await startManager();

    await send("createGroup", { requestId: "g-1", title: "Team", members: [] });
    const room = rooms()[0].room;
    await send("forget", { requestId: "f-1", room });
    expect(rooms().length).toBe(0);

    await send("accept", { requestId: "a-1", room });
    expect(rooms().length).toBe(1);
    expect(rooms()[0].kind).toBe("group");
    expect(rooms()[0].room.equals(room)).toBe(true);
    // deno-lint-ignore no-explicit-any
    const requests = manager.key("requests").get() as any;
    expect(requests["a-1"].status).toBe("done");
  });

  it("accepts a direct room only with its counterpart", async () => {
    const { manager, send, rooms } = await startManager();

    await send("openDirect", { requestId: "d-1", counterpart: BOB });
    const room = rooms()[0].room;
    await send("forget", { requestId: "f-1", room });

    await send("accept", { requestId: "a-1", room });
    // deno-lint-ignore no-explicit-any
    const refused = manager.key("requests").get() as any;
    expect(refused["a-1"].status).toBe("refused");
    expect(rooms().length).toBe(0);

    await send("accept", { requestId: "a-2", room, counterpart: BOB });
    expect(rooms().length).toBe(1);
    expect(rooms()[0].counterpart).toBe(BOB);
  });

  it("drops a notice reported delivered", async () => {
    const { manager, send } = await startManager();

    await send("openDirect", { requestId: "d-1", counterpart: BOB });
    // deno-lint-ignore no-explicit-any
    const before = manager.key("outgoingNotices").get() as any[];
    expect(before.length).toBe(1);

    await send("delivered", { requestId: "n-1", id: before[0].id });
    // deno-lint-ignore no-explicit-any
    const after = manager.key("outgoingNotices").get() as any[];
    expect(after.length).toBe(0);
  });
});
