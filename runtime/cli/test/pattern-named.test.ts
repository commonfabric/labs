import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { Identity, issueDelegation } from "@commonfabric/identity";
import { indexProofs } from "@commonfabric/pattern-index/membership";
import {
  chooseProfile,
  NamingError,
  namingWarning,
  profileProof,
} from "../lib/pattern-named.ts";
import type { ListedProfile } from "../lib/profile.ts";

const person = await Identity.fromPassphrase("pattern named person");
const someoneElse = await Identity.fromPassphrase("pattern named other");
const profileKey = await Identity.fromPassphrase("pattern named profile");

const listed = (more: Partial<ListedProfile>): ListedProfile => ({
  name: "Sam",
  picture: undefined,
  pictureByOwner: false,
  avatar: "",
  avatarByOwner: false,
  space: profileKey.did(),
  id: "fid1:profile",
  address: "",
  current: false,
  ...more,
});

/** The delegation a profile space issues its owner when it is made. */
const rootDelegation = (aud: string, cmd = "/memory") =>
  issueDelegation(profileKey, {
    aud: aud as `did:key:${string}`,
    sub: profileKey.did(),
    cmd,
    pol: [],
  });

describe("pattern-named", () => {
  describe("chooseProfile()", () => {
    it("answers the current profile by default, and the one named by its space", () => {
      const work = listed({ space: "did:key:z6Mkwork", name: "Work" });
      const home = listed({ current: true, name: "Home" });

      expect(chooseProfile([work, home], undefined)).toBe(home);
      expect(chooseProfile([work, home], "did:key:z6Mkwork")).toBe(work);
    });

    it("asks for --profile when there are profiles but none is current", () => {
      expect(() => chooseProfile([listed({})], undefined)).toThrow(
        "name one with --profile",
      );
    });

    it("throws for no profile, a space none lives in, and a profile with no name", () => {
      expect(() => chooseProfile([], undefined)).toThrow(NamingError);
      expect(() => chooseProfile([listed({ current: true })], "did:key:z6Mkx"))
        .toThrow("None of your profiles");
      expect(() =>
        chooseProfile([listed({ current: true, name: "" })], undefined)
      )
        .toThrow("has no name to show");
    });
  });

  describe("profileProof()", () => {
    it("answers the profile's own delegation to the signer, in the index's proof encoding", async () => {
      const toPerson = await rootDelegation(person.did());
      const toOther = await rootDelegation(someoneElse.did());

      const proof = await profileProof(
        {
          space: profileKey.did(),
          piece: "fid1:profile",
          displayName: "Sam",
          delegations: [toOther.bytes, toPerson.bytes],
        },
        person.did(),
      );

      expect(proof).toEqual(indexProofs([toPerson.bytes]));
    });

    it("passes over a recorded delegation that does not decode or whose signature does not hold", async () => {
      const good = await rootDelegation(person.did());
      const forged = new Uint8Array(good.bytes);
      forged[forged.length - 1] ^= 0xff;

      const proof = await profileProof(
        {
          space: profileKey.did(),
          piece: "fid1:profile",
          displayName: "Sam",
          delegations: [new Uint8Array([1, 2, 3]), forged, good.bytes],
        },
        person.did(),
      );

      expect(proof).toEqual(indexProofs([good.bytes]));
    });

    it("throws when Home records no delegation of the whole space to the signer", async () => {
      const narrower = await rootDelegation(person.did(), "/memory/read");

      await expect(profileProof(
        {
          space: profileKey.did(),
          piece: "fid1:profile",
          displayName: "Sam",
          delegations: [narrower.bytes],
        },
        person.did(),
      )).rejects.toThrow(NamingError);
    });
  });

  describe("namingWarning()", () => {
    it("names what is shown and says it cannot be unseen, in one line", () => {
      const warning = namingWarning("Sam");

      expect(warning).toContain('"Sam"');
      expect(warning).toContain("cannot be unseen");
      expect(warning).not.toContain("\n");
    });
  });
});
