import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { Identity } from "@commonfabric/identity";
import type * as MemoryV2Server from "@commonfabric/memory/v2/server";

import { Runtime } from "../src/runtime.ts";
import type { Cell } from "../src/cell.ts";
import type { Pattern } from "../src/builder/types.ts";
import {
  getPatternIdentityRef,
  getPatternSetupIdentityRef,
} from "../src/index.ts";
import type { RuntimeProgram } from "../src/harness/types.ts";
import { rawMetaWriteAuthorization } from "../src/meta-seam.ts";
import { EmulatedStorageManager } from "../src/storage/v2-emulate.ts";
import { newSharedServer } from "./memory-v2-test-utils.ts";

// The patternIdentity watcher's store-load arm (`followPointer` in
// runner.ts): a pointer that moves to a pattern this session has never
// evaluated loads it from the store, names what it reads
// (`#syncCellsForRunningPattern`), and only then swaps. Between the load
// resolving and the naming resolving, the piece may have stopped, the runner
// may have cycled, or the pointer may have moved again; the guard after the
// naming step drops the swap in each of those cases. Swapping a stopped piece
// would stage a setup nothing can run, and swapping past a newer pointer would
// run the older pattern.
//
// Whether the suite ever lands in that window is a matter of scheduling, so
// the guard's `return` was covered on some `main` runs and not on others (the
// coverage ratchet on #7514; docs/development/COVERAGE.md, "Coverage must not
// depend on the execution environment"). These cases construct the window
// instead of racing for it: the naming step is held open through the runner's
// `dependencySyncer` test seam, the supersession happens while it is held, and
// the swap must not follow once it is released.
//
// Synchronization goes through `runner.idlePointerMaintenance()`: the runner
// suite runs under a frozen clock (test/clock-preload.ts), so wall-clock
// polling cannot observe this work. It settles the held chain, so a case calls
// it only once the hold is released.

const signer = await Identity.fromPassphrase("pattern-swap-superseded-naming");
const space = signer.did();

const V1 = [
  "import { pattern } from 'commonfabric';",
  "export default pattern<Record<string, never>, { marker: string }>(() => {",
  "  return { marker: 'v1' };",
  "});",
  "",
].join("\n");

const V2 = [
  "import { pattern } from 'commonfabric';",
  "export default pattern<Record<string, never>, { marker: string }>(() => {",
  "  return { marker: 'v2' };",
  "});",
  "",
].join("\n");

const programOf = (contents: string): RuntimeProgram => ({
  main: "/main.tsx",
  files: [{ name: "/main.tsx", contents }],
});

type PieceCell = Cell<Record<string, unknown>>;

const markerOf = (cell: PieceCell): string =>
  (cell.getAsQueryResult() as { marker: string }).marker;

