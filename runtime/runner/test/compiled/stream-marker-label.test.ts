import { expect } from "@std/expect";
import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { Identity } from "@commonfabric/identity";

import type { Artifact } from "../../../../base/pattern-compiler/exec/executor.ts";
import type { JSONSchema } from "../../src/builder/types.ts";
import {
  type MemorySpace,
  recordRelevantSchemaWritePolicyInput,
} from "../../src/cell.ts";
import {
  type CompiledPiece,
  startCompiledPiece,
} from "../../src/compiled/piece.ts";
import { readStoredCfcMetadata } from "../../src/cfc/metadata.ts";
import { Runtime } from "../../src/runtime.ts";
import { openStorage, type TestStorage } from "./storage.ts";

/** The pattern of `compare/fixtures/labeled-rows.tsx`. */
const artifact = async (): Promise<Artifact> => {
  const [{ patterns }] = JSON.parse(
    await Deno.readTextFile(
      new URL(
        "../../../../base/pattern-compiler/compare/fixtures/labeled-rows.emit.json",
        import.meta.url,
      ),
    ),
  ) as { patterns: Artifact[] }[];
  return patterns.find(({ name }) => name === "default")!;
};

// `fixtures/labeled-rows.tsx`: the rows of a `map` over an array of plain
// values in place, each element's name under the clause `person`, and each
// row with a stream of its own. A derivation that makes a row writes the
// marker of the row's stream, which carries the label of the row's
// existence, the membership of the collection (ruling Z96), and not the
// join of what the derivation read, which holds the clause.
describe("the marker of the stream of a row whose element carries a clause", () => {
  let runtime: Runtime;
  let storageManager: TestStorage;
  let space: MemorySpace;
  let pieces: CompiledPiece[];

  beforeEach(async () => {
    const signer = await Identity.fromPassphrase("compiled stream marker");
    space = signer.did();
    storageManager = openStorage(signer);
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

  const settled = () => runtime.scheduler.idleWithPendingCommits();

  it("is stored with each row, and no derivation is refused, after three adds", async () => {
    const pattern = await artifact();
    const result = runtime.getCell<Record<string, unknown>>(space, "result");
    // The name the handler copies, stored under the clause `person`, which
    // the argument's type declares at each element's name, and
    // `badge`, which each row reads, under the clause `badge`, which the
    // argument's type admits at no store of the rows.
    const labeled = async (name: string, clause: string, value: string) => {
      const schema = {
        type: "string",
        ifc: { confidentiality: [clause] },
      } as JSONSchema;
      const seed = runtime.edit();
      const cell = runtime.getCell<string>(space, name, schema, seed);
      recordRelevantSchemaWritePolicyInput(
        seed,
        cell.getAsNormalizedFullLink(),
        schema,
      );
      cell.set(value);
      expect((await seed.commit().settled).error).toBeUndefined();
      return cell;
    };
    const secret = await labeled("secret", "person", "Ada");
    const badge = await labeled("badge", "badge", "!");
    const tx = runtime.edit();
    const piece = startCompiledPiece(
      runtime,
      tx,
      pattern,
      { items: [], secret: secret.withTx(tx), badge: badge.withTx(tx) },
      result.withTx(tx),
    );
    pieces.push(piece);
    runtime.prepareTxForCommit(tx);
    expect((await tx.commit().settled).error).toBeUndefined();
    await settled();
    for (let added = 0; added < 3; added++) {
      result.key("add").send({} as never);
      await settled();
    }

    expect(piece.refusals).toEqual([]);
    const rows = await result.key("$UI").pull() as {
      children: { children: unknown[] }[][];
    };
    expect(JSON.stringify(rows)).toContain("Ada!");
    expect(rows.children[0].length).toBe(3);
    // Each row's marker holds the clause of the membership of the rows,
    // which the handler that added the element read, and not the clause of
    // `badge`, which the derivation read for the row's text.
    const read = runtime.edit();
    try {
      const markers = piece.instance.streams().flatMap((held) => {
        const entity = held.keys.length === 0
          ? undefined
          : piece.transactions.entityOfStream(held);
        return entity === undefined ? [] : [entity];
      });
      expect(markers.length).toBe(3);
      for (const id of markers) {
        const metadata = readStoredCfcMetadata(read, {
          space,
          id,
          scope: "space",
        });
        const clauses = JSON.stringify(
          metadata?.labelMap.entries.map(({ label }) =>
            label.confidentiality ?? []
          ),
        );
        expect(clauses).toContain("person");
        expect(clauses).not.toContain("badge");
      }
    } finally {
      read.abort();
    }
  });
});
