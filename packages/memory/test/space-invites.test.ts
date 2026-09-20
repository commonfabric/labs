import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";
import {
  buildInviteLink,
  createInviteCredentials,
  inviteCodeVerifier,
  isInviteSecret,
  normalizeInviteHost,
  parseInviteLink,
} from "../space-invites.ts";

const space = "did:key:z6MkiTBz1ymuepAQ4HEHYSF1H8MuKWGmRfDCwAZDGBnSpXXX";

describe("space-invites", () => {
  it("rejects malformed origins, links, and secret encodings", () => {
    expect(() => normalizeInviteHost("not an origin")).toThrow("invalid-host");
    for (const secret of [undefined, 32, "", "A".repeat(42), "A".repeat(44)]) {
      expect(isInviteSecret(secret)).toBe(false);
    }
    expect(isInviteSecret("A".repeat(43))).toBe(true);
    const link = buildInviteLink("https://shell.example", {
      host: "https://service.example",
      space,
      ...createInviteCredentials(),
    });
    for (const invalidSpace of ["other", "did:key:z0invalid"]) {
      const malformed = new URL(link);
      malformed.searchParams.set("space", invalidSpace);
      expect(() => parseInviteLink(malformed)).toThrow("invalid-link");
    }
    expect(() => parseInviteLink("private input is not a URL")).toThrow(
      "invalid-link",
    );
  });
  it("keeps the bearer code exclusively in the fragment and round trips its destination", () => {
    const invite = {
      host: "https://example.com",
      space,
      ...createInviteCredentials(),
    };
    const link = buildInviteLink("https://shell.example", invite);
    expect(new URL(link).search.includes(invite.code)).toBe(false);
    expect(new URL(link).hash).toBe(`#code=${invite.code}`);
    expect(parseInviteLink(link)).toEqual(invite);
    expect(parseInviteLink(new URL("https://shell.example/space")))
      .toBeUndefined();
    expect(() =>
      parseInviteLink(link.href.replace("#code=", "&invite=duplicate#code="))
    ).toThrow("invalid-link");
  });
  it("binds the verifier to its version, normalized origin, space, invite ID, and full secret", () => {
    const invite = {
      host: "https://EXAMPLE.com:443/",
      space,
      inviteId: "A".repeat(22),
      code: "A".repeat(43),
    };
    expect(inviteCodeVerifier(invite)).toBe(
      "IOJKH3t822YSd5VzGDtVWxUE1Ft2uBmoFht4Iy909Xg",
    );
    const baseline = inviteCodeVerifier(invite);
    for (
      const changed of [
        { host: "https://other.example" },
        { space: space + "A" },
        { inviteId: "B".repeat(22) },
        { code: "B".repeat(42) + "A" },
      ]
    ) expect(inviteCodeVerifier({ ...invite, ...changed })).not.toBe(baseline);
  });
  it("rejects insecure or ambiguous service destinations and noncanonical secrets", () => {
    expect(normalizeInviteHost("http://127.0.0.1:8080/")).toBe(
      "http://127.0.0.1:8080",
    );
    for (
      const host of [
        "http://remote.example",
        "https://user:pass@example.com",
        "https://example.com/path",
        "https://example.com/?secret=x",
        "javascript:alert(1)",
      ]
    ) expect(() => normalizeInviteHost(host)).toThrow();
    expect(() =>
      inviteCodeVerifier({
        host: "https://example.com",
        space,
        inviteId: "A".repeat(22),
        code: "A".repeat(42) + "B",
      })
    ).toThrow("invalid-request");
  });
});
