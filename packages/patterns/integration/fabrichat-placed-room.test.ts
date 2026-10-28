/**
 * A FabriChat room that is some other social space's chat: a room with no
 * `about`, running in a space whose root is a container that lists the space's
 * participants. What `wish({ query: "#default" })` resolves to is the space
 * cell's root, which a pattern test's space has none of, so this is checked
 * here, against a runtime and storage of the test's own;
 * `../fabrichat/join.test.tsx` covers a room that is its space's root.
 */

import { expect } from "@std/expect";
import { fromFileUrl } from "@std/path";
import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";

import { Identity } from "@commonfabric/identity";
import { type Cell, type JSONSchema, Runtime } from "@commonfabric/runner";
import {
  markRendererTrustedEvent,
  reviewedActionProvenance,
} from "@commonfabric/runner/cfc";
import { resolveLocalProgram } from "@commonfabric/runner/local-program.deno";
import {
  EmulatedStorageManager,
  newLoopbackServer,
} from "@commonfabric/runner/storage/cache.deno";

const signer = await Identity.fromPassphrase("fabrichat-placed-room");
const space = signer.did();

const ROOM_PATH = fromFileUrl(
  new URL("../fabrichat/room.tsx", import.meta.url),
);

// The patterns package, which the room's imports reach across.
const PATTERNS = fromFileUrl(new URL("..", import.meta.url));

// Reads a room's participants as links, not copies.
const participantListSchema = {
  type: "array",
  items: { type: "unknown", asCell: ["cell"] },
  // deno-lint-ignore no-explicit-any
} as any;

describe("fabrichat-placed-room", () => {
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
    await runtime?.idle();
    await storageManager?.synced();
    await runtime?.dispose();
    await storageManager?.close();
    await server?.close();
  });

  it("lists the participants its space's root lists, for a room with no `about`", async () => {
    const program = await resolveLocalProgram(
      (resolver) => runtime.harness.resolve(resolver),
      { main: ROOM_PATH, root: PATTERNS },
    );
    const tx = runtime.edit();
    const pattern = await runtime.patternManager.compilePattern(program, {
      space,
      tx,
    });
    // The container, the space's root, lists one participant.
    const participant = runtime.getCell<{ name: string }>(
      space,
      "container participant",
      undefined,
      tx,
    );
    participant.set({ name: "Placed" });
    const container = runtime.getCell<{ participants: Cell<unknown>[] }>(
      space,
      "container",
      undefined,
      tx,
    );
    container.set({ participants: [participant] });
    runtime.getSpaceCell(space, undefined, tx).key("defaultPattern").set(
      container,
    );
    const room = runtime.run(
      tx,
      // deno-lint-ignore no-explicit-any
      pattern as any,
      {},
      runtime.getCell<Record<string, unknown>>(
        space,
        "placed room",
        undefined,
        tx,
      ),
    );
    runtime.prepareTxForCommit(tx);
    expect((await tx.commit().settled).error).toBeUndefined();
    await runtime.idle();
    await room.pull();

    const listed = room.key("participants").asSchema(participantListSchema)
      .get() as Cell<unknown>[];
    expect(listed.length).toBe(1);
    expect(listed[0].equalLinks(participant)).toBe(true);
  });

  it("stores a message in a social space while the viewer's manager has a confidential catalog in Home", async () => {
    expect(runtime.cfcEnforcementMode).toBe("enforce-strict");
    const home = signer.did();
    const member = await Identity.fromPassphrase("fabrichat social member");
    const social = await runtime.createSpace({
      grants: { [member.did()]: "WRITE" },
    });
    const tx = runtime.edit();
    const profile = runtime.getCell<{ name: string }>(home, "viewer profile", {
      type: "object",
      properties: { name: { type: "string" } },
      ifc: { addIntegrity: ["fabrichat-test-profile"] },
    }, tx);
    profile.set({ name: "Viewer" });
    const catalogSchema = {
      type: "object",
      properties: {
        entries: { type: "object" },
        offers: { type: "object" },
      },
      ifc: {
        confidentiality: [{
          type: "https://commonfabric.org/cfc/atom/PersonalSpace",
          owner: home,
        }],
      },
    } as const satisfies JSONSchema;
    const catalog = runtime.getCell(
      home,
      "private Home catalog",
      catalogSchema,
      tx,
    );
    catalog.set({ entries: {}, offers: {} });
    runtime.prepareTxForCommit(tx);
    expect((await tx.commit().settled).error).toBeUndefined();
    const roomTx = runtime.edit();
    const program = await resolveLocalProgram(
      (resolver) => runtime.harness.resolve(resolver),
      {
        main: fromFileUrl(
          new URL(
            "./fixtures/fabrichat-private-catalog/main.tsx",
            import.meta.url,
          ),
        ),
        root: PATTERNS,
      },
    );
    const pattern = await runtime.patternManager.compilePattern(program, {
      space: social,
      tx: roomTx,
    });
    const room = runtime.run(
      roomTx,
      pattern,
      { profile, catalog },
      runtime.getCell(social, "social room", undefined, roomTx),
    );
    runtime.prepareTxForCommit(roomTx);
    expect((await roomTx.commit().settled).error).toBeUndefined();
    await runtime.idle();
    await room.pull();
    expect(room.key("canSend").get()).toBe(true);
    const click = {
      type: "click",
      requestId: "social-send",
      target: { value: "Visible in the social room" },
      provenance: reviewedActionProvenance("dom", {
        surface: "ChatSendSurface",
        action: "ChatSend",
      }),
    };
    markRendererTrustedEvent(click);
    const sendTx = runtime.edit();
    room.withTx(sendTx).key("sendMessage").send(click);
    expect((await sendTx.commit().settled).error).toBeUndefined();
    await runtime.idle();
    await room.pull();
    expect(room.key("messages").key("count").get()).toBe(1);
    expect(
      room.key("messages").key("latest").key("messages").key(0).key("body")
        .get(),
    )
      .toBe("Visible in the social room");
    expect(catalog.get()).toEqual({ entries: {}, offers: {} });
    const memberStorage = EmulatedStorageManager.connectTo(server, {
      as: member,
    });
    const memberRuntime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager: memberStorage,
    });
    try {
      const argument = room.getArgumentCell();
      if (argument === undefined) throw new Error("The room has no argument.");
      const messages = argument.key("messages").asSchema<
        Cell<{ body: string }>[]
      >({
        type: "array",
        items: {
          type: "object",
          properties: { body: { type: "string" } },
          asCell: ["cell"],
        },
      }).get();
      expect(messages).toHaveLength(1);
      const message = messages[0];
      const body = memberRuntime.getCellFromLink(
        message.getAsNormalizedFullLink(),
      )
        .key("body");
      expect(await body.pull()).toBe("Visible in the social room");
    } finally {
      await memberRuntime.dispose();
      await memberStorage.close();
    }
  });
});
