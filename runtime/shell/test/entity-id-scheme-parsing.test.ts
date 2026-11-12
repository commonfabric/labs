/**
 * The debug command surface bridges between human-typed bare ids and the full
 * schemed URIs that programmatic surfaces (diagnostics `pieceId`, error
 * strings) emit. A full schemed id passes through untouched, since the scheme
 * is part of the identity, while adding `of:` to a bare id is a human-input
 * convenience only. `scheduler-graph-layout.test.ts` covers the scheduler
 * graph's side, `extractEntityId()`.
 */

import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";

import { normalizeEntityId } from "../src/lib/debug-utils.ts";

describe("entity-id-scheme-parsing", () => {
  describe("normalizeEntityId()", () => {
    it("prefixes bare ids and passes schemed ids through", () => {
      // Bare id (typed or copied from a URL path): of: is the convenience.
      expect(normalizeEntityId({ id: "fid1:abc" })).toBe("of:fid1:abc");
      // Full schemed ids are canonical either way.
      expect(normalizeEntityId({ id: "of:fid1:abc" })).toBe("of:fid1:abc");
      expect(normalizeEntityId({ id: "computed:fid1:abc" })).toBe(
        "computed:fid1:abc",
      );
      // The did fallback follows the same rule.
      expect(normalizeEntityId({ did: "fid1:def" })).toBe("of:fid1:def");
      expect(normalizeEntityId({ did: "computed:fid1:def" })).toBe(
        "computed:fid1:def",
      );
    });
  });
});
