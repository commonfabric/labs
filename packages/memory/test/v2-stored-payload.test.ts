/**
 * The stored-payload rule is shared by two readers that accept different
 * payloads: the engine reads what it wrote, through `decodeMemoryBoundary`,
 * while an offline reader over a durable file may also meet untagged
 * plain-JSON rows. Everything either of them decides ABOUT a payload —
 * whether an absent one is readable, whether a decoded root is a document —
 * has to be the same on both sides, or the two disagree about which stored
 * states exist while claiming to replicate one another.
 *
 * So every case here runs under both decoders and asserts they agree. The
 * trap this guards is a rule that reaches its verdict by handing a fallback
 * STRING to the decoder: `decodeMemoryBoundary` refuses any untagged payload,
 * so a `"[]"` fallback rejects for the engine and succeeds for a plain-JSON
 * reader, and a rule that reads differently per decoder is not shared.
 */

import { assertEquals, assertThrows } from "@std/assert";
import { describe, it } from "@std/testing/bdd";
import type { FabricValue } from "@commonfabric/data-model";

import type { PatchOp } from "../v2.ts";
import {
  decodeMemoryBoundary,
  decodeStoredDocumentPayload,
  decodeStoredPatchListPayload,
  encodeMemoryBoundary,
} from "../v2.ts";

/** An offline reader's decoder: untagged rows are plain JSON. */
const plainJson = (source: string): FabricValue => JSON.parse(source);

/** The two decoders the rule is parameterized over, with a matching encoder. */
const DECODERS = [
  {
    name: "decodeMemoryBoundary",
    decode: decodeMemoryBoundary,
    encode: (value: unknown) => encodeMemoryBoundary(value as never),
  },
  { name: "plain JSON", decode: plainJson, encode: JSON.stringify },
] as const;

describe("v2 stored payload", () => {
  describe("decodeStoredDocumentPayload()", () => {
    for (const { name, decode, encode } of DECODERS) {
      it(`returns the document for a well-formed payload under ${name}`, () => {
        assertEquals(
          decodeStoredDocumentPayload(decode, encode({ value: { n: 1 } })),
          { value: { n: 1 } },
        );
      });

      it(`refuses an absent payload under ${name}`, () => {
        // Never reaches the decoder: an absent document is `null`, and `null`
        // is not a tree of paths.
        assertThrows(
          () => decodeStoredDocumentPayload(decode, null),
          TypeError,
          "got null",
        );
      });

      it(`refuses a root that is not a document under ${name}`, () => {
        assertThrows(
          () => decodeStoredDocumentPayload(decode, encode([1, 2])),
          TypeError,
          "got an array",
        );
        assertThrows(
          () => decodeStoredDocumentPayload(decode, encode(null)),
          TypeError,
          "got null",
        );
      });
    }
  });

  describe("decodeStoredPatchListPayload()", () => {
    const ops: PatchOp[] = [{ op: "replace", path: "/value/n", value: 2 }];

    for (const { name, decode, encode } of DECODERS) {
      it(`returns the ops for a well-formed payload under ${name}`, () => {
        assertEquals(decodeStoredPatchListPayload(decode, encode(ops)), ops);
      });

      it(`refuses an absent payload under ${name}`, () => {
        // Nothing writes a patch row without a payload, so an absent one is a
        // malformed row. Reading it as the empty list would apply nothing and
        // leave the document reading current.
        assertThrows(
          () => decodeStoredPatchListPayload(decode, null),
          TypeError,
          "must carry a payload",
        );
      });

      it(`refuses a payload that is not a list under ${name}`, () => {
        assertThrows(
          () => decodeStoredPatchListPayload(decode, encode({ op: "add" })),
          TypeError,
          "must be arrays",
        );
      });
    }
  });

  describe("the two decoders", () => {
    it("agree on every verdict the rule reaches without them", () => {
      // The absent cases are the ones a fallback string would split, since
      // only one decoder accepts an untagged one. Assert the agreement
      // directly rather than relying on the per-decoder cases above lining up.
      const verdict = (run: () => unknown): string => {
        try {
          return `ok:${JSON.stringify(run())}`;
        } catch (e) {
          return `throws:${(e as Error).message}`;
        }
      };
      for (const data of [null]) {
        assertEquals(
          verdict(() =>
            decodeStoredDocumentPayload(decodeMemoryBoundary, data)
          ),
          verdict(() => decodeStoredDocumentPayload(plainJson, data)),
        );
        assertEquals(
          verdict(() =>
            decodeStoredPatchListPayload(decodeMemoryBoundary, data)
          ),
          verdict(() => decodeStoredPatchListPayload(plainJson, data)),
        );
      }
    });
  });
});
