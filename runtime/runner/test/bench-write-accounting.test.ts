/**
 * Checks the write accounting on both the shapes the journal produces and on a
 * live transaction. The synthetic cases fix what each shape means; the live
 * ones check that the shapes are the ones the runner actually records, and that
 * a reconstructed value is the value that went in.
 */

import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { Identity } from "@commonfabric/identity";
import { StorageManager } from "@commonfabric/runner/storage/cache.deno";
import { Runtime } from "../src/runtime.ts";
import type { IAttestation } from "../src/storage/interface.ts";
import {
  accountNovelty,
  addAccounts,
  jsonBytes,
  noveltyWrites,
} from "./bench-write-accounting.ts";

const signer = await Identity.fromPassphrase("bench write accounting test");
const space = signer.did();

function attestation(
  id: string,
  path: string[],
  value: unknown,
): IAttestation {
  return {
    address: { id: `of:${id}`, type: "application/json", path },
    value: value as IAttestation["value"],
  };
}

/** A runtime over its own emulated storage, plus the way to shut it down. */
function runtimeFixture() {
  const storageManager = StorageManager.emulate({ as: signer });
  const runtime = new Runtime({
    apiUrl: new URL(import.meta.url),
    storageManager,
  });
  const close = async () => {
    await runtime.dispose();
    await storageManager.close();
  };
  return { runtime, close };
}

