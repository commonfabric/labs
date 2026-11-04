import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import {
  createProfileSpace,
  PROFILE_NAME,
  userA,
  userB,
} from "./profile-space-identity-collision-support.ts";

describe("CT-1650 profile space identity (per-user, name-independent)", () => {
  it("two users with the same profile name get distinct spaces", async () => {
    const spaceA = await createProfileSpace(userA, PROFILE_NAME);
    const spaceB = await createProfileSpace(userB, PROFILE_NAME);

    expect(spaceA).not.toBe(spaceB);
  });
});
