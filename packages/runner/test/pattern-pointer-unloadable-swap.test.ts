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
    await tx.commit();
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
    await tx.commit();
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
      await otherTx.commit();
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
    await tx.commit();
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
