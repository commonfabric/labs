import { afterEach, describe, it } from "@std/testing/bdd";
import { rawMetaWriteAuthorization } from "../src/meta-seam.ts";
import { expect } from "@std/expect";
import { toFileUrl } from "@std/path";
import { Identity } from "@commonfabric/identity";

import { EmulatedStorageManager } from "../src/storage/cache.deno.ts";
import { newLoopbackServer } from "../src/storage/v2-emulate.ts";
import { Runtime } from "../src/runtime.ts";
import type { Engine } from "../src/harness/engine.ts";
import type { RuntimeProgram } from "../src/harness/types.ts";
import { getMetaLink } from "../src/link-utils.ts";
import { getLogger } from "@commonfabric/utils/logger";
import {
  getPatternIdentityRef,
  getPatternSetupIdentityRef,
  resolveEntryIdentity,
} from "../src/index.ts";
import {
  brandTrustedPattern,
  noteDerivedCopy,
  resolveProducerEntryRef,
  setArtifactEntryRef,
  setPatternSourcePath,
} from "../src/builder/pattern-metadata.ts";

/**
 * Session-synthetic `keyless:` identities must NEVER land in durable state —
 * pattern-manager.ts's own contract ("such refs must never be written into
 * durable state"). The keyless population is runtime-built pattern VALUES
 * whose producing code is module-addressed (the transformer hoists all
 * source-authored lift()/handler() code to cf:module), so nothing keyless
 * should ever need loading: reactive producers re-derive on demand.
 *
 * Three writers touch a minted pattern, and each has to hold the contract
 * (docs/history/plans/server-execution-v2/optimize/
 * keyless-diagnosis-2026-08-27.md analyzes them):
 *   1. `Runner.setup()`'s durable `patternIdentity`/`patternSetupIdentity`
 *      stamps (`entryRefForPattern` always mints, so an `if (entryRef)`
 *      filters nothing);
 *   2. `Runner.#substituteOpPatternRefs`' `$patternRef` sentinel for keyless
 *      map/filter/flatMap ops (written into the node's durable inputs doc);
 *   3. the storage-boundary serializer itself (`patternToEncodableForm`):
 *      the mint sets the pattern's forward entry ref, so the designed
 *      "no entry ref -> full graph" fallback stops firing and every later
 *      boundary write of the VALUE emits the keyless ref.
 *
 * The first test is the blanket pin: a run exercising all three writers must
 * leave NO `keyless:` byte sequence anywhere in the raw sqlite store. The
 * second pins the roll-forward's keyless case: with the running ref keyless,
 * the repair converges the durable pointer to the running pattern's
 * module-addressed PRODUCER (the first real entry ref up the derivation
 * chain / late-indexed identity) instead of refusing.
 */

const signer = await Identity.fromPassphrase("keyless-never-durable");
const space = signer.did();

// Synthetic churn keys, declared as the keys the pointer table holds.
type PointerKey = Parameters<
  Runtime["runner"]["accessForTestingOnly"]["sessionPatternPointers"]["set"]
>[0];

// A minimal map-over-pattern program. Bare-evaluated (non-registering), its
// op pattern carries no content-addressed entry ref, so node instantiation
// mints the op's `keyless:` session identity.
const MAP_PROGRAM_SOURCE = `
import { NAME, pattern, UI, type VNode, Writable } from "commonfabric";

interface ItemIn {
  n: number;
}
interface ItemOut {
  [NAME]: string;
  [UI]: VNode;
  doubled: number;
}

const Item = pattern<ItemIn, ItemOut>(({ n }) => {
  return {
    [NAME]: "item",
    [UI]: <div>{n}</div>,
    doubled: n,
  };
});

export const itemOp = Item;

export default pattern(() => {
  const items = new Writable<number[]>([1, 2, 3]);
  const ui = <div>{items.map((n) => <Item n={n} />)}</div>;
  return {
    [NAME]: "keyless-map-root",
    [UI]: ui,
  };
});
`;

const mapProgram: RuntimeProgram = {
  main: "/main.tsx",
  files: [{ name: "/main.tsx", contents: MAP_PROGRAM_SOURCE }],
};

// The swap-test shape: a hand-built pattern object that never saw a compile.
const handBuiltPattern = () => ({
  argumentSchema: {},
  resultSchema: {
    type: "object",
    properties: { marker: { type: "string" } },
  },
  result: { marker: "hand-built" },
  nodes: [],
});

// A well-formed content identity whose source closure is persisted nowhere —
// the unloadable-vintage stand-in (same construction as
// pattern-pointer-unloadable-swap.test.ts).
const UNLOADABLE_SOURCE = [
  "import { pattern } from 'commonfabric';",
  "export default pattern<Record<string, never>, { marker: string }>(() => {",
  "  return { marker: 'unloadable-vintage' };",
  "});",
  "",
].join("\n");

const unloadableIdentityPromise = resolveEntryIdentity(
  "/main.tsx",
  (name) =>
    name === "/main.tsx"
      ? Promise.resolve(UNLOADABLE_SOURCE)
      : Promise.reject(new Error(`not found: ${name}`)),
);

/** Every occurrence of `needle` across all files under `dir`, with context. */
const scanDirForBytes = async (
  dir: string,
  needle: string,
): Promise<string[]> => {
  const hits: string[] = [];
  const needleBytes = new TextEncoder().encode(needle);
  const scanFile = async (path: string) => {
    const bytes = await Deno.readFile(path);
    for (let i = 0; i + needleBytes.length <= bytes.length; i++) {
      if (bytes[i] !== needleBytes[0]) continue;
      let match = true;
      for (let j = 1; j < needleBytes.length; j++) {
        if (bytes[i + j] !== needleBytes[j]) {
          match = false;
          break;
        }
      }
      if (!match) continue;
      const start = Math.max(0, i - 40);
      const end = Math.min(bytes.length, i + needleBytes.length + 80);
      const context = new TextDecoder("utf-8", { fatal: false })
        .decode(bytes.slice(start, end))
        .replace(/[^\x20-\x7e]/g, ".");
      hits.push(`${path} @${i}: …${context}…`);
    }
  };
  const walk = async (current: string) => {
    for await (const entry of Deno.readDir(current)) {
      const path = `${current}/${entry.name}`;
      if (entry.isDirectory) await walk(path);
      else if (entry.isFile) await scanFile(path);
    }
  };
  await walk(dir);
  return hits;
};

