import { expect } from "@std/expect";
import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { Identity } from "@commonfabric/identity";

import type { Artifact } from "../../../../base/pattern-compiler/exec/executor.ts";
import { inputClause } from "../../../../base/pattern-compiler/compare/generate.ts";
import { scenarioAudience } from "../../../../base/pattern-compiler/compare/harness.ts";
import type { JSONSchema } from "../../src/builder/types.ts";
import type { Cell, MemorySpace } from "../../src/cell.ts";
import { readStoredCfcMetadata } from "../../src/cfc/metadata.ts";
import {
  type CompiledPiece,
  startCompiledPiece,
} from "../../src/compiled/piece.ts";
import { parseLink } from "../../src/link-utils.ts";
import { Runtime } from "../../src/runtime.ts";
import { type SharedStorage, shareStorage, storedList } from "./storage.ts";

/** The pattern `Cells` of `compare/fixtures/runner-lists.tsx`. */
const CELLS: Artifact = (JSON.parse(
  await Deno.readTextFile(
    new URL(
      "../../../../base/pattern-compiler/compare/fixtures/runner-lists.emit.json",
      import.meta.url,
    ),
  ),
) as { patterns: Artifact[] }[])[0].patterns.find(({ name }) =>
  name === "Cells"
)!;

/** A schema with one confidentiality clause the space admits. */
const labeled = async (name: string): Promise<JSONSchema> => ({
  type: "object",
  properties: {
    id: { type: "string" },
    title: { type: "string" },
    done: { type: "boolean" },
  },
  ifc: { confidentiality: [inputClause(name, await scenarioAudience())] },
} as JSONSchema);

/**
 * Has every transaction `runtime` makes store version-1 envelopes, whatever
 * is asked of it later: the spelling of the compiled path before P452, for
 * a comparison.
 */
const spellingVersionOne = (runtime: Runtime): void => {
  const edit = runtime.edit.bind(runtime);
  runtime.edit = ((...given: Parameters<Runtime["edit"]>) => {
    const tx = edit(...given);
    const set = tx.setCfcContentAddressedLabels.bind(tx);
    set(false);
    tx.setCfcContentAddressedLabels = () => set(false);
    return tx;
  }) as Runtime["edit"];
};

