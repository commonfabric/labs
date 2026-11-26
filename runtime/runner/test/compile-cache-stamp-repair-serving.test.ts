// The load ahead of a setup repairs the compile-cache records a flow stamp
// labeled (module-loading.md, "Repairing a stamped record"). On a serving
// runtime every transaction it opens seals into its space's wave unless it is
// stamped, and an unstamped seal is refused (serving-loop.md §3d), so the
// repair's own transaction is a stamped bookkeeping direct commit. These pin
// that arm on a host serving the home space: a clean closure, a stamped one,
// one a racing commit changes, one a handler's run reaches, and one in a space
// the runtime does not serve, where a direct commit may not write.

import { expect } from "@std/expect";
import { stub } from "@std/testing/mock";
import type { FabricPlainObject, FabricValue } from "@commonfabric/data-model";
import { CFC_ATOM_TYPE } from "@commonfabric/api/cfc";
import { Identity } from "@commonfabric/identity";
import { getLogger } from "@commonfabric/logger";
import type * as MemoryV2Server from "@commonfabric/memory/v2/server";
import {
  applyCommit,
  read,
  selectDocHead,
} from "@commonfabric/memory/v2/engine";
import {
  afterEach,
  beforeEach,
  describe,
  it,
} from "@commonfabric/test-support/test";
import { EmulatedStorageManager } from "../src/storage/v2-emulate.ts";
import { Runtime } from "../src/runtime.ts";
import type { MemorySpace } from "../src/storage/interface.ts";
import { ExecutorHost } from "../src/executor/host.ts";
import type {
  DelegatedCarriage,
  WaveCommitSink,
} from "../src/executor/wave.ts";
import {
  getPatternIdentityRef,
  resolveEntryIdentity,
  type RuntimeProgram,
  systemPatternSource,
} from "../src/index.ts";
import {
  compiledDocKey,
  sourceDocKey,
} from "../src/compilation-cache/cell-cache.ts";
import { readStoredCfcMetadata } from "../src/cfc/metadata.ts";
import type { URI } from "../src/sigil-types.ts";
import {
  SEED_ENVELOPE_SCHEMA_HASH,
  seedStoredEnvelope,
  storedFields,
  writeSeedEnvelopeDoc,
} from "./cfc-seed-envelope.ts";
import { ArrivalLog, awaitReplica } from "./support/serving-waits.ts";
import { newSharedServer } from "./memory-v2-test-utils.ts";

const homeSigner = await Identity.fromPassphrase("stamp repair serving home");
const homeSpace = homeSigner.did() as MemorySpace;
const foreignSpace = (await Identity.fromPassphrase(
  "stamp repair serving foreign",
)).did() as MemorySpace;
const serviceSigner = await Identity.fromPassphrase(
  "stamp repair serving service",
);
const aliceSigner = await Identity.fromPassphrase("stamp repair serving alice");

/** A label the programs below do not declare. */
const UNDECLARED_ATOM = aliceSigner.did();

/** Another such label, which a racing commit adds. */
const RACING_ATOM = serviceSigner.did();

/** The declarations of a confidential argument, for the programs below. */
const CONFIDENTIAL_ARGUMENT = `
const ATOM = {
  type: "https://commonfabric.org/cfc/atom/Resource",
  class: "CompileCacheStampRepairServing",
  subject: "did:example:owner",
} as const;
type Label = readonly [typeof ATOM];
`;

/**
 * A program whose argument is confidential under a `Resource` atom it
 * declares, so that a setup of it is prepared and measures what it writes.
 */
const PROGRAM: RuntimeProgram = {
  main: "/labeled.tsx",
  files: [{
    name: "/labeled.tsx",
    contents: `/// <cts-enable />
import { Confidential, NAME, pattern } from "commonfabric";
${CONFIDENTIAL_ARGUMENT}
interface Args { seed: Confidential<string, Label>; }
export default pattern<Args, { label: string }>(({ seed }) => ({
  [NAME]: "Stamp repair",
  label: "v:" + seed,
}));
`,
  }],
};

