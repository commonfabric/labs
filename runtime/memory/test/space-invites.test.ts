import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";
import { stub } from "@std/testing/mock";
import {
  buildInviteLink,
  createInviteCredentials,
  INVITE_LINK_SCHEME,
  inviteCodeVerifier,
  isInviteId,
  isInviteSecret,
  normalizeInviteHost,
  parseInviteLink,
} from "../space-invites.ts";

const space = "did:key:z6MkiTBz1ymuepAQ4HEHYSF1H8MuKWGmRfDCwAZDGBnSpXXX";
const inviter = "did:key:z6MkhaXgBZDvotDkL5257faiztiGiC2QtKLGpbnnEGta2doK";

/**
 * Returns the message of what `parse` throws, so a test can check both the
 * refusal code and that nothing else, such as the code, is in it.
 */
function refusal(parse: () => unknown): string {
  try {
    parse();
  } catch (error) {
    return (error as Error).message;
  }
  throw new Error("expected a refusal");
}

describe("space-invites", () => {
  it("accepts canonical loopback HTTP origins across the loopback address range", () => {
    for (
      const host of [
        "http://127.1.2.3:8080",
        "http://127.255.255.255",
        "http://localhost.:8080",
        "http://[::1]:8080",
        "http://[::ffff:7f00:1]:8080",
        "http://[::ffff:7fff:ffff]",
      ]
    ) {
      expect(normalizeInviteHost(host)).toBe(host);
      const invite = { host, space, ...createInviteCredentials() };
      expect(parseInviteLink(buildInviteLink(host, invite))).toEqual(invite);
    }
    for (
      const host of [
        "http://126.255.255.255",
        "http://128.0.0.1",
        "http://localhost.example",
        "http://[::2]",
        "http://[::ffff:7eff:ffff]",
        "http://[::ffff:8000:1]",
      ]
    ) {
      expect(() => normalizeInviteHost(host)).toThrow("invalid-host");
    }
  });
  it("refuses malformed DID key destinations before building an invitation", () => {
    const credentials = createInviteCredentials();
    for (
      const invalidSpace of [
        "did:key:foo",
        "did:key:",
        "did:key:z0invalid",
        "did:key:z" + "A".repeat(121),
      ]
    ) {
      const invite = {
        host: "https://example.com",
        space: invalidSpace,
        ...credentials,
      };
      expect(() => inviteCodeVerifier(invite)).toThrow("invalid-request");
      expect(() => buildInviteLink("https://shell.example", invite)).toThrow(
        "invalid-request",
      );
    }
  });
  it("rejects malformed origins, links, and secret encodings", () => {
    expect(() => normalizeInviteHost("not an origin")).toThrow("invalid-host");
    for (
      const secret of [
        undefined,
        32,
        "",
        "A".repeat(42),
        "A".repeat(44),
        // Nonzero bits past the last whole byte.
        `${"A".repeat(42)}B`,
      ]
    ) {
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
    const queryCode = new URL(link);
    queryCode.searchParams.set("code", invite.code);
    queryCode.hash = "";
    expect(() => parseInviteLink(queryCode)).toThrow("invalid-link");
    const duplicateCode = new URL(link);
    duplicateCode.searchParams.set("code", invite.code);
    expect(() => parseInviteLink(duplicateCode)).toThrow("invalid-link");
    expect(parseInviteLink(new URL("https://shell.example/space")))
      .toBeUndefined();
    expect(() =>
      parseInviteLink(link.href.replace("#code=", "&invite=duplicate#code="))
    ).toThrow("invalid-link");
  });
  it("round trips an optional inviter DID in the query, outside the code verifier", () => {
    const invite = {
      host: "https://example.com",
      space,
      ...createInviteCredentials(),
    };
    const link = buildInviteLink("https://shell.example", {
      ...invite,
      inviter,
    });
    expect(link.searchParams.get("inviter")).toBe(inviter);
    expect(parseInviteLink(link)).toEqual({ ...invite, inviter });
    // The parsed link verifies against the same code as the issued one: the
    // inviter a link carries never enters the verifier.
    expect(inviteCodeVerifier(parseInviteLink(link)!)).toBe(
      inviteCodeVerifier(invite),
    );
    expect(inviteCodeVerifier({ ...invite, inviter })).toBe(
      inviteCodeVerifier(invite),
    );
  });
  it("parses a link without an inviter exactly as before", () => {
    const invite = {
      host: "https://example.com",
      space,
      ...createInviteCredentials(),
    };
    const link = buildInviteLink("https://shell.example", invite);
    expect(link.searchParams.has("inviter")).toBe(false);
    expect(parseInviteLink(link)).not.toHaveProperty("inviter");
  });
  it("rejects a malformed inviter when building or parsing, and any other unknown key", () => {
    const invite = {
      host: "https://example.com",
      space,
      ...createInviteCredentials(),
    };
    const link = buildInviteLink("https://shell.example", invite);
    for (
      const inviter of [
        "",
        "someone",
        "did:key:z0invalid",
        "did:web:x.test",
        `did:key:z${"1".repeat(121)}`,
      ]
    ) {
      expect(() =>
        buildInviteLink("https://shell.example", { ...invite, inviter })
      ).toThrow("invalid-request");
      const malformed = new URL(link);
      malformed.searchParams.set("inviter", inviter);
      expect(() => parseInviteLink(malformed)).toThrow("invalid-link");
    }
    const duplicate = new URL(link);
    duplicate.searchParams.append("inviter", space);
    duplicate.searchParams.append("inviter", space);
    expect(() => parseInviteLink(duplicate)).toThrow("invalid-link");
    const unknown = new URL(link);
    unknown.searchParams.set("inviter", space);
    unknown.searchParams.set("note", "hello");
    expect(() => parseInviteLink(unknown)).toThrow("invalid-link");
    // The inviter belongs in the query; in the fragment beside the code it
    // is an unknown fragment key.
    const inFragment = new URL(link);
    inFragment.hash = `${inFragment.hash.slice(1)}&inviter=${space}`;
    expect(() => parseInviteLink(inFragment)).toThrow("invalid-link");
  });
  it("carries no access in the link, so none can be edited in or out of it", () => {
    // Access lives only in the server's invitation row, fixed by the owner's
    // signed create request. A link names where and which invitation, never
    // what it grants, so an OWNER link and a WRITE link have the same shape.
    const invite = {
      host: "https://example.com",
      space,
      ...createInviteCredentials(),
    };
    const link = buildInviteLink("https://shell.example", invite);
    expect([...link.searchParams.keys()].sort()).toEqual([
      "host",
      "invite",
      "space",
    ]);
    expect(parseInviteLink(link)).toEqual(invite);
    for (const access of ["OWNER", "WRITE", "READ"]) {
      const inQuery = new URL(link);
      inQuery.searchParams.set("access", access);
      expect(() => parseInviteLink(inQuery)).toThrow("invalid-link");
      const inFragment = new URL(link);
      inFragment.hash = `${inFragment.hash.slice(1)}&access=${access}`;
      expect(() => parseInviteLink(inFragment)).toThrow("invalid-link");
    }
  });
  it("generates invite IDs that begin with a letter and vary with the first random byte", () => {
    const ids = new Set<string>();
    for (let first = 0; first < 256; first++) {
      using _random = stub(
        crypto,
        "getRandomValues",
        <T extends ArrayBufferView | null>(array: T) => {
          const bytes = new Uint8Array(
            array!.buffer,
            array!.byteOffset,
            array!.byteLength,
          );
          bytes.fill(0xF8);
          bytes[0] = first;
          return array;
        },
      );
      const { inviteId } = createInviteCredentials();
      expect(isInviteId(inviteId)).toBe(true);
      expect(inviteId).toMatch(/^[A-Za-z]/);
      ids.add(inviteId);
    }
    expect(ids.size).toBeGreaterThanOrEqual(128);
  });
  it("binds the verifier to its version, normalized origin, space, invite ID, and full secret", () => {
    const invite = {
      host: "https://EXAMPLE.com:443/",
      space,
      inviteId: "A".repeat(22),
      code: "A".repeat(43),
    };
    expect(inviteCodeVerifier(invite)).toBe(
      "vkcDbR4COvg5bodlCDvy2marG9681d8fyX7UwZg01nA",
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
  describe("parseInviteLink() forms", () => {
    const invite = {
      host: "https://service.example",
      space,
      ...createInviteCredentials(),
    };
    const link = buildInviteLink("https://links.example", invite);
    const query = link.search;
    const scheme = `${INVITE_LINK_SCHEME}://join${query}`;

    it("names the scheme `fbrc`", () => {
      expect(INVITE_LINK_SCHEME).toBe("fbrc");
    });
    it("returns the same invitation for the `/join`, `/open`, and `fbrc://join` forms", () => {
      const withInviter = buildInviteLink("https://links.example", {
        ...invite,
        inviter,
      });
      for (
        const [built, expected] of [[link, invite], [withInviter, {
          ...invite,
          inviter,
        }]] as const
      ) {
        expect(parseInviteLink(built)).toEqual(expected);
        expect(parseInviteLink(built.href.replace("/join?", "/open?")))
          .toEqual(expected);
        expect(
          parseInviteLink(
            `${INVITE_LINK_SCHEME}://join${built.search}${built.hash}`,
          ),
        ).toEqual(expected);
      }
    });
    it("returns the service named in the query as `host`, never the link's own origin", () => {
      const parsed = parseInviteLink(`${scheme}${link.hash}`)!;
      expect(parsed.host).toBe("https://service.example");
      expect(inviteCodeVerifier(parsed)).toBe(inviteCodeVerifier(invite));
    });
    it("returns the invitation for a fragmentless `fbrc://join` link given the code apart from it", () => {
      expect(parseInviteLink(scheme, { code: invite.code })).toEqual(invite);
      expect(parseInviteLink(`${scheme}#`, { code: invite.code })).toEqual(
        invite,
      );
    });
    it("returns `undefined` for the setup reply and every other action or path", () => {
      for (
        const other of [
          `${INVITE_LINK_SCHEME}://setup?n=abc123`,
          // The setup action is never an invitation, whatever it carries.
          `${INVITE_LINK_SCHEME}://setup${query}${link.hash}`,
          `${INVITE_LINK_SCHEME}://other${query}${link.hash}`,
          `${INVITE_LINK_SCHEME}://JOIN${query}${link.hash}`,
          `${INVITE_LINK_SCHEME}:join${query}${link.hash}`,
          `${INVITE_LINK_SCHEME}:///join${query}${link.hash}`,
          `https://links.example/setup${query}${link.hash}`,
          `https://links.example/join/${query}${link.hash}`,
        ]
      ) {
        expect(parseInviteLink(other)).toBeUndefined();
        expect(parseInviteLink(other, { code: invite.code })).toBeUndefined();
      }
    });
    it("throws `invalid-link`, without the code, for a malformed scheme-form or separated-code invitation", () => {
      const cases: [string, { code?: string }][] = [
        // No code anywhere.
        [scheme, {}],
        [`${scheme}#`, {}],
        // A code both in the fragment and apart from it.
        [`${scheme}${link.hash}`, { code: invite.code }],
        // A fragment other than the code beside a separate code.
        [`${scheme}#inviter=${inviter}`, { code: invite.code }],
        // A separate code is defined only for the scheme form.
        [link.href.replace(link.hash, ""), { code: invite.code }],
        [link.href.replace(link.hash, "").replace("/join?", "/open?"), {
          code: invite.code,
        }],
        // Anything but the bare `join` host.
        [`${INVITE_LINK_SCHEME}://join/${query}${link.hash}`, {}],
        [`${INVITE_LINK_SCHEME}://join/x${query}`, { code: invite.code }],
        [`${INVITE_LINK_SCHEME}://join:5${query}${link.hash}`, {}],
        [`${INVITE_LINK_SCHEME}://someone@join${query}${link.hash}`, {}],
        // Unknown, missing, or misplaced keys.
        [`${scheme}&note=hello${link.hash}`, {}],
        [`${scheme}&code=${invite.code}`, {}],
        [`${scheme}&code=${invite.code}`, { code: invite.code }],
        [`${scheme.replace(/&invite=[^&]*/, "")}${link.hash}`, {}],
        [`${scheme}${link.hash}&access=OWNER`, {}],
      ];
      for (const [malformed, options] of cases) {
        expect(refusal(() => parseInviteLink(malformed, options))).toBe(
          "invalid-link",
        );
      }
    });
    it("throws `invalid-request` for a separate code that is not an invitation secret", () => {
      expect(refusal(() => parseInviteLink(scheme, { code: "short" }))).toBe(
        "invalid-request",
      );
    });
  });
});
