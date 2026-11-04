import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import {
  createProfileSpace,
  PROFILE_NAME,
  userA,
} from "./profile-space-identity-collision-support.ts";

describe("CT-1650 profile space identity (per-user, name-independent)", () => {
  it("one user's two same-named profiles get distinct spaces", async () => {
    const spaceA = await createProfileSpace(userA, PROFILE_NAME);
    const spaceA2 = await createProfileSpace(userA, PROFILE_NAME);

    expect(spaceA).not.toBe(spaceA2);
  });
});
