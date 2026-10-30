import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { shortDid } from "./short-did.ts";

describe("shortDid()", () => {
  it("returns the method and the last four characters of a long `did:key`", () => {
    expect(shortDid("did:key:z6MkecWJLQz2vTvJQeDQbKjZ7CMuGJQDW62248YMiefPYdTN"))
      .toBe("did:key:…YdTN");
  });

  it("returns a DID whose method-specific part is exactly 20 characters whole", () => {
    const did = `did:key:${"a".repeat(20)}`;
    expect(shortDid(did)).toBe(did);
  });

  it("returns the shortened form for a method-specific part of 21 characters", () => {
    expect(shortDid(`did:key:${"a".repeat(21)}`)).toBe("did:key:…aaaa");
  });

  it("returns the last four characters of the method-specific part, not the first four", () => {
    expect(shortDid(`did:key:${"a".repeat(20)}WXYZ`)).toBe("did:key:…WXYZ");
  });

  it("returns a short `did:web` whole", () => {
    expect(shortDid("did:web:example.com")).toBe("did:web:example.com");
  });

  it("returns the shortened form for a long method-specific part holding colons of its own", () => {
    expect(shortDid("did:web:example.com:users:alice-in-wonderland"))
      .toBe("did:web:…land");
  });

  it("returns a DID with an empty method-specific part whole", () => {
    expect(shortDid("did:key:")).toBe("did:key:");
  });

  it("returns a part counted and cut by code point, not by UTF-16 unit", () => {
    const tail = "\u{1F369}\u{1F369}\u{1F369}\u{1F369}";
    const did = `did:key:${"a".repeat(16)}${tail}`;
    expect(shortDid(did)).toBe(did);
    expect(shortDid(`did:key:${"a".repeat(17)}${tail}`))
      .toBe(`did:key:…${tail}`);
  });

  it("returns a string that is not a DID unchanged", () => {
    expect(shortDid("*")).toBe("*");
    expect(shortDid("alice")).toBe("alice");
  });

  it("returns a DID with an empty method unchanged", () => {
    const did = `did::${"a".repeat(30)}`;
    expect(shortDid(did)).toBe(did);
  });

  it("returns a DID with no method-specific part unchanged", () => {
    expect(shortDid("did:key")).toBe("did:key");
  });

  it("returns a DID whose prefix is not lowercase unchanged", () => {
    const did = `DID:key:${"a".repeat(30)}`;
    expect(shortDid(did)).toBe(did);
  });

  it("returns the empty string for the empty string and for `undefined`", () => {
    expect(shortDid("")).toBe("");
    expect(shortDid(undefined)).toBe("");
  });
});