describe("keyless identities never land durably (L3(a), RULED 2026-08-27)", () => {
  let runtime: Runtime | undefined;
  let storageManager: EmulatedStorageManager | undefined;

  afterEach(async () => {
    await runtime?.runner.idlePointerMaintenance();
    await runtime?.dispose();
    await storageManager?.close();
    runtime = undefined;
    storageManager = undefined;
  });

  it("leaves no `keyless:` bytes in the raw store across all three writer paths", async () => {
    const directory = await Deno.makeTempDir({
      prefix: "keyless-never-durable-",
    });
    const store = toFileUrl(`${directory}/`);
    const server = newLoopbackServer({
      subscriptionRefreshDelayMs: 0,
      store,
    });
    storageManager = EmulatedStorageManager.connectTo(server, { as: signer });
    // The SESSION-side instantiation report must keep flowing even though
    // the durable stamp is skipped: cf-harness's stranded-piece guard
    // (`run_pattern` via `keylessSince`) exists to see exactly this
    // evidence, and coupling the observer to the durable write makes it
    // fail open. Collected here so the same test that proves the store
    // stays clean proves the report still happens.
    const reportedIdentities: string[] = [];
    runtime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager,
      onPatternInstantiated: (instantiation) =>
        reportedIdentities.push(instantiation.identity),
    });
    try {
      // Writer 1: Runner.setup's durable pattern-pointer stamps for a
      // hand-built (keyless) root pattern.
      {
        const tx = runtime.edit();
        const cell = runtime.getCell<Record<string, unknown>>(
          space,
          "keyless-writer-1-root",
          undefined,
          tx,
        );
        // deno-lint-ignore no-explicit-any
        const running = runtime.run(tx, handBuiltPattern() as any, {}, cell);
        await tx.commit().settled;
        await running.pull();
        expect(
          reportedIdentities.some((identity) =>
            identity.startsWith("keyless:")
          ),
        ).toBe(true);
      }

      // Writer 2: the map builtin's `$patternRef` sentinel for a keyless op
      // (bare evaluation indexes nothing, so the op pattern has no ref).
      const engine = runtime.harness as Engine;
      const evalResult = await engine.compileAndEvaluateModules(mapProgram);
      const factory = evalResult.main!.default as Parameters<
        Runtime["run"]
      >[1];
      {
        const tx = runtime.edit();
        const cell = runtime.getCell<Record<string, unknown>>(
          space,
          "keyless-writer-2-map",
          undefined,
          tx,
        );
        const running = runtime.run(tx, factory, {}, cell);
        runtime.prepareTxForCommit(tx);
        await tx.commit().settled;
        const cancel = running.sink(() => {});
        await runtime.idle();
        cancel();
      }

      // Writer 3: the storage boundary itself. The root factory was minted a
      // keyless ref by the run above; writing it as a plain VALUE must fall
      // back to the full-graph serialization, not emit the minted ref.
      {
        const tx = runtime.edit();
        const cell = runtime.getCell<Record<string, unknown>>(
          space,
          "keyless-writer-3-value",
          undefined,
          tx,
        );
        cell.withTx(tx).set({ captured: factory });
        await tx.commit().settled;
      }
      // Same boundary, asserted directly: `toJSON` reaches
      // patternToEncodableForm; a minted (keyless) ref must not surface.
      expect(JSON.stringify(factory)).not.toContain("keyless:");

      await runtime.idle();
      await runtime.storageManager.synced();
    } finally {
      await runtime.runner.idlePointerMaintenance();
      await runtime.dispose();
      runtime = undefined;
      await storageManager.close();
      storageManager = undefined;
      await server.close();
    }

    try {
      const hits = await scanDirForBytes(directory, "keyless:");
      expect(hits).toEqual([]);
    } finally {
      await Deno.remove(directory, { recursive: true });
    }
  });

  it("converges an unloadable pointer to the running keyless pattern's producer identity", async () => {
    // The late-indexing window: a pattern evaluated bare (keyless) starts a
    // piece; its module is indexed AFTERWARDS (the production shape where a
    // bundle registers after build-time copies/uses). With the durable
    // pointer then repointed to a definitively unloadable identity, the
    // roll-forward converges to the producer — the first module-addressed
    // (non-keyless) entry ref reachable from the running pattern value —
    // rather than refusing for want of anything durable to write.
    storageManager = EmulatedStorageManager.emulate({ as: signer });
    runtime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager,
    });

    const engine = runtime.harness as Engine;
    const evalResult = await engine.compileAndEvaluateModules(mapProgram);
    const factory = evalResult.main!.default as Parameters<Runtime["run"]>[1];
    // Bare evaluation indexed nothing: keyless going in.
    expect(runtime.patternManager.getArtifactEntryRef(factory as object))
      .toBeUndefined();

    const tx = runtime.edit();
    const cell = runtime.getCell<Record<string, unknown>>(
      space,
      "keyless-producer-converge",
      undefined,
      tx,
    );
    const running = runtime.run(tx, factory, {}, cell);
    runtime.prepareTxForCommit(tx);
    await tx.commit().settled;
    const cancel = running.sink(() => {});
    await runtime.idle();

    // The module registers AFTER the piece started: the pattern's structure
    // is now addressable under its real content identity.
    runtime.patternManager.registerEvaluatedModules(evalResult);
    const realRef = runtime.patternManager.getArtifactEntryRef(
      factory as object,
    );
    expect(realRef).toBeDefined();
    expect(realRef!.identity).not.toMatch(/^keyless:/);

    // Repoint the durable pointer at a definitively unloadable identity.
    const unloadableIdentity = await unloadableIdentityPromise;
    {
      const repointTx = runtime.edit();
      cell.withTx(repointTx).setMetaRaw("patternIdentity", {
        identity: unloadableIdentity,
        symbol: "default",
      }, rawMetaWriteAuthorization);
      await repointTx.commit().settled;
    }
    await runtime.idle();
    await runtime.runner.idlePointerMaintenance();
    await runtime.idle();
    await runtime.runner.idlePointerMaintenance();

    // Converged to the producer's real identity — not left unloadable, and
    // never a `keyless:` write.
    const healed = getPatternIdentityRef(cell);
    expect(healed?.identity).toBe(realRef!.identity);
    cancel();
    await runtime.idle();
  });

  it("heals a legacy durable keyless pointer over a running real pattern", async () => {
    // Pre-guard stores carry durable `keyless:` pattern pointers (today's
    // leaked orphans). Read back while a REAL pattern runs, such a pointer is
    // definitively unloadable in every session and every CFC mode — the
    // watcher tolerates it (debug record, no load probe) and, with the heal
    // family on, rolls the pointer forward to the running identity.
    storageManager = EmulatedStorageManager.emulate({ as: signer });
    runtime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager,
    });
    const tx = runtime.edit();
    const compiled = await runtime.patternManager.compilePattern(mapProgram, {
      space,
      tx,
    });
    const realRef = runtime.patternManager.getArtifactEntryRef(
      compiled as object,
    )!;
    const cell = runtime.getCell<Record<string, unknown>>(
      space,
      "legacy-keyless-pointer-heal",
      undefined,
      tx,
    );
    const running = runtime.run(
      tx,
      compiled as Parameters<Runtime["run"]>[1],
      {},
      cell,
    );
    runtime.prepareTxForCommit(tx);
    await tx.commit().settled;
    const cancel = running.sink(() => {});
    await runtime.idle();
    expect(getPatternIdentityRef(cell)?.identity).toBe(realRef.identity);

    // The legacy orphan: a durable keyless pointer from a pre-guard session
    // (never minted here, so the in-memory index cannot serve it either).
    {
      const repointTx = runtime.edit();
      cell.withTx(repointTx).setMetaRaw("patternIdentity", {
        identity: "keyless:fid1:legacy-orphan-from-a-pre-guard-session",
        symbol: "default",
      }, rawMetaWriteAuthorization);
      await repointTx.commit().settled;
    }
    await runtime.idle();
    await runtime.runner.idlePointerMaintenance();
    await runtime.idle();
    await runtime.runner.idlePointerMaintenance();

    expect(getPatternIdentityRef(cell)?.identity).toBe(realRef.identity);
    cancel();
    await runtime.idle();
  });

  it("tolerates a legacy keyless pointer in the start walk: not started, not rejected", async () => {
    // The boot-walk face of the same legacy state: starting a piece whose
    // durable pointer is a pre-guard keyless orphan must not fail the walk
    // with a load rejection — the pointer is unloadable by construction, the
    // piece is reported as not started (the tolerated orphan), and the debug
    // record says why.
    storageManager = EmulatedStorageManager.emulate({ as: signer });
    runtime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager,
    });
    const tx = runtime.edit();
    const cell = runtime.getCell<Record<string, unknown>>(
      space,
      "legacy-keyless-pointer-start",
      undefined,
      tx,
    );
    cell.withTx(tx).set({ marker: "orphan" });
    cell.withTx(tx).setMetaRaw("patternIdentity", {
      identity: "keyless:fid1:legacy-orphan-from-a-pre-guard-session",
      symbol: "default",
    }, rawMetaWriteAuthorization);
    await tx.commit().settled;
    await runtime.idle();

    const started = await runtime.runner.start(cell);
    expect(started).toBe(false);
  });

  it("a derived copy sheds its pre-registration keyless shadow once the root promotes", async () => {
    // The late-indexing window crossed with a build-time copy: a copy made
    // while the root's only ref was the session mint must not pin that
    // keyless ref (getArtifactEntryRef consults the exact object first, so
    // a pinned copy would shadow the root's later REAL promotion forever —
    // leaving the copy's pieces pointer-less and its boundary form embedded
    // in a fresh runtime).
    storageManager = EmulatedStorageManager.emulate({ as: signer });
    runtime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager,
    });
    const engine = runtime.harness as Engine;
    const evalResult = await engine.compileAndEvaluateModules(mapProgram);
    const factory = evalResult.main!.default as object;

    // Mint the session identity on the (still unregistered) root, then make
    // a derivation copy while the root is keyless.
    const minted = runtime.patternManager.ensureKeylessPatternIdentity(
      factory as never,
    );
    expect(minted.identity).toMatch(/^keyless:/);
    const copy = { derivedCopyOf: "map-root" };
    noteDerivedCopy(copy, factory);

    // The module registers: the root's ref promotes to its real identity.
    runtime.patternManager.registerEvaluatedModules(evalResult);
    const rootRef = runtime.patternManager.getArtifactEntryRef(factory);
    expect(rootRef).toBeDefined();
    expect(rootRef!.identity).not.toMatch(/^keyless:/);

    // The copy resolves through the root and sees the REAL identity.
    const copyRef = runtime.patternManager.getArtifactEntryRef(copy);
    expect(copyRef?.identity).toBe(rootRef!.identity);
  });

  it("a keyed piece re-setup with a keyless pattern sheds its stale durable pointer", async () => {
    // The reverse handoff: a piece that once carried a REAL durable pointer
    // is re-setup with a hand-built (keyless) pattern. The keyless setup
    // stamps nothing — so it must CLEAR the stale pointer and setup marker,
    // or later starts (fresh sessions especially) would select the old
    // pattern over the state setup just staged.
    storageManager = EmulatedStorageManager.emulate({ as: signer });
    runtime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager,
    });
    const tx = runtime.edit();
    const compiled = await runtime.patternManager.compilePattern(mapProgram, {
      space,
      tx,
    });
    const cell = runtime.getCell<Record<string, unknown>>(
      space,
      "keyed-to-keyless-supersede",
      undefined,
      tx,
    );
    const running = runtime.run(
      tx,
      compiled as Parameters<Runtime["run"]>[1],
      {},
      cell,
    );
    runtime.prepareTxForCommit(tx);
    await tx.commit().settled;
    const cancel = running.sink(() => {});
    await runtime.idle();
    expect(getPatternIdentityRef(cell)).toBeDefined();
    cancel();
    runtime.runner.stop(cell);

    const tx2 = runtime.edit();
    // deno-lint-ignore no-explicit-any
    const rerun = runtime.run(tx2, handBuiltPattern() as any, {}, cell);
    await tx2.commit().settled;
    await rerun.pull();

    expect(getPatternIdentityRef(cell)).toBeUndefined();
    expect(getPatternSetupIdentityRef(cell)).toBeUndefined();
  });

  it("a fresh session replays a keyless piece's setup without restaging its stored argument", async () => {
    // The cross-session `cf cell get` transform shape: session A sets up a
    // keyless piece over a deterministic doc; session B (fresh runtime, no
    // durable pointer, no setup marker — the keyless piece's designed
    // durable verdict) re-runs the structurally same pattern on the same
    // doc. Zero evidence of any update exists, so setup must NOT restage —
    // restaging validates the stored argument against the candidate schema
    // and rewrites defaults, and the transform replay failed exactly there
    // ("additional property"). The pattern's schema rejects extras; the
    // stored argument carries one (written un-validated by A's plain
    // new-cell path, as materialized link reads do in production).
    const directory = await Deno.makeTempDir({ prefix: "keyless-replay-" });
    const store = toFileUrl(`${directory}/`);
    const server = newLoopbackServer({
      subscriptionRefreshDelayMs: 0,
      store,
    });
    const strictPattern = () => ({
      argumentSchema: {
        type: "object",
        properties: { v: { type: "number" } },
        additionalProperties: false,
      },
      resultSchema: {
        type: "object",
        properties: { out: { type: "number" } },
      },
      result: { out: { $alias: { cell: "argument", path: ["v"] } } },
      nodes: [],
    });
    try {
      const managerA = EmulatedStorageManager.connectTo(server, {
        as: signer,
      });
      const runtimeA = new Runtime({
        apiUrl: new URL(import.meta.url),
        storageManager: managerA,
      });
      try {
        const tx = runtimeA.edit();
        const cell = runtimeA.getCell<Record<string, unknown>>(
          space,
          "keyless-cross-session-replay",
          undefined,
          tx,
        );
        const running = runtimeA.run(
          tx,
          // deno-lint-ignore no-explicit-any
          strictPattern() as any,
          { v: 1, extra: 2 },
          cell,
        );
        await tx.commit().settled;
        await running.pull();
        await runtimeA.storageManager.synced();
      } finally {
        await runtimeA.runner.idlePointerMaintenance();
        await runtimeA.dispose();
        await managerA.close();
      }

      storageManager = EmulatedStorageManager.connectTo(server, {
        as: signer,
      });
      runtime = new Runtime({
        apiUrl: new URL(import.meta.url),
        storageManager,
      });
      const tx2 = runtime.edit();
      const cell2 = runtime.getCell<Record<string, unknown>>(
        space,
        "keyless-cross-session-replay",
        undefined,
        tx2,
      );
      await cell2.sync();
      const rerun = runtime.run(
        tx2,
        // deno-lint-ignore no-explicit-any
        strictPattern() as any,
        { v: 1, extra: 2 },
        cell2,
      );
      const committed = await tx2.commit().settled;
      expect(committed.error).toBeUndefined();
      const value = await rerun.pull();
      expect((value as { out?: number })?.out).toBe(1);
    } finally {
      await server.close();
      await Deno.remove(directory, { recursive: true });
    }
  });

  it("a failed keyless re-setup restores the prior session pointer", async () => {
    // The durable stamp was transactional: keyless P1's stamp survived a
    // LATER setup's failed transaction untouched. The session pointer that
    // replaced it is set eagerly at staging (mirroring
    // `locallyPreparedResults`), so the failure cleanup must RESTORE the
    // prior committed pointer — deleting it would leave the still-running
    // P1 piece pointer-less: start-by-pointer dead, marker absent (the
    // evicted/zero-evidence shape) — a piece this session owns turning
    // unresolvable because someone ELSE's setup failed.
    storageManager = EmulatedStorageManager.emulate({ as: signer });
    runtime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager,
    });
    const tx = runtime.edit();
    const cell = runtime.getCell<Record<string, unknown>>(
      space,
      "failed-resetup-restores-pointer",
      undefined,
      tx,
    );
    // deno-lint-ignore no-explicit-any
    const running = runtime.run(tx, handBuiltPattern() as any, {}, cell);
    await tx.commit().settled;
    await running.pull();
    const first = runtime.runner.sessionPatternPointerFor(cell);
    expect(first).toBeDefined();
    runtime.runner.stop(cell);

    // A structurally DIFFERENT keyless pattern staged over it; the staging
    // transaction dies before commit.
    const differentPattern = {
      ...handBuiltPattern(),
      result: { marker: "hand-built-v2" },
    };
    const tx2 = runtime.edit();
    // deno-lint-ignore no-explicit-any
    runtime.run(tx2, differentPattern as any, {}, cell);
    expect(runtime.runner.sessionPatternPointerFor(cell)?.identity)
      .not.toBe(first!.identity);
    tx2.abort();

    expect(runtime.runner.sessionPatternPointerFor(cell)?.identity).toBe(
      first!.identity,
    );
  });

  it("a failed REAL re-setup keeps the keyless session pointer; a committed one sheds it", async () => {
    // The other half of the same transactional semantics: a real pattern's
    // setup deletes the session pointer because its durable stamps
    // supersede it — but the stamps are staged IN the transaction, so the
    // delete must land with the commit, not at staging, or a failed real
    // re-setup drops the pointer while its stamps roll back, leaving the
    // keyless piece with neither.
    storageManager = EmulatedStorageManager.emulate({ as: signer });
    runtime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager,
    });
    const setupTx = runtime.edit();
    const compiled = await runtime.patternManager.compilePattern({
      main: "/main.tsx",
      files: [{
        name: "/main.tsx",
        contents: [
          "import { pattern } from 'commonfabric';",
          "export default pattern<Record<string, never>, { marker: string }>(",
          "  () => ({ marker: 'real-resetup' }),",
          ");",
          "",
        ].join("\n"),
      }],
    }, {
      space,
      tx: setupTx,
    });
    const cell = runtime.getCell<Record<string, unknown>>(
      space,
      "failed-real-resetup-keeps-pointer",
      undefined,
      setupTx,
    );
    // deno-lint-ignore no-explicit-any
    const running = runtime.run(setupTx, handBuiltPattern() as any, {}, cell);
    await setupTx.commit().settled;
    await running.pull();
    const first = runtime.runner.sessionPatternPointerFor(cell);
    expect(first).toBeDefined();
    runtime.runner.stop(cell);

    // Real re-setup whose transaction dies: stamps roll back, pointer stays.
    const tx2 = runtime.edit();
    runtime.run(tx2, compiled as Parameters<Runtime["run"]>[1], {}, cell);
    tx2.abort();
    expect(getPatternIdentityRef(cell)).toBeUndefined();
    expect(runtime.runner.sessionPatternPointerFor(cell)?.identity).toBe(
      first!.identity,
    );

    // The same re-setup COMMITTED: durable stamps land, pointer sheds.
    const tx3 = runtime.edit();
    const rerun = runtime.run(
      tx3,
      compiled as Parameters<Runtime["run"]>[1],
      {},
      cell,
    );
    await tx3.commit().settled;
    await rerun.pull();
    expect(getPatternIdentityRef(cell)).toBeDefined();
    expect(runtime.runner.sessionPatternPointerFor(cell)).toBeUndefined();
    runtime.runner.stop(cell);
  });

  it("an evicted session pointer does not masquerade as the zero-evidence state", async () => {
    // The session pointer map is BOUNDED: past its capacity a long-lived
    // session (a server streaming keyless `cf cell get` transforms) evicts its
    // oldest entries. An evicted piece then reads pointer-absent AND
    // marker-absent — byte-identical to the DESIGNED zero-evidence state (a
    // fresh session replaying a keyless piece) — so a DIFFERENT keyless
    // pattern staged over it with no supplied argument would skip exactly
    // the restage validation the un-evicted state performed, reading stale
    // argument bytes through the new schema unvalidated. Eviction is
    // "evidence unknown", not "no evidence": the eviction tombstone forces
    // the conservative restage, whose validation rejects the stored
    // argument the new pattern cannot read — loudly.
    storageManager = EmulatedStorageManager.emulate({ as: signer });
    runtime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager,
    });
    // Accepts extras…
    const loosePattern = () => ({
      argumentSchema: { type: "object" },
      resultSchema: {
        type: "object",
        properties: { out: { type: "number" } },
      },
      result: { out: { $alias: { cell: "argument", path: ["v"] } } },
      nodes: [],
    });
    // …the re-setup pattern does not.
    const strictPattern = () => ({
      argumentSchema: {
        type: "object",
        properties: { v: { type: "number" } },
        additionalProperties: false,
      },
      resultSchema: {
        type: "object",
        properties: { out: { type: "number" } },
      },
      result: { out: { $alias: { cell: "argument", path: ["v"] } } },
      nodes: [],
    });

    const tx = runtime.edit();
    const cell = runtime.getCell<Record<string, unknown>>(
      space,
      "evicted-pointer-not-zero-evidence",
      undefined,
      tx,
    );
    const running = runtime.run(
      tx,
      // deno-lint-ignore no-explicit-any
      loosePattern() as any,
      { v: 1, extra: 2 },
      cell,
    );
    await tx.commit().settled;
    await running.pull();
    expect(runtime.runner.sessionPatternPointerFor(cell)).toBeDefined();
    runtime.runner.stop(cell);

    // Capacity-evict the piece's pointer with synthetic churn — the map's
    // REAL eviction path, just fed faster than a server would.
    const pointers = runtime.runner.accessForTestingOnly.sessionPatternPointers;
    for (
      let i = 0;
      runtime.runner.sessionPatternPointerFor(cell) !== undefined;
      i++
    ) {
      if (i > 100_000) throw new Error("the pointer never evicted");
      pointers.set(`synthetic/${i}` as PointerKey, {
        identity: `keyless:churn-${i}`,
        symbol: "default",
      });
    }

    // The different-pattern re-setup with NO supplied argument: the restage
    // decision is the only validation gate left, and it must fire.
    const tx2 = runtime.edit();
    let loud = false;
    try {
      const rerun = runtime.run(
        tx2,
        // deno-lint-ignore no-explicit-any
        strictPattern() as any,
        undefined,
        cell,
      );
      const committed = await tx2.commit().settled;
      if (committed.error !== undefined) loud = true;
      else await rerun.pull();
    } catch {
      loud = true;
    }
    expect(loud).toBe(true);
  });

  it("an evicted pointer does not force a restage onto the SAME pattern's replay", async () => {
    // The discriminating half of the eviction tombstone: it records WHICH
    // pattern the evicted pointer named. A re-setup with the SAME mint (the
    // session identity is a stable content hash of the pattern structure —
    // the cf-get transform replay shape) is evidence AGREEING with the
    // stored setup, so the exemption's protective verdict stands: no
    // restage — restaging would strictly validate a stored argument the
    // original staging never validated (the production incident this
    // exemption ships for). Only an eviction tombstone naming a DIFFERENT
    // identity forces the conservative restage.
    storageManager = EmulatedStorageManager.emulate({ as: signer });
    runtime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager,
    });
    // Accepts nothing beyond `v` — but the stored argument will carry an
    // extra property, written unvalidated by the plain-cell path (as
    // materialized link reads do in production).
    const strictPattern = () => ({
      argumentSchema: {
        type: "object",
        properties: { v: { type: "number" } },
        additionalProperties: false,
      },
      resultSchema: {
        type: "object",
        properties: { out: { type: "number" } },
      },
      result: { out: { $alias: { cell: "argument", path: ["v"] } } },
      nodes: [],
    });

    const tx = runtime.edit();
    const cell = runtime.getCell<Record<string, unknown>>(
      space,
      "evicted-pointer-same-pattern-replay",
      undefined,
      tx,
    );
    const running = runtime.run(
      tx,
      // deno-lint-ignore no-explicit-any
      strictPattern() as any,
      { v: 1, extra: 2 },
      cell,
    );
    await tx.commit().settled;
    await running.pull();
    expect(runtime.runner.sessionPatternPointerFor(cell)).toBeDefined();
    runtime.runner.stop(cell);

    // Capacity-evict the pointer (same churn as above).
    const pointers = runtime.runner.accessForTestingOnly.sessionPatternPointers;
    for (
      let i = 0;
      runtime.runner.sessionPatternPointerFor(cell) !== undefined;
      i++
    ) {
      if (i > 100_000) throw new Error("the pointer never evicted");
      pointers.set(`same-synthetic/${i}` as PointerKey, {
        identity: `keyless:churn-${i}`,
        symbol: "default",
      });
    }

    // The SAME pattern's replay (structurally identical build → same mint)
    // must not be broken by the eviction: no restage, no validation error.
    const tx2 = runtime.edit();
    const rerun = runtime.run(
      tx2,
      // deno-lint-ignore no-explicit-any
      strictPattern() as any,
      { v: 1, extra: 2 },
      cell,
    );
    const committed = await tx2.commit().settled;
    expect(committed.error).toBeUndefined();
    const value = await rerun.pull();
    expect((value as { out?: number })?.out).toBe(1);
  });

  it("a tombstone never keeps an identity that failed to commit", async () => {
    // The corner where the two bounded maps meet: a staged keyless setup's
    // pointer is set eagerly, so a capacity wave passing through the
    // STAGING WINDOW evicts an identity that has not committed — and if
    // that staging then fails, the tombstone would name a pointer that was
    // never the doc's committed state. A later replay of the pattern that
    // DID commit would read a different-identity tombstone and restage —
    // the same-pattern replay failure reintroduced through the side door.
    // The failure cleanup re-points such a tombstone at the last committed
    // pointer.
    storageManager = EmulatedStorageManager.emulate({ as: signer });
    runtime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager,
    });
    const strictPattern = () => ({
      argumentSchema: {
        type: "object",
        properties: { v: { type: "number" } },
        additionalProperties: false,
      },
      resultSchema: {
        type: "object",
        properties: { out: { type: "number" } },
      },
      result: { out: { $alias: { cell: "argument", path: ["v"] } } },
      nodes: [],
    });

    const tx = runtime.edit();
    const cell = runtime.getCell<Record<string, unknown>>(
      space,
      "tombstone-uncommitted-identity",
      undefined,
      tx,
    );
    const running = runtime.run(
      tx,
      // deno-lint-ignore no-explicit-any
      strictPattern() as any,
      { v: 1, extra: 2 },
      cell,
    );
    await tx.commit().settled;
    await running.pull();
    runtime.runner.stop(cell);

    // A DIFFERENT keyless setup staged over it (pointer set eagerly). Its
    // schema is permissive so the restage validation the different-pattern
    // staging performs passes — this scenario is about the COMMIT dying,
    // not the staging.
    const stagedOnlyPattern = {
      argumentSchema: { type: "object" },
      resultSchema: {
        type: "object",
        properties: { marker: { type: "string" } },
      },
      result: { marker: "staged-only" },
      nodes: [],
    };
    const tx2 = runtime.edit();
    const rerun = runtime.run(
      tx2,
      // deno-lint-ignore no-explicit-any
      stagedOnlyPattern as any,
      undefined,
      cell,
    );
    void rerun;
    // …then a capacity wave evicts the STAGED pointer inside its own
    // staging window…
    const pointers = runtime.runner.accessForTestingOnly.sessionPatternPointers;
    for (
      let i = 0;
      runtime.runner.sessionPatternPointerFor(cell) !== undefined;
      i++
    ) {
      if (i > 100_000) throw new Error("the pointer never evicted");
      pointers.set(`uncommitted-synthetic/${i}` as PointerKey, {
        identity: `keyless:churn-${i}`,
        symbol: "default",
      });
    }
    // …and the staging fails.
    tx2.abort();

    // The COMMITTED pattern's replay must keep the exemption: the tombstone
    // may not pin the aborted staging's identity as this doc's evidence.
    const tx3 = runtime.edit();
    const replay = runtime.run(
      tx3,
      // deno-lint-ignore no-explicit-any
      strictPattern() as any,
      { v: 1, extra: 2 },
      cell,
    );
    const committed = await tx3.commit().settled;
    expect(committed.error).toBeUndefined();
    const value = await replay.pull();
    expect((value as { out?: number })?.out).toBe(1);
  });

  it("a first-ever staging evicted mid-window leaves no tombstone when it fails", async () => {
    // The delete arm of the same repair: this session had NO committed
    // pointer for the doc before the failed staging, so there is nothing
    // for the tombstone to fall back to — it is removed, restoring the
    // designed zero-evidence verdict, exactly as if the aborted staging
    // had never happened. Discriminating shape (a surviving tombstone
    // must fail this test): the doc is a CROSS-SESSION one whose stored
    // argument carries an extra the strict re-setup's schema rejects —
    // the zero-evidence exemption skips that validation, while a
    // tombstone left by the aborted staging would read as
    // different-identity evidence and force the restage that rejects it.
    const directory = await Deno.makeTempDir({
      prefix: "keyless-tombstone-delete-",
    });
    const store = toFileUrl(`${directory}/`);
    const server = newLoopbackServer({
      subscriptionRefreshDelayMs: 0,
      store,
    });
    const loosePattern = () => ({
      argumentSchema: { type: "object" },
      resultSchema: {
        type: "object",
        properties: { out: { type: "number" } },
      },
      result: { out: { $alias: { cell: "argument", path: ["v"] } } },
      nodes: [],
    });
    const strictPattern = () => ({
      argumentSchema: {
        type: "object",
        properties: { v: { type: "number" } },
        additionalProperties: false,
      },
      resultSchema: {
        type: "object",
        properties: { out: { type: "number" } },
      },
      result: { out: { $alias: { cell: "argument", path: ["v"] } } },
      nodes: [],
    });
    try {
      // Session A stages the stored argument (extras allowed) and dies.
      const managerA = EmulatedStorageManager.connectTo(server, {
        as: signer,
      });
      const runtimeA = new Runtime({
        apiUrl: new URL(import.meta.url),
        storageManager: managerA,
      });
      try {
        const tx = runtimeA.edit();
        const cell = runtimeA.getCell<Record<string, unknown>>(
          space,
          "tombstone-first-staging-clears",
          undefined,
          tx,
        );
        const running = runtimeA.run(
          tx,
          // deno-lint-ignore no-explicit-any
          loosePattern() as any,
          { v: 1, extra: 2 },
          cell,
        );
        await tx.commit().settled;
        await running.pull();
        await runtimeA.storageManager.synced();
      } finally {
        await runtimeA.runner.idlePointerMaintenance();
        await runtimeA.dispose();
        await managerA.close();
      }

      // Session B: first-EVER keyless staging for this doc HERE (no
      // committed pointer in B), evicted inside its own staging window,
      // then failed.
      storageManager = EmulatedStorageManager.connectTo(server, {
        as: signer,
      });
      runtime = new Runtime({
        apiUrl: new URL(import.meta.url),
        storageManager,
      });
      const cell2 = runtime.getCell<Record<string, unknown>>(
        space,
        "tombstone-first-staging-clears",
      );
      await cell2.sync();
      // The result document carries its argument link as data, and the run
      // reads the argument document, so it is named here: a run that finds
      // it absent is held for a name-sync, and the staging below is meant
      // to happen in this turn.
      const argumentLink = getMetaLink(cell2, "argument");
      expect(argumentLink).toBeDefined();
      await runtime.getCellFromLink(argumentLink!).sync();
      const tx2 = runtime.edit();
      // deno-lint-ignore no-explicit-any
      runtime.run(tx2, handBuiltPattern() as any, undefined, cell2);
      expect(runtime.runner.sessionPatternPointerFor(cell2)).toBeDefined();
      const pointers =
        runtime.runner.accessForTestingOnly.sessionPatternPointers;
      for (
        let i = 0;
        runtime.runner.sessionPatternPointerFor(cell2) !== undefined;
        i++
      ) {
        if (i > 100_000) throw new Error("the pointer never evicted");
        pointers.set(`first-staging-synthetic/${i}` as PointerKey, {
          identity: `keyless:churn-${i}`,
          symbol: "default",
        });
      }
      tx2.abort();

      // No tombstone survives: the strict pattern's setup reads the
      // designed zero-evidence state and does NOT restage-validate A's
      // stored argument (which its schema would reject) — a surviving
      // tombstone would force exactly that rejection.
      const tx3 = runtime.edit();
      const rerun = runtime.run(
        tx3,
        // deno-lint-ignore no-explicit-any
        strictPattern() as any,
        { v: 1, extra: 2 },
        cell2,
      );
      const committed = await tx3.commit().settled;
      expect(committed.error).toBeUndefined();
      const value = await rerun.pull();
      expect((value as { out?: number })?.out).toBe(1);
    } finally {
      await server.close();
      await Deno.remove(directory, { recursive: true });
    }
  });

  it("the legacy-tolerance diagnostics render under debug logging", async () => {
    // The tolerance arms log LAZILY: their message closures execute only at
    // debug level, so a closure that throws — a renamed field, a bad
    // interpolation — would break the tolerance path exactly when an
    // operator turns diagnostics on to investigate the legacy state. Drive
    // every arm with debug enabled and assert the tolerated outcomes hold
    // (a crashing closure would fail these loudly).
    const loggers = [getLogger("runner"), getLogger("pattern-manager")];
    const prior = loggers.map((l) => ({
      disabled: l.disabled,
      level: l.level,
    }));
    for (const l of loggers) {
      l.disabled = false;
      l.level = "debug";
    }
    try {
      storageManager = EmulatedStorageManager.emulate({ as: signer });
      runtime = new Runtime({
        apiUrl: new URL(import.meta.url),
        storageManager,
      });
      const orphan = "keyless:fid1:legacy-orphan-from-a-pre-guard-session";

      // Load-skip arm: a keyless identity never probes storage.
      expect(
        await runtime.patternManager.loadPatternByIdentity(
          orphan,
          "default",
          space,
        ),
      ).toBeUndefined();

      // Start-walk tolerance arm: not started, not rejected.
      {
        const tx = runtime.edit();
        const cell = runtime.getCell<Record<string, unknown>>(
          space,
          "debug-diagnostics-start-walk",
          undefined,
          tx,
        );
        cell.withTx(tx).set({ marker: "orphan" });
        cell.withTx(tx).setMetaRaw("patternIdentity", {
          identity: orphan,
          symbol: "default",
        }, rawMetaWriteAuthorization);
        await tx.commit().settled;
        await runtime.idle();
        expect(await runtime.runner.start(cell)).toBe(false);
      }

      // Watcher legacy arm + heal convergence message: a running REAL
      // pattern whose durable pointer is repointed to the orphan converges
      // back to the running identity.
      {
        const tx = runtime.edit();
        const compiled = await runtime.patternManager.compilePattern(
          mapProgram,
          { space, tx },
        );
        const realRef = runtime.patternManager.getArtifactEntryRef(
          compiled as object,
        )!;
        const cell = runtime.getCell<Record<string, unknown>>(
          space,
          "debug-diagnostics-watcher-heal",
          undefined,
          tx,
        );
        const running = runtime.run(
          tx,
          compiled as Parameters<Runtime["run"]>[1],
          {},
          cell,
        );
        runtime.prepareTxForCommit(tx);
        await tx.commit().settled;
        const cancel = running.sink(() => {});
        await runtime.idle();
        {
          const repointTx = runtime.edit();
          cell.withTx(repointTx).setMetaRaw("patternIdentity", {
            identity: orphan,
            symbol: "default",
          }, rawMetaWriteAuthorization);
          await repointTx.commit().settled;
        }
        await runtime.idle();
        await runtime.runner.idlePointerMaintenance();
        await runtime.idle();
        await runtime.runner.idlePointerMaintenance();
        expect(getPatternIdentityRef(cell)?.identity).toBe(realRef.identity);
        cancel();
        await runtime.idle();
      }

      // No-producer refusal arm: an unloadable durable pointer over a
      // running hand-built (keyless, producer-less) pattern is left as
      // written — nothing durable-legal to converge to.
      {
        const tx = runtime.edit();
        const cell = runtime.getCell<Record<string, unknown>>(
          space,
          "debug-diagnostics-no-producer",
          undefined,
          tx,
        );
        // deno-lint-ignore no-explicit-any
        const running = runtime.run(tx, handBuiltPattern() as any, {}, cell);
        await tx.commit().settled;
        await running.pull();
        const unloadableIdentity = await unloadableIdentityPromise;
        {
          const repointTx = runtime.edit();
          cell.withTx(repointTx).setMetaRaw("patternIdentity", {
            identity: unloadableIdentity,
            symbol: "default",
          }, rawMetaWriteAuthorization);
          await repointTx.commit().settled;
        }
        await runtime.idle();
        await runtime.runner.idlePointerMaintenance();
        await runtime.idle();
        await runtime.runner.idlePointerMaintenance();
        expect(getPatternIdentityRef(cell)?.identity).toBe(
          unloadableIdentity,
        );
        runtime.runner.stop(cell);
      }
    } finally {
      loggers.forEach((l, i) => {
        l.disabled = prior[i].disabled;
        l.level = prior[i].level;
      });
    }
  });

  it("the producer walk serves copies and refuses non-artifacts", () => {
    // Non-object values carry no identity facts: the guards return without
    // touching the maps.
    setArtifactEntryRef(42, { identity: "real-guard", symbol: "default" });
    expect(resolveProducerEntryRef(42)).toBeUndefined();
    expect(resolveProducerEntryRef(undefined)).toBeUndefined();

    // The walk STEPS: a copy made while the root was keyless has no own
    // real ref, so the walk follows `derivedFrom` to the root and returns
    // the root's later-promoted real identity.
    storageManager = EmulatedStorageManager.emulate({ as: signer });
    runtime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager,
    });
    const root = handBuiltPattern();
    const minted = runtime.patternManager.ensureKeylessPatternIdentity(
      root as never,
    );
    expect(minted.identity).toMatch(/^keyless:/);
    const copy = { producerWalkCopyOf: "root" };
    noteDerivedCopy(copy, root);
    const realRef = { identity: "producer-walk-real", symbol: "default" };
    setArtifactEntryRef(root, realRef);
    expect(resolveProducerEntryRef(copy)).toEqual(realRef);
  });

  it("the session swap channel tolerates a failed commit and a stopped piece", async () => {
    // The swap request rides the setup transaction's commit callback. Its
    // two refusal arms: a FAILED staging must not swap (the setup never
    // landed), and a swap arriving after the piece was STOPPED must not
    // touch the dead registration (the watcher's cancel already ran).
    storageManager = EmulatedStorageManager.emulate({ as: signer });
    runtime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager,
    });
    const first = handBuiltPattern();
    const second = {
      ...handBuiltPattern(),
      result: { marker: "hand-built-swap-v2" },
    };
    const third = {
      ...handBuiltPattern(),
      result: { marker: "hand-built-swap-v3" },
    };

    const tx = runtime.edit();
    const cell = runtime.getCell<Record<string, unknown>>(
      space,
      "session-swap-corners",
      undefined,
      tx,
    );
    // deno-lint-ignore no-explicit-any
    const running = runtime.run(tx, first as any, {}, cell);
    await tx.commit().settled;
    await running.pull();
    const firstPointer = runtime.runner.sessionPatternPointerFor(cell);
    expect(firstPointer).toBeDefined();

    // Failed staging: the swap callback sees the commit error and returns.
    const tx2 = runtime.edit();
    // deno-lint-ignore no-explicit-any
    runtime.run(tx2, second as any, {}, cell);
    tx2.abort();
    expect(runtime.runner.sessionPatternPointerFor(cell)?.identity).toBe(
      firstPointer!.identity,
    );

    // Stopped between staging and commit: the captured swap handler runs
    // against a deactivated watcher and returns without touching the dead
    // registration. Pinned observables: the committed staging's pointer
    // stands (the setup legitimately landed), and the piece restarts
    // cleanly through the ordinary path — a swap fired against the
    // cancelled registration would leave it wedged or half-instantiated.
    const tx3 = runtime.edit();
    // deno-lint-ignore no-explicit-any
    const third_run = runtime.run(tx3, third as any, {}, cell);
    void third_run;
    const thirdPointer = runtime.runner.sessionPatternPointerFor(cell);
    expect(thirdPointer).toBeDefined();
    runtime.runner.stop(cell);
    const committed = await tx3.commit().settled;
    expect(committed.error).toBeUndefined();
    await runtime.idle();
    expect(runtime.runner.sessionPatternPointerFor(cell)?.identity).toBe(
      thirdPointer!.identity,
    );
    expect(await runtime.runner.start(cell)).toBe(true);
    const restarted = await cell.pull();
    expect((restarted as { marker?: string })?.marker).toBe(
      "hand-built-swap-v3",
    );
    runtime.runner.stop(cell);
  });

  it("a stopped keyless piece restarts through the sync in-session lookup", async () => {
    // Restart-after-stop is one of the sanctioned session-pointer flows:
    // start(resultCell) resolves the pointer, and the minted artifact is
    // LIVE in this session's index, so the start takes the synchronous
    // instantiate path — no storage load for a keyless identity.
    storageManager = EmulatedStorageManager.emulate({ as: signer });
    runtime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager,
    });
    const tx = runtime.edit();
    const cell = runtime.getCell<Record<string, unknown>>(
      space,
      "keyless-restart-sync-path",
      undefined,
      tx,
    );
    // deno-lint-ignore no-explicit-any
    const running = runtime.run(tx, handBuiltPattern() as any, {}, cell);
    await tx.commit().settled;
    await running.pull();
    runtime.runner.stop(cell);

    expect(await runtime.runner.start(cell)).toBe(true);
    const value = await cell.pull();
    expect((value as { marker?: string })?.marker).toBe("hand-built");
    runtime.runner.stop(cell);
  });

  it("counts a keyless mint against a module-indexed pattern (missing-association tripwire)", async () => {
    // The sanctioned keyless population is runtime-BUILT values. A pattern
    // carrying a module-index source path reaching the mint means its
    // content-addressed association went missing — the tripwire counts it.
    storageManager = EmulatedStorageManager.emulate({ as: signer });
    runtime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager,
    });

    // A plain hand-built pattern mints silently: anomaly count stays 0.
    {
      const tx = runtime.edit();
      const cell = runtime.getCell<Record<string, unknown>>(
        space,
        "mint-tripwire-clean",
        undefined,
        tx,
      );
      // deno-lint-ignore no-explicit-any
      const running = runtime.run(tx, handBuiltPattern() as any, {}, cell);
      await tx.commit().settled;
      await running.pull();
      expect(runtime.patternManager.keylessMintAnomalies).toBe(0);
    }

    // The anomaly shape: a "module-indexed" pattern (source path stamped by
    // the indexing loop — always on a branded artifact) that somehow lost
    // its entry-ref association.
    {
      const anomalous = brandTrustedPattern(handBuiltPattern());
      setPatternSourcePath(anomalous, "/tripwire.tsx");
      const tx = runtime.edit();
      const cell = runtime.getCell<Record<string, unknown>>(
        space,
        "mint-tripwire-anomalous",
        undefined,
        tx,
      );
      // deno-lint-ignore no-explicit-any
      const running = runtime.run(tx, anomalous as any, {}, cell);
      await tx.commit().settled;
      await running.pull();
      expect(runtime.patternManager.keylessMintAnomalies).toBe(1);
    }
  });
});
