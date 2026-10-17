import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { Identity } from "@commonfabric/identity";
import * as MemoryV2Server from "@commonfabric/memory/v2/server";

import type { Pattern } from "../../src/builder/types.ts";
import { brandTrustedPattern } from "../../src/builder/pattern-metadata.ts";
import type { Cell } from "../../src/cell.ts";
import { loadStoredCfcEnvelope } from "../../src/cfc/prepare.ts";
import type { RuntimeProgram } from "../../src/harness/types.ts";
import { Runtime } from "../../src/runtime.ts";
import { runtimePresets } from "../../src/runtime-presets.ts";
import { EmulatedStorageManager } from "../../src/storage/v2-emulate.ts";
import type {
  RuntimeTelemetryEvent,
  RuntimeTelemetryMarker,
} from "../../src/telemetry.ts";
import { newSharedServer } from "../memory-v2-test-utils.ts";

const signer = await Identity.fromPassphrase("created-cell-writer-policy");
const other = await Identity.fromPassphrase(
  "created-cell-writer-policy other user",
);
const space = signer.did();

// `f` is the declared writer of every protected cell; `g` and `h` have the
// same unlabeled state type and are named by none, `h` clearing the cell.
// Each cell is created with `undefined`, as the agent queue's `agentRunner`
// is, except `init`, which is created with a value. `nested` declares its
// policy on a field only, and `mixed` beside a field a node may fill. `keyed`'s
// writer `k` writes one key of the cell, as fabrichat's window registry does.
// `ui`, `uiNested` and `uiInit` are guarded by a UI contract alone, on the
// whole cell or on one field, which `g`'s unlabeled write brings no trusted
// event for.
const program: RuntimeProgram = {
  main: "/main.tsx",
  files: [{
    name: "/main.tsx",
    contents: `import {
  Cfc, CurrentPrincipal, handler, pattern, RepresentsCurrentUser, Stream,
  Writable, WriteAuthorizedBy,
} from "commonfabric";
type Entry = { host: string };
const f = handler<string, { value: Writable<Entry | undefined> }>((event, { value }) => value.set({ host: event }));
const g = handler<string, { value: Writable<Entry | undefined> }>((event, { value }) => value.set({ host: event }));
const h = handler<string, { value: Writable<Entry | undefined> }>((_event, { value }) => value.set(undefined));
const k = handler<string, { value: Writable<Entry> }>((event, { value }) => value.key("host").set(event));
type Protected = WriteAuthorizedBy<Entry, typeof f>;
type NestedProtected = { host: WriteAuthorizedBy<string, typeof f> };
type MixedProtected = { host?: WriteAuthorizedBy<string, typeof f>; produced?: number };
type Keyed = WriteAuthorizedBy<Entry, typeof k>;
type UiPolicy = { helper: "UiAction"; action: "Post"; trustedPattern: "Poster"; requiredEventIntegrity: ["Poster"] };
type UiOnly = Cfc<Entry, { uiContract: UiPolicy }>;
type UiNested = { host: Cfc<string, { uiContract: UiPolicy }> };
type Owned = RepresentsCurrentUser<Cfc<WriteAuthorizedBy<Entry, typeof f>, { ownerPrincipal: CurrentPrincipal }>>;
export default pattern<{}, {
  undef: Protected; init: Protected; owned: Owned; nested: NestedProtected;
  mixed: MixedProtected; keyed: Keyed;
  ui: UiOnly; uiInit: UiOnly; uiNested: UiNested;
  gUi: Stream<string>; gUiInit: Stream<string>; gUiNested: Stream<string>;
  fUndef: Stream<string>; gUndef: Stream<string>; hUndef: Stream<string>;
  fNested: Stream<string>; gNested: Stream<string>;
  fMixed: Stream<string>; gMixed: Stream<string>;
  fInit: Stream<string>; gInit: Stream<string>;
  fOwned: Stream<string>; kKeyed: Stream<string>;
}>(() => {
  const undef = new Writable<Protected | undefined>(undefined).for("undef");
  const init = new Writable<Protected | undefined>({ host: "initial" }).for("init");
  const owned = new Writable<Owned | undefined>(undefined).for("owned");
  const nested = new Writable<NestedProtected | undefined>(undefined).for("nested");
  const mixed = new Writable<MixedProtected | undefined>(undefined).for("mixed");
  const keyed = new Writable<Keyed | undefined>(undefined).for("keyed");
  const ui = new Writable<UiOnly | undefined>(undefined).for("ui");
  const uiInit = new Writable<UiOnly | undefined>({ host: "initial" }).for("uiInit");
  const uiNested = new Writable<UiNested | undefined>(undefined).for("uiNested");
  return {
    undef: undef as any, init: init as any, owned: owned as any, nested: nested as any,
    mixed: mixed as any, keyed: keyed as any,
    ui: ui as any, uiInit: uiInit as any, uiNested: uiNested as any,
    gUi: g({ value: ui as any }), gUiInit: g({ value: uiInit as any }),
    gUiNested: g({ value: uiNested as any }),
    fUndef: f({ value: undef as any }), gUndef: g({ value: undef as any }), hUndef: h({ value: undef as any }),
    fNested: f({ value: nested as any }), gNested: g({ value: nested as any }),
    fMixed: f({ value: mixed as any }), gMixed: g({ value: mixed as any }),
    fInit: f({ value: init as any }), gInit: g({ value: init as any }),
    fOwned: f({ value: owned as any }), kKeyed: k({ value: keyed as any }),
  };
});`,
  }],
};