// `fixtures/runner-lists.tsx`, `Cells`: a `map` over an array of
// references, three items each under a clause of its own, whose rows are
// documents of their own. A compiled piece commits its labels as
// version-2 envelopes (P452, ruling Z95); today's path keeps the
// runtime's default.
describe("the labels a compiled piece commits", () => {
  let signer: Identity;
  let space: MemorySpace;
  let shared: SharedStorage[];
  let runtimes: Runtime[];
  let pieces: CompiledPiece[];

  beforeEach(async () => {
    signer = await Identity.fromPassphrase("pattern-compiler-compare");
    space = signer.did();
    shared = [];
    runtimes = [];
    pieces = [];
  });

  afterEach(async () => {
    for (const piece of pieces) piece.stop();
    for (const runtime of runtimes) {
      await runtime.scheduler.idleWithPendingCommits();
      await runtime.dispose();
    }
    for (const storage of shared) await storage.close();
  });

  const runtimeOn = (
    storage: SharedStorage,
    compiledPatterns = true,
  ): Runtime => {
    const runtime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager: storage.open(signer),
      cfcFlowLabels: "persist",
      experimental: { compiledPatterns },
      servingPosture: true,
    });
    runtimes.push(runtime);
    return runtime;
  };

  const commit = async (
    runtime: Runtime,
    write: (tx: ReturnType<Runtime["edit"]>) => void,
  ) => {
    const tx = runtime.edit();
    write(tx);
    runtime.prepareTxForCommit(tx);
    expect((await tx.commit().settled).error).toBeUndefined();
    await runtime.scheduler.idleWithPendingCommits();
  };

  /** Starts `Cells` in `runtime` over `items`, its result named `tag`. */
  const start = async (
    runtime: Runtime,
    items: Cell<unknown[]>,
    tag: string,
  ): Promise<Cell<Record<string, unknown>>> => {
    const result = runtime.getCell<Record<string, unknown>>(space, tag);
    await commit(runtime, (tx) => {
      pieces.push(
        startCompiledPiece(runtime, tx, CELLS, { items }, result.withTx(tx)),
      );
    });
    return result;
  };

  /**
   * The links of `result` and of each row document it links to, as the
   * runtime that wrote them reads them.
   */
  const documentsOf = (
    writer: Runtime,
    result: Cell<Record<string, unknown>>,
  ) => {
    const base = result.getAsNormalizedFullLink();
    return [
      base,
      ...(storedList(writer, result, ["rows"]) as unknown[]).map((row) =>
        parseLink(row as never, base)
      ),
    ];
  };

  /** The envelope version and the labels `reader` reads for `links`. */
  const read = async (
    reader: Runtime,
    links: ReturnType<typeof documentsOf>,
  ) => {
    await Promise.all(
      links.map((link) => reader.getCellFromLink(link).sync()),
    );
    const tx = reader.edit();
    try {
      return links.map(({ id }) => {
        const stored = readStoredCfcMetadata(tx, {
          space,
          id: id as never,
          scope: "space",
        });
        return {
          version: stored?.version,
          labels: JSON.parse(JSON.stringify(stored?.labelMap ?? null)),
        };
      });
    } finally {
      tx.abort();
    }
  };

  /**
   * A piece over three labeled items, and a second piece in another
   * runtime on the same storage over the rows the first stored: what a
   * client reads of the first piece's documents and of the second's.
   */
  const run = async (versionOne: boolean) => {
    const storage = shareStorage();
    shared.push(storage);
    const first = runtimeOn(storage);
    if (versionOne) spellingVersionOne(first);
    const cells = await Promise.all(
      ["one", "two", "three"].map(async (title, index) => ({
        cell: first.getCell<Record<string, unknown>>(
          space,
          `item ${index}`,
          await labeled(`clause-${title}`),
        ),
        value: { id: `i${index}`, title, done: false },
      })),
    );
    const items = first.getCell<unknown[]>(space, "items");
    await commit(first, (tx) => {
      for (const { cell, value } of cells) cell.withTx(tx).set(value);
      items.withTx(tx).set(cells.map(({ cell }) => cell));
    });
    const result = await start(first, items, "first result");
    const second = runtimeOn(storage);
    if (versionOne) spellingVersionOne(second);
    const rows = (storedList(first, result, ["rows"]) as unknown[]).map(
      (row) =>
        second.getCellFromLink(
          parseLink(row as never, result.getAsNormalizedFullLink()),
        ),
    );
    await Promise.all(rows.map((row) => row.sync()));
    const secondItems = second.getCell<unknown[]>(space, "second items");
    await commit(second, (tx) => secondItems.withTx(tx).set(rows));
    const secondResult = await start(second, secondItems, "second result");
    const client = runtimeOn(storage);
    return {
      first: await read(client, documentsOf(first, result)),
      second: await read(client, documentsOf(second, secondResult)),
    };
  };

  it("are version-2 envelopes that a client reads as the labels version 1 gave, of the piece and of a second piece that read it", async () => {
    const before = await run(true);
    const after = await run(false);

    for (const { version } of [...before.first, ...before.second]) {
      expect(version).toBe(1);
    }
    for (const { version } of [...after.first, ...after.second]) {
      expect(version).toBe(2);
    }
    expect(after.first.map(({ labels }) => labels)).toEqual(
      before.first.map(({ labels }) => labels),
    );
    expect(after.second.map(({ labels }) => labels)).toEqual(
      before.second.map(({ labels }) => labels),
    );
  });

  it("leave today's path at version 1, with the experimental option on and off", async () => {
    for (const compiledPatterns of [true, false]) {
      const storage = shareStorage();
      shared.push(storage);
      const runtime = runtimeOn(storage, compiledPatterns);
      const cell = runtime.getCell<Record<string, unknown>>(
        space,
        "today's item",
        await labeled("clause-today"),
      );
      await commit(
        runtime,
        (tx) => cell.withTx(tx).set({ id: "t", title: "today", done: false }),
      );
      const tx = runtime.edit();
      try {
        expect(
          readStoredCfcMetadata(tx, {
            space,
            id: cell.getAsNormalizedFullLink().id,
            scope: "space",
          })?.version,
        ).toBe(1);
      } finally {
        tx.abort();
      }
    }
  });
});
