/**
 * Two sessions deriving from one per-session input over shared storage. The
 * session that wrote its instance and the session that holds none derive
 * different results, each lands in its own session instance behind the one
 * shared redirect, and once both have settled nothing writes again: the
 * shared redirect stays as it is and the space's commit sequence does not
 * move. The remote-echo breaker runs over it as it runs everywhere: with the
 * two sessions placing their output the same way there is no loop for it to
 * see.
 */

import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";

import { Identity } from "@commonfabric/identity";
import * as Engine from "@commonfabric/memory/v2/engine";
import type * as MemoryV2Server from "@commonfabric/memory/v2/server";

import type { RuntimeProgram } from "../src/harness/types.ts";
import { parseLink } from "../src/link-utils.ts";
import { Runtime } from "../src/runtime.ts";
import { EmulatedStorageManager } from "../src/storage/v2-emulate.ts";
import { newSharedServer } from "./memory-v2-test-utils.ts";

const signer = await Identity.fromPassphrase("scoped output convergence");
const space = signer.did();

const CAUSE = "scoped output convergence piece";

type Result = { shown: string; editing: boolean };

/** A piece whose shown text derives from a per-session editing flag. */
const PROGRAM: RuntimeProgram = {
  main: "/main.tsx",
  files: [{
    name: "/main.tsx",
    contents: [
      'import { computed, pattern, Writable } from "commonfabric";',
      "",
      "export default pattern<{}, { shown: string; editing: boolean }>(",
      "  () => {",
      "    const editing = new Writable.perSession(false);",
      '    const shown = computed(() => editing.get() ? "editing" : "reading");',
      "    return { shown, editing };",
      "  },",
      ");",
    ].join("\n"),
  }],
};

describe("scoped-output-convergence", () => {
  let server: MemoryV2Server.Server;
  let storageA: EmulatedStorageManager;
  let storageB: EmulatedStorageManager;
  let a: Runtime;
  let b: Runtime;

  beforeEach(() => {
    server = newSharedServer();
    storageA = EmulatedStorageManager.connectTo(server, { as: signer });
    storageB = EmulatedStorageManager.connectTo(server, { as: signer });
  });

  afterEach(async () => {
    await a?.dispose();
    await b?.dispose();
    await storageA?.close();
    await storageB?.close();
    await server?.close();
  });

  /** Constructs both sessions' runtimes. */
  function connect(): void {
    a = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager: storageA,
    });
    b = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager: storageB,
    });
  }

  /**
   * Runs the piece in both sessions and asserts that each reads its own
   * result behind the one shared redirect and that, settled, neither writes
   * again.
   */
  async function converge(): Promise<void> {
    // Session A creates the piece and opens its editor, so its own instance
    // of `editing` holds true.
    const txA = a.edit();
    const compiledA = await a.patternManager.compilePattern(PROGRAM, {
      space,
      tx: txA,
    });
    const resultA = a.getCell<Result>(space, CAUSE, undefined, txA);
    a.run(txA, compiledA, {}, resultA);
    a.prepareTxForCommit(txA);
    await txA.commit().settled;
    await a.idle();
    await storageA.synced();
    await resultA.pull();

    const open = a.edit();
    resultA.key("editing").withTx(open).set(true);
    a.prepareTxForCommit(open);
    await open.commit().settled;
    await a.idle();
    await storageA.synced();
    await resultA.pull();
    expect(resultA.key("shown").get()).toBe("editing");

    // Session B resumes the same piece. It holds no instance of `editing`,
    // so it reads the declaration's default.
    const compiledB = await b.patternManager.compilePattern(PROGRAM, { space });
    const txB = b.edit();
    const resultB = b.getCell<Result>(
      space,
      CAUSE,
      compiledB.resultSchema,
      txB,
    );
    await txB.commit().settled;
    await b.start(resultB);
    const cancel = resultB.key("shown").sink(() => {});
    try {
      await b.settled();
      await b.idle();
      await storageB.synced();
      await resultB.pull();
      expect(resultB.key("shown").get()).toBe("reading");

      // Both results sit behind one shared redirect, and that redirect names
      // a session instance: each session follows it to its own.
      const internalA = parseLink(resultA.key("shown").getRaw(), resultA)!;
      const internalB = parseLink(resultB.key("shown").getRaw(), resultB)!;
      expect(internalB).toMatchObject({ id: internalA.id, scope: "space" });
      const cellA = a.getCellFromLink(internalA);
      const cellB = b.getCellFromLink(internalB);
      await cellA.pull();
      await cellB.pull();
      const redirectA = parseLink(cellA.getRaw(), cellA)!;
      const redirectB = parseLink(cellB.getRaw(), cellB)!;
      expect(redirectA).toMatchObject({ id: internalA.id, scope: "session" });
      expect(redirectB).toMatchObject({ id: internalA.id, scope: "session" });

      // Settled recomputation on both sides writes nothing further.
      const engine = await server.engineForSpace(space);
      const seq = Engine.serverSeq(engine);
      await a.idle();
      await b.idle();
      await storageA.synced();
      await storageB.synced();
      await resultA.pull();
      await resultB.pull();
      expect(Engine.serverSeq(engine)).toBe(seq);
      expect(resultA.key("shown").get()).toBe("editing");
      expect(resultB.key("shown").get()).toBe("reading");
      expect(parseLink(cellA.getRaw(), cellA)).toEqual(redirectA);
      expect(parseLink(cellB.getRaw(), cellB)).toEqual(redirectB);
    } finally {
      cancel();
    }
  }

  it("keeps the shared output stable across a session with the instance and one without", async () => {
    // The breaker counts a run that rewrites the document that re-triggered
    // it. Placed the same way on both sides, the two sessions' runs never
    // rewrite each other's output, so it counts no cycle at all.

    connect();
    await converge();
    const nothing = { active: 0, trips: 0, cyclesObserved: 0 };
    expect(a.scheduler.getEchoBreakerStats()).toEqual(nothing);
    expect(b.scheduler.getEchoBreakerStats()).toEqual(nothing);
  });
});