describe("pattern swap superseded while the incoming pattern is named", () => {
  let server: MemoryV2Server.Server;
  let manager: EmulatedStorageManager;
  let rt: Runtime;
  // Releases a naming step a case held open, so teardown can settle the
  // watcher chain even when an assertion failed before the case released it.
  let releaseHeld: (() => void) | undefined;

  beforeEach(() => {
    server = newSharedServer();
    manager = EmulatedStorageManager.connectTo(server, { as: signer });
    rt = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager: manager,
    });
  });
  afterEach(async () => {
    rt.runner.accessForTestingOnly.dependencySyncer = undefined;
    releaseHeld?.();
    releaseHeld = undefined;
    await rt.runner.idlePointerMaintenance();
    await rt.dispose();
    await manager.close();
    await server.close();
  });

  // V2 is compiled and persisted through a replica of its own by a runtime of
  // its own, so `rt` has never evaluated it: the watcher takes the store-load
  // arm, not the in-memory one.
  const persistV2 = async (): Promise<string> => {
    const otherManager = EmulatedStorageManager.connectTo(server, {
      as: signer,
    });
    const other = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager: otherManager,
    });
    try {
      const tx = other.edit();
      const v2 = await other.patternManager.compilePattern(programOf(V2), {
        space,
        tx,
      });
      const identity = other.patternManager.getArtifactEntryRef(v2)!.identity;
      other.prepareTxForCommit(tx);
      expect((await tx.commit()).error).toBeUndefined();
      await other.idle();
      await other.patternManager.flushCompileCacheWrites();
      await other.storageManager.synced();
      return identity;
    } finally {
      await other.dispose();
      await otherManager.close();
    }
  };

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
    rt.prepareTxForCommit(tx);
    expect((await tx.commit()).error).toBeUndefined();
    await running.pull();
    expect(markerOf(cell)).toBe("v1");
    expect(getPatternSetupIdentityRef(cell)?.identity).toBe(v1Ref.identity);
    return { cell, v1Ref };
  };

  // Holds the next naming step open. `named` resolves with the pattern being
  // named once the step is entered; `release` lets the step proceed. Later
  // steps pass straight through.
  const holdNextNaming = () => {
    let release!: () => void;
    const released = new Promise<void>((resolve) => {
      release = resolve;
    });
    let entered!: (pattern: Pattern) => void;
    const named = new Promise<Pattern>((resolve) => {
      entered = resolve;
    });
    let held = false;
    rt.runner.accessForTestingOnly.dependencySyncer = async (
      target,
      pattern,
      inputs,
      sync,
    ) => {
      if (held) return sync(target, pattern, inputs);
      held = true;
      entered(pattern);
      await released;
      return sync(target, pattern, inputs);
    };
    releaseHeld = release;
    return { named, release };
  };

  // The pattern the held naming step is naming. Resolves undefined instead of
  // hanging when the watcher settles without ever entering a naming step (the
  // load failed, or the swap took the in-memory arm).
  const namedOrSettled = (
    named: Promise<Pattern>,
  ): Promise<Pattern | undefined> =>
    Promise.race([
      named,
      rt.runner.idlePointerMaintenance().then(() => undefined),
    ]);

  const repoint = async (cell: PieceCell, identity: string) => {
    const tx = rt.edit();
    cell.withTx(tx).setMetaRaw("patternIdentity", {
      identity,
      symbol: "default",
    }, rawMetaWriteAuthorization);
    rt.prepareTxForCommit(tx);
    expect((await tx.commit()).error).toBeUndefined();
    await rt.idle();
  };

  it("does not swap a piece stopped while the incoming pattern was named", async () => {
    const v2Identity = await persistV2();
    const { cell, v1Ref } = await runV1("swap-superseded-by-stop");
    const hold = holdNextNaming();
    await repoint(cell, v2Identity);
    const naming = await namedOrSettled(hold.named);
    expect(naming).toBeDefined();
    expect(rt.patternManager.getArtifactEntryRef(naming!)?.identity).toBe(
      v2Identity,
    );

    // The piece stops with the naming step in flight.
    rt.runner.stop(cell);
    hold.release();
    await rt.runner.idlePointerMaintenance();
    await rt.idle();

    // A swap stages the incoming pattern's setup before it instantiates
    // anything, so a swap that ran on the stopped piece would have stamped
    // V2 as the set-up identity. The pointer itself is left as written.
    expect(getPatternSetupIdentityRef(cell)?.identity).toBe(v1Ref.identity);
    expect(getPatternIdentityRef(cell)?.identity).toBe(v2Identity);
  });

  it("does not swap to a pattern the pointer moved past while it was named", async () => {
    const v2Identity = await persistV2();
    const { cell, v1Ref } = await runV1("swap-superseded-by-repoint");
    const hold = holdNextNaming();
    await repoint(cell, v2Identity);
    const naming = await namedOrSettled(hold.named);
    expect(naming).toBeDefined();
    expect(rt.patternManager.getArtifactEntryRef(naming!)?.identity).toBe(
      v2Identity,
    );

    // The pointer moves back to V1 with V2's naming step in flight. V1 is
    // live in this session and already set up on the piece, so that swap
    // lands at once.
    await repoint(cell, v1Ref.identity);
    expect(markerOf(cell)).toBe("v1");

    hold.release();
    await rt.runner.idlePointerMaintenance();
    await rt.idle();

    // The stale V2 swap did not run over the newer pointer: the piece still
    // runs V1, and V1 is still the set-up identity.
    expect(markerOf(cell)).toBe("v1");
    expect(getPatternSetupIdentityRef(cell)?.identity).toBe(v1Ref.identity);
    expect(getPatternIdentityRef(cell)?.identity).toBe(v1Ref.identity);
  });
});
