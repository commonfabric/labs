/**
 * These tests cover a running piece whose durable `patternIdentity` names an
 * identity this runtime cannot load. The watcher sees the pointer as a change,
 * fails the load, and logs "pattern-load-error". Left in place, the pointer
 * would keep naming an identity no session can load, and every start of the
 * piece by identity would fail.
 *
 * With by-identity recovery enabled (CFC enforcement not disabled), a
 * DEFINITIVE load failure of the pointed-at identity while a pattern is RUNNING
 * rolls the pointer back to the running pattern's identity, durably, so the
 * piece converges instead of staying stranded. NOT definitive, and never rolled
 * back: CFC-disabled probes (undefined means "probe unsupported" there), and
 * session-synthetic keyless refs are never written durably.
 *
 * All synchronization goes through runner.idlePointerMaintenance() — the
 * runner suite runs under a frozen clock (test/clock-preload.ts), so
 * wall-clock polling cannot observe this work.
 */

import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { Identity } from "@commonfabric/identity";

import { StorageManager } from "@commonfabric/runner/storage/cache.deno";
import { Runtime } from "../src/runtime.ts";
import { getPatternIdentityRef, resolveEntryIdentity } from "../src/index.ts";
import type { RuntimeProgram } from "../src/harness/types.ts";
import { rawMetaWriteAuthorization } from "../src/meta-seam.ts";

const signer = await Identity.fromPassphrase("pattern-pointer-unloadable");
const space = signer.did();

const V1 = [
  "import { pattern } from 'commonfabric';",
  "export default pattern<Record<string, never>, { marker: string }>(() => {",
  "  return { marker: 'v1' };",
  "});",
  "",
].join("\n");

const V2_LOADABLE = [
  "import { pattern } from 'commonfabric';",
  "export default pattern<Record<string, never>, { marker: string }>(() => {",
  "  return { marker: 'v2' };",
  "});",
  "",
].join("\n");

// A well-formed content identity whose source closure is persisted NOWHERE in
// this store — the "obsolete vintage this runtime cannot load" stand-in.
const UNLOADABLE_SOURCE = [
  "import { pattern } from 'commonfabric';",
  "export default pattern<Record<string, never>, { marker: string }>(() => {",
  "  return { marker: 'unloadable-vintage' };",
  "});",
  "",
].join("\n");

const programOf = (contents: string): RuntimeProgram => ({
  main: "/main.tsx",
  files: [{ name: "/main.tsx", contents }],
});

// A second identity no store holds, for the release between the running
// pattern and the unloadable one.
const INTERMEDIATE_SOURCE = [
  "import { pattern } from 'commonfabric';",
  "export default pattern<Record<string, never>, { marker: string }>(() => {",
  "  return { marker: 'intermediate-release' };",
  "});",
  "",
].join("\n");

const intermediateIdentityPromise = resolveEntryIdentity(
  "/main.tsx",
  (name) =>
    name === "/main.tsx"
      ? Promise.resolve(INTERMEDIATE_SOURCE)
      : Promise.reject(new Error(`not found: ${name}`)),
);

const unloadableIdentityPromise = resolveEntryIdentity(
  "/main.tsx",
  (name) =>
    name === "/main.tsx"
      ? Promise.resolve(UNLOADABLE_SOURCE)
      : Promise.reject(new Error(`not found: ${name}`)),
);

