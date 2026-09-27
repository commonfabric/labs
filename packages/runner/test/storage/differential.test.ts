import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { FabricBytes } from "@commonfabric/data-model/fabric-primitives";

import * as Differential from "../../src/storage/differential.ts";
import type { IMemoryAddress, State } from "../../src/storage/interface.ts";

const TYPE = "application/json" as const;
const ENTITY = "of:differential" as const;
const IDENTITY = { principal: "did:test:alice", sessionId: "session-1" };

/**
 * Checks out a document holding `before`, replaces it with one holding
 * `after`, and returns the paths of the changes the comparison records.
 */
const changedPaths = (before: unknown, after: unknown): string[][] => {
  let held: State = { the: TYPE, of: ENTITY, is: { value: before } } as State;
  const memory = { get: (_address: IMemoryAddress) => held };
  const checkout = Differential.checkout(memory, [held], IDENTITY);
  held = { the: TYPE, of: ENTITY, is: { value: after } } as State;
  return [...checkout.compare(memory)].map((change) => [
    ...change.address.path,
  ]);
};

describe("differential", () => {
  describe("compare()", () => {
    it("records no change for an equal copy that shares nothing with the original", () => {
      const copy = () => ({
        list: [1, { name: "a" }],
        bytes: new FabricBytes(new Uint8Array([1, 2])),
      });

      expect(changedPaths(copy(), copy())).toEqual([]);
    });

    it("records a change at a special object whose content differs, and nowhere else", () => {
      const shared = { name: "a" };

      expect(changedPaths(
        { shared, bytes: new FabricBytes(new Uint8Array([1])) },
        { shared, bytes: new FabricBytes(new Uint8Array([2])) },
      )).toEqual([["value", "bytes"]]);
    });

    it("records each edited path of a revision that shares the rest", () => {
      const entries = Object.fromEntries(
        Array.from({ length: 20 }, (_, index) => [`key-${index}`, { index }]),
      );
      const revision = {
        ...entries,
        "key-3": { index: 30 },
        "key-7": { index: 7, added: true },
      };

      expect(changedPaths(entries, revision)).toEqual([
        ["value", "key-3", "index"],
        ["value", "key-7", "added"],
      ]);
    });
  });
});