describe("bench-write-accounting", () => {
  describe("noveltyWrites", () => {
    it("returns the value of a write with nothing below it", () => {
      expect(noveltyWrites([attestation("a", ["value", "n"], 7)])).toEqual([
        { id: "of:a", path: ["value", "n"], value: 7 },
      ]);
    });

    it("folds the paths below a whole-document write into one write", () => {
      const writes = noveltyWrites([
        attestation("a", [], { value: { n: 7, s: "x" } }),
        attestation("a", ["value", "n"], 7),
        attestation("a", ["value", "s"], "x"),
      ]);
      expect(writes).toEqual([
        { id: "of:a", path: [], value: { value: { n: 7, s: "x" } } },
      ]);
    });

    it("rebuilds a value from the paths a nested write recorded", () => {
      // A write below the root records each container empty, with its contents
      // on the paths below it.
      const writes = noveltyWrites([
        attestation("a", ["value", "1"], {}),
        attestation("a", ["value", "1", "label"], "Z"),
        attestation("a", ["value", "1", "aliases"], []),
        attestation("a", ["value", "1", "aliases", "0"], "w"),
      ]);
      expect(writes).toEqual([{
        id: "of:a",
        path: ["value", "1"],
        value: { label: "Z", aliases: ["w"] },
      }]);
    });

    it("keeps one write per document", () => {
      const writes = noveltyWrites([
        attestation("a", [], { value: 1 }),
        attestation("b", [], { value: 2 }),
      ]);
      expect(writes.map((write) => write.id)).toEqual(["of:a", "of:b"]);
    });

    it("keeps sibling writes in one document apart", () => {
      const writes = noveltyWrites([
        attestation("a", ["value", "0"], "x"),
        attestation("a", ["value", "1"], "y"),
      ]);
      expect(writes).toEqual([
        { id: "of:a", path: ["value", "0"], value: "x" },
        { id: "of:a", path: ["value", "1"], value: "y" },
      ]);
    });
  });

  describe("jsonBytes", () => {
    it("counts an ASCII value at one byte per character", () => {
      expect(jsonBytes({ a: 1 })).toBe('{"a":1}'.length);
    });

    it("counts a character that encodes wide at its encoded width", () => {
      // "é" is one UTF-16 code unit and two UTF-8 bytes; "🍩" is two code
      // units and four bytes. The quotes account for the other two.
      expect(jsonBytes("é")).toBe(4);
      expect(jsonBytes("🍩")).toBe(6);
    });

    it("returns zero for a value JSON does not represent", () => {
      expect(jsonBytes(undefined)).toBe(0);
    });
  });

  describe("accountNovelty", () => {
    it("counts the JSON bytes of each top-level write", () => {
      expect(accountNovelty([
        attestation("a", [], { value: [1, 2, 3] }),
        attestation("a", ["value", "0"], 1),
        attestation("a", ["value", "1"], 2),
        attestation("a", ["value", "2"], 3),
      ])).toEqual({ docs: 1, bytes: '{"value":[1,2,3]}'.length });
    });

    it("counts a removed slot as no bytes", () => {
      expect(accountNovelty([attestation("a", ["value", "n"], undefined)]))
        .toEqual({ docs: 1, bytes: 0 });
    });

    it("counts a wide character at its encoded width", () => {
      expect(accountNovelty([attestation("a", ["value", "s"], "é")]))
        .toEqual({ docs: 1, bytes: 4 });
    });

    it("returns nothing for a transaction that wrote nothing", () => {
      expect(accountNovelty([])).toEqual({ docs: 0, bytes: 0 });
    });
  });

  describe("addAccounts", () => {
    it("adds both fields", () => {
      expect(addAccounts({ docs: 1, bytes: 20 }, { docs: 2, bytes: 5 }))
        .toEqual({ docs: 3, bytes: 25 });
    });
  });

  describe("over a live transaction", () => {
    it("counts the bytes a scalar list put in its document", async () => {
      const { runtime, close } = runtimeFixture();
      try {
        const tx = runtime.edit();
        const cell = runtime.getCell<number[]>(
          space,
          "accounting-scalars",
          undefined,
          tx,
        );
        cell.set([1, 2, 3]);
        expect(accountNovelty(tx.journal.novelty(space)))
          .toEqual({ docs: 1, bytes: '{"value":[1,2,3]}'.length });
        await tx.commit().settled;
      } finally {
        await close();
      }
    });

    it("counts one document per object element of a list", async () => {
      const { runtime, close } = runtimeFixture();
      try {
        const tx = runtime.edit();
        const cell = runtime.getCell<{ n: number }[]>(
          space,
          "accounting-elements",
          undefined,
          tx,
        );
        cell.set([{ n: 1 }, { n: 2 }, { n: 3 }]);
        // The parent array holds a link per element, and each element is a
        // document of its own.
        expect(accountNovelty(tx.journal.novelty(space)).docs).toBe(4);
        await tx.commit().settled;
      } finally {
        await close();
      }
    });

    it("returns the item a targeted write stored", async () => {
      const { runtime, close } = runtimeFixture();
      try {
        const setupTx = runtime.edit();
        const seed = runtime.getCell<{ label: string; tags: string[] }[]>(
          space,
          "accounting-targeted",
          undefined,
          setupTx,
        );
        seed.set([
          { label: "a", tags: ["one"] },
          { label: "b", tags: ["two"] },
        ]);
        await setupTx.commit().settled;

        const tx = runtime.edit();
        const cell = runtime.getCell<{ label: string; tags: string[] }[]>(
          space,
          "accounting-targeted",
          undefined,
          tx,
        );
        const replacement = { label: "c", tags: ["three"] };
        cell.key(1).set(replacement);
        expect(noveltyWrites(tx.journal.novelty(space))).toEqual([{
          id: seed.getAsNormalizedFullLink().id,
          path: ["value", "1"],
          value: replacement,
        }]);
        expect(accountNovelty(tx.journal.novelty(space))).toEqual({
          docs: 1,
          bytes: JSON.stringify(replacement).length,
        });
        await tx.commit().settled;
      } finally {
        await close();
      }
    });

    it("returns nothing once the transaction has committed", async () => {
      const { runtime, close } = runtimeFixture();
      try {
        const tx = runtime.edit();
        const cell = runtime.getCell<number[]>(
          space,
          "accounting-settled",
          undefined,
          tx,
        );
        cell.set([1, 2, 3]);
        await tx.commit().settled;
        // A settled transaction releases its journal, which is why the
        // benchmarks read these numbers before they commit.
        expect(accountNovelty(tx.journal.novelty(space)))
          .toEqual({ docs: 0, bytes: 0 });
      } finally {
        await close();
      }
    });
  });
});
