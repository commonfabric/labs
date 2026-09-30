import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";

import { indexBy } from "./voter-index.ts";

/**
 * A stand-in for a profile cell: an entity id, the space it lives in, and the
 * cell it resolves to, which is its own entity unless the link points on.
 */
interface Voter {
  id: string;
  space: string;
  resolves?: string;
}

/** A stand-in for a roster row: a name, and the voter it belongs to. */
interface Member {
  name: string;
  voter: Voter;
}

const keyOf = (voter: Voter) => voter.id;
const memberKeyOf = (member: Member) => keyOf(member.voter);
const cellOf = (voter: Voter) => voter.resolves ?? voter.id;

/** Compares links as written, which is what a key is read off. */
const sameLink = (member: Member, voter: Voter) =>
  member.voter.id === voter.id && member.voter.space === voter.space;

/** Compares the cells two links reach, which a key cannot predict. */
const sameCell = (member: Member, voter: Voter) =>
  cellOf(member.voter) === cellOf(voter);

const alice: Voter = { id: "alice-profile", space: "did:key:home" };
const bob: Voter = { id: "bob-profile", space: "did:key:home" };
const rosterOfTwo: Member[] = [
  { name: "Alice", voter: alice },
  { name: "Bob", voter: bob },
];

/** A row whose link is written differently but reaches Alice's cell. */
const aliasForAlice: Member = {
  name: "Alice",
  voter: { id: "alias-profile", space: "did:key:home", resolves: alice.id },
};

/** A row under Alice's key that reaches someone else's cell. */
const decoyUnderAlicesKey: Member = {
  name: "Decoy",
  voter: { id: alice.id, space: "did:key:home", resolves: "other-profile" },
};

/** A roster of `size` members, each under a key of their own. */
const rosterOf = (size: number): Member[] =>
  Array.from({ length: size }, (_, index) => ({
    name: `Voter ${index}`,
    voter: { id: `profile-${index}`, space: "did:key:home" },
  }));

describe("indexBy()", () => {
  it("returns the member the subject's key names", () => {
    const memberOf = indexBy(rosterOfTwo, memberKeyOf, keyOf, sameLink);

    expect(memberOf(bob)?.name).toBe("Bob");
  });

  it("returns `undefined` for a subject no member is the same as", () => {
    const stranger: Voter = { id: "gone", space: "did:key:home" };

    const memberOf = indexBy(rosterOfTwo, memberKeyOf, keyOf, sameLink);

    expect(memberOf(stranger)).toBeUndefined();
  });

  it("keeps apart two members that share a key but are not the same", () => {
    // Two profile cells in different spaces carry one entity id, so the key
    // narrows the roster to both of them and the comparison picks one.

    const guest: Voter = { id: alice.id, space: "did:key:guest" };
    const roster: Member[] = [
      { name: "Alice", voter: alice },
      { name: "Guest", voter: guest },
    ];

    const memberOf = indexBy(roster, memberKeyOf, keyOf, sameLink);

    expect(memberOf(alice)?.name).toBe("Alice");
    expect(memberOf(guest)?.name).toBe("Guest");
  });

  it("returns a member whose key differs from the subject's", () => {
    const memberOf = indexBy([aliasForAlice], memberKeyOf, keyOf, sameCell);

    expect(memberOf(alice)?.name).toBe("Alice");
  });

  it("returns a member outside the bucket the subject's key names", () => {
    // The key narrows to a member the comparison then turns down. Settling
    // there would lose Alice her name, so the search goes on to the rest.

    const roster = [decoyUnderAlicesKey, aliasForAlice];

    const memberOf = indexBy(roster, memberKeyOf, keyOf, sameCell);

    expect(memberOf(alice)?.name).toBe("Alice");
  });

  it("returns a member the index cannot key", () => {
    const memberOf = indexBy(rosterOfTwo, () => undefined, keyOf, sameLink);

    expect(memberOf(bob)?.name).toBe("Bob");
  });

  it("returns a member for a subject the index cannot key", () => {
    const memberOf = indexBy(
      rosterOfTwo,
      memberKeyOf,
      () => undefined,
      sameLink,
    );

    expect(memberOf(bob)?.name).toBe("Bob");
  });

  it("compares only the members the subject's key names", () => {
    // What the index is for: a roster of any size costs the comparisons its
    // key narrows to, rather than one comparison per member.

    const roster = rosterOf(50);
    let compared = 0;
    const countingSame = (member: Member, voter: Voter) => {
      compared++;
      return sameLink(member, voter);
    };

    const memberOf = indexBy(roster, memberKeyOf, keyOf, countingSame);

    expect(memberOf(roster[49].voter)?.name).toBe("Voter 49");
    expect(compared).toBe(1);
  });

  it("compares every member for a subject whose key names none", () => {
    // The price of settling nothing by key: a subject the roster does not
    // hold — a voter who has left it — is compared with all of it.

    const roster = rosterOf(50);
    const stranger: Voter = { id: "gone", space: "did:key:home" };
    let compared = 0;
    const countingSame = (member: Member, voter: Voter) => {
      compared++;
      return sameLink(member, voter);
    };

    const memberOf = indexBy(roster, memberKeyOf, keyOf, countingSame);

    expect(memberOf(stranger)).toBeUndefined();
    expect(compared).toBe(50);
  });

  it("keys no member until the first lookup", () => {
    let keyed = 0;
    const countingKey = (member: Member) => {
      keyed++;
      return memberKeyOf(member);
    };

    const memberOf = indexBy(rosterOf(50), countingKey, keyOf, sameLink);
    expect(keyed).toBe(0);

    memberOf(alice);
    expect(keyed).toBe(50);
  });
});