const ENTRY_IDENTITY = await resolveEntryIdentity(
  PROGRAM.main,
  (name) =>
    Promise.resolve(
      PROGRAM.files.find((file) => file.name === name)!.contents,
    ),
);

/** Where a system pattern's module is served, which makes a child tracked. */
const LAUNCHER_PATH = "/api/patterns/system/stamp-launcher.tsx";

/**
 * A system pattern with a verb that launches a child of its own module, so
 * that the handler's run prepares the verification of the child's closure
 * while its transaction is open (`Runner`'s handler-result path).
 */
const LAUNCHER: RuntimeProgram = {
  main: LAUNCHER_PATH,
  files: [{
    name: LAUNCHER_PATH,
    contents: `/// <cts-enable />
import { action, cell, Confidential, pattern, Stream } from "commonfabric";
${CONFIDENTIAL_ARGUMENT}
interface ChildArgs { seed: Confidential<string, Label>; }
export const Child = pattern<ChildArgs, { label: string }>(({ seed }) => ({
  label: "child:" + seed,
}));
interface Verbs {
  launch: Stream<{ seed: string }>;
  launched: number;
}
export default pattern<Record<string, never>, Verbs>(() => {
  const launched = cell(0);
  const launch = action((event: { seed: string }) => {
    launched.set(launched.get() + 1);
    return Child({ seed: event.seed });
  });
  return { launch, launched };
});
`,
  }],
};

const LAUNCHER_IDENTITY = await resolveEntryIdentity(
  LAUNCHER.main,
  (name) =>
    Promise.resolve(
      LAUNCHER.files.find((file) => file.name === name)!.contents,
    ),
);

/**
 * The root pair a write-back left on a source record, as measured on a real
 * space: a shape entry and a value entry, each holding `atom`, the value
 * entry also naming the compile-cache writer's transformation.
 */
const rootPairStamp = (atom: string): FabricValue[] =>
  [
    {
      path: [],
      origin: "derived",
      observes: "shape",
      label: { confidentiality: [atom] },
    },
    {
      path: [],
      origin: "derived",
      observes: "value",
      label: {
        confidentiality: [atom],
        integrity: [{
          type: CFC_ATOM_TYPE.TransformedBy,
          identity: { kind: "builtin", builtinId: "compile-cache" },
        }],
      },
    },
  ] as unknown as FabricValue[];

type Stored = FabricPlainObject & {
  value?: FabricPlainObject;
  cfc?: FabricPlainObject & {
    labelMap: FabricPlainObject & { entries: FabricValue[] };
  };
};

/** One log line of the stamp repair's, its lazy messages evaluated. */
type RepairLog = { level: string; key: string; messages: unknown[] };

