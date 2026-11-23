import { expect } from "@std/expect";
import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { Identity } from "@commonfabric/identity";

import type { Artifact } from "../../../../base/pattern-compiler/exec/executor.ts";
import type { MemorySpace } from "../../src/cell.ts";
import {
  type CompiledPiece,
  startCompiledPiece,
} from "../../src/compiled/piece.ts";
import { Runtime } from "../../src/runtime.ts";
import { StorageManager } from "../../src/storage/cache.deno.ts";

/** The statement of the handler body of the fixture that sets `last`. */
const SETS_LAST = "last.set(summaryOf(event.glaze));";

/**
 * The pattern of `compare/fixtures/module-data.tsx` as the crate emitted
 * it, with the statement of its handler body that sets `last` replaced by
 * `statements`.
 */
const artifactWithBody = async (statements: string): Promise<Artifact> => {
  const [{ patterns }] = JSON.parse(
    await Deno.readTextFile(
      new URL(
        "../../../../base/pattern-compiler/compare/fixtures/module-data.emit.json",
        import.meta.url,
      ),
    ),
  ) as { patterns: Artifact[] }[];
  const artifact = patterns.find(({ name }) => name === "default")!;
  const [module] = artifact.code.modules;
  const changed = module.source.replaceAll(SETS_LAST, statements);
  // A change that matched nothing would test the fixture as it is.
  expect(changed).not.toBe(module.source);
  module.source = changed;
  return artifact;
};

/**
 * A handler body that runs `write` and sets `last` to "written" where it
 * returns and to "refused" where it throws a `TypeError`.
 */
const attempt = (write: string): string =>
  `try { ${write}; last.set("written"); } catch (error) { ` +
  `last.set(error instanceof TypeError ? "refused" : String(error)); }`;

// The fixture declares module data, two functions of module scope and a
// handler. The crate's check refuses a source that writes to any of them,
// so each case puts the write into the emitted text of the handler body.
describe("what the value code of a compiled piece cannot change", () => {
  let runtime: Runtime;
  let storageManager: ReturnType<typeof StorageManager.emulate>;
  let space: MemorySpace;
  let pieces: CompiledPiece[];

  beforeEach(async () => {
    const signer = await Identity.fromPassphrase("compiled module freeze");
    space = signer.did();
    storageManager = StorageManager.emulate({ as: signer });
    runtime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager,
      cfcFlowLabels: "persist",
      experimental: { compiledPatterns: true },
      servingPosture: true,
    });
    pieces = [];
  });

  afterEach(async () => {
    for (const piece of pieces) piece.stop();
    await runtime.scheduler.idleWithPendingCommits();
    await runtime.dispose();
    await storageManager.close();
  });

  /**
   * Starts a piece from `artifact`, sends one event to its handler, and
   * returns what `last` holds when the runtime is settled.
   */
  const lastAfterAnEvent = async (artifact: Artifact) => {
    const result = runtime.getCell<Record<string, unknown>>(space, "result");
    const tx = runtime.edit();
    pieces.push(
      startCompiledPiece(runtime, tx, artifact, {}, result.withTx(tx)),
    );
    runtime.prepareTxForCommit(tx);
    expect((await tx.commit().settled).error).toBeUndefined();
    await runtime.scheduler.idleWithPendingCommits();
    result.key("record").send({ glaze: "sugar" } as never);
    await runtime.scheduler.idleWithPendingCommits();
    const read = runtime.edit();
    try {
      return result.withTx(read).key("last").get();
    } finally {
      read.abort();
    }
  };

  it("runs the handler body as the crate emitted it", async () => {
    const artifact = await artifactWithBody(`${SETS_LAST} `);

    expect(await lastAfterAnEvent(artifact)).toBe("sugar donut,3,2,3,1");
  });

  const refused: [what: string, write: string][] = [
    ["appends to an array of module data", 'GLAZES.push("maple")'],
    ["sets a member of a record of module data", "MENU.extra = 1"],
    [
      "sets an element of an array inside a record of module data",
      "MENU.sizes[0] = 9",
    ],
    ["sets an entry of a map of module data", 'PRICES.set("maple", 4)'],
    [
      "sets an entry of a map of module data with the intrinsic method",
      'Map.prototype.set.call(PRICES, "maple", 4)',
    ],
    ["adds a member to a set of module data", 'SEASONAL.add("maple")'],
    ["sets a property of a declared function", "labelOf.calls = 1"],
    [
      "sets a property of the prototype of a declared function",
      "labelOf.prototype.calls = 1",
    ],
    ["sets a property of a function held in a constant", "priceOf.calls = 1"],
    ["sets a property of a handler", "record.calls = 1"],
    ["sets a property of an imported function", "handler.calls = 1"],
    ["sets a property of an imported cell constructor", "Writable.calls = 1"],
    ["sets a member of the exports of its module", "$exports.added = 1"],
    ["sets a property of a function of `$rt`", "$rt.force.calls = 1"],
    ["sets a property of the host `$rt` holds", "$rt.nohost.calls = 1"],
    ["sets a member of the handle it is handed", "last.calls = 1"],
    ["sets a member of the reference `$rt` holds", '$rt.self.doc = "other"'],
  ];
  for (const [what, write] of refused) {
    it(`refuses a handler body that ${what}`, async () => {
      const artifact = await artifactWithBody(attempt(write));

      expect(await lastAfterAnEvent(artifact)).toBe("refused");
    });
  }

  it("gives a handler body no member of a handle that names its position", async () => {
    const artifact = await artifactWithBody(
      "last.set([typeof last.target, typeof last.slot, typeof last.below, " +
        "typeof last.declared, typeof last.fixed].join());",
    );

    expect(await lastAfterAnEvent(artifact)).toBe(
      "undefined,undefined,undefined,undefined,undefined",
    );
  });

  it("gives a handler body no array of `$rt` to write to", async () => {
    const artifact = await artifactWithBody(
      "last.set(Object.values($rt).filter((member) => " +
        'typeof member !== "function" && !Object.isFrozen(member)).length' +
        ".toString());",
    );

    expect(await lastAfterAnEvent(artifact)).toBe("0");
  });
});
