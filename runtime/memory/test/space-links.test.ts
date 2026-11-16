import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";
import type { DIDKey } from "@commonfabric/identity/did";
import {
  buildInviteLink,
  createInviteCredentials,
  INVITE_LINK_SCHEME,
  parseInviteLink,
} from "../space-invites.ts";
import {
  buildSpaceLink,
  parseSpaceLink,
  SpaceLinkError,
} from "../space-links.ts";

const space: DIDKey =
  "did:key:z6MkiTBz1ymuepAQ4HEHYSF1H8MuKWGmRfDCwAZDGBnSpXXX";
const loom = { host: "https://service.example", space };
const link = buildSpaceLink("https://links.example", loom);
const scheme = `${INVITE_LINK_SCHEME}://space${link.search}`;

/** `link` with the query field `key` set to `value`, or removed for null. */
function withField(key: string, value: string | null, base = link): string {
  const url = new URL(base);
  if (value === null) url.searchParams.delete(key);
  else url.searchParams.set(key, value);
  return url.href;
}

/** The refusal code `parse` throws. */
function refusal(parse: () => unknown): string {
  try {
    parse();
  } catch (error) {
    if (error instanceof SpaceLinkError) return error.code;
    throw error;
  }
  throw new Error("expected a refusal");
}

describe("space links", () => {
  it("builds `/space?host&space` on the shell origin, with nothing secret and no fragment", () => {
    expect(link.origin).toBe("https://links.example");
    expect(link.pathname).toBe("/space");
    expect([...link.searchParams.keys()].sort()).toEqual(["host", "space"]);
    expect(link.searchParams.get("host")).toBe("https://service.example");
    expect(link.searchParams.get("space")).toBe(space);
    expect(link.hash).toBe("");
  });
  it("returns the same space for the `/space` and `fbrc://space` forms", () => {
    expect(parseSpaceLink(link)).toEqual(loom);
    expect(parseSpaceLink(scheme)).toEqual(loom);
    expect(parseSpaceLink(`http://127.0.0.1:5173/space${link.search}`))
      .toEqual(loom);
    expect(
      parseSpaceLink(
        buildSpaceLink("http://localhost:8000", {
          host: "http://localhost:8000/",
          space,
        }),
      ),
    ).toEqual({ host: "http://localhost:8000", space });
  });
  it("ignores fields and fragments it does not know, so links stay readable as the format grows", () => {
    for (
      const tolerated of [
        `${link.href}&fbclid=abc`,
        `${link.href}&utm_source=chat&name=Book%20club`,
        `${link.href}#`,
        `${link.href}#anything`,
        `${scheme}&later=1#x`,
        // A code on a space link is never read, so it is never handed on.
        `${link.href}&invite=abc#code=secret`,
      ]
    ) {
      expect(parseSpaceLink(tolerated), tolerated).toEqual(loom);
    }
  });
  it("is not an invitation, and an invitation is not a space link", () => {
    expect(parseInviteLink(link)).toBeUndefined();
    expect(parseInviteLink(scheme)).toBeUndefined();
    const invite = buildInviteLink("https://links.example", {
      ...loom,
      ...createInviteCredentials(),
    });
    expect(parseSpaceLink(invite)).toBeUndefined();
    expect(
      parseSpaceLink(
        `${INVITE_LINK_SCHEME}://join${invite.search}${invite.hash}`,
      ),
    ).toBeUndefined();
  });
  it("returns `undefined` for URLs that are not space links", () => {
    for (
      const other of [
        `${INVITE_LINK_SCHEME}://setup?n=abc123`,
        `${INVITE_LINK_SCHEME}://other${link.search}`,
        `https://links.example/space/${link.search}`,
        `https://links.example/piece${link.search}`,
        // Another site's `/space`, naming neither field.
        "https://rooms.example/space?id=abc",
        "https://links.example/space",
      ]
    ) {
      expect(parseSpaceLink(other), other).toBeUndefined();
    }
  });
  it("throws `invalid-link` for a space link that names no one space or no service", () => {
    for (
      const malformed of [
        withField("host", null),
        withField("host", ""),
        withField("space", null),
        withField("space", ""),
        withField("space", "not-a-did"),
        // A space is a well-formed `did:key`, as an invitation's is, so a
        // link cannot carry a spelling no invitation could.
        withField("space", "did:"),
        withField("space", "did:key:x"),
        withField("space", "did:web:evil.example"),
        withField("space", "did:key:abc def"),
        withField("space", `${space} `),
        `${INVITE_LINK_SCHEME}://SPACE${link.search}`,
        // A scheme URL naming no action is malformed, as for an invitation.
        `${INVITE_LINK_SCHEME}:space${link.search}`,
        `${INVITE_LINK_SCHEME}:///space${link.search}`,
        `${link.href}&host=https://other.example`,
        `${link.href}&space=${space}`,
        `${INVITE_LINK_SCHEME}://space/${link.search}`,
        `${INVITE_LINK_SCHEME}://space/x${link.search}`,
        `${INVITE_LINK_SCHEME}://space:5${link.search}`,
        `${INVITE_LINK_SCHEME}://someone@space${link.search}`,
        link.href.replace("https://", "https://someone@"),
        "private input is not a URL",
      ]
    ) {
      expect(refusal(() => parseSpaceLink(malformed)), malformed).toBe(
        "invalid-link",
      );
    }
  });
  it("throws `invalid-host` for a service that is not a secure origin", () => {
    for (
      const host of [
        "http://service.example",
        "https://service.example/path",
        "ftp://service.example",
      ]
    ) {
      expect(refusal(() => parseSpaceLink(withField("host", host))), host)
        .toBe("invalid-host");
      expect(
        refusal(() => buildSpaceLink("https://links.example", { host, space })),
        host,
      ).toBe("invalid-host");
    }
    expect(
      refusal(() => buildSpaceLink("http://links.example", loom)),
    ).toBe("invalid-host");
    // The link's own origin is held to the same rule, as an invitation's is.
    for (
      const origin of ["http://links.example", "ftp://links.example"]
    ) {
      expect(refusal(() => parseSpaceLink(`${origin}/space${link.search}`)))
        .toBe("invalid-host");
    }
  });
  it("refuses to build a link to a malformed space", () => {
    expect(
      refusal(() =>
        buildSpaceLink("https://links.example", {
          host: loom.host,
          space: "did:key:short",
        })
      ),
    ).toBe("invalid-link");
  });
});