describe("created cell writer policy", () => {
  let server: MemoryV2Server.Server;
  let manager: EmulatedStorageManager;
  let runtime: Runtime;
  let result: Cell<unknown>;

  /**
   * Sets the program up. A setup is the acting principal's act unless
   * `attributeInitialization` is `false`. `rebuild`, given, replaces the
   * compiled pattern with one built from it.
   */
  const setUp = async (
    attributeInitialization?: false,
    rebuild?: (compiled: Pattern) => Pattern,
  ) => {
    const setup = runtime.edit();
    const compiled = await runtime.patternManager.compilePattern(program, {
      space,
      tx: setup,
    });
    result = runtime.run(
      setup,
      rebuild?.(compiled) ?? compiled,
      {},
      runtime.getCell(space, "created-cell-writer-policy", undefined, setup),
      attributeInitialization === false ? { attributeInitialization } : {},
    );
    runtime.prepareTxForCommit(setup);
    expect((await setup.commit().settled).error).toBeUndefined();
    await result.pull();
    await runtime.idle();
  };

  beforeEach(() => {
    server = newSharedServer();
    manager = EmulatedStorageManager.connectTo(server, { as: signer });
    runtime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager: manager,
    });
  });

  afterEach(async () => {
    await runtime?.dispose();
    await manager?.close();
    await server?.close();
  });

  const host = (key: string, cell = result) =>
    (cell.key(key as never).get() as { host?: string } | undefined)?.host;

  const stored = (key: string, cell = result, on = runtime) => {
    const link = cell.key(key as never).resolveAsCell()
      .getAsNormalizedFullLink();
    return loadStoredCfcEnvelope(on.readTx(), {
      space: link.space,
      id: link.id,
      scope: link.scope,
    });
  };

  /** The principals the cell's stored label says it represents. */
  const representedBy = (key: string): string[] => {
    const envelope = stored(key);
    if (envelope.status !== "loaded") return [];
    return envelope.metadata.labelMap.entries
      .flatMap((entry) => entry.label.integrity ?? [])
      .filter((atom) =>
        (atom as { kind?: string }).kind === "represents-principal"
      )
      .map((atom) => (atom as { subject: unknown }).subject as string)
      .sort();
  };

  /** Sends `value` on `stream`, resolving with each event commit's error, or "ok". */
  const send = async (
    stream: string,
    value: string,
    cell = result,
    on = runtime,
  ) => {
    const commits: Extract<
      RuntimeTelemetryMarker,
      { type: "scheduler.event.commit" }
    >[] = [];
    const listener = (event: Event) => {
      const marker = (event as RuntimeTelemetryEvent).detail.marker;
      if (marker.type === "scheduler.event.commit") commits.push(marker);
    };
    on.telemetry.addEventListener("telemetry", listener);
    try {
      await on.editWithRetry((tx) => {
        cell.withTx(tx).key(stream).send(value as never);
      });
      await on.scheduler.idleWithPendingCommits();
      await on.idle();
      await cell.pull();
      return commits.map((commit) => commit.error ?? "ok");
    } finally {
      on.telemetry.removeEventListener("telemetry", listener);
    }
  };

  describe("on a cell created with undefined", () => {
    it("stores the declared writer policy at setup", async () => {
      await setUp();

      const envelope = stored("undef");
      expect(envelope.status).toBe("loaded");
      expect(JSON.stringify(envelope.status === "loaded" && envelope.schema))
        .toContain('"writeAuthorizedBy"');
      expect(host("undef")).toBeUndefined();
    });

    it("refuses a write by a handler the policy does not name", async () => {
      await setUp();

      const outcomes = await send("gUndef", "g");

      expect(outcomes).toHaveLength(1);
      expect(String(outcomes[0])).toContain("writeAuthorizedBy");
      expect(host("undef")).toBeUndefined();
    });

    it("admits the declared writer's first write", async () => {
      await setUp();

      expect(await send("fUndef", "f")).toEqual(["ok"]);
      expect(host("undef")).toBe("f");
      expect(String((await send("gUndef", "g"))[0])).toContain(
        "writeAuthorizedBy",
      );
      expect(host("undef")).toBe("f");
    });

    it("refuses a clear by a handler the policy does not name", async () => {
      await setUp();

      expect(await send("fUndef", "f")).toEqual(["ok"]);
      const outcomes = await send("hUndef", "h");

      expect(outcomes).toHaveLength(1);
      expect(String(outcomes[0])).toContain("writeAuthorizedBy");
      expect(host("undef")).toBe("f");
    });

    it("stores a policy declared on a field only, and refuses a handler it does not name", async () => {
      await setUp();

      expect(stored("nested").status).toBe("loaded");
      const outcomes = await send("gNested", "g");
      expect(outcomes).toHaveLength(1);
      expect(String(outcomes[0])).toContain("writeAuthorizedBy");
      expect(host("nested")).toBeUndefined();
      expect(await send("fNested", "f")).toEqual(["ok"]);
      expect(host("nested")).toBe("f");
    });

    it("binds no owner in a setup that is nobody's act, and binds the declared writer's first writer", async () => {
      await setUp(false);

      expect(stored("owned").status).toBe("loaded");
      expect(representedBy("owned")).toEqual([]);
      expect(await send("fOwned", "f")).toEqual(["ok"]);
      expect(representedBy("owned")).toEqual([signer.did()]);
    });

    it("binds no owner in a setup that is the acting principal's act, and binds the declared writer's first writer", async () => {
      // The setup writes no value, so it initializes nothing a claim about a
      // principal could be bound to.

      await setUp();

      expect(stored("owned").status).toBe("loaded");
      expect(representedBy("owned")).toEqual([]);
      expect(await send("fOwned", "f")).toEqual(["ok"]);
      expect(representedBy("owned")).toEqual([signer.did()]);
    });

    it("admits a declared writer whose first write sets one key of the cell", async () => {
      await setUp();

      expect(stored("keyed").status).toBe("loaded");
      expect(await send("kKeyed", "k")).toEqual(["ok"]);
      expect(host("keyed")).toBe("k");
    });
  });

  describe("on a cell a UI contract alone guards", () => {
    it("stores the contract at setup, and refuses a write that brings no trusted event", async () => {
      await setUp();

      expect(stored("ui").status).toBe("loaded");
      const outcomes = await send("gUi", "g");
      expect(outcomes).toHaveLength(1);
      expect(String(outcomes[0])).toContain("trusted-event");
      expect(host("ui")).toBeUndefined();
    });

    it("stores a contract declared on a field only, and refuses a write that brings no trusted event", async () => {
      await setUp();

      expect(stored("uiNested").status).toBe("loaded");
      const outcomes = await send("gUiNested", "g");
      expect(outcomes).toHaveLength(1);
      expect(String(outcomes[0])).toContain("trusted-event");
      expect(host("uiNested")).toBeUndefined();
    });

    it("refuses the same write on the cell created with a value", async () => {
      await setUp();

      expect(stored("uiInit").status).toBe("loaded");
      const outcomes = await send("gUiInit", "g");
      expect(outcomes).toHaveLength(1);
      expect(String(outcomes[0])).toContain("trusted-event");
      expect(host("uiInit")).toBe("initial");
    });
  });

  describe("on a cell a node fills only part of", () => {
    // The builder never emits such a node, since every node it builds writes a
    // cell of its own, so the graph is built by hand here: a node whose output
    // is `mixed`'s `produced` field, beside the `host` field `f` writes.

    /** Adds to `compiled` a node that fills `mixed`'s `produced` field. */
    const withProducer = (compiled: Pattern): Pattern => {
      const descriptor = compiled.derivedInternalCells?.find((candidate) =>
        JSON.stringify(candidate.schema).includes('"produced"')
      );
      expect(descriptor).toBeDefined();
      return brandTrustedPattern({
        ...compiled,
        nodes: [...compiled.nodes, {
          module: { type: "javascript", implementation: () => 1 },
          inputs: {},
          outputs: {
            $alias: {
              partialCause: descriptor!.partialCause,
              path: ["produced"],
            },
          },
        }],
      } as Pattern);
    };

    it("stores the policy of the positions the node does not fill, and refuses a handler it does not name", async () => {
      await setUp(undefined, withProducer);

      expect(stored("mixed").status).toBe("loaded");
      const outcomes = await send("gMixed", "g");
      expect(outcomes).toHaveLength(1);
      expect(String(outcomes[0])).toContain("writeAuthorizedBy");
      expect(host("mixed")).toBeUndefined();
      expect(await send("fMixed", "f")).toEqual(["ok"]);
      expect(host("mixed")).toBe("f");
    });
  });

  describe("on a cell created with a value", () => {
    it("stores the declared writer policy at setup, and refuses a handler the policy does not name", async () => {
      await setUp();

      expect(stored("init").status).toBe("loaded");
      expect(String((await send("gInit", "g"))[0])).toContain(
        "writeAuthorizedBy",
      );
      expect(host("init")).toBe("initial");
    });
  });

  describe("on a per-user cell created with undefined", () => {
    // Each user's instance of the cell declares its policy where that user's
    // runtime starts the piece, as well as at setup.
    const scopedProgram: RuntimeProgram = {
      main: "/main.tsx",
      files: [{
        name: "/main.tsx",
        contents:
          `import { handler, pattern, PerUser, Stream, Writable, WriteAuthorizedBy } from "commonfabric";
type Entry = { host: string };
const f = handler<string, { value: Writable<Entry | undefined> }>((event, { value }) => value.set(event === "" ? undefined : { host: event }));
const g = handler<string, { value: Writable<Entry | undefined> }>((event, { value }) => value.set({ host: event }));
export default pattern<{}, { mine: PerUser<WriteAuthorizedBy<Entry, typeof f>>; fMine: Stream<string>; gMine: Stream<string> }>(() => {
  const mine = new Writable<PerUser<WriteAuthorizedBy<Entry, typeof f>> | undefined>(undefined).for("mine");
  return { mine: mine as any, fMine: f({ value: mine as any }), gMine: g({ value: mine as any }) };
});`,
      }],
    };

    /** A runtime over its own replicas of `server`, as a separate session is. */
    const sessionRuntime = (storage: EmulatedStorageManager) =>
      new Runtime(runtimePresets.patternTest({
        apiUrl: new URL(import.meta.url),
        storageManager: storage,
        experimental: {},
      }));

    it("keeps the stored policy when a later start finds the cell cleared", async () => {
      const creatorStorage = EmulatedStorageManager.connectTo(server, {
        as: signer,
      });
      const creator = sessionRuntime(creatorStorage);
      const coldStorage = EmulatedStorageManager.connectTo(server, {
        as: signer,
      });
      const cold = sessionRuntime(coldStorage);
      try {
        const setup = creator.edit();
        const compiled = await creator.patternManager.compilePattern(
          scopedProgram,
          { space, tx: setup },
        );
        const created = creator.run(
          setup,
          compiled,
          {},
          creator.getCell(space, "per-user-cell", undefined, setup),
        );
        creator.prepareTxForCommit(setup);
        expect((await setup.commit().settled).error).toBeUndefined();
        await created.pull();
        await creator.idle();
        expect(stored("mine", created, creator).status).toBe("loaded");
        expect(await send("fMine", "f", created, creator)).toEqual(["ok"]);
        expect(await send("fMine", "", created, creator)).toEqual(["ok"]);
        expect(host("mine", created)).toBeUndefined();
        await creator.storageManager.synced();

        const started = cold.getCell(space, "per-user-cell");
        await started.sync();
        expect(await cold.start(started)).toBe(true);
        await started.pull();
        await cold.idle();

        expect(host("mine", started)).toBeUndefined();
        expect(stored("mine", started, cold).status).toBe("loaded");
        expect(String((await send("gMine", "g", started, cold))[0]))
          .toContain("writeAuthorizedBy");
        expect(await send("fMine", "f", started, cold)).toEqual(["ok"]);
        expect(host("mine", started)).toBe("f");
      } finally {
        await cold.dispose();
        await creator.dispose();
        await coldStorage.close();
        await creatorStorage.close();
      }
    });

    it("stores the policy on the instance of a user whose runtime starts the piece after setup", async () => {
      // The other user's instance did not exist at setup: the start's
      // preparation creates it, in a transaction of its own.

      const creatorStorage = EmulatedStorageManager.connectTo(server, {
        as: signer,
      });
      const creator = sessionRuntime(creatorStorage);
      const otherStorage = EmulatedStorageManager.connectTo(server, {
        as: other,
      });
      const otherRuntime = sessionRuntime(otherStorage);
      try {
        const setup = creator.edit();
        const compiled = await creator.patternManager.compilePattern(
          scopedProgram,
          { space, tx: setup },
        );
        const created = creator.run(
          setup,
          compiled,
          {},
          creator.getCell(space, "per-user-cell-other", undefined, setup),
        );
        creator.prepareTxForCommit(setup);
        expect((await setup.commit().settled).error).toBeUndefined();
        await created.pull();
        await creator.idle();
        expect(await send("fMine", "creator", created, creator)).toEqual([
          "ok",
        ]);
        await creator.storageManager.synced();

        const started = otherRuntime.getCell(space, "per-user-cell-other");
        await started.sync();
        expect(await otherRuntime.start(started)).toBe(true);
        await started.pull();
        await otherRuntime.idle();

        // The other user's instance is not the creator's: it holds nothing.
        expect(host("mine", started)).toBeUndefined();
        expect(stored("mine", started, otherRuntime).status).toBe("loaded");
        expect(String((await send("gMine", "g", started, otherRuntime))[0]))
          .toContain("writeAuthorizedBy");
        expect(host("mine", started)).toBeUndefined();
        expect(await send("fMine", "f", started, otherRuntime)).toEqual([
          "ok",
        ]);
        expect(host("mine", started)).toBe("f");
      } finally {
        await otherRuntime.dispose();
        await creator.dispose();
        await otherStorage.close();
        await creatorStorage.close();
      }
    });
  });
});
