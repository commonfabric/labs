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
import { waitForCellValue } from "@commonfabric/integration/wait-for-cell-value";
import { aclDocId } from "@commonfabric/memory/acl";
import { type Cell, Runtime, UI } from "@commonfabric/runner";
import {
  markRendererTrustedEvent,
  reviewedActionProvenance,
} from "@commonfabric/runner/cfc";
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

const PROFILE_PATH = fromFileUrl(
  new URL("../system/profile-home.tsx", import.meta.url),
);

const RESULT_CAUSE = "fabrichat manager";

// The reviewed action a start is admitted from, as
// `../fabrichat/schemas.tsx` names it.
const START_ACTION = { surface: "ChatStartSurface", action: "ChatStart" };

/**
 * `event` as a click on the manager's start control delivers it: carrying the
 * reviewed action, and marked as the renderer marks a click it delivers.
 */
const startClick = (
  event: Record<string, unknown>,
): Record<string, unknown> => {
  const click = {
    type: "click",
    ...event,
    provenance: reviewedActionProvenance("dom", START_ACTION),
  };
  markRendererTrustedEvent(click);
  return click;
};

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
  const startManager = async (resolveProfile = false) => {
    // The core gets a profile directly; the default wrapper resolves its
    // profile from the home roster the test controls.
    const program = {
      ...await resolveLocalProgram(
        (resolver) => runtime.harness.resolve(resolver),
        { main: MANAGER_PATH },
      ),
      ...(resolveProfile ? {} : { mainExport: "FabriChatManagerCore" }),
    };
    const tx = runtime.edit();
    if (resolveProfile) {
      runtime.getHomeSpaceCell(tx).key("defaultPattern").set({ profiles: [] });
    }
    const pattern = await runtime.patternManager.compilePattern(program, {
      space: home,
      tx,
    });
    const profileSpace = resolveProfile
      ? (await Identity.fromPassphrase("fabrichat default manager profile"))
        .did()
      : home;
    const profile = runtime.getCell<{
      name: string;
      initialNameApplied?: string;
      avatar?: string;
      bio?: string;
      elements?: unknown[];
    }>(
      profileSpace,
      "profile",
      undefined,
      tx,
    );
    if (!resolveProfile) profile.set({ name: "Tester" });
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
      resolveProfile ? {} : { myProfile: profile },
      resultCell,
    );
    runtime.prepareTxForCommit(tx);
    expect((await tx.commit().settled).error).toBeUndefined();
    await manager.pull();
    const send = async (stream: string, event: Record<string, unknown>) => {
      const sendTx = runtime.edit();
      manager.withTx(sendTx).key(stream).send(
        stream === "openDirect" || stream === "createGroup"
          ? startClick(event)
          : event,
      );
      expect((await sendTx.commit().settled).error).toBeUndefined();
      await runtime.idle();
      await manager.pull();
    };
    const rooms = () =>
      // deno-lint-ignore no-explicit-any
      manager.key("rooms").asSchema(entryListSchema).get() as any[];
    return { manager, send, rooms, profile };
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

  it("grants everyone WRITE on a group room made joinable by its link", async () => {
    const { send, rooms } = await startManager();

    await send("createGroup", {
      requestId: "g-1",
      title: "Open team",
      members: [CAROL],
      joinableByLink: true,
    });
    const space = rooms()[0].room.getAsNormalizedFullLink().space;
    expect(
      (await server.readDocument(
        space as Parameters<typeof server.readDocument>[0],
        aclDocId(space) as Parameters<typeof server.readDocument>[1],
      ))?.value,
    ).toEqual({
      [home]: "OWNER",
      [CAROL]: "WRITE",
      "*": "WRITE",
    });
  });

  it("creates a room after the default manager's missing profile becomes available", async () => {
    const { manager, send, rooms, profile } = await startManager(true);
    await send("createGroup", {
      requestId: "missing-profile",
      title: "Not created",
      members: [],
    });
    expect(manager.key("requests").key("missing-profile").get()).toEqual({
      status: "refused",
      reason: "Starting a chat needs a profile.",
    });
    expect(rooms()).toHaveLength(0);
    expect(manager.key("outgoingNotices").get()).toEqual([]);
    const disabled = manager.key(UI).key("children").key(5)
      .key("children").key(0).key("children").key(0)
      .key("props").key("disabled").asSchema<boolean>({ type: "boolean" });
    expect(disabled.get()).toBe(true);

    const profileTx = runtime.edit();
    const profileProgram = await resolveLocalProgram(
      (resolver) => runtime.harness.resolve(resolver),
      { main: PROFILE_PATH },
    );
    const profilePattern = await runtime.patternManager.compilePattern(
      profileProgram,
      { space: profile.getAsNormalizedFullLink().space, tx: profileTx },
    );
    runtime.run(profileTx, profilePattern, { initialName: "Tester" }, profile);
    runtime.prepareTxForCommit(profileTx);
    expect((await profileTx.commit().settled).error).toBeUndefined();
    await profile.pull();
    const tx = runtime.edit();
    runtime.getHomeSpaceCell(tx).key("defaultPattern").set({
      profiles: [profile],
      defaultProfile: { profile },
    });
    runtime.prepareTxForCommit(tx);
    expect((await tx.commit().settled).error).toBeUndefined();
    await waitForCellValue<boolean>(
      runtime,
      disabled,
      (value) => value === false,
    );

    await send("createGroup", {
      requestId: "recovered-profile",
      title: "Recovered",
      members: [],
    });
    await waitForCellValue<{ status: string }>(
      runtime,
      manager.key("requests").key("recovered-profile"),
      (value) => value?.status === "done",
    );
    expect(rooms()).toHaveLength(1);
    // Host reads follow the room beyond the index-read transaction.
    const room: Cell<unknown> = rooms()[0].room.withTx();
    expect(await runtime.start(room)).toBe(true);
    await room.pull();
    await waitForCellValue<boolean>(
      runtime,
      room.key("canSend").asSchema<boolean>({ type: "boolean" }),
      (value) => value === true,
    );
    const sendTx = runtime.edit();
    const messageEvent = {
      type: "click",
      requestId: "message-after-recovery",
      target: { value: "Hello" },
      provenance: reviewedActionProvenance("dom", {
        surface: "ChatSendSurface",
        action: "ChatSend",
      }),
    };
    markRendererTrustedEvent(messageEvent);
    room.withTx(sendTx).key("sendMessage").send(messageEvent);
    runtime.prepareTxForCommit(sendTx);
    expect((await sendTx.commit().settled).error).toBeUndefined();
    await waitForCellValue<number>(
      runtime,
      room.key("messages").key("count").asSchema<number>({ type: "number" }),
      (value) => value === 1,
    );
    const latest = await waitForCellValue<Cell<unknown>[]>(
      runtime,
      room.key("messages").key("latest").key("messages")
        .asSchema<Cell<unknown>[]>({
          type: "array",
          items: { type: "unknown", asCell: ["cell"] },
        }),
      (value) => value?.length === 1,
    );
    const author = latest[0].withTx().key("authorProfile").resolveAsCell();
    expect(author.equals(profile)).toBe(true);
  });
});
