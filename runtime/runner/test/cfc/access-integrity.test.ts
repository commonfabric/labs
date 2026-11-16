import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";

import { CFC_ATOM_TYPE } from "@commonfabric/api/cfc";
import type { CfcAtom } from "@commonfabric/api/cfc";
import type { CfcConfClause } from "@commonfabric/memory/v2/cfc-release-authority";

import {
  type ConsumedLocation,
  exchangeEachObservation,
  joinLocationIntegrity,
} from "../../src/cfc/access-integrity.ts";

const CERTIFIED: CfcAtom = {
  type: CFC_ATOM_TYPE.PolicyCertified,
  policy: "did:key:policy",
};
const SAFE: CfcAtom = { type: CFC_ATOM_TYPE.InjectionSafe };
const ALICE: CfcConfClause = {
  type: CFC_ATOM_TYPE.User,
  subject: "did:key:alice",
};
const BOB: CfcConfClause = { type: CFC_ATOM_TYPE.User, subject: "did:key:bob" };

const location = (
  key: string,
  overrides: Partial<ConsumedLocation> = {},
): ConsumedLocation => ({
  key,
  confidentiality: [],
  integrity: [],
  evidence: [],
  ...overrides,
});

describe("access-integrity", () => {
  describe("joinLocationIntegrity()", () => {
    it("returns no integrity for no locations", () => {
      expect(joinLocationIntegrity([])).toEqual([]);
    });

    it("returns one location's integrity whole when it was observed twice alike", () => {
      const observed = location("doc/a", { integrity: [CERTIFIED, SAFE] });
      expect(joinLocationIntegrity([observed, { ...observed }])).toEqual([
        CERTIFIED,
        SAFE,
      ]);
    });

    it("returns only the shared hereditary atoms when one location was observed with two labels", () => {
      // The two observations did not observe one value, so they are joined
      // as two inputs and the value-bound atom drops.

      expect(joinLocationIntegrity([
        location("doc/a", { integrity: [CERTIFIED, SAFE] }),
        location("doc/a", { integrity: [CERTIFIED, SAFE], evidence: [SAFE] }),
      ])).toEqual([CERTIFIED]);
    });
  });

  describe("exchangeEachObservation()", () => {
    it("does not exchange at a location that consumed none of the clauses", () => {
      const seen: (readonly CfcConfClause[])[] = [];
      const result = exchangeEachObservation(
        [ALICE],
        [
          location("doc/a", { confidentiality: [BOB], evidence: [SAFE] }),
          location("doc/b", { confidentiality: [ALICE], evidence: [SAFE] }),
        ],
        (clauses) => {
          seen.push(clauses);
          return [];
        },
      );
      expect(seen).toEqual([[ALICE]]);
      expect(result.confidentiality).toEqual([]);
    });

    it("returns a clause no location consumed as read", () => {
      const result = exchangeEachObservation(
        [ALICE, BOB],
        [location("doc/a", { confidentiality: [ALICE], evidence: [SAFE] })],
        () => [],
      );
      expect(result.confidentiality).toEqual([BOB]);
    });
  });
});
