/**
 * A manager discovers declared container chats through real space roots and
 * keeps each conversation's membership separate from its container's.
 */

import { expect } from "@std/expect";
import { fromFileUrl } from "@std/path";
import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";

import { Identity } from "@commonfabric/identity";
import {
  type Cell,
  Runtime,
  sendEvent,
  writeResultSchemaMeta,
} from "@commonfabric/runner";
import {
  markRendererTrustedEvent,
  readStoredCfcMetadata,
  reviewedActionProvenance,
} from "@commonfabric/runner/cfc";
import { resolveLocalProgram } from "@commonfabric/runner/local-program.deno";
import {
  EmulatedStorageManager,
  newLoopbackServer,
} from "@commonfabric/runner/storage/cache.deno";

const signer = await Identity.fromPassphrase("fabrichat container index");
const home = signer.did();

/** A listed conversation, read as a link and its opaque revision. */
interface Entry {
  /** The resolved conversation. */
  room: Cell<unknown>;

  /** The room's declared conversation kind. */
  kind: string;

  /** The membership revision clients return when forgetting it. */
  revision: string;
}

const entriesSchema = {
  type: "array",
  items: {
    type: "object",
    properties: {
      room: { type: "object", asCell: ["cell"] },
      kind: { type: "string" },
      revision: { type: "string" },
    },
  },
} as const;

