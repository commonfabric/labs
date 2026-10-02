// Drives the ingest-channel control-plane client (lib/ingest-channels.ts) in
// process against a stubbed fetch, so the wire contract every verb depends on
// is actually exercised without a live toolshed.
//
// The assertions that matter here are the ones the server verifies:
//   * the request carries the CF1 first-party proof headers, i.e. signing
//     really happened with the caller's own key;
//   * the body bytes SENT are the bytes that were SIGNED — the proof commits to
//     a body hash, so a client that serializes twice mints nothing but 401s.
// Everything else (status handling, error surfacing) is about not swallowing
// what the server said.

import { afterAll, beforeAll, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { Identity, legacySpaceDid } from "@commonfabric/identity";
import { sha256 } from "@commonfabric/content-hash";
import { toUnpaddedBase64url } from "@commonfabric/utils/base64url";
import {
  type ChannelConfig,
  controlPlaneUrl,
  listChannels,
  mintChannel,
  newRequestId,
  resolveSpaceDid,
  revokeChannel,
  rotateChannel,
} from "../lib/ingest-channels.ts";

const API_URL = new URL("http://ingest-channels-test.invalid:9999");
const SPACE_DID = "did:key:z6MkIngestChannelsTestSpaceAAAAAAAAAAAAAAAAAAAAA";

// Mirrors packages/runner/src/toolshed-http-auth.ts. Spelled literally rather
// than imported so a rename of the wire header shows up as a failure here.
const AUTH_HEADER = "CF-Request-Auth";
const PROOF_HEADER = "CF-Request-Proof";
const USER_DID_HEADER = "CF-User-DID";
const BODY_SHA256_HEADER = "CF-Request-Body-SHA256";

let tmpRoot: string;
let config: ChannelConfig;
let userDid: string;

interface RecordedRequest {
  url: URL;
  method: string;
  headers: Headers;
  body: string;
}

interface StubReply {
  status?: number;

  /** Serialized as JSON. */
  body?: unknown;

  /** Sent verbatim, for the not-JSON case. */
  raw?: string;
}

/**
 * Runs `fn` with `globalThis.fetch` replaced by a recorder that answers with
 * `reply`, and always puts the real fetch back.
 */
async function withStubbedFetch<T>(
  reply: StubReply,
  fn: (calls: RecordedRequest[]) => Promise<T>,
): Promise<T> {
  const original = globalThis.fetch;
  const calls: RecordedRequest[] = [];
  globalThis.fetch = ((input: string | URL | Request, init?: RequestInit) => {
    calls.push({
      url: new URL(typeof input === "string" ? input : input.toString()),
      method: init?.method ?? "GET",
      headers: new Headers(init?.headers),
      body: typeof init?.body === "string" ? init.body : "",
    });
    return Promise.resolve(
      new Response(reply.raw ?? JSON.stringify(reply.body ?? {}), {
        status: reply.status ?? 200,
      }),
    );
  }) as typeof fetch;
  try {
    return await fn(calls);
  } finally {
    globalThis.fetch = original;
  }
}

/** The proof commits to a hash of the body; assert it hashes what was sent. */
function expectSignedTheBytesItSent(call: RecordedRequest): void {
  const sentBytes = new TextEncoder().encode(call.body);
  expect(call.headers.get(BODY_SHA256_HEADER)).toBe(
    toUnpaddedBase64url(sha256(sentBytes)),
  );
}

/**
 * Asserts `call` is a signed POST of `verb`, addressed to `space` when one is
 * given and to the prefix that names no space otherwise.
 */
function expectFirstPartyProof(
  call: RecordedRequest,
  verb: string,
  space?: string,
): void {
  expect(call.method).toBe("POST");
  expect(call.url.pathname).toBe(
    space === undefined
      ? `/api/ingest-channels/${verb}`
      : `/api/spaces/${space}/ingest-channels/${verb}`,
  );
  expect(call.headers.get("Content-Type")).toBe("application/json");
  expect(call.headers.get(AUTH_HEADER)).toMatch(/^CF1 issued-at=/);
  expect(call.headers.get(PROOF_HEADER)).toMatch(/^[A-Za-z0-9_-]+$/);
  expect(call.headers.get(USER_DID_HEADER)).toBe(userDid);
  expectSignedTheBytesItSent(call);
}

beforeAll(async () => {
  tmpRoot = await Deno.makeTempDir({ prefix: "cli-ingest-channels-" });
  const identityPath = `${tmpRoot}/id.key`;
  const pkcs8 = await Identity.generatePkcs8();
  await Deno.writeFile(identityPath, pkcs8);
  userDid = (await Identity.fromPkcs8(pkcs8)).did();
  config = { apiUrl: API_URL, identityPath };
});

afterAll(async () => {
  await Deno.remove(tmpRoot, { recursive: true }).catch(() => {});
});

describe("resolveSpaceDid", () => {
  describe("control-plane URL construction", () => {
    // A root-absolute path resolved against a base URL discards the base's own
    // path, so a deployment served under a prefix had every command addressed at
    // the origin — failing as a 404 from somewhere else rather than as a
    // configuration error.

    it("keeps the configured base path", () => {
      expect(
        controlPlaneUrl(new URL("https://host.example/fabric"), "list").href,
      )
        .toBe("https://host.example/fabric/api/ingest-channels/list");
    });

    it("handles a trailing slash, a bare origin, and a nested prefix", () => {
      for (
        const [base, expected] of [
          [
            "https://host.example/fabric/",
            "/fabric/api/ingest-channels/list",
          ],
          ["https://host.example", "/api/ingest-channels/list"],
          ["https://host.example/", "/api/ingest-channels/list"],
          ["https://host.example/a/b", "/a/b/api/ingest-channels/list"],
        ] as const
      ) {
        expect(controlPlaneUrl(new URL(base), "list").pathname, base)
          .toBe(expected);
      }
    });

    it("returns a path naming the space ahead of the verb, under the configured base path", () => {
      expect(
        controlPlaneUrl(
          new URL("https://host.example/fabric/"),
          "mint",
          SPACE_DID,
        ).href,
      ).toBe(
        `https://host.example/fabric/api/spaces/${SPACE_DID}/ingest-channels/mint`,
      );
    });

    it("does not mutate the caller's URL", () => {
      const base = new URL("https://host.example/fabric");
      controlPlaneUrl(base, "list");
      expect(base.href).toBe("https://host.example/fabric");
    });

    it("signs the same pathful URL it sends to", async () => {
      // The proof commits to the URL, so signing one path and sending another
      // is not merely a wrong endpoint — it would fail to verify.

      await withStubbedFetch(
        { body: { channels: [] } },
        async (calls) => {
          await listChannels({
            ...config,
            apiUrl: new URL("https://host.example/fabric"),
          });
          expect(calls[0].url.pathname).toBe(
            "/fabric/api/ingest-channels/list",
          );
        },
      );
    });
  });

  it("passes a did:key through untouched", async () => {
    expect(await resolveSpaceDid(config.identityPath, SPACE_DID)).toBe(
      SPACE_DID,
    );
  });

  it("derives a DID from a space name", async () => {
    const did = await resolveSpaceDid(config.identityPath, "ingest-test-space");
    expect(did).toBe(await legacySpaceDid("ingest-test-space"));
    expect(did).not.toBe(SPACE_DID);
  });

  it("resolves a space name with no network and no identity file", async () => {
    // A name resolves through the legacy derivation alone, so resolving it
    // opens nothing: no request, and no read of the caller's key.

    await withStubbedFetch({ status: 503 }, async (calls) => {
      expect(
        await resolveSpaceDid(`${tmpRoot}/absent.key`, "ingest-offline-space"),
      ).toBe(await legacySpaceDid("ingest-offline-space"));
      expect(calls).toEqual([]);
    });
  });

  it("derives the same DID for a name regardless of who asks", async () => {
    // A legacy name's DID is derived from a shared public passphrase plus the
    // name, not from the caller. Pin the property so a change to the
    // derivation is loud.
    const second = `${tmpRoot}/other.key`;
    await Deno.writeFile(second, await Identity.generatePkcs8());

    const mine = await resolveSpaceDid(config.identityPath, "shared-name");
    const theirs = await resolveSpaceDid(second, "shared-name");
    expect(theirs).toBe(mine);

    // ...and a different name is a different space.
    expect(await resolveSpaceDid(second, "other-name")).not.toBe(mine);
  });
});

describe("newRequestId", () => {
  it("is a fresh UUID per call", () => {
    const first = newRequestId();
    const second = newRequestId();
    expect(first).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
    expect(second).not.toBe(first);
  });
});

describe("ingest-channel verbs", () => {
  it("mint signs the request and returns the one-shot token", async () => {
    const minted = {
      id: "chan-1",
      url: `${API_URL.origin}/api/spaces/${SPACE_DID}/ingest/chan-1`,
      space: SPACE_DID,
      causePrefix: "ingest/phone-1",
      installId: "phone-1",
      expiresAt: "2026-09-01T00:00:00.000Z",
      token: "tok-secret",
    };
    const result = await withStubbedFetch(
      { body: minted },
      async (calls) => {
        const got = await mintChannel(config, {
          space: SPACE_DID,
          installId: "phone-1",
          causePrefix: "ingest/phone-1",
          name: "Phone",
          ttlDays: 30,
          requestId: "req-1",
        });
        expect(calls.length).toBe(1);
        expectFirstPartyProof(calls[0], "mint", SPACE_DID);
        // The space is in the path, and so is no part of the body.
        expect(JSON.parse(calls[0].body)).toEqual({
          installId: "phone-1",
          causePrefix: "ingest/phone-1",
          name: "Phone",
          ttlDays: 30,
          requestId: "req-1",
        });
        return got;
      },
    );
    expect(result).toEqual(minted);
  });

  it("list unwraps the channels array", async () => {
    const channels = [{
      id: "chan-1",
      name: "Phone",
      space: SPACE_DID,
      causePrefix: "ingest/phone-1",
      installId: "phone-1",
      sink: "journal",
      createdAt: "2026-08-01T00:00:00.000Z",
      enabled: true,
      lastSeenAt: null,
    }];
    const result = await withStubbedFetch(
      { body: { channels } },
      async (calls) => {
        const got = await listChannels(config, { space: SPACE_DID });
        expectFirstPartyProof(calls[0], "list", SPACE_DID);
        expect(JSON.parse(calls[0].body)).toEqual({});
        return got;
      },
    );
    expect(result).toEqual(channels);
  });

  it("list with no filter still sends a signed empty body", async () => {
    const result = await withStubbedFetch(
      { body: { channels: [] } },
      async (calls) => {
        const got = await listChannels(config);
        expectFirstPartyProof(calls[0], "list");
        expect(calls[0].body).toBe("{}");
        return got;
      },
    );
    expect(result).toEqual([]);
  });

  it("rotate posts the id and the new ttl", async () => {
    const rotated = {
      id: "chan-1",
      url: `${API_URL.origin}/api/spaces/${SPACE_DID}/ingest/chan-1`,
      space: SPACE_DID,
      causePrefix: "ingest/phone-1",
      installId: "phone-1",
      token: "tok-rotated",
    };
    const result = await withStubbedFetch(
      { body: rotated },
      async (calls) => {
        const got = await rotateChannel(config, {
          space: SPACE_DID,
          id: "chan-1",
          ttlDays: 7,
          requestId: "req-2",
        });
        expectFirstPartyProof(calls[0], "rotate", SPACE_DID);
        expect(JSON.parse(calls[0].body)).toEqual({
          id: "chan-1",
          ttlDays: 7,
          requestId: "req-2",
        });
        return got;
      },
    );
    expect(result).toEqual(rotated);
  });

  it("revoke posts the id and returns the revocation time", async () => {
    const result = await withStubbedFetch(
      { body: { id: "chan-1", revokedAt: "2026-08-04T12:00:00.000Z" } },
      async (calls) => {
        const got = await revokeChannel(config, {
          space: SPACE_DID,
          id: "chan-1",
          requestId: "rq-1",
          expectedRevision: 3,
        });
        expectFirstPartyProof(calls[0], "revoke", SPACE_DID);
        // The idempotency key is part of the SIGNED body: a captured revoke is
        // otherwise replayable for its whole proof window, and the server
        // spends this id in the same transaction as the write.
        expect(JSON.parse(calls[0].body)).toEqual({
          id: "chan-1",
          requestId: "rq-1",
          // Also signed: it names the generation being revoked, which is what
          // stops a captured-and-withheld revoke landing on a later one.
          expectedRevision: 3,
        });
        return got;
      },
    );
    expect(result).toEqual({
      id: "chan-1",
      revokedAt: "2026-08-04T12:00:00.000Z",
    });
  });
});

describe("ingest-channel error surfacing", () => {
  it("throws the server's own error string on a non-2xx", async () => {
    await withStubbedFetch(
      { status: 403, body: { error: "no OWNER grant on that space" } },
      async () => {
        await expect(
          revokeChannel(config, {
            space: SPACE_DID,
            id: "chan-1",
            requestId: "rq-1",
            expectedRevision: 3,
          }),
        ).rejects.toThrow("no OWNER grant on that space");
      },
    );
  });

  it("falls back to the status when the body carries no error", async () => {
    await withStubbedFetch(
      { status: 409, body: { requestId: "req-1" } },
      async () => {
        await expect(
          mintChannel(config, {
            space: SPACE_DID,
            installId: "phone-1",
            requestId: "req-1",
          }),
        ).rejects.toThrow("HTTP 409");
      },
    );
  });

  it("reports the status when the response is not JSON at all", async () => {
    // A proxy or a 502 page: don't pretend it parsed, and name the status so
    // the caller can tell an outage apart from a rejection.
    await withStubbedFetch(
      { status: 502, raw: "<html>bad gateway</html>" },
      async () => {
        await expect(listChannels(config)).rejects.toThrow(
          "list failed (502): <html>bad gateway</html>",
        );
      },
    );
  });
});
