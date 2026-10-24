import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { profileLook } from "./profile-look.ts";

describe("profileLook()", () => {
  const picture = new Uint8Array([0x89, 0x50, 0x4e, 0x47]);

  it("returns the picture alone when the profile has one", () => {
    expect(profileLook(picture, "🦊")).toEqual({ picture });
  });

  it("returns the trimmed avatar text when there is no picture", () => {
    expect(profileLook(undefined, " 🦊 ")).toEqual({ avatar: "🦊" });
    expect(profileLook(new Uint8Array(), "data:image/png;base64,iVB"))
      .toEqual({ avatar: "data:image/png;base64,iVB" });
  });

  it("returns neither when there is no picture and the text is blank", () => {
    expect(profileLook(undefined, undefined)).toEqual({});
    expect(profileLook(new Uint8Array(), "   ")).toEqual({});
  });
});
