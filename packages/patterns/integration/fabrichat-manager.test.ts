/**
 * The real FabriChat manager, creating rooms in spaces of their own. Which
 * space a room lives in is something a pattern can't read, so this is checked
 * here, against a runtime and storage of the test's own;
 * `../fabrichat/creation.test.tsx` covers the rest of what the manager does
 * with the rooms it creates.
 */

import { expect } from "@std/expect";
import { fromFileUrl } from "@std/path";
import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";

import { Identity } from "@commonfabric/identity";
import { aclDocId } from "@commonfabric/memory/acl";
import { Runtime } from "@commonfabric/runner";
import { resolveLocalProgram } from "@commonfabric/runner/local-program.deno";
import {
  EmulatedStorageManager,
  newLoopbackServer,
} from "@commonfabric/runner/storage/cache.deno";

const signer = await Identity.fromPassphrase("fabrichat-manager");
const home = signer.did();

// Stand-ins for principals, each a base58btc key as a principal's is.
const BOB = "did:key:z6MkBob";
const CAROL = "did:key:z6MkCaro1";

const MANAGER_PATH = fromFileUrl(
  new URL("../fabrichat/manager.tsx", import.meta.url),
);

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

describe("fabrichat-manager", () => {
  let server: ReturnType<typeof newLoopbackServer>;
  let storageManager: EmulatedStorageManager;
  let runtime: Runtime;

  beforeEach(() => {
    server = newLoopbackServer();
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
    // The manager's core, given a profile of its own: `#profile` resolves
    // nothing here, and a manager starts no chat without one.
    const program = {
      ...await resolveLocalProgram(
        (resolver) => runtime.harness.resolve(resolver),
        { main: MANAGER_PATH },
      ),
      mainExport: "FabriChatManagerCore",
    };
    const tx = runtime.edit();
    const pattern = await runtime.patternManager.compilePattern(program, {
      space: home,
      tx,
    });
    const profile = runtime.getCell<{ name: string }>(
      home,
      "profile",
      undefined,
      tx,
    );
    profile.set({ name: "Tester" });
    const resultCell = runtime.getCell<Record<string, unknown>>(
      home,
      RESULT_CAUSE,
      undefined,
      tx,
    );
    const manager = runtime.run(
      tx,
      // deno-lint-ignore no-explicit-any
      pattern as any,
      { myProfile: profile },
      resultCell,
    );
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

  it("creates each room in a space of its own that grants its members alone", async () => {
    const { send, rooms } = await startManager();

    await send("openDirect", { requestId: "d-1", counterpart: BOB });
    await send("createGroup", {
      requestId: "g-1",
      title: "Team",
      members: [CAROL],
    });
    const spaces = rooms().map((entry) =>
      entry.room.getAsNormalizedFullLink().space
    );
    expect(spaces.length).toBe(2);
    expect(spaces).not.toContain(home);
    expect(spaces[0]).not.toBe(spaces[1]);

    // This user holds OWNER, each other member WRITE, and no one else.
    const aclOf = async (space: string) =>
      (await server.readDocument(
        space as Parameters<typeof server.readDocument>[0],
        aclDocId(space) as Parameters<typeof server.readDocument>[1],
      ))?.value;
    const spaceOf = (kind: string) =>
      rooms().find((entry) => entry.kind === kind).room
        .getAsNormalizedFullLink().space;
    expect(await aclOf(spaceOf("direct"))).toEqual({
      [home]: "OWNER",
      [BOB]: "WRITE",
    });
    expect(await aclOf(spaceOf("group"))).toEqual({
      [home]: "OWNER",
      [CAROL]: "WRITE",
    });
  });
});