describe("unloadable patternIdentity pointer vs a running pattern", () => {
  let storageManager: ReturnType<typeof StorageManager.emulate>;
  let rt: Runtime;

  const newRuntime = (extra: { cfcEnforcementMode?: "disabled" } = {}) =>
    new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager,
      ...extra,
    });

  beforeEach(() => {
    storageManager = StorageManager.emulate({ as: signer });
  });
  afterEach(async () => {
    // Settle the watcher's load attempt and any roll-forward before teardown
    // so no promise is pending at process exit.
    await rt?.runner.idlePointerMaintenance();
    await rt?.dispose();
    await storageManager?.close();
  });

  const runV1 = async (cause: string) => {
    const tx = rt.edit();
    const v1 = await rt.patternManager.compilePattern(programOf(V1), {
      space,
      tx,
    });
    const v1Ref = rt.patternManager.getArtifactEntryRef(v1)!;
    const cell = rt.getCell<Record<string, unknown>>(
      space,
      cause,
      undefined,
      tx,
    );
    const running = rt.run(tx, v1, {}, cell);
    await tx.commit().settled;
    await running.pull();
    expect((cell.getAsQueryResult() as { marker: string }).marker).toBe("v1");
    expect(getPatternIdentityRef(cell)?.identity).toBe(v1Ref.identity);
    return { cell, v1Ref };
  };

  const repointTo = async (
    cell: ReturnType<Runtime["getCell"]>,
    identity: string,
  ) => {
    const tx = rt.edit();
    cell.withTx(tx).setMetaRaw("patternIdentity", {
      identity,
      symbol: "default",
    }, rawMetaWriteAuthorization);
    await tx.commit().settled;
    await rt.idle();
    // Deterministic: settles the watcher load chain and any roll-forward.
    await rt.runner.idlePointerMaintenance();
    await rt.idle();
    await rt.runner.idlePointerMaintenance();
  };

  it("rolls the pointer back to the running identity", async () => {
    rt = newRuntime();
    const { cell, v1Ref } = await runV1("unloadable-pointer-rollback");
    await repointTo(cell, await unloadableIdentityPromise);

    const ref = getPatternIdentityRef(cell);
    expect(ref?.identity).toBe(v1Ref.identity);
    expect(ref?.symbol).toBe(v1Ref.symbol);
    // The running pattern was never torn down by the failed swap.
    expect((cell.getAsQueryResult() as { marker: string }).marker).toBe("v1");
  });

  // What a newer runtime's adoption writes, staged into `tx`: the update's
  // revision, preceded by a baseline revision for the running pattern when
  // its source was retained, or else a `displacedPattern` record stamped
  // with `displacedAt`; and, unless `movePointer` is false, the pointer.
  const stageRecordedUpdate = (
    tx: ReturnType<Runtime["edit"]>,
    cell: ReturnType<Runtime["getCell"]>,
    running: { identity: string; symbol: string },
    identity: string,
    options: {
      baseline: boolean;
      timestamp: number;
      displacedAt?: number;
      movePointer?: boolean;
    },
  ) => {
    const sourceOf = (id: string) =>
      rt.getCell(space, `pattern:${id}`, undefined, tx).getAsLink();
    const update = {
      revisionId: `update-${options.timestamp}`,
      timestamp: options.timestamp,
      pattern: { identity, symbol: "default" },
      source: sourceOf(identity),
      operation: "origin-update",
    };
    const history = options.baseline
      ? [{
        revisionId: `baseline-${options.timestamp}`,
        timestamp: options.timestamp,
        pattern: { identity: running.identity, symbol: running.symbol },
        source: sourceOf(running.identity),
        operation: "baseline",
      }, update]
      : [update];
    cell.withTx(tx).setMetaRaw(
      "pieceSourceHistory",
      history,
      rawMetaWriteAuthorization,
    );
    if (options.displacedAt !== undefined) {
      cell.withTx(tx).setMetaRaw("displacedPattern", {
        identity: running.identity,
        symbol: running.symbol,
        displacedAt: options.displacedAt,
      }, rawMetaWriteAuthorization);
    }
    if (options.movePointer !== false) {
      cell.withTx(tx).setMetaRaw("patternIdentity", {
        identity,
        symbol: "default",
      }, rawMetaWriteAuthorization);
    }
  };

  const settlePointerMaintenance = async () => {
    await rt.idle();
    await rt.runner.idlePointerMaintenance();
    await rt.idle();
    await rt.runner.idlePointerMaintenance();
  };

  it("stops the piece and keeps a pointer a recorded update moved past the running pattern", async () => {
    // Another runtime, newer than this one, adopted a release this runtime
    // cannot load: its transition records the running pattern as the
    // baseline and the new identity as the update, and moves the pointer in
    // the same commit. This runtime is the one behind. Writing its running
    // identity back would undo the adoption, and the next start of the newer
    // runtime would adopt again, without end. This runtime stops its own copy
    // of the piece instead, which writes nothing.

    rt = newRuntime();
    const { cell, v1Ref } = await runV1(
      "unloadable-pointer-recorded-transition",
    );
    const unloadableIdentity = await unloadableIdentityPromise;
    const tx = rt.edit();
    stageRecordedUpdate(tx, cell, v1Ref, unloadableIdentity, {
      baseline: true,
      timestamp: Date.now(),
    });
    await tx.commit().settled;
    await settlePointerMaintenance();

    expect(getPatternIdentityRef(cell)?.identity).toBe(unloadableIdentity);
    expect(rt.runner.isRunning(cell)).toBe(false);
  });

  it("stops the piece when the recorded update displaced the running pattern without a baseline", async () => {
    // An adoption whose predecessor's source is not retained records no
    // baseline revision; the transition names the predecessor in
    // `displacedPattern`, stamped with its own timestamp.

    rt = newRuntime();
    const { cell, v1Ref } = await runV1("unloadable-pointer-displaced");
    const unloadableIdentity = await unloadableIdentityPromise;
    const timestamp = Date.now();
    const tx = rt.edit();
    stageRecordedUpdate(tx, cell, v1Ref, unloadableIdentity, {
      baseline: false,
      timestamp,
      displacedAt: timestamp,
    });
    await tx.commit().settled;
    await settlePointerMaintenance();

    expect(getPatternIdentityRef(cell)?.identity).toBe(unloadableIdentity);
    expect(rt.runner.isRunning(cell)).toBe(false);
  });

  it("rolls the pointer back when the displaced pattern matches no recorded revision", async () => {
    // A `displacedPattern` record names the predecessor of the transition
    // that wrote it, stamped with that transition's time. One whose time no
    // revision in the history carries is tied to no recorded transition, so
    // the repair rolls the pointer back as it would without any history.

    rt = newRuntime();
    const { cell, v1Ref } = await runV1("unloadable-pointer-stale-displaced");
    const unloadableIdentity = await unloadableIdentityPromise;
    const timestamp = Date.now();
    const tx = rt.edit();
    stageRecordedUpdate(tx, cell, v1Ref, unloadableIdentity, {
      baseline: false,
      timestamp,
      displacedAt: timestamp - 1,
    });
    await tx.commit().settled;
    await settlePointerMaintenance();

    expect(getPatternIdentityRef(cell)?.identity).toBe(v1Ref.identity);
    expect(rt.runner.isRunning(cell)).toBe(true);
  });

  it("stops the piece when a later update follows the one that displaced the running pattern", async () => {
    // The running pattern A was displaced without a baseline by the update
    // to B at T1, and a second update moved B to C at T2 with B as its
    // baseline. The displacement record still names A at T1, the time B's
    // revision carries, so A is two updates behind the pointer.

    rt = newRuntime();
    const { cell, v1Ref } = await runV1("unloadable-pointer-displaced-twice");
    const intermediateIdentity = await intermediateIdentityPromise;
    const unloadableIdentity = await unloadableIdentityPromise;
    const t1 = Date.now();
    const t2 = t1 + 1;
    const tx = rt.edit();
    const sourceOf = (identity: string) =>
      rt.getCell(space, `pattern:${identity}`, undefined, tx).getAsLink();
    const revision = (
      revisionId: string,
      timestamp: number,
      identity: string,
      operation: string,
    ) => ({
      revisionId,
      timestamp,
      pattern: { identity, symbol: "default" },
      source: sourceOf(identity),
      operation,
    });
    cell.withTx(tx).setMetaRaw("pieceSourceHistory", [
      revision("update-b", t1, intermediateIdentity, "origin-update"),
      revision("baseline-b", t2, intermediateIdentity, "baseline"),
      revision("update-c", t2, unloadableIdentity, "origin-update"),
    ], rawMetaWriteAuthorization);
    cell.withTx(tx).setMetaRaw("displacedPattern", {
      identity: v1Ref.identity,
      symbol: v1Ref.symbol,
      displacedAt: t1,
    }, rawMetaWriteAuthorization);
    cell.withTx(tx).setMetaRaw("patternIdentity", {
      identity: unloadableIdentity,
      symbol: "default",
    }, rawMetaWriteAuthorization);
    await tx.commit().settled;
    await settlePointerMaintenance();

    expect(getPatternIdentityRef(cell)?.identity).toBe(unloadableIdentity);
    expect(rt.runner.isRunning(cell)).toBe(false);
  });

  it("stops the piece when the update is recorded while its rollback is pending", async () => {
    // The pointer moves with no record first, so the watcher decides to roll
    // it back. The update's record lands before the rollback's transaction
    // runs; the transaction reads it and writes nothing.

    rt = newRuntime();
    const { cell, v1Ref } = await runV1("unloadable-pointer-in-flight");
    const unloadableIdentity = await unloadableIdentityPromise;
    const editWithRetry = rt.editWithRetry.bind(rt);
    let recorded = false;
    rt.editWithRetry =
      (async (...args: Parameters<Runtime["editWithRetry"]>) => {
        if (!recorded) {
          recorded = true;
          const recordTx = rt.edit();
          stageRecordedUpdate(recordTx, cell, v1Ref, unloadableIdentity, {
            baseline: true,
            timestamp: Date.now(),
            movePointer: false,
          });
          await recordTx.commit().settled;
        }
        return await editWithRetry(...args);
      }) as Runtime["editWithRetry"];
    try {
      await repointTo(cell, unloadableIdentity);
    } finally {
      rt.editWithRetry = editWithRetry;
    }

    expect(recorded).toBe(true);
    expect(getPatternIdentityRef(cell)?.identity).toBe(unloadableIdentity);
    expect(rt.runner.isRunning(cell)).toBe(false);
  });

  it("never rolls back under CFC-disabled probes (undefined is not a verdict)", async () => {
    // With cfcEnforcementMode "disabled", loadPatternByIdentity returns
    // undefined for anything outside the in-memory index — "probe
    // unsupported", not "artifact dead". A legitimate repoint to a LOADABLE
    // identity (persisted by another session) must survive.
    rt = newRuntime({ cfcEnforcementMode: "disabled" });

    // Persist a loadable V2 through a separate enforcing runtime so the
    // artifact genuinely exists in the shared store.
    const other = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager,
      experimental: {},
    });
    let v2Identity: string;
    try {
      const otherTx = other.edit();
      const v2 = await other.patternManager.compilePattern(
        programOf(V2_LOADABLE),
        { space, tx: otherTx },
      );
      v2Identity = other.patternManager.getArtifactEntryRef(v2)!.identity;
      await otherTx.commit().settled;
      await other.idle();
    } finally {
      await other.dispose();
    }

    const { cell } = await runV1("unloadable-pointer-cfc-disabled");
    await repointTo(cell, v2Identity);

    // The repoint stands: no rollback to V1.
    expect(getPatternIdentityRef(cell)?.identity).toBe(v2Identity);
  });

  it("never writes a keyless session pointer durably", async () => {
    // A hand-built (keyless) pattern gets a session-synthetic `keyless:` ref
    // minted and indexed during setup. If its piece is repointed to an
    // unloadable identity, rolling back would write a pointer no fresh
    // runtime can load — so the roll-forward must not engage at all.
    rt = newRuntime();
    const keylessPattern = {
      argumentSchema: {},
      resultSchema: {
        type: "object",
        properties: { marker: { type: "string" } },
      },
      result: { marker: "keyless" },
      nodes: [],
    };
    const tx = rt.edit();
    const cell = rt.getCell<Record<string, unknown>>(
      space,
      "unloadable-pointer-keyless",
      undefined,
      tx,
    );
    // deno-lint-ignore no-explicit-any
    const running = rt.run(tx, keylessPattern as any, {}, cell);
    await tx.commit().settled;
    await running.pull();
    const keylessRef = getPatternIdentityRef(cell);
    if (keylessRef !== undefined) {
      expect(keylessRef.identity).toMatch(/^keyless:/);
    }

    const unloadableIdentity = await unloadableIdentityPromise;
    await repointTo(cell, unloadableIdentity);

    // No rollback: the pointer keeps the (unloadable) repoint rather than
    // gaining a session-synthetic identity.
    expect(getPatternIdentityRef(cell)?.identity).toBe(unloadableIdentity);
  });
});
