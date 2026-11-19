import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { Identity } from "@commonfabric/identity";
import * as MemoryV2Server from "@commonfabric/memory/v2/server";

import { EmulatedStorageManager } from "../src/storage/v2-emulate.ts";
import type { MemorySpace } from "../src/storage/interface.ts";
import { Runtime } from "../src/runtime.ts";
import { resolveCellPath } from "../src/piece-helpers.ts";
import type { JSONSchema } from "../src/builder/types.ts";
import { newSharedServer } from "./memory-v2-test-utils.ts";

// Fresh-replica read asymmetry: writes from one replica commit durably, but a
// second (fresh) replica's reads of the same data used to come back masked —
// `undefined` / "property not found" — whenever the read path carried no
// schema. A schema-less sync normalizes to the rejecting selector and
// delivers only the root doc; link targets the selector never walked read as
// `unclaimed` (silently undefined). The fix kicks a background pull for
// same-space link targets the local replica has never seen (see the hop loop
// in link-resolution.ts and IStorageManager.shouldPullDoc), which
// `Cell.pull()`'s convergence loop awaits — so schema-less pulls now resolve
// to the true value. This suite mirrors the CLI `cf cell get` read path
// (schema-less cell -> pull() -> resolveCellPath).
const signer = await Identity.fromPassphrase("fresh-replica-read-asymmetry");
const space = signer.did();

const entrySchema = {
  type: "object",
  properties: {
    title: { type: "string" },
    body: { type: "string" },
  },
} as const satisfies JSONSchema;

const containerSchema = {
  type: "object",
  properties: {
    boardTitle: { type: "string" },
    myName: { type: "string" },
    topics: { type: "array", items: entrySchema },
  },
} as const satisfies JSONSchema;

const CONTAINER_CAUSE = "asymmetry-container";

