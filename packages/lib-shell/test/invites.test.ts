import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";

import {
  buildInviteLink,
  normalizeInviteHost,
  parseInviteLink,
} from "@commonfabric/lib-shell/invites";

const invitation = {
  host: "https://fabric.example",
  space: "did:key:z6MkSyntheticSpace" as const,
  inviteId: "invite-1",
  code: "synthetic-bearer-code",
};

describe("invites", () => {
  it("round-trips an invite with its secret confined to the fragment", () => {
    const url = buildInviteLink("https://shell.example", invitation);
    expect(url.pathname).toBe("/join");
    expect(url.searchParams.has("code")).toBe(false);
    expect(url.hash).toBe("#code=synthetic-bearer-code");
    expect(parseInviteLink(url)).toEqual(invitation);
  });

  it("canonicalizes HTTPS and loopback origins", () => {
    expect(normalizeInviteHost("https://FABRIC.example:443/")).toBe(
      "https://fabric.example",
    );
    for (
      const host of [
        "http://localhost:8000",
        "http://127.0.0.1:8000",
        "http://[::1]:8000",
      ]
    ) {
      expect(normalizeInviteHost(host)).toBe(host);
    }
  });

  it("refuses credentials, paths, queries, fragments, and remote HTTP", () => {
    for (
      const host of [
        "https://name:key@fabric.example",
        "https://fabric.example/api",
        "https://fabric.example?x=1",
        "https://fabric.example#x",
        "http://fabric.example",
        "data:hello",
      ]
    ) {
      expect(() => normalizeInviteHost(host)).toThrow();
    }
  });

  it("returns `undefined` for a non-invite route", () => {
    expect(parseInviteLink(new URL("https://shell.example/space")))
      .toBeUndefined();
  });

  it("refuses duplicate fields and query-string secrets", () => {
    const duplicate = buildInviteLink("https://shell.example", invitation);
    duplicate.searchParams.append("space", invitation.space);
    expect(() => parseInviteLink(duplicate)).toThrow();
    const querySecret = buildInviteLink("https://shell.example", invitation);
    querySecret.searchParams.set("code", invitation.code);
    expect(() => parseInviteLink(querySecret)).toThrow();
  });

  it("refuses empty or malformed invite fields without quoting their contents", () => {
    for (const field of ["space", "inviteId", "code"] as const) {
      expect(() =>
        buildInviteLink("https://shell.example", { ...invitation, [field]: "" })
      ).toThrow();
    }
    const malformed = buildInviteLink("https://shell.example", invitation);
    malformed.searchParams.set("space", "private-secret-value");
    expect(() => parseInviteLink(malformed)).toThrow("Invalid invitation");
    try {
      parseInviteLink(malformed);
    } catch (error) {
      expect(String(error)).not.toContain("private-secret-value");
    }
  });
});
