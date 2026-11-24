import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";

import type { MemorySpace } from "@commonfabric/memory/interface";

import { canonicalizePreparedDigestInput } from "../../src/cfc/canonical.ts";
import type {
  CfcAddress,
  CfcExternalContentObservation,
  PreparedDigestInput,
  WritePolicyInput,
} from "../../src/cfc/types.ts";

const SPACE_A: MemorySpace = "did:key:a";
const SPACE_B: MemorySpace = "did:key:b";

const address = (space: MemorySpace, id: string): CfcAddress => ({
  space,
  scope: "space",
  id,
  path: [],
});

const empty = (): PreparedDigestInput => ({
  consumedReads: [],
  attemptedWrites: [],
  writes: [],
  writeAttemptLog: [],
  triggerReads: [],
  dereferenceTraces: [],
  writePolicyInputs: [],
});

describe("canonicalizePreparedDigestInput()", () => {
  // Each case hands the records over in both orders, so a comparator that
  // ignored the key the case names would leave one of them out of order.

  it("returns member records ordered by space before id", () => {
    const first = {
      space: SPACE_A,
      scope: "space" as const,
      id: "of:z",
      metaPath: ["labels"],
    };
    const second = {
      space: SPACE_B,
      scope: "space" as const,
      id: "of:a",
      metaPath: ["labels"],
    };
    for (const consumedReads of [[first, second], [second, first]]) {
      expect(
        canonicalizePreparedDigestInput({ ...empty(), consumedReads })
          .consumedReads,
      ).toEqual([first, second]);
    }
  });

  it("returns external-content observations ordered by source address", () => {
    const observation = (
      source: CfcAddress,
    ): CfcExternalContentObservation => ({
      source,
      flow: {},
      consumed: {},
      locations: [],
      labeledSpaces: [],
      sources: [],
    });
    const first = observation(address(SPACE_A, "of:z"));
    const second = observation(address(SPACE_B, "of:a"));
    for (
      const externalContentObservations of [[first, second], [second, first]]
    ) {
      expect(
        canonicalizePreparedDigestInput({
          ...empty(),
          externalContentObservations,
        }).externalContentObservations,
      ).toEqual([first, second]);
    }
  });

  it("returns preserved-output policy inputs ordered by target", () => {
    const preserved = (target: CfcAddress): WritePolicyInput => ({
      kind: "preserved-output",
      target,
      value: "kept",
    });
    const first = preserved(address(SPACE_A, "of:z"));
    const second = preserved(address(SPACE_B, "of:a"));
    for (const writePolicyInputs of [[first, second], [second, first]]) {
      expect(
        canonicalizePreparedDigestInput({ ...empty(), writePolicyInputs })
          .writePolicyInputs,
      ).toEqual([first, second]);
    }
  });
});
