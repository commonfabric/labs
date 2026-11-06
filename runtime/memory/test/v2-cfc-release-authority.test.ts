import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";

import { CFC_ATOM_TYPE } from "@commonfabric/api/cfc";
import { hashStringOf } from "@commonfabric/data-model";

import {
  clauseAlternatives,
  clauseReleasableBy,
  commitmentAwareEquals,
  hasExactKeys,
  isActorOwnedAlternative,
  isCfcFieldCommitment,
  isOrClause,
} from "../v2/cfc-release-authority.ts";

const ACTOR = "did:key:z6MkactorActorActorActorActorActorActorActor";
const OTHER = "did:key:z6MkotherOtherOtherOtherOtherOtherOtherOther";

const committed = (value: string) => ({ digestOf: hashStringOf(value) });

describe("cfc-release-authority", () => {
  describe("isOrClause()", () => {
    it("returns `true` for a record whose sole key is an `anyOf` array", () => {
      expect(isOrClause({ anyOf: [ACTOR] })).toBe(true);
    });

    it("returns `false` for an atom, a record with another key beside `anyOf`, and an `anyOf` that is not an array", () => {
      expect(isOrClause(ACTOR)).toBe(false);
      expect(isOrClause({ anyOf: [ACTOR], extra: 1 })).toBe(false);
      expect(isOrClause({ anyOf: ACTOR })).toBe(false);
    });
  });

  describe("clauseAlternatives()", () => {
    it("returns an OR-clause's alternatives, and a bare atom as its own one", () => {
      expect(clauseAlternatives({ anyOf: [ACTOR, OTHER] })).toEqual([
        ACTOR,
        OTHER,
      ]);
      expect(clauseAlternatives(ACTOR)).toEqual([ACTOR]);
    });
  });

  describe("isCfcFieldCommitment()", () => {
    it("returns `true` only for a record whose sole key is a string `digestOf`", () => {
      expect(isCfcFieldCommitment(committed(ACTOR))).toBe(true);
      expect(isCfcFieldCommitment({ digestOf: 1 })).toBe(false);
      expect(isCfcFieldCommitment({ digestOf: "x", extra: 1 })).toBe(false);
      expect(isCfcFieldCommitment("x")).toBe(false);
    });
  });

  describe("commitmentAwareEquals()", () => {
    it("returns `true` for equal values, and for a commitment against the plaintext it commits to", () => {
      expect(commitmentAwareEquals({ a: [1] }, { a: [1] })).toBe(true);
      expect(commitmentAwareEquals(committed(ACTOR), ACTOR)).toBe(true);
      expect(commitmentAwareEquals(ACTOR, committed(ACTOR))).toBe(true);
    });

    it("compares commitments nested in arrays and records field by field", () => {
      expect(
        commitmentAwareEquals(
          [{ owner: committed(ACTOR) }],
          [{ owner: ACTOR }],
        ),
      ).toBe(true);
      expect(
        commitmentAwareEquals({ owner: committed(ACTOR) }, { owner: OTHER }),
      ).toBe(false);
    });

    it("returns `false` for two different commitments, differing lengths or key sets, and unlike shapes", () => {
      expect(commitmentAwareEquals(committed(ACTOR), committed(OTHER)))
        .toBe(false);
      expect(commitmentAwareEquals([1], [1, 2])).toBe(false);
      expect(commitmentAwareEquals({ a: 1 }, { a: 1, b: 2 })).toBe(false);
      expect(commitmentAwareEquals({ a: 1 }, { b: 1 })).toBe(false);
      expect(commitmentAwareEquals([1], { 0: 1 })).toBe(false);
      expect(commitmentAwareEquals(1, 2)).toBe(false);
    });
  });

  describe("hasExactKeys()", () => {
    it("returns `true` only for a record holding exactly the keys named", () => {
      expect(hasExactKeys({ a: 1, b: 2 }, ["a", "b"])).toBe(true);
      expect(hasExactKeys({ a: 1, b: 2 }, ["a"])).toBe(false);
      expect(hasExactKeys({ a: 1 }, ["a", "b"])).toBe(false);
      expect(hasExactKeys({ a: 1, c: 2 }, ["a", "b"])).toBe(false);
    });
  });

  describe("isActorOwnedAlternative()", () => {
    const shapes = [
      { type: CFC_ATOM_TYPE.User, subject: ACTOR },
      { type: CFC_ATOM_TYPE.Context, name: "inbox", subject: ACTOR },
      { type: CFC_ATOM_TYPE.Resource, class: "did", subject: ACTOR },
      { type: CFC_ATOM_TYPE.Space, id: ACTOR },
      { type: CFC_ATOM_TYPE.PersonalSpace, owner: ACTOR },
    ];

    it("returns `true` for the actor's bare DID and each shape naming the actor", () => {
      expect(isActorOwnedAlternative(ACTOR, ACTOR)).toBe(true);
      for (const shape of shapes) {
        expect(isActorOwnedAlternative(shape, ACTOR)).toBe(true);
      }
    });

    it("returns `false` for each shape naming another principal, or carrying a further field", () => {
      expect(isActorOwnedAlternative(OTHER, ACTOR)).toBe(false);
      for (const shape of shapes) {
        expect(isActorOwnedAlternative(shape, OTHER)).toBe(false);
        expect(isActorOwnedAlternative({ ...shape, scope: "x" }, ACTOR))
          .toBe(false);
      }
    });

    it("returns `false` for another atom type, an atom that isn't a record, and a non-string name or class", () => {
      expect(
        isActorOwnedAlternative({
          type: CFC_ATOM_TYPE.Caveat,
          kind: "x",
          source: ACTOR,
        }, ACTOR),
      ).toBe(false);
      expect(isActorOwnedAlternative([ACTOR], ACTOR)).toBe(false);
      expect(isActorOwnedAlternative(7, ACTOR)).toBe(false);
      expect(
        isActorOwnedAlternative(
          { type: CFC_ATOM_TYPE.Context, name: 1, subject: ACTOR },
          ACTOR,
        ),
      ).toBe(false);
      expect(
        isActorOwnedAlternative(
          { type: CFC_ATOM_TYPE.Resource, class: 1, subject: ACTOR },
          ACTOR,
        ),
      ).toBe(false);
    });
  });

  describe("clauseReleasableBy()", () => {
    it("returns `true` for a clause every alternative of which stands for the actor", () => {
      expect(clauseReleasableBy(ACTOR, ACTOR)).toBe(true);
      expect(
        clauseReleasableBy({
          anyOf: [ACTOR, { type: CFC_ATOM_TYPE.Space, id: ACTOR }],
        }, ACTOR),
      ).toBe(true);
    });

    it("reads a commitment to the actor in a commitment-classified field as the actor", () => {
      expect(
        clauseReleasableBy({
          type: CFC_ATOM_TYPE.PersonalSpace,
          owner: committed(ACTOR),
        } as never, ACTOR),
      ).toBe(true);
    });

    it("returns `false` for a commitment in a public field, a commitment to another principal, an empty clause, and one with another's alternative", () => {
      expect(
        clauseReleasableBy({
          type: CFC_ATOM_TYPE.Space,
          id: committed(ACTOR),
        } as never, ACTOR),
      ).toBe(false);
      expect(
        clauseReleasableBy({
          type: CFC_ATOM_TYPE.PersonalSpace,
          owner: committed(OTHER),
        } as never, ACTOR),
      ).toBe(false);
      expect(clauseReleasableBy({ anyOf: [] }, ACTOR)).toBe(false);
      expect(clauseReleasableBy({ anyOf: [ACTOR, OTHER] }, ACTOR)).toBe(
        false,
      );
    });
  });
});