describe("compile-cache-stamp-repair-serving", () => {
  let server: MemoryV2Server.Server;
  let host: ExecutorHost;
  let clientManager: EmulatedStorageManager;
  let client: Runtime;
  let servingRuntime: Runtime | undefined;
  let activations: ArrivalLog<{ space: string; outcome: string }>;
  let cancelDemand: () => void;
  let cleanups: Array<() => Promise<void> | void>;

  /** Every batch the serving loop handed the store, and what it writes. */
  let batches: ArrivalLog<{ space: string; ids: string[] }>;

  /** Run once, ahead of the store taking the next batch that writes `id`. */
  let beforeStoreWrites: { id: string; run: () => Promise<void> } | undefined;

  /** What the pattern manager and the cell cache logged of the repair. */
  let repairLogs: RepairLog[];

  beforeEach(async () => {
    server = newSharedServer({
      subscriptionRefreshDelayMs: 0,
      delegatingDids: [serviceSigner.did()],
    });
    servingRuntime = undefined;
    cleanups = [];
    batches = new ArrivalLog();
    beforeStoreWrites = undefined;
    activations = new ArrivalLog();
    repairLogs = [];
    for (const name of ["pattern-manager", "cell-cache"]) {
      const logger = getLogger(name);
      for (const level of ["debug", "warn"] as const) {
        const original = logger[level].bind(logger);
        const captured = stub(
          logger,
          level,
          (key: string, ...messages: unknown[]) => {
            if (key.startsWith("compile-cache-stamp")) {
              repairLogs.push({
                level,
                key,
                messages: messages.flatMap((message) =>
                  typeof message === "function" ? message() : [message]
                ),
              });
            }
            original(key, ...messages);
          },
        );
        cleanups.push(() => captured.restore());
      }
    }
    host = new ExecutorHost({
      server,
      serviceIdentity: serviceSigner.did(),
      decorateWaveCommitSink: (sink: WaveCommitSink): WaveCommitSink => ({
        reportsCommits: sink.reportsCommits,
        currentHeads: sink.currentHeads.bind(sink),
        concurrentWritePaths: sink.concurrentWritePaths.bind(sink),
        intrusionSince: sink.intrusionSince?.bind(sink),
        staleReads: sink.staleReads?.bind(sink),
        sessionOverwritePathsSince: sink.sessionOverwritePathsSince?.bind(sink),
        commitSpaceAccessChange: sink.commitSpaceAccessChange?.bind(sink),
        commitWave: async (batch) => {
          const ids = batch.operations.flatMap((op) =>
            "id" in op ? [op.id as string] : []
          );
          batches.record({ space: batch.space, ids });
          const hook = beforeStoreWrites;
          if (hook !== undefined && ids.includes(hook.id)) {
            beforeStoreWrites = undefined;
            await hook.run();
          }
          return await sink.commitWave(batch);
        },
      }),
      createRuntime: (space) => {
        const manager = EmulatedStorageManager.connectTo(server, {
          as: serviceSigner,
          servingHomeSpace: space,
        });
        const runtime = new Runtime({
          apiUrl: new URL(import.meta.url),
          storageManager: manager,
          servingPosture: true,
          experimental: { serverExecution: true },
          cfcEnforcementMode: "enforce-strict",
          cfcFlowLabels: "persist",
        });
        servingRuntime = runtime;
        return Promise.resolve({
          runtime,
          dispose: async () => {
            await runtime.dispose();
            await manager.close();
          },
        });
      },
      policy: { flushDeadlineMs: 5_000, idleParkMs: 600_000 },
      onActivationSettled: (space, outcome) =>
        activations.record({ space, outcome }),
    });

    // A client's demand activates the home space's serving tenure. The
    // client also stands in for the runtime that left the stamps.
    clientManager = EmulatedStorageManager.connectTo(server, {
      as: aliceSigner,
    });
    client = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager: clientManager,
      cfcEnforcementMode: "enforce-strict",
      cfcFlowLabels: "persist",
    });
    cancelDemand = client.getCell<{ ping: number }>(
      homeSpace,
      "stamp-repair-serving-demand",
      undefined,
    ).sink(() => {});
    await activations.matching((entry) =>
      entry.space === homeSpace && entry.outcome === "active"
    );
  });

  afterEach(async () => {
    cancelDemand();
    await host.close();
    for (const cleanup of cleanups.reverse()) await cleanup();
    await client.dispose();
    await clientManager.close();
    await server.close();
  });

  /** The serving runtime's compile of `program` into the home space, once
   * the waves holding its write-back have committed it. */
  const compileIntoHome = async (program: RuntimeProgram = PROGRAM) => {
    const serving = servingRuntime!;
    const pattern = await serving.patternManager.compilePattern(program, {
      space: homeSpace,
    });
    await serving.sealsCommitted!();
    await serving.patternManager.flushCompileCacheWrites();
    await serving.patternManager.compileCacheWriteOutcomesSettled();
    return pattern;
  };

  /** The client's compile of the program into `space`, once committed. */
  const compileOnClient = async (space: MemorySpace) => {
    await client.patternManager.compilePattern(PROGRAM, { space });
    await client.patternManager.flushCompileCacheWrites();
    await client.storageManager.synced();
  };

  /** The keys of `identity`'s two records, at the serving runtime's version. */
  const recordKeys = async (identity = ENTRY_IDENTITY) => {
    const version = await servingRuntime!.patternManager
      .compileCacheRuntimeVersion({ patternCoverage: false });
    return {
      source: sourceDocKey(identity),
      compiled: compiledDocKey(version!, identity),
    };
  };

  /** The id of the document `key` names in `space`. */
  const idOf = (space: MemorySpace, key: string) =>
    client.getCell(space, key).getAsNormalizedFullLink().id as URI;

  /** The document `id` in `space`, as the store holds it. */
  const storedDoc = async (space: MemorySpace, id: URI) =>
    read(await server.engineForSpace(space), { id });

  /** The head of the document `id` in `space`'s store. */
  const storedHead = async (space: MemorySpace, id: URI) =>
    selectDocHead(await server.engineForSpace(space), {
      id,
      scopeKey: "space",
    });

  /** The confidentiality atoms the label the store holds on `id` carries. */
  const storedAtoms = async (space: MemorySpace, id: URI) =>
    (((await storedDoc(space, id)) as Stored | null)?.cfc?.labelMap.entries ??
      []).flatMap((entry) =>
        (entry as { label: { confidentiality?: unknown[] } }).label
          .confidentiality ?? []
      );

  /**
   * Adds `entries` to the label stored on the record `key` names in `space`,
   * with the client's authority, and returns the record's id.
   */
  const plant = async (
    space: MemorySpace,
    key: string,
    entries: FabricValue[],
  ): Promise<URI> => {
    const cell = client.getCell(space, key);
    await cell.sync();
    const id = cell.getAsNormalizedFullLink().id as URI;
    const address = { space, scope: "space" as const, id, path: [] };
    const tx = client.edit();
    const current = storedFields(tx, address) as Stored;
    if (current.cfc === undefined) writeSeedEnvelopeDoc(tx, space);
    const cfc = current.cfc ?? {
      version: 1,
      schemaHash: SEED_ENVELOPE_SCHEMA_HASH,
      labelMap: { version: 1, entries: [] },
    };
    seedStoredEnvelope(tx, address, {
      ...current,
      cfc: {
        ...cfc,
        labelMap: {
          ...cfc.labelMap,
          entries: [...cfc.labelMap.entries, ...entries],
        },
      },
    } as unknown as FabricValue);
    expect((await tx.commit().settled).error).toBeUndefined();
    return id;
  };

  /** Resolves once the serving runtime's replica shows `atom` on `id`. */
  const servingSees = (space: MemorySpace, key: string, atom: string) =>
    awaitReplica(servingRuntime!.storageManager, async () => {
      const serving = servingRuntime!;
      await serving.getCell(space, key).sync();
      const tx = serving.edit();
      try {
        const id = serving.getCell(space, key, undefined, tx)
          .getAsNormalizedFullLink().id;
        return (readStoredCfcMetadata(tx, { space, id })?.labelMap.entries ??
          []).some((entry) =>
            (entry.label.confidentiality ?? []).includes(atom as never)
          );
      } finally {
        tx.abort();
      }
    });

  /**
   * A served instantiation of `pattern` in `space`, as
   * `servedInstantiatePiece()` makes one in a lifecycle verb on the home
   * space: the trigger, then a setup in a stamped bookkeeping transaction,
   * which carries `carriage` into a space the runtime does not serve.
   * Returns, once the verb's writes are durable, the setup's commit error if
   * any, and the atoms the store held on the entry's source record when the
   * trigger returned, ahead of the wave the verb's cycle commits.
   */
  const instantiate = (
    space: MemorySpace,
    pattern: Awaited<ReturnType<typeof compileIntoHome>>,
    cause: string,
    carriage?: DelegatedCarriage,
  ) =>
    host.runLifecycleVerb(homeSpace, {
      name: "instantiate",
      run: async (runtime) => {
        await runtime.idle();
        await runtime.patternManager.prepareSourceClosureVerification(space, [
          ENTRY_IDENTITY,
        ]);
        const atomsAfterTrigger = await storedAtoms(
          space,
          idOf(space, sourceDocKey(ENTRY_IDENTITY)),
        );
        const piece = runtime.getCell(space, cause, pattern.resultSchema);
        const outcome = await runtime.editWithRetry((tx) => {
          runtime.stampServerRun(tx, {
            actionId: `test/instantiate/${cause}`,
            kind: "bookkeeping",
            ...runtime.delegationForWriteTo(space, carriage),
          });
          void runtime.setup(tx, pattern, { seed: "c" }, piece, {
            initializePieceSourceHistory: true,
          });
        });
        return { error: outcome.error, atomsAfterTrigger };
      },
    });

  /** The pattern identity the piece `cause` names in `space` stores. */
  const storedPatternIdentity = async (space: MemorySpace, cause: string) => {
    const cell = client.getCell(space, cause);
    await cell.sync();
    return getPatternIdentityRef(cell)?.identity;
  };

  /** The repair's warnings: an error thrown inside it lands here. */
  const repairFailures = () =>
    repairLogs.filter((log) => log.level === "warn").map((log) => ({
      key: log.key,
      messages: log.messages.map(String),
    }));

  /** The outcomes the pattern manager logged for repairs it made. */
  const repairOutcomes = () =>
    repairLogs.filter((log) => log.key === "compile-cache-stamp-repair")
      .map((log) => log.messages.at(-1));

  describe("on a clean closure", () => {
    it("writes nothing, and the setup that follows commits", async () => {
      const pattern = await compileIntoHome();
      const keys = await recordKeys();
      const source = idOf(homeSpace, keys.source);
      const compiled = idOf(homeSpace, keys.compiled);
      const heads = [
        await storedHead(homeSpace, source),
        await storedHead(homeSpace, compiled),
      ];
      expect(heads[0]).toBeGreaterThan(0);
      const batchesBefore = batches.entries.length;

      await host.runLifecycleVerb(homeSpace, {
        name: "trigger",
        run: (runtime) =>
          runtime.patternManager.prepareSourceClosureVerification(homeSpace, [
            ENTRY_IDENTITY,
          ]),
      });

      expect(
        batches.entries.slice(batchesBefore).filter((batch) =>
          batch.ids.includes(source) || batch.ids.includes(compiled)
        ),
      ).toEqual([]);
      expect([
        await storedHead(homeSpace, source),
        await storedHead(homeSpace, compiled),
      ]).toEqual(heads);

      expect((await instantiate(homeSpace, pattern, "clean-piece")).error)
        .toBeUndefined();
      expect(await storedPatternIdentity(homeSpace, "clean-piece")).toBe(
        ENTRY_IDENTITY,
      );
      expect(repairOutcomes()).toEqual([]);
      expect(repairFailures()).toEqual([]);
      expect(host.stats().unstampedSealRefusals).toBe(0);
    });
  });

  describe("on a closure a stamp labels", () => {
    for (
      const [where, compiledToo] of [
        ["at the source record's root", false],
        ["at the source and compiled records' roots", true],
      ] as const
    ) {
      it(`repairs the records stamped ${where} through a direct commit, and the setup that follows commits`, async () => {
        const pattern = await compileIntoHome();
        const keys = await recordKeys();
        const source = await plant(
          homeSpace,
          keys.source,
          rootPairStamp(UNDECLARED_ATOM),
        );
        const compiled = idOf(homeSpace, keys.compiled);
        if (compiledToo) {
          await plant(homeSpace, keys.compiled, rootPairStamp(UNDECLARED_ATOM));
          expect(await storedAtoms(homeSpace, compiled)).toContain(
            UNDECLARED_ATOM,
          );
        }
        await servingSees(homeSpace, keys.source, UNDECLARED_ATOM);
        expect(await storedAtoms(homeSpace, source)).toContain(
          UNDECLARED_ATOM,
        );
        const sourceValue = (await storedDoc(homeSpace, source) as Stored)
          .value;

        const { error, atomsAfterTrigger } = await instantiate(
          homeSpace,
          pattern,
          "stamped-piece",
        );

        expect(repairFailures()).toEqual([]);
        expect(host.stats().unstampedSealRefusals).toBe(0);
        expect(repairOutcomes()).toEqual(["repaired"]);
        // Durable when the trigger returned, ahead of the verb's wave: the
        // repair committed on its own.
        expect(atomsAfterTrigger).toEqual([]);
        expect(error).toBeUndefined();
        expect(await storedAtoms(homeSpace, source)).toEqual([]);
        expect((await storedDoc(homeSpace, source) as Stored).value).toEqual(
          sourceValue,
        );
        // Erased: the store holds no document there any more.
        if (compiledToo) {
          expect(await storedDoc(homeSpace, compiled)).toBeNull();
        }
        expect(await storedPatternIdentity(homeSpace, "stamped-piece")).toBe(
          ENTRY_IDENTITY,
        );
      });
    }
  });

  describe("on a closure a racing commit changes", () => {
    it("writes nothing over the racing commit to the record, and the setup that follows is refused", async () => {
      // The racing commit lands after the repair verified the record and
      // before the store takes the repair's write of it.

      const pattern = await compileIntoHome();
      const keys = await recordKeys();
      const source = await plant(
        homeSpace,
        keys.source,
        rootPairStamp(UNDECLARED_ATOM),
      );
      await servingSees(homeSpace, keys.source, UNDECLARED_ATOM);
      let racedHead: number | undefined;
      beforeStoreWrites = {
        id: source,
        run: async () => {
          await plant(homeSpace, keys.source, rootPairStamp(RACING_ATOM));
          racedHead = await storedHead(homeSpace, source);
        },
      };

      const { error } = await instantiate(homeSpace, pattern, "raced-piece");

      expect(racedHead).toBeDefined();
      expect(repairFailures()).toEqual([]);
      expect(host.stats().unstampedSealRefusals).toBe(0);
      expect(repairOutcomes()).toEqual(["conflicted"]);
      expect(await storedHead(homeSpace, source)).toBe(racedHead);
      expect(await storedAtoms(homeSpace, source)).toEqual(
        expect.arrayContaining([UNDECLARED_ATOM, RACING_ATOM]),
      );
      expect(String(error?.message)).toContain("misfit");
      expect(await storedPatternIdentity(homeSpace, "raced-piece"))
        .toBeUndefined();
    });

    it("erases nothing where a racing commit relabels the source record that guards an erase", async () => {
      // The guard is read as the verifier reads, and that read still
      // conditions the commit on the record being unchanged, label included.

      const pattern = await compileIntoHome();
      const keys = await recordKeys();
      const source = idOf(homeSpace, keys.source);
      const compiled = await plant(
        homeSpace,
        keys.compiled,
        rootPairStamp(UNDECLARED_ATOM),
      );
      await servingSees(homeSpace, keys.compiled, UNDECLARED_ATOM);
      let racedHead: number | undefined;
      beforeStoreWrites = {
        id: compiled,
        run: async () => {
          await plant(homeSpace, keys.source, rootPairStamp(RACING_ATOM));
          racedHead = await storedHead(homeSpace, source);
        },
      };

      await instantiate(homeSpace, pattern, "guard-raced");

      expect(racedHead).toBeDefined();
      expect(repairOutcomes()).toEqual(["conflicted"]);
      expect(await storedHead(homeSpace, source)).toBe(racedHead);
      expect(await storedAtoms(homeSpace, compiled)).toEqual(
        expect.arrayContaining([UNDECLARED_ATOM]),
      );
    });

    it("repairs the record at the next load, which the race did not stop", async () => {
      // A conflict is a race the next load can win, so the session tries
      // again where a refusal it would not.

      const pattern = await compileIntoHome();
      const keys = await recordKeys();
      const source = await plant(
        homeSpace,
        keys.source,
        rootPairStamp(UNDECLARED_ATOM),
      );
      await servingSees(homeSpace, keys.source, UNDECLARED_ATOM);
      beforeStoreWrites = {
        id: source,
        run: async () => {
          await plant(homeSpace, keys.source, rootPairStamp(RACING_ATOM));
        },
      };
      expect((await instantiate(homeSpace, pattern, "raced-once")).error)
        .toBeDefined();
      await servingSees(homeSpace, keys.source, RACING_ATOM);

      const { error } = await instantiate(homeSpace, pattern, "after-race");

      expect(repairOutcomes()).toEqual(["conflicted", "repaired"]);
      expect(await storedAtoms(homeSpace, source)).toEqual([]);
      expect(error).toBeUndefined();
      expect(await storedPatternIdentity(homeSpace, "after-race")).toBe(
        ENTRY_IDENTITY,
      );
    });
  });

  describe("on a closure reached from a handler's run", () => {
    it("repairs the child's stamped record while the handler's transaction is open, and the handler's run commits", async () => {
      const pattern = await compileIntoHome(LAUNCHER);
      const resultSchema = pattern.resultSchema;
      await host.runLifecycleVerb(homeSpace, {
        name: "instantiate-launcher",
        run: async (runtime) => {
          await runtime.patternManager.prepareSourceClosureVerification(
            homeSpace,
            [LAUNCHER_IDENTITY],
          );
          const piece = runtime.getCell(homeSpace, "launcher", resultSchema);
          const outcome = await runtime.editWithRetry((tx) => {
            runtime.stampServerRun(tx, {
              actionId: "test/instantiate/launcher",
              kind: "bookkeeping",
            });
            void runtime.setup(tx, pattern, {}, piece, {
              initializePieceSourceHistory: true,
              initialPieceSourceOrigin: systemPatternSource(
                "system/stamp-launcher.tsx",
              ),
            });
          });
          expect(outcome.error).toBeUndefined();
          return { rootId: piece.getAsNormalizedFullLink().id };
        },
        demandRoots: (receipt) => [receipt.rootId],
      });
      const keys = await recordKeys(LAUNCHER_IDENTITY);
      const source = await plant(
        homeSpace,
        keys.source,
        rootPairStamp(UNDECLARED_ATOM),
      );
      await servingSees(homeSpace, keys.source, UNDECLARED_ATOM);

      const senderManager = EmulatedStorageManager.connectTo(server, {
        as: aliceSigner,
      });
      const sender = new Runtime({
        apiUrl: new URL(import.meta.url),
        storageManager: senderManager,
        experimental: { serverExecution: true },
      });
      cleanups.push(async () => {
        await sender.dispose();
        await senderManager.close();
      });
      const launcher = sender.getCell<
        { launched: number; launch: { seed: string } }
      >(homeSpace, "launcher", resultSchema);
      await launcher.sync();
      expect(repairOutcomes()).toEqual([]);
      // Each trigger the event's processing makes, with the count the store
      // holds at that moment: the handler's own write of it is in the
      // transaction still open.
      const engine = await server.engineForSpace(homeSpace);
      const launchedId = launcher.key("launched").resolveAsCell()
        .getAsNormalizedFullLink().id;
      const triggers: unknown[] = [];
      const manager = servingRuntime!.patternManager;
      const prepare = manager.prepareSourceClosureVerification.bind(manager);
      using _trigger = stub(
        manager,
        "prepareSourceClosureVerification",
        (space: MemorySpace, identities: Iterable<string>) => {
          const list = [...identities];
          triggers.push({
            space,
            identities: list,
            launched: read(engine, { id: launchedId })?.value,
          });
          return prepare(space, list);
        },
      );
      const eventsBefore = host.stats().events.processed;
      const edit = sender.edit();
      launcher.withTx(edit).key("launch").send({ seed: "h" });
      sender.prepareTxForCommit(edit);
      expect((await edit.commit().settled).error).toBeUndefined();
      await awaitReplica(sender.storageManager, async () => {
        await launcher.sync();
        return launcher.key("launched").get() === 1;
      });
      await host.whenQuiescent();

      expect(triggers).toEqual([{
        space: homeSpace,
        identities: [LAUNCHER_IDENTITY],
        launched: 0,
      }]);
      expect(read(engine, { id: launchedId })?.value).toBe(1);
      expect(host.stats().events.processed).toBeGreaterThan(eventsBefore);
      expect(repairFailures()).toEqual([]);
      expect(host.stats().unstampedSealRefusals).toBe(0);
      expect(repairOutcomes()).toEqual(["repaired"]);
      expect(await storedAtoms(homeSpace, source)).toEqual([]);
    });
  });

  describe("on a closure in a space the runtime does not serve", () => {
    // A space alice owns, as a served `.inSpace()` child's target is the
    // acting user's: a setup there rides the triggering run's §2b delegated
    // carriage, which the repair's own transaction does not carry.

    const carriage: DelegatedCarriage = {
      acting: { user: aliceSigner.did(), session: "stamp-repair-session" },
      capabilityRef: "event-consequence:stamp-repair",
    };

    /** Writes the foreign space's genesis, which names alice its owner, and
     * then the client's compile of the program into it. */
    const createForeignSpace = async () => {
      applyCommit(await server.engineForSpace(foreignSpace), {
        sessionId: "stamp-repair-foreign-genesis",
        space: foreignSpace,
        principal: foreignSpace,
        commit: {
          localSeq: 1,
          reads: { confirmed: [], pending: [] },
          operations: [{
            op: "set",
            id: `of:${foreignSpace}`,
            value: { value: { [aliceSigner.did()]: "OWNER" } },
          }],
        },
      });
      await compileOnClient(foreignSpace);
    };

    it("commits a setup there of a clean closure", async () => {
      // What the refusal below is measured against: a setup there that reads
      // no stamp commits.

      const pattern = await compileIntoHome();
      await createForeignSpace();

      const { error } = await instantiate(
        foreignSpace,
        pattern,
        "foreign-clean",
        carriage,
      );

      expect(error).toBeUndefined();
      expect(await storedPatternIdentity(foreignSpace, "foreign-clean")).toBe(
        ENTRY_IDENTITY,
      );
      expect(repairOutcomes()).toEqual([]);
      expect(host.stats().unstampedSealRefusals).toBe(0);
    });

    it("leaves the stamped record as it was, with the direct commit refused and no wave error, and the setup that follows is refused", async () => {
      const pattern = await compileIntoHome();
      await createForeignSpace();
      const keys = await recordKeys();
      const source = await plant(
        foreignSpace,
        keys.source,
        rootPairStamp(UNDECLARED_ATOM),
      );
      const head = await storedHead(foreignSpace, source);

      const { error, atomsAfterTrigger } = await instantiate(
        foreignSpace,
        pattern,
        "foreign-piece",
        carriage,
      );

      expect(atomsAfterTrigger).toContain(UNDECLARED_ATOM);
      expect(repairFailures()).toEqual([]);
      expect(host.stats().unstampedSealRefusals).toBe(0);
      expect(repairOutcomes()).toEqual(["conflicted"]);
      expect(
        repairLogs.filter((log) =>
          log.key === "compile-cache-stamp-repair-refused"
        ).map((log) =>
          (log.messages.at(-1) as { message?: string } | undefined)?.message
        ),
      ).toEqual([
        expect.stringContaining("a direct commit may write only the serving"),
      ]);
      expect(await storedHead(foreignSpace, source)).toBe(head);
      expect(await storedAtoms(foreignSpace, source)).toContain(
        UNDECLARED_ATOM,
      );
      expect(String(error?.message)).toContain("misfit");
      expect(await storedPatternIdentity(foreignSpace, "foreign-piece"))
        .toBeUndefined();
    });
  });
});
