import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { Identity } from "@commonfabric/identity";
import type * as MemoryV2Server from "@commonfabric/memory/v2/server";

import { Runtime } from "../src/runtime.ts";
import type { Cell } from "../src/cell.ts";
import type { Pattern } from "../src/builder/types.ts";
import type { RuntimeProgram } from "../src/harness/types.ts";
import type { IExtendedStorageTransaction } from "../src/storage/interface.ts";
import { rawMetaWriteAuthorization } from "../src/meta-seam.ts";
import { EmulatedStorageManager } from "../src/storage/v2-emulate.ts";
import { newSharedServer } from "./memory-v2-test-utils.ts";

const signer = await Identity.fromPassphrase("pattern-watcher-lagging-pointer");
const space = signer.did();

const sourceOf = (marker: string) =>
  [
    "import { pattern } from 'commonfabric';",
    "export default pattern<Record<string, never>, { marker: string }>(() => {",
    `  return { marker: '${marker}' };`,
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

describe("pattern-watcher-lagging-pointer", () => {
  // A piece started on a new pattern writes its pattern pointer in the
  // transaction that starts it, and its watcher first reads the pointer while
  // that transaction is still open, when the store still names the pattern
  // the start replaces. Each case stops a piece running one pattern and starts
  // it on another in a transaction the case commits itself, so it decides
  // what lands in that window.

  let server: MemoryV2Server.Server;
  let manager: EmulatedStorageManager;
  let rt: Runtime;

  beforeEach(() => {
    server = newSharedServer();
    manager = EmulatedStorageManager.connectTo(server, { as: signer });
    rt = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager: manager,
    });
  });

  afterEach(async () => {
    await rt.runner.idlePointerMaintenance();
    await rt.dispose();
    await manager.close();
    await server.close();
  });

  const compile = async (marker: string) => {
    const tx = rt.edit();
    const pattern = await rt.patternManager.compilePattern(
      programOf(sourceOf(marker)),
      { space, tx },
    );
    rt.prepareTxForCommit(tx);
    expect((await tx.commit().settled).error).toBeUndefined();
    const identity = rt.patternManager.getArtifactEntryRef(pattern)!.identity;
    return { pattern, identity };
  };

  const runOn = async (
    cell: PieceCell,
    pattern: Pattern,
    tx = rt.edit(),
  ): Promise<PieceCell> => {
    const running = rt.run(tx, pattern, {}, cell.withTx(tx));
    rt.prepareTxForCommit(tx);
    expect((await tx.commit().settled).error).toBeUndefined();
    await running.pull();
    return cell;
  };

  const runFirst = (cause: string, pattern: Pattern): Promise<PieceCell> =>
    runOn(rt.getCell<Record<string, unknown>>(space, cause), pattern);

  // Stops `cell` and starts it on `pattern` in a transaction left open, so
  // the store holds the previous pointer until the caller commits it.
  const restartOpen = (
    cell: PieceCell,
    pattern: Pattern,
    tx = rt.edit(),
  ): IExtendedStorageTransaction => {
    rt.runner.stop(cell.withTx(tx));
    rt.run(tx, pattern, {}, cell.withTx(tx));
    rt.prepareTxForCommit(tx);
    return tx;
  };

  // A transaction moving the pointer, as a source update elsewhere does.
  const moveTx = (cell: PieceCell, identity: string) => {
    const tx = rt.edit();
    cell.withTx(tx).setMetaRaw("patternIdentity", {
      identity,
      symbol: "default",
    }, rawMetaWriteAuthorization);
    rt.prepareTxForCommit(tx);
    return tx;
  };

  const settled = async () => {
    await rt.idle();
    await rt.runner.idlePointerMaintenance();
  };

  // Counts the watcher's lookups of `identity`, one for each time it follows
  // the pointer there. The starts here are handed their pattern, so they
  // look nothing up.
  const followsTo = (identity: string) => {
    const patterns = rt.patternManager;
    const lookUp = patterns.artifactFromIdentitySyncInSpace.bind(patterns);
    const counts = { follows: 0 };
    patterns.artifactFromIdentitySyncInSpace = (id, ...rest) => {
      if (id === identity) counts.follows++;
      return lookUp(id, ...rest);
    };
    return counts;
  };

  it("follows neither the pointer it replaces nor its own write landing", async () => {
    const v1 = await compile("v1");
    const v2 = await compile("v2");
    const v2Follows = followsTo(v2.identity);
    const cell = await runFirst("own-write", v1.pattern);
    const v1Follows = followsTo(v1.identity);

    const tx = restartOpen(cell, v2.pattern);
    await settled();
    expect(v1Follows.follows).toBe(0);
    expect((await tx.commit().settled).error).toBeUndefined();
    await settled();
    await cell.pull();

    expect(v1Follows.follows).toBe(0);
    expect(v2Follows.follows).toBe(0);
    expect(markerOf(cell)).toBe("v2");
  });

  it("follows a move to another pattern made while its transaction is open", async () => {
    const v1 = await compile("v1");
    const v2 = await compile("v2");
    const v3 = await compile("v3");
    const cell = await runFirst("move-elsewhere", v1.pattern);

    const tx = restartOpen(cell, v2.pattern);
    expect((await moveTx(cell, v3.identity).commit().settled).error)
      .toBeUndefined();
    await settled();
    await cell.pull();
    expect(markerOf(cell)).toBe("v3");
    tx.abort("the pointer moved past this start");
  });

  it("follows a later move back to the pattern it replaced", async () => {
    const v1 = await compile("v1");
    const v2 = await compile("v2");
    const cell = await runFirst("move-back-later", v1.pattern);

    const tx = restartOpen(cell, v2.pattern);
    expect((await tx.commit().settled).error).toBeUndefined();
    await settled();
    await cell.pull();
    expect(markerOf(cell)).toBe("v2");

    expect((await moveTx(cell, v1.identity).commit().settled).error)
      .toBeUndefined();
    await settled();
    await cell.pull();
    expect(markerOf(cell)).toBe("v1");
  });

  it("follows a move back that lands right behind its own write", async () => {
    // Both commits land before the watcher runs again, so the value it reads
    // next is the one its first run passed over.

    const v1 = await compile("v1");
    const v2 = await compile("v2");
    const cell = await runFirst("move-back-at-once", v1.pattern);

    const tx = restartOpen(cell, v2.pattern);
    const started = tx.commit().settled;
    const moved = moveTx(cell, v1.identity).commit().settled;
    expect((await started).error).toBeUndefined();
    expect((await moved).error).toBeUndefined();
    await settled();
    await cell.pull();
    expect(markerOf(cell)).toBe("v1");
  });

  it("follows the pointer it replaced once its transaction aborts", async () => {
    const v1 = await compile("v1");
    const v2 = await compile("v2");
    const cell = await runFirst("aborted", v1.pattern);
    const v1Follows = followsTo(v1.identity);

    const tx = restartOpen(cell, v2.pattern);
    await settled();
    expect(v1Follows.follows).toBe(0);
    tx.abort("the start is withdrawn");
    await settled();

    expect(v1Follows.follows).toBe(1);
  });

  it("passes over the pointer its watcher reads, for a start as another actor at user scope", async () => {
    // The start's transaction names an actor other than the runtime's own.
    // The watcher reads the pointer under the runtime's identity, where it
    // names the pattern the start replaces; a read under the transaction's
    // identity finds no pointer at all.

    const v1 = await compile("v1");
    const v2 = await compile("v2");
    const actor = {
      principal: (await Identity.fromPassphrase("lagging pointer actor"))
        .did(),
      sessionId: rt.scopeKeyIdentity.sessionId,
    };
    const asActor = () => {
      const tx = rt.edit();
      tx.tx.scopeKeyIdentity = actor;
      return tx;
    };
    const cell = rt.getCell<Record<string, unknown>>(
      space,
      "actor-restart",
      undefined,
      undefined,
      "user",
    );
    await runOn(cell, v1.pattern, asActor());
    await settled();
    const v1Follows = followsTo(v1.identity);

    const tx = restartOpen(cell, v2.pattern, asActor());
    await settled();
    expect((await tx.commit().settled).error).toBeUndefined();
    await settled();

    expect(v1Follows.follows).toBe(0);
  });
});
