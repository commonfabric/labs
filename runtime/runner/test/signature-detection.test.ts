import { describe, it } from "@std/testing/bdd";
import { assertEquals } from "@std/assert";
import {
  ifElseHasSchemas,
  SIGNATURE_ARGS,
  unlessHasSchemas,
  whenHasSchemas,
} from "../src/builder/built-in.ts";

/**
 * Tests for signature detection utilities.
 *
 * These utilities determine whether ifElse/when/unless were called with
 * schema arguments prepended (new signature) or without (legacy signature).
 *
 * The key insight is that we CANNOT use `arg !== undefined` because
 * `undefined` is a valid VALUE in either signature. For example:
 *   ifElse(pending, undefined, { result })
 *
 * Instead we use arguments.length to distinguish:
 *   - Legacy ifElse: 3 args
 *   - Schema ifElse: 7 args
 *
 * If these signatures ever change, update SIGNATURE_ARGS and these tests.
 */

describe("Signature detection utilities", () => {
  describe("SIGNATURE_ARGS constants", () => {
    it("defines correct argument counts for ifElse", () => {
      assertEquals(SIGNATURE_ARGS.ifElse.legacy, 3);
      assertEquals(SIGNATURE_ARGS.ifElse.withSchemas, 7);
    });

    it("defines correct argument counts for when", () => {
      assertEquals(SIGNATURE_ARGS.when.legacy, 2);
      assertEquals(SIGNATURE_ARGS.when.withSchemas, 5);
    });

    it("defines correct argument counts for unless", () => {
      assertEquals(SIGNATURE_ARGS.unless.legacy, 2);
      assertEquals(SIGNATURE_ARGS.unless.withSchemas, 5);
    });
  });

  describe("ifElseHasSchemas", () => {
    it("returns false for legacy signature (3 args)", () => {
      assertEquals(ifElseHasSchemas(3), false);
    });

    it("returns true for schema signature (7 args)", () => {
      assertEquals(ifElseHasSchemas(7), true);
    });

    it("returns true for more than 7 args (future-proofing)", () => {
      assertEquals(ifElseHasSchemas(8), true);
      assertEquals(ifElseHasSchemas(10), true);
    });

    it("returns false for fewer than 7 args", () => {
      assertEquals(ifElseHasSchemas(0), false);
      assertEquals(ifElseHasSchemas(1), false);
      assertEquals(ifElseHasSchemas(4), false);
      assertEquals(ifElseHasSchemas(6), false);
    });
  });

  describe("whenHasSchemas", () => {
    it("returns false for legacy signature (2 args)", () => {
      assertEquals(whenHasSchemas(2), false);
    });

    it("returns true for schema signature (5 args)", () => {
      assertEquals(whenHasSchemas(5), true);
    });

    it("returns true for more than 5 args (future-proofing)", () => {
      assertEquals(whenHasSchemas(6), true);
      assertEquals(whenHasSchemas(10), true);
    });

    it("returns false for fewer than 5 args", () => {
      assertEquals(whenHasSchemas(0), false);
      assertEquals(whenHasSchemas(1), false);
      assertEquals(whenHasSchemas(3), false);
      assertEquals(whenHasSchemas(4), false);
    });
  });

  describe("unlessHasSchemas", () => {
    it("returns false for legacy signature (2 args)", () => {
      assertEquals(unlessHasSchemas(2), false);
    });

    it("returns true for schema signature (5 args)", () => {
      assertEquals(unlessHasSchemas(5), true);
    });

    it("returns true for more than 5 args (future-proofing)", () => {
      assertEquals(unlessHasSchemas(6), true);
      assertEquals(unlessHasSchemas(10), true);
    });

    it("returns false for fewer than 5 args", () => {
      assertEquals(unlessHasSchemas(0), false);
      assertEquals(unlessHasSchemas(1), false);
      assertEquals(unlessHasSchemas(3), false);
      assertEquals(unlessHasSchemas(4), false);
    });
  });
});