describe("fresh-replica read asymmetry", () => {
  let server: MemoryV2Server.Server;
  let writerStorage: EmulatedStorageManager;
  let writerRt: Runtime;

  beforeEach(async () => {
    server = newSharedServer();
    writerStorage = EmulatedStorageManager.connectTo(server, {
      as: signer,
    });
    writerRt = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager: writerStorage,
    });

    // Writer replica: container whose `topics` entries are LINKS to separate
    // entry cells (the shape addTopic-style handlers produce).
    const tx = writerRt.edit();
    const entry0 = writerRt.getCell(space, "entry-0", entrySchema, tx);
    entry0.set({ title: "T0", body: "B0" });
    const entry1 = writerRt.getCell(space, "entry-1", entrySchema, tx);
    entry1.set({ title: "T1", body: "B1" });
    const entry2 = writerRt.getCell(space, "entry-2", entrySchema, tx);
    entry2.set({ title: "T2", body: "B2" });
    const container = writerRt.getCell(
      space,
      CONTAINER_CAUSE,
      containerSchema,
      tx,
    );
    container.set({
      boardTitle: "the board",
      myName: "gideon-c",
      topics: [entry0, entry1, entry2],
    });
    const result = await tx.commit().settled;
    expect(result.error).toBeUndefined();
    await writerStorage.synced();
  });

  afterEach(async () => {
    await writerRt?.dispose();
    await writerStorage?.close();
    await server?.close();
  });

  function freshReader(): { rt: Runtime; close: () => Promise<void> } {
    const storage = EmulatedStorageManager.connectTo(server, {
      as: signer,
    });
    const rt = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager: storage,
    });
    return {
      rt,
      close: async () => {
        await rt.dispose();
        await storage.close();
      },
    };
  }

  it("writer's own replica reads everything (control)", async () => {
    const container = writerRt.getCell(space, CONTAINER_CAUSE, containerSchema);
    const value = await container.pull();
    expect(value?.boardTitle).toBe("the board");
    expect(value?.topics?.length).toBe(3);
    expect(value?.topics?.[1]?.title).toBe("T1");
  });

  it("fresh replica, schema'd sync + get resolves linked entries", async () => {
    const { rt, close } = freshReader();
    try {
      const container = rt.getCell(space, CONTAINER_CAUSE, containerSchema);
      await container.sync();
      const value = container.get();
      expect(value?.boardTitle).toBe("the board");
      expect(value?.topics?.length).toBe(3);
      expect(value?.topics?.[0]?.title).toBe("T0");
      expect(value?.topics?.[1]?.title).toBe("T1");
      expect(value?.topics?.[2]?.body).toBe("B2");
    } finally {
      await close();
    }
  });

  it("fresh replica, SCHEMA-LESS pull resolves linked entries", async () => {
    const { rt, close } = freshReader();
    try {
      const container = rt.getCell<Record<string, unknown>>(
        space,
        CONTAINER_CAUSE,
        undefined,
      );
      const value = (await container.pull()) as {
        boardTitle?: string;
        topics?: { title?: string; body?: string }[];
      };
      expect(value?.boardTitle).toBe("the board");
      // Before the shouldPullDoc kick, these read [null, null, null]: the
      // schema-less sync's rejecting selector delivered only the container
      // root, and the never-pulled entry docs masked as null.
      expect(value?.topics?.length).toBe(3);
      expect(value?.topics?.[0]?.title).toBe("T0");
      expect(value?.topics?.[1]?.title).toBe("T1");
      expect(value?.topics?.[2]?.body).toBe("B2");
    } finally {
      await close();
    }
  });

  it("fresh replica, SCHEMA-LESS pull + per-index path reads (CLI piece get shape)", async () => {
    const { rt, close } = freshReader();
    try {
      const container = rt.getCell<Record<string, unknown>>(
        space,
        CONTAINER_CAUSE,
        undefined,
      );
      await container.pull();
      // Before the fix each of these threw `Cannot access path ... -
      // property "title" not found` — the CLI's manufactured-data-loss
      // signature (indistinguishable from past-array-end errors).
      expect(resolveCellPath(container, ["boardTitle"])).toBe("the board");
      expect(resolveCellPath(container, ["topics", 0, "title"])).toBe("T0");
      expect(resolveCellPath(container, ["topics", 1, "title"])).toBe("T1");
      expect(resolveCellPath(container, ["topics", 2, "title"])).toBe("T2");
    } finally {
      await close();
    }
  });

  it("fresh replica, schema-less pull converges across a two-hop link chain", async () => {
    // container.topics[N] -> entry doc -> entry.detail -> detail doc: each
    // hop is a doc the rejecting selector never delivered, so convergence
    // needs one kick round per depth level.
    const chainSchema = {
      type: "object",
      properties: {
        detail: {
          type: "object",
          properties: { note: { type: "string" } },
        },
      },
    } as const satisfies JSONSchema;

    const tx = writerRt.edit();
    const detail = writerRt.getCell(
      space,
      "chain-detail",
      { type: "object", properties: { note: { type: "string" } } } as const,
      tx,
    );
    detail.set({ note: "deep note" });
    const chainEntry = writerRt.getCell(space, "chain-entry", chainSchema, tx);
    chainEntry.set({ detail });
    const chainContainer = writerRt.getCell(
      space,
      "chain-container",
      {
        type: "object",
        properties: { entry: chainSchema },
      } as const,
      tx,
    );
    chainContainer.set({ entry: chainEntry });
    const result = await tx.commit().settled;
    expect(result.error).toBeUndefined();
    await writerStorage.synced();

    const { rt, close } = freshReader();
    try {
      const container = rt.getCell<Record<string, unknown>>(
        space,
        "chain-container",
        undefined,
      );
      const value = (await container.pull()) as {
        entry?: { detail?: { note?: string } };
      };
      expect(value?.entry?.detail?.note).toBe("deep note");
    } finally {
      await close();
    }
  });

  it("fresh replica, dangling link reads as absent without stalling pull", async () => {
    // A link to a cell that was never written: the kick pulls, the server
    // reports nothing, and the read settles as undefined/null — one kick
    // only (the shouldPullDoc set), so pull's convergence loop terminates.
    const tx = writerRt.edit();
    const ghost = writerRt.getCell(space, "ghost-entry", entrySchema, tx);
    const holder = writerRt.getCell(
      space,
      "dangling-holder",
      {
        type: "object",
        properties: { present: { type: "string" }, ghost: entrySchema },
      } as const,
      tx,
    );
    holder.set({ present: "here", ghost });
    const result = await tx.commit().settled;
    expect(result.error).toBeUndefined();
    await writerStorage.synced();

    const { rt, close } = freshReader();
    try {
      const cell = rt.getCell<Record<string, unknown>>(
        space,
        "dangling-holder",
        undefined,
      );
      const value = (await cell.pull()) as {
        present?: string;
        ghost?: unknown;
      };
      expect(value?.present).toBe("here");
      expect(value?.ghost ?? null).toBeNull();
    } finally {
      await close();
    }
  });

  it("fresh replica, whole-array read under a strict required items schema converges", async () => {
    // Models the topics board: items schema with `required` (strict, not
    // nullable), entries as links. One absent element used to void the WHOLE
    // array (traverseArrayWithSchema's every -> undefined), so a fresh
    // replica read the board's topics as []/undefined while every per-index
    // leaf read worked. The pull must converge to the full array.
    const strictContainerSchema = {
      type: "object",
      properties: {
        topics: {
          type: "array",
          items: {
            type: "object",
            properties: {
              title: { type: "string" },
              body: { type: "string" },
            },
            required: ["title", "body"],
          },
          default: [],
        },
      },
    } as const satisfies JSONSchema;

    const { rt, close } = freshReader();
    try {
      const container = rt.getCell(
        space,
        CONTAINER_CAUSE,
        strictContainerSchema,
      );
      const value = await container.pull();
      expect(value?.topics?.length).toBe(3);
      expect(value?.topics?.[0]?.title).toBe("T0");
      expect(value?.topics?.[1]?.title).toBe("T1");
      expect(value?.topics?.[2]?.body).toBe("B2");
    } finally {
      await close();
    }
  });

  it("shouldPullDoc reserves once per doc+scope; retractDocPullKick re-enables", async () => {
    // Reservation lifecycle (cubic P2): the kick set is taken before the
    // async pull settles, so a failed pull must be able to hand the
    // reservation back — otherwise one transient failure masks the doc for
    // the manager's lifetime. Scope is part of the key: scoped instances
    // are distinct docs.
    const storage = EmulatedStorageManager.connectTo(server, {
      as: signer,
    });
    try {
      const id = writerRt.getCell(space, "reserve-probe", entrySchema)
        .getAsNormalizedFullLink().id;
      expect(storage.shouldPullDoc(space, id)).toBe(true);
      expect(storage.shouldPullDoc(space, id)).toBe(false);
      storage.retractDocPullKick(space, id);
      expect(storage.shouldPullDoc(space, id)).toBe(true);
      // A different scope is an independent reservation.
      expect(storage.shouldPullDoc(space, id, "user")).toBe(true);
      // data: URIs are always locally materializable — never pulled.
      expect(storage.shouldPullDoc(space, "data:application/json,{}")).toBe(
        false,
      );
    } finally {
      await storage.close();
    }
  });

  it("a transiently failed kick is retried instead of masking forever", async () => {
    // Integration of the retract-on-failure semantics: the first kick for
    // one entry doc fails (injected). The failure hands back the
    // shouldPullDoc reservation, so a later resolution pass re-kicks — in
    // practice within the SAME pull when sibling arrivals re-run the read
    // effect, and at latest on the next read. Without the retract, the
    // entry would be masked for the replica's lifetime.
    const { rt, close } = freshReader();
    try {
      const entry1Id = writerRt.getCell(space, "entry-1", entrySchema)
        .getAsNormalizedFullLink().id;
      const storage = rt.storageManager;
      const provider = storage.open(space);
      const origSync = provider.sync.bind(provider);
      let injections = 0;
      provider.sync = ((uri, selector, scope) => {
        if (uri === entry1Id && injections === 0) {
          injections++;
          return Promise.reject(new Error("injected transient failure"));
        }
        return origSync(uri, selector, scope);
      }) as typeof provider.sync;

      const container = rt.getCell<Record<string, unknown>>(
        space,
        CONTAINER_CAUSE,
        undefined,
      );
      const first = (await container.pull()) as {
        topics?: ({ title?: string } | null | undefined)[];
      };
      // Unpoisoned entries always converge on the first pull.
      expect(first?.topics?.[0]?.title).toBe("T0");
      expect(first?.topics?.[2]?.title).toBe("T2");

      // The poisoned entry heals by the second pull at the latest.
      const second = (await container.pull()) as {
        topics?: ({ title?: string } | null | undefined)[];
      };
      expect(second?.topics?.[1]?.title).toBe("T1");
      // Exactly one injected failure, exactly one successful retry: the
      // reservation really was taken, failed, and handed back.
      expect(injections).toBe(1);
    } finally {
      await close();
    }
  });

  it("releases failed-load reservations and retries after reconnect", async () => {
    const { rt, close } = freshReader();
    try {
      const storage = rt.storageManager;
      const subscribe = storage.subscribeConnectionState!.bind(storage);
      let connectionListener: Parameters<typeof subscribe>[1] | undefined;
      storage.subscribeConnectionState = (observedSpace, callback) => {
        if (observedSpace !== space) return subscribe(observedSpace, callback);
        connectionListener = callback;
        callback({ status: "ready", epoch: 0 });
        return () => {
          connectionListener = undefined;
        };
      };
      const provider = storage.open(space);
      const origSync = provider.sync.bind(provider);
      const ghostId = writerRt.getCell(space, "eldl-ghost", entrySchema)
        .getAsNormalizedFullLink().id;
      let calls = 0;
      let failures = 0;
      provider.sync = ((uri, selector, scope) => {
        if (uri !== ghostId) return origSync(uri, selector, scope);
        calls++;
        if (failures === 0) {
          failures++;
          return Promise.reject(new Error("injected transient failure"));
        }
        return origSync(uri, selector, scope);
      }) as typeof provider.sync;

      const link = {
        space,
        id: ghostId,
        path: [] as readonly string[],
      } as Parameters<typeof rt.ensureLinkedDocLoaded>[0];

      rt.ensureLinkedDocLoaded(link, space);
      await (storage.crossSpaceSettled?.() ?? Promise.resolve());
      expect(failures).toBe(1);

      // A ready-connection failure stays terminal for this epoch.
      rt.ensureLinkedDocLoaded(link, space);
      await (storage.crossSpaceSettled?.() ?? Promise.resolve());
      expect(calls).toBe(1);
      connectionListener!({
        status: "disconnected",
        epoch: 0,
        cause: new Error("connection lost"),
      });
      connectionListener!({ status: "ready", epoch: 1 });
      rt.ensureLinkedDocLoaded(link, space);
      await (storage.crossSpaceSettled?.() ?? Promise.resolve());
      expect(calls).toBe(2);

      // After the successful kick the dedup holds: a third report is a no-op.
      rt.ensureLinkedDocLoaded(link, space);
      await (storage.crossSpaceSettled?.() ?? Promise.resolve());
      expect(calls).toBe(2);

      // A same-space doc the replica already holds takes the early return:
      // reported missing (e.g. a stale traversal), but never re-kicked.
      const container = rt.getCell<Record<string, unknown>>(
        space,
        CONTAINER_CAUSE,
        undefined,
      );
      await container.sync();
      const containerLink = container.getAsNormalizedFullLink();
      const containerSyncs: number[] = [];
      const counting = provider.sync;
      provider.sync = ((uri, selector, scope) => {
        if (uri === containerLink.id) containerSyncs.push(1);
        return counting(uri, selector, scope);
      }) as typeof provider.sync;
      rt.ensureLinkedDocLoaded(
        {
          space,
          id: containerLink.id,
          path: [] as readonly string[],
        } as Parameters<typeof rt.ensureLinkedDocLoaded>[0],
        space,
      );
      await (storage.crossSpaceSettled?.() ?? Promise.resolve());
      expect(containerSyncs.length).toBe(0);
    } finally {
      await close();
    }
  });

  it("a failed cross-space kick does not clear another read's reservation", async () => {
    // Retract-only-if-owned: a cross-space kick never takes the
    // shouldPullDoc reservation, so its failure must not hand back a
    // reservation a concurrent same-space read holds for the same target —
    // that would permit duplicate syncs while the first is still pending.
    const { rt, close } = freshReader();
    try {
      const storage = rt.storageManager;
      const provider = storage.open(space);
      const origSync = provider.sync.bind(provider);
      const ghostId = writerRt.getCell(space, "xspace-ghost", entrySchema)
        .getAsNormalizedFullLink().id;
      provider.sync = ((uri, selector, scope) => {
        if (uri === ghostId) {
          return Promise.reject(new Error("injected failure"));
        }
        return origSync(uri, selector, scope);
      }) as typeof provider.sync;

      // A same-space read holds the reservation (as if its kick is in
      // flight).
      expect(storage.shouldPullDoc?.(space, ghostId)).toBe(true);

      // A cross-space-sourced report for the same target fails its kick.
      const otherSource = "did:key:zOtherSourceSpace" as MemorySpace;
      rt.ensureLinkedDocLoaded(
        {
          space,
          id: ghostId,
          path: [] as readonly string[],
        } as Parameters<typeof rt.ensureLinkedDocLoaded>[0],
        otherSource,
      );
      await (storage.crossSpaceSettled?.() ?? Promise.resolve());

      // The same-space reservation survives: no duplicate kick permitted.
      expect(storage.shouldPullDoc?.(space, ghostId)).toBe(false);
    } finally {
      await close();
    }
  });

  it("missing-target kicks are scope-keyed: one scope does not suppress another", async () => {
    // Cubic P1: Runtime.ensureLinkedDocLoaded dedupes kicks; scoped
    // instances (user/session) are distinct docs, so a kick for one scope
    // must not swallow a later kick for another.
    const { rt, close } = freshReader();
    try {
      const storage = rt.storageManager;
      const provider = storage.open(space);
      const origSync = provider.sync.bind(provider);
      const synced: string[] = [];
      provider.sync = ((uri, selector, scope) => {
        synced.push(`${scope ?? "space"}\0${uri}`);
        return origSync(uri, selector, scope);
      }) as typeof provider.sync;

      const ghostId = writerRt.getCell(space, "p1-scoped-ghost", entrySchema)
        .getAsNormalizedFullLink().id;
      const baseLink = {
        space,
        id: ghostId,
        path: [] as readonly string[],
      };
      rt.ensureLinkedDocLoaded(
        baseLink as Parameters<typeof rt.ensureLinkedDocLoaded>[0],
        space,
      );
      rt.ensureLinkedDocLoaded(
        { ...baseLink, scope: "user" } as Parameters<
          typeof rt.ensureLinkedDocLoaded
        >[0],
        space,
      );
      await (storage.crossSpaceSettled?.() ?? Promise.resolve());
      const forGhost = synced.filter((entry) => entry.endsWith(`\0${ghostId}`));
      expect(forGhost.some((entry) => entry.startsWith("space\0"))).toBe(true);
      expect(forGhost.some((entry) => entry.startsWith("user\0"))).toBe(true);
      // And the dedup still holds within a scope: repeat is a no-op.
      const before = synced.length;
      rt.ensureLinkedDocLoaded(
        baseLink as Parameters<typeof rt.ensureLinkedDocLoaded>[0],
        space,
      );
      await (storage.crossSpaceSettled?.() ?? Promise.resolve());
      expect(synced.length).toBe(before);
    } finally {
      await close();
    }
  });

  it("characterization: schema-less sync + one-shot get still shows root only", async () => {
    // get() is synchronous: the hop kick is async, so the FIRST get() after a
    // bare schema-less sync() still masks linked entries. pull() (above) is
    // the converging read; this test documents the remaining get()-vs-pull()
    // semantic so a future change that heals or breaks it is visible.
    const { rt, close } = freshReader();
    try {
      const container = rt.getCell<Record<string, unknown>>(
        space,
        CONTAINER_CAUSE,
        undefined,
      );
      await container.sync();
      const value = container.get() as {
        boardTitle?: string;
        topics?: unknown[];
      };
      expect(value?.boardTitle).toBe("the board");
      expect(value?.topics?.length).toBe(3);
      expect(value?.topics?.every((entry) => entry == null)).toBe(true);
    } finally {
      await close();
    }
  });
});
