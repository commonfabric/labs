/**
 * The debug command surface and the scheduler graph both bridge between
 * human-typed bare ids and the full schemed URIs that programmatic surfaces
 * (diagnostics `pieceId`, error strings) emit. A full schemed id passes
 * through untouched, since the scheme is part of the identity, while adding
 * `of:` to a bare id is a human-input convenience only.
 */

import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";

import { normalizeEntityId } from "../src/lib/debug-utils.ts";
import { XSchedulerGraph } from "../src/views/SchedulerGraphView.ts";

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

  describe("XSchedulerGraph", () => {
    describe("static members", () => {
      describe("#extractEntityId()", () => {
        it("returns the entity id with its scheme", () => {
          const helpers = XSchedulerGraph.accessForTestingOnly;

          expect(
            helpers.extractEntityId("sink:did:key:z6Mkabc/of:fid1:AAA/path"),
          ).toBe("of:fid1:AAA");
          expect(helpers.extractEntityId(
            "action:pattern:did:key:z6Mkabc/computed:fid1:BBB/value",
          )).toBe("computed:fid1:BBB");
        });
      });
    });
  });
});