describe("fabrichat-container-index", () => {
  let server: ReturnType<typeof newLoopbackServer>;
  let storage: EmulatedStorageManager;
  let runtime: Runtime;

  beforeEach(() => {
    server = newLoopbackServer();
    storage = EmulatedStorageManager.connectTo(server, { as: signer });
    runtime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager: storage,
    });
  });

  afterEach(async () => {
    await runtime.idle();
    await storage.synced();
    await runtime.dispose();
    await storage.close();
    await server.close();
  });

  it("discovers a declared chat added later, forgets only that conversation, and restores it with a fresh revision", async () => {
    const social = await runtime.createSpace({ spaceKind: "photo-album" });
    let tx = runtime.edit();
    const container = runtime.getCell<Record<string, unknown>>(
      social,
      "container",
      undefined,
      tx,
    );
    container.set({});
    runtime.getSpaceCell(social, undefined, tx).key("defaultPattern").set(
      container,
    );
    const room = runtime.getCell(
      social,
      "declared conversation",
      undefined,
      tx,
    );
    room.set({ about: { kind: "group", title: "Photos" } });
    const roomAlias = runtime.getCell(
      social,
      "conversation alias",
      undefined,
      tx,
    );
    roomAlias.set(room);
    const other = runtime.getCell(social, "other conversation", undefined, tx);
    other.set({ about: { kind: "group", title: "Other" } });
    runtime.prepareTxForCommit(tx);
    expect((await tx.commit().settled).error).toBeUndefined();
    tx = runtime.edit();
    const catalog = runtime.getCell(home, "catalog", undefined, tx);
    catalog.set({
      entries: {
        [social]: {
          space: social,
          host: "http://localhost:8000",
          kind: "photo-album",
          state: "saved",
          revision: "1:initial",
          since: 123,
        },
      },
      offers: {},
    });
    const program = await resolveLocalProgram(
      (resolver) => runtime.harness.resolve(resolver),
      {
        main: fromFileUrl(new URL("../fabrichat/manager.tsx", import.meta.url)),
        root: fromFileUrl(new URL("..", import.meta.url)),
      },
    );
    const pattern = await runtime.patternManager.compilePattern({
      ...program,
      mainExport: "FabriChatManagerCore",
    }, { space: home, tx });
    const manager = runtime.run(
      tx,
      pattern,
      { sharedSpaceCatalog: catalog },
      runtime.getCell(home, "manager", undefined, tx),
    );
    runtime.prepareTxForCommit(tx);
    expect((await tx.commit().settled).error).toBeUndefined();
    await runtime.idle();
    await manager.pull();
    const entries = manager.key("rooms").asSchema<Entry[]>(entriesSchema);
    expect(entries.get()).toEqual([]);

    const declareTx = runtime.edit();
    container.withTx(declareTx).key("chatRoom").set(roomAlias);
    expect((await declareTx.commit().settled).error).toBeUndefined();
    await runtime.idle();
    await manager.pull();
    expect(entries.get()).toHaveLength(1);
    expect(entries.get()[0].room.equals(room)).toBe(true);
    const discoveredRevision = entries.get()[0].revision;
    sendEvent(manager.key("forget"), {
      room: other,
      revision: discoveredRevision,
      requestId: "mismatched-room",
    });
    await runtime.idle();
    await manager.pull();
    expect(manager.key("requests").key("mismatched-room").key("status").get())
      .toBe("refused");
    expect(manager.key("roomMembership").get()).toEqual([]);
    expect(entries.get()).toHaveLength(1);
    sendEvent(manager.key("forget"), {
      room: entries.get()[0].room,
      revision: discoveredRevision,
      requestId: "forget",
    });
    await runtime.idle();
    await manager.pull();
    expect(manager.key("requests").key("forget").key("status").get()).toBe(
      "done",
    );
    expect(entries.get()).toEqual([]);
    expect(catalog.key("entries").key(social).key("state").get()).toBe("saved");

    // A membership choice names a conversation, even when the declaration
    // reaches it through an alias whose target can change.
    const retargetTx = runtime.edit();
    roomAlias.withTx(retargetTx).set(other);
    expect((await retargetTx.commit().settled).error).toBeUndefined();
    await runtime.idle();
    await manager.pull();
    expect(entries.get()).toHaveLength(1);
    expect(entries.get()[0].room.equals(other)).toBe(true);
    const restoreAliasTx = runtime.edit();
    roomAlias.withTx(restoreAliasTx).set(room);
    expect((await restoreAliasTx.commit().settled).error).toBeUndefined();
    await runtime.idle();
    await manager.pull();
    expect(entries.get()).toEqual([]);

    const reopenedStorage = EmulatedStorageManager.connectTo(server, {
      as: signer,
    });
    const reopenedRuntime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager: reopenedStorage,
    });
    try {
      const reopened = reopenedRuntime.getCell(home, "manager");
      await reopenedRuntime.start(reopened);
      await reopened.pull();
      expect(reopened.key("rooms").asSchema<Entry[]>(entriesSchema).get())
        .toEqual([]);
      expect(reopened.key("roomMembership").key(0).key("state").get()).toBe(
        "archived",
      );
    } finally {
      await reopenedRuntime.idle();
      await reopenedRuntime.dispose();
      await reopenedStorage.close();
    }

    sendEvent(manager.key("accept"), {
      room,
      container,
      keepArchived: true,
      requestId: "offered",
    });
    await runtime.idle();
    await manager.pull();
    expect(entries.get()).toEqual([]);
    sendEvent(manager.key("joinRoom"), {
      room: roomAlias,
      container,
      requestId: "join",
    });
    await runtime.idle();
    await manager.pull();
    expect(manager.key("requests").key("join").key("status").get()).toBe(
      "done",
    );
    expect(entries.get()).toHaveLength(1);
    expect(entries.get()[0].revision).not.toBe(discoveredRevision);
    sendEvent(manager.key("forget"), {
      room,
      revision: discoveredRevision,
      requestId: "stale",
    });
    await runtime.idle();
    await manager.pull();
    expect(manager.key("requests").key("stale").key("status").get()).toBe(
      "refused",
    );
    expect(entries.get()).toHaveLength(1);

    sendEvent(manager.key("joinRoom"), {
      room: other,
      container,
      requestId: "wrong",
    });
    await runtime.idle();
    await manager.pull();
    expect(manager.key("requests").key("wrong").key("status").get()).toBe(
      "refused",
    );
    expect(entries.get()).toHaveLength(1);
    const replaceTx = runtime.edit();
    roomAlias.withTx(replaceTx).set(other);
    expect((await replaceTx.commit().settled).error).toBeUndefined();
    await runtime.idle();
    await manager.pull();
    expect(entries.get()).toHaveLength(2);
    expect(entries.get().some((entry) => entry.room.equals(other))).toBe(true);
    expect(catalog.key("entries").get()).toEqual({
      [social]: {
        space: social,
        host: "http://localhost:8000",
        kind: "photo-album",
        state: "saved",
        revision: "1:initial",
        since: 123,
      },
    });
    const directTx = runtime.edit();
    const directRoom = runtime.getCell(
      social,
      "direct conversation",
      undefined,
      directTx,
    );
    directRoom.set({ about: { kind: "direct" } });
    container.withTx(directTx).key("chatRoom").set(directRoom);
    expect((await directTx.commit().settled).error).toBeUndefined();
    await runtime.idle();
    await manager.pull();
    const directEntry = entries.get().find((entry) =>
      entry.room.equals(directRoom)
    );
    expect(directEntry?.kind).toBe("direct");
    sendEvent(manager.key("forget"), {
      room: directRoom,
      revision: directEntry?.revision,
      requestId: "forget-direct",
    });
    await runtime.idle();
    await manager.pull();
    expect(manager.key("requests").key("forget-direct").key("status").get())
      .toBe("done");
    expect(entries.get().some((entry) => entry.room.equals(directRoom))).toBe(
      false,
    );
    expect(
      manager.key("roomMembership").asSchema<Entry[]>(entriesSchema).get()
        .find((entry) => entry.room.equals(directRoom))?.kind,
    ).toBe("direct");
  });
  it("lists a room once through standalone and container entries and keeps forgetting it independent of its container", async () => {
    const standalone = await runtime.createSpace({
      spaceKind: "fabrichat-room",
    });
    const social = await runtime.createSpace({});
    let tx = runtime.edit();
    const room = runtime.getCell(
      standalone,
      "root conversation",
      undefined,
      tx,
    );
    room.set({
      about: { kind: "group", title: "Shared", record: { kind: "group" } },
    });
    runtime.getSpaceCell(standalone, undefined, tx).key("defaultPattern").set(
      room,
    );
    runtime.prepareTxForCommit(tx);
    expect((await tx.commit().settled).error).toBeUndefined();
    tx = runtime.edit();
    const container = runtime.getCell(social, "container", undefined, tx);
    container.set({ chatRoom: room });
    runtime.getSpaceCell(social, undefined, tx).key("defaultPattern").set(
      container,
    );
    runtime.prepareTxForCommit(tx);
    expect((await tx.commit().settled).error).toBeUndefined();
    tx = runtime.edit();
    const catalog = runtime.getCell(home, "catalog", undefined, tx);
    const stored = {
      entries: {
        [social]: {
          space: social,
          host: "http://localhost:8000",
          kind: "social",
          state: "saved",
          revision: "1:initial",
        },
        [standalone]: {
          space: standalone,
          host: "http://localhost:8000",
          kind: "fabrichat-room",
          state: "saved",
          revision: "1:initial",
        },
      },
      offers: {},
    };
    catalog.set({
      entries: { [social]: stored.entries[social] },
      offers: {},
    });
    const program = await resolveLocalProgram(
      (resolver) => runtime.harness.resolve(resolver),
      {
        main: fromFileUrl(new URL("../fabrichat/manager.tsx", import.meta.url)),
        root: fromFileUrl(new URL("..", import.meta.url)),
      },
    );
    const pattern = await runtime.patternManager.compilePattern({
      ...program,
      mainExport: "FabriChatManagerCore",
    }, { space: home, tx });
    const manager = runtime.run(
      tx,
      pattern,
      { sharedSpaceCatalog: catalog },
      runtime.getCell(home, "manager", undefined, tx),
    );
    runtime.prepareTxForCommit(tx);
    expect((await tx.commit().settled).error).toBeUndefined();
    await manager.pull();
    const entries = manager.key("rooms").asSchema<Entry[]>(entriesSchema);
    expect(entries.get()).toHaveLength(1);
    expect(entries.get()[0].room.equals(room)).toBe(true);
    const containerRevision = entries.get()[0].revision;
    sendEvent(manager.key("joinRoom"), {
      room,
      container,
      requestId: "container-first",
    });
    await runtime.idle();
    await manager.pull();
    expect(entries.get()).toHaveLength(1);
    expect(catalog.key("entries").key(standalone).key("kind").get()).toBe(
      "fabrichat-room",
    );
    expect(catalog.key("entries").key(standalone).key("state").get()).toBe(
      "saved",
    );
    expect(catalog.key("entries").key(social).get()).toEqual(
      stored.entries[social],
    );
    expect(manager.key("roomMembership").key(0).key("catalogRevision").get())
      .toBe(catalog.key("entries").key(standalone).key("revision").get());
    const saveStandaloneTx = runtime.edit();
    catalog.withTx(saveStandaloneTx).key("entries").key(standalone).set(
      stored.entries[standalone],
    );
    expect((await saveStandaloneTx.commit().settled).error).toBeUndefined();
    await runtime.idle();
    await manager.pull();
    expect(entries.get()).toHaveLength(1);
    expect(entries.get()[0].revision).toBe("1:initial");
    const removeFirstJoinTx = runtime.edit();
    catalog.withTx(removeFirstJoinTx).key("entries").set({
      [social]: stored.entries[social],
    });
    expect((await removeFirstJoinTx.commit().settled).error).toBeUndefined();
    await runtime.idle();
    await manager.pull();
    expect(entries.get()).toEqual([]);
    const restoreFirstJoinTx = runtime.edit();
    catalog.withTx(restoreFirstJoinTx).key("entries").key(standalone).set(
      stored.entries[standalone],
    );
    expect((await restoreFirstJoinTx.commit().settled).error).toBeUndefined();
    await runtime.idle();
    await manager.pull();
    expect(entries.get()).toHaveLength(1);
    sendEvent(manager.key("forget"), {
      room,
      revision: containerRevision,
      requestId: "stale-container-source",
    });
    await runtime.idle();
    await manager.pull();
    expect(
      manager.key("requests").key("stale-container-source").key("status").get(),
    ).toBe("refused");
    expect(entries.get()).toHaveLength(1);
    sendEvent(manager.key("forget"), {
      room,
      revision: entries.get()[0].revision,
      requestId: "forget-root",
    });
    await runtime.idle();
    await manager.pull();
    expect(entries.get()).toEqual([]);
    expect(catalog.key("entries").key(social).key("state").get()).toBe("saved");
    // A later Home catalog restore controls standalone room membership.
    const catalogRestoreTx = runtime.edit();
    catalog.withTx(catalogRestoreTx).key("entries").key(standalone).set({
      ...stored.entries[standalone],
      revision: "3:catalog-restore",
    });
    expect((await catalogRestoreTx.commit().settled).error).toBeUndefined();
    await runtime.idle();
    await manager.pull();
    expect(entries.get()).toHaveLength(1);
    expect(entries.get()[0].revision).toBe("3:catalog-restore");
    sendEvent(manager.key("forget"), {
      room,
      revision: entries.get()[0].revision,
      requestId: "forget-restored-root",
    });
    await runtime.idle();
    await manager.pull();
    expect(entries.get()).toEqual([]);
    sendEvent(manager.key("joinRoom"), {
      room,
      container,
      requestId: "join-container",
    });
    await runtime.idle();
    await manager.pull();
    expect(entries.get()).toHaveLength(1);
    const revision = entries.get()[0].revision;
    sendEvent(manager.key("forget"), { room, revision, requestId: "forget" });
    await runtime.idle();
    await manager.pull();
    expect(entries.get()).toEqual([]);
    expect(catalog.key("entries").key(social).get()).toEqual(
      stored.entries[social],
    );
    expect(catalog.key("entries").key(standalone).key("state").get()).toBe(
      "archived",
    );
    sendEvent(manager.key("joinRoom"), { room, requestId: "join-root" });
    await runtime.idle();
    await manager.pull();
    expect(entries.get()).toHaveLength(1);
    expect(entries.get()[0].room.equals(room)).toBe(true);
    expect(entries.get()[0].revision).not.toBe(revision);
    const beforeCatalogChange = entries.get()[0].revision;
    const archiveTx = runtime.edit();
    catalog.withTx(archiveTx).key("entries").key(standalone).set({
      ...stored.entries[standalone],
      state: "archived",
      revision: "7:catalog-archive",
    });
    expect((await archiveTx.commit().settled).error).toBeUndefined();
    await runtime.idle();
    await manager.pull();
    expect(entries.get()).toEqual([]);
    const restoreTx = runtime.edit();
    catalog.withTx(restoreTx).key("entries").key(standalone).set({
      ...stored.entries[standalone],
      revision: "8:catalog-restore",
    });
    expect((await restoreTx.commit().settled).error).toBeUndefined();
    await runtime.idle();
    await manager.pull();
    expect(entries.get()).toHaveLength(1);
    expect(entries.get()[0].revision).toBe("8:catalog-restore");
    sendEvent(manager.key("forget"), {
      room,
      revision: beforeCatalogChange,
      requestId: "stale-before-catalog-change",
    });
    await runtime.idle();
    await manager.pull();
    expect(
      manager.key("requests").key("stale-before-catalog-change").key("status")
        .get(),
    ).toBe("refused");
    expect(entries.get()).toHaveLength(1);
    const removeTx = runtime.edit();
    catalog.withTx(removeTx).key("entries").set({
      [social]: stored.entries[social],
    });
    expect((await removeTx.commit().settled).error).toBeUndefined();
    await runtime.idle();
    await manager.pull();
    expect(entries.get()).toEqual([]);
  });

  it("joins an unsaved container's real room when its viewer sends a message", async () => {
    const social = await runtime.createSpace({});
    let tx = runtime.edit();
    const profile = runtime.getCell(social, "profile", {
      type: "object",
      properties: { name: { type: "string" } },
      ifc: { addIntegrity: ["fabrichat-test-profile"] },
    }, tx);
    profile.set({ name: "Sender" });
    runtime.prepareTxForCommit(tx);
    expect((await tx.commit().settled).error).toBeUndefined();
    tx = runtime.edit();
    const program = await resolveLocalProgram(
      (resolver) => runtime.harness.resolve(resolver),
      {
        main: fromFileUrl(new URL("../fabrichat/manager.tsx", import.meta.url)),
        root: fromFileUrl(new URL("..", import.meta.url)),
      },
    );
    const managerPattern = await runtime.patternManager.compilePattern({
      ...program,
      mainExport: "FabriChatManagerCore",
    }, { space: home, tx });
    const manager = runtime.run(
      tx,
      managerPattern,
      { myProfile: profile },
      runtime.getCell(home, "manager", undefined, tx),
    );
    const homeRoot = runtime.getCell(home, "home", undefined, tx);
    homeRoot.set({
      profiles: [profile],
      defaultProfile: profile,
      chatManager: manager,
    });
    runtime.getSpaceCell(home, undefined, tx).key("defaultPattern").set(
      homeRoot,
    );
    runtime.prepareTxForCommit(tx);
    expect((await tx.commit().settled).error).toBeUndefined();
    await manager.pull();
    tx = runtime.edit();
    const roomProgram = await resolveLocalProgram(
      (resolver) => runtime.harness.resolve(resolver),
      {
        main: fromFileUrl(new URL("../fabrichat/room.tsx", import.meta.url)),
        root: fromFileUrl(new URL("..", import.meta.url)),
      },
    );
    const roomPattern = await runtime.patternManager.compilePattern(
      roomProgram,
      { space: social, tx },
    );
    const room = runtime.run(
      tx,
      roomPattern,
      {},
      runtime.getCell(social, "room", undefined, tx),
    );
    const container = runtime.getCell(social, "container", undefined, tx);
    container.set({ chatRoom: room });
    runtime.getSpaceCell(social, undefined, tx).key("defaultPattern").set(
      container,
    );
    runtime.prepareTxForCommit(tx);
    expect((await tx.commit().settled).error).toBeUndefined();
    await runtime.idle();
    await room.pull();
    expect(room.key("canSend").get()).toBe(true);
    const entries = manager.key("rooms").asSchema<Entry[]>(entriesSchema);
    expect(entries.get()).toEqual([]);
    const click = {
      type: "click",
      requestId: "placed-message",
      target: { value: "Our shared photos" },
      provenance: reviewedActionProvenance("dom", {
        surface: "ChatSendSurface",
        action: "ChatSend",
      }),
    };
    markRendererTrustedEvent(click);
    tx = runtime.edit();
    room.withTx(tx).key("sendMessage").send(click);
    expect((await tx.commit().settled).error).toBeUndefined();
    await runtime.idle();
    await room.pull();
    await manager.pull();
    expect(room.key("messages").key("count").get()).toBe(1);
    expect(entries.get()).toHaveLength(1);
    expect(entries.get()[0].room.equals(room)).toBe(true);
    expect(manager.key("sharedSpaceCatalog").get()).toEqual({
      entries: {},
      offers: {},
    });
  });

  it("lists a declared chat reached through a document holding only a link while the list carries a label", async () => {
    // A Loom root's `ensureChatRoom` declares its room this way: the room the
    // handler makes is reached through the handler's output for it, a
    // document holding only a link to the room and no CFC metadata of its
    // own. The room, a pattern's result, carries `schema` metadata and no
    // label of its own at its root.

    const refusals: string[] = [];
    runtime.scheduler.onError((error: Error) => {
      refusals.push(error?.message ?? String(error));
    });
    const social = await runtime.createSpace({ spaceKind: "loom" });
    let tx = runtime.edit();
    const room = runtime.getCell(social, "ensured conversation", undefined, tx);
    room.set({ about: { kind: "group", title: "Loom chat" } });
    writeResultSchemaMeta(room, {
      type: "object",
      properties: { about: { type: "object" } },
    });
    const output = runtime.getCell(social, "handler output", undefined, tx);
    output.setRaw(room.getAsLink());
    const container = runtime.getCell(social, "container", undefined, tx);
    container.set({ chatRoom: output });
    runtime.getSpaceCell(social, undefined, tx).key("defaultPattern").set(
      container,
    );
    runtime.prepareTxForCommit(tx);
    expect((await tx.commit().settled).error).toBeUndefined();
    const readTx = runtime.edit();
    expect(
      readStoredCfcMetadata(readTx, output.getAsNormalizedFullLink()),
    ).toBeUndefined();

    tx = runtime.edit();
    const catalog = runtime.getCell(home, "catalog", undefined, tx);
    catalog.set({
      entries: {
        [social]: {
          space: social,
          host: "http://localhost:8000",
          kind: "loom",
          state: "saved",
          revision: "1:initial",
          since: 123,
        },
      },
      offers: {},
    });
    // A label on `direct` labels the list without reaching the room.
    const direct = runtime.getCell(
      home,
      "direct",
      {
        type: "object",
        ifc: {
          confidentiality: [{
            type: "https://commonfabric.org/cfc/atom/PersonalSpace",
            owner: home,
          }],
        },
      } as const,
      tx,
    );
    direct.set({});
    const program = await resolveLocalProgram(
      (resolver) => runtime.harness.resolve(resolver),
      {
        main: fromFileUrl(new URL("../fabrichat/manager.tsx", import.meta.url)),
        root: fromFileUrl(new URL("..", import.meta.url)),
      },
    );
    const pattern = await runtime.patternManager.compilePattern({
      ...program,
      mainExport: "FabriChatManagerCore",
    }, { space: home, tx });
    const manager = runtime.run(
      tx,
      pattern,
      { sharedSpaceCatalog: catalog, direct },
      runtime.getCell(home, "manager", undefined, tx),
    );
    runtime.prepareTxForCommit(tx);
    expect((await tx.commit().settled).error).toBeUndefined();
    await runtime.idle();
    await manager.pull();
    await runtime.idle();

    const entries = manager.key("rooms").asSchema<Entry[]>(entriesSchema);
    const rooms = manager.key("rooms").resolveAsCell()
      .getAsNormalizedFullLink();
    expect(readStoredCfcMetadata(readTx, rooms)).toBeDefined();
    expect(refusals).toEqual([]);
    expect(entries.get()).toHaveLength(1);
    expect(entries.get()[0].room.equals(room)).toBe(true);
    // `equals()` resolves links, so the stored link is read as written: it
    // names the room's own document, not the link-only one on the way.
    const stored = manager.key("rooms").resolveAsCell().key(0).key("room")
      .getRaw() as { "/": { "link@1": { id: string } } };
    expect(stored["/"]["link@1"].id).toBe(room.getAsNormalizedFullLink().id);
    expect(stored["/"]["link@1"].id).not.toBe(
      output.getAsNormalizedFullLink().id,
    );
  });
});
