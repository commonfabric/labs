import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";

import { fromBase64url } from "@commonfabric/utils/base64url";

import {
  GitHubApp,
  type GitHubCredential,
  GitHubCredentials,
  INSTALLATION_TOKEN_RENEWAL_MS,
  staticGitHubCredential,
} from "./github-auth.ts";

const HOUR_MS = 60 * 60_000;
const START_MS = Date.parse("2026-10-06T12:00:00Z");

/** An RSA key pair, with the private half as PEM in both forms GitHub uses. */
interface TestKey {
  /** The public half, to check signatures with. */
  publicKey: CryptoKey;

  /** The private half, as a PKCS#8 PEM. */
  pkcs8: string;

  /** The private half, as the PKCS#1 PEM GitHub issues. */
  pkcs1: string;
}

/** A request the app made, as a fake GitHub saw it. */
interface SeenRequest {
  /** The method and the path, as in `POST app/installations/1/access_tokens`. */
  route: string;

  /** The bearer token the request carried. */
  bearer: string;
}

async function testKey(): Promise<TestKey> {
  const pair = await crypto.subtle.generateKey(
    {
      name: "RSASSA-PKCS1-v1_5",
      modulusLength: 2048,
      publicExponent: new Uint8Array([1, 0, 1]),
      hash: "SHA-256",
    },
    true,
    ["sign", "verify"],
  );
  const pkcs8 = new Uint8Array(
    await crypto.subtle.exportKey("pkcs8", pair.privateKey),
  );
  return {
    publicKey: pair.publicKey,
    pkcs8: pem("PRIVATE KEY", pkcs8),
    pkcs1: pem("RSA PRIVATE KEY", pkcs1Within(pkcs8)),
  };
}

function pem(label: string, der: Uint8Array): string {
  const body = btoa(Array.from(der, (byte) => String.fromCharCode(byte)).join(""))
    .replace(/.{64}/g, "$&\n");
  return `-----BEGIN ${label}-----\n${body}\n-----END ${label}-----\n`;
}

// The PKCS#1 key a PKCS#8 RSA key carries. For a 2048-bit key the structure
// opens with 26 bytes ahead of it: the outer sequence's header, the version,
// the algorithm identifier, and the header of the octet string holding it.
function pkcs1Within(pkcs8: Uint8Array): Uint8Array {
  expect(Array.from(pkcs8.slice(22, 24))).toEqual([0x04, 0x82]);
  expect(pkcs8[24] << 8 | pkcs8[25]).toBe(pkcs8.length - 26);
  return pkcs8.slice(26);
}

/**
 * A fake GitHub for the app's own requests. It lists `installations`, a
 * hundred to a page, and mints a token named after the installation and a
 * count, expiring an hour after `now()`. A route in `failures` gets that
 * status instead, and a route in `bodies` that body.
 */
function fakeGitHub(
  installations: { id: number; target_type: string; account: object }[],
  now: () => number,
  failures = new Map<string, number>(),
  bodies = new Map<string, object>(),
) {
  const seen: SeenRequest[] = [];
  let minted = 0;
  const fetch: typeof globalThis.fetch = (input, init) => {
    const url = new URL(String(input));
    const route = `${init?.method ?? "GET"} ${url.pathname.slice(1)}`;
    const authorization = new Headers(init?.headers).get("authorization") ??
      "";
    seen.push({ route, bearer: authorization.replace(/^Bearer /, "") });
    const failure = failures.get(route);
    if (failure) return Promise.resolve(new Response(null, { status: failure }));
    const body = bodies.get(route);
    if (body) return Promise.resolve(Response.json(body));
    if (route === "GET app/installations") {
      const page = Number(url.searchParams.get("page"));
      return Promise.resolve(
        Response.json(installations.slice((page - 1) * 100, page * 100)),
      );
    }
    const mint = /^POST app\/installations\/(\d+)\/access_tokens$/.exec(route);
    if (mint) {
      minted++;
      return Promise.resolve(Response.json({
        token: `installation-${mint[1]}-token-${minted}`,
        expires_at: new Date(now() + HOUR_MS).toISOString(),
      }, { status: 201 }));
    }
    return Promise.resolve(new Response(null, { status: 404 }));
  };
  return { fetch, seen };
}

const ORGANIZATION = {
  id: 7,
  target_type: "Organization",
  account: { login: "CommonFabric" },
};
const ENTERPRISE = {
  id: 9,
  target_type: "Enterprise",
  account: { slug: "common-fabric" },
};

describe("github-auth", () => {
  describe("GitHubApp", () => {
    describe("instance members", () => {
      describe("installation()", () => {
        it("returns a token minted for the organization's installation", async () => {
          const key = await testKey();
          const github = fakeGitHub([ENTERPRISE, ORGANIZATION], () => START_MS);
          const app = new GitHubApp("Iv23test", key.pkcs1, {
            fetch: github.fetch,
            now: () => START_MS,
          });
          const credential = app.installation({
            kind: "organization",
            name: "commonfabric",
          });

          expect(await credential.token()).toBe("installation-7-token-1");
          expect(github.seen.map((request) => request.route)).toEqual([
            "GET app/installations",
            "POST app/installations/7/access_tokens",
          ]);
        });

        it("returns a token minted for the enterprise's installation", async () => {
          const key = await testKey();
          const github = fakeGitHub([ORGANIZATION, ENTERPRISE], () => START_MS);
          const app = new GitHubApp("Iv23test", key.pkcs8, {
            fetch: github.fetch,
            now: () => START_MS,
          });

          expect(
            await app.installation({ kind: "enterprise", name: "common-fabric" })
              .token(),
          ).toBe("installation-9-token-1");
        });

        it("finds an installation listed on a later page", async () => {
          const key = await testKey();
          const others = Array.from({ length: 100 }, (_, i) => ({
            id: 1000 + i,
            target_type: "Organization",
            account: { login: `other-${i}` },
          }));
          const github = fakeGitHub(
            [...others, ORGANIZATION],
            () => START_MS,
          );
          const app = new GitHubApp("Iv23test", key.pkcs8, {
            fetch: github.fetch,
            now: () => START_MS,
          });

          expect(
            await app.installation({ kind: "organization", name: "commonfabric" })
              .token(),
          ).toBe("installation-7-token-1");
        });

        it("rejects when the app is not installed on the account", async () => {
          const key = await testKey();
          const github = fakeGitHub([ORGANIZATION], () => START_MS);
          const app = new GitHubApp("Iv23test", key.pkcs8, {
            fetch: github.fetch,
            now: () => START_MS,
          });

          // An organization login matching the enterprise's slug does not
          // stand in for the enterprise.
          await expect(
            app.installation({ kind: "enterprise", name: "CommonFabric" })
              .token(),
          ).rejects.toThrow(
            "GitHub App `Iv23test` is not installed on enterprise `CommonFabric`",
          );
        });

        it("signs its own requests as the app, with a JWT GitHub accepts", async () => {
          const key = await testKey();
          const github = fakeGitHub([ORGANIZATION], () => START_MS);
          const app = new GitHubApp("Iv23test", key.pkcs1, {
            fetch: github.fetch,
            now: () => START_MS,
          });
          await app.installation({ kind: "organization", name: "commonfabric" })
            .token();

          const [header, payload, encoded] = github.seen[0].bearer.split(".");
          const signature = new Uint8Array(fromBase64url(encoded));
          const decode = (part: string) =>
            JSON.parse(new TextDecoder().decode(fromBase64url(part)));
          expect(decode(header)).toEqual({ alg: "RS256", typ: "JWT" });
          expect(decode(payload)).toEqual({
            iat: START_MS / 1000 - 60,
            exp: START_MS / 1000 + 540,
            iss: "Iv23test",
          });
          expect(
            await crypto.subtle.verify(
              "RSASSA-PKCS1-v1_5",
              key.publicKey,
              signature,
              new TextEncoder().encode(`${header}.${payload}`),
            ),
          ).toBe(true);
          expect(
            await crypto.subtle.verify(
              "RSASSA-PKCS1-v1_5",
              key.publicKey,
              signature,
              new TextEncoder().encode(`${header}.${payload}x`),
            ),
          ).toBe(false);
        });

        it("rejects every token request when the private key is not an RSA PEM key", async () => {
          const github = fakeGitHub([ORGANIZATION], () => START_MS);
          const app = new GitHubApp("Iv23test", "not a key", {
            fetch: github.fetch,
            now: () => START_MS,
          });
          const credential = app.installation({
            kind: "organization",
            name: "commonfabric",
          });

          for (let i = 0; i < 2; i++) {
            await expect(credential.token()).rejects.toThrow(
              "expected a PEM RSA private key",
            );
          }
          expect(github.seen).toEqual([]);
        });

        it("reuses a token until it is within the renewal margin of expiring", async () => {
          const key = await testKey();
          let now = START_MS;
          const github = fakeGitHub([ORGANIZATION], () => now);
          const app = new GitHubApp("Iv23test", key.pkcs8, {
            fetch: github.fetch,
            now: () => now,
          });
          const credential = app.installation({
            kind: "organization",
            name: "commonfabric",
          });

          expect(await credential.token()).toBe("installation-7-token-1");
          now = START_MS + HOUR_MS - INSTALLATION_TOKEN_RENEWAL_MS - 1;
          expect(await credential.token()).toBe("installation-7-token-1");
          now = START_MS + HOUR_MS - INSTALLATION_TOKEN_RENEWAL_MS;
          expect(await credential.token()).toBe("installation-7-token-2");
          expect(github.seen.map((request) => request.route)).toEqual([
            "GET app/installations",
            "POST app/installations/7/access_tokens",
            "POST app/installations/7/access_tokens",
          ]);
        });

        it("mints one token for requests that ask at the same time", async () => {
          const key = await testKey();
          const github = fakeGitHub([ORGANIZATION], () => START_MS);
          const app = new GitHubApp("Iv23test", key.pkcs8, {
            fetch: github.fetch,
            now: () => START_MS,
          });
          const credential = app.installation({
            kind: "organization",
            name: "commonfabric",
          });

          expect(
            await Promise.all([credential.token(), credential.token()]),
          ).toEqual(["installation-7-token-1", "installation-7-token-1"]);
          expect(github.seen.length).toBe(2);
        });

        it("looks the installation up again after minting a token fails", async () => {
          const key = await testKey();
          const failures = new Map([
            ["POST app/installations/7/access_tokens", 404],
          ]);
          const github = fakeGitHub([ORGANIZATION], () => START_MS, failures);
          const app = new GitHubApp("Iv23test", key.pkcs8, {
            fetch: github.fetch,
            now: () => START_MS,
          });
          const credential = app.installation({
            kind: "organization",
            name: "commonfabric",
          });

          await expect(credential.token()).rejects.toThrow(
            "GitHub App `Iv23test` request POST " +
              "app/installations/7/access_tokens failed: HTTP 404",
          );
          failures.clear();
          expect(await credential.token()).toBe("installation-7-token-1");
          expect(github.seen.map((request) => request.route)).toEqual([
            "GET app/installations",
            "POST app/installations/7/access_tokens",
            "GET app/installations",
            "POST app/installations/7/access_tokens",
          ]);
        });

        it("returns a token minted for a user account's installation, for an organization-kind account", async () => {
          const key = await testKey();
          const user = { id: 4, target_type: "User", account: { login: "octo" } };
          const github = fakeGitHub([user], () => START_MS);
          const app = new GitHubApp("Iv23test", key.pkcs8, {
            fetch: github.fetch,
            now: () => START_MS,
          });

          expect(
            await app.installation({ kind: "organization", name: "octo" })
              .token(),
          ).toBe("installation-4-token-1");
        });

        it("rejects a minted token that lacks an expiry", async () => {
          const key = await testKey();
          const github = fakeGitHub(
            [ORGANIZATION],
            () => START_MS,
            new Map(),
            new Map([[
              "POST app/installations/7/access_tokens",
              { token: "no-expiry" },
            ]]),
          );
          const app = new GitHubApp("Iv23test", key.pkcs8, {
            fetch: github.fetch,
            now: () => START_MS,
          });

          await expect(
            app.installation({ kind: "organization", name: "commonfabric" })
              .token(),
          ).rejects.toThrow(
            "GitHub App `Iv23test` was given a malformed token for " +
              "organization `commonfabric`",
          );
        });

        it("mints a new token, looking the installation up again, once its token is refused", async () => {
          const key = await testKey();
          const github = fakeGitHub([ORGANIZATION], () => START_MS);
          const app = new GitHubApp("Iv23test", key.pkcs8, {
            fetch: github.fetch,
            now: () => START_MS,
          });
          const credential = app.installation({
            kind: "organization",
            name: "commonfabric",
          });

          const first = await credential.token();
          credential.refused("some-other-token");
          expect(await credential.token()).toBe(first);
          credential.refused(first);
          expect(await credential.token()).toBe("installation-7-token-2");
          expect(github.seen.map((request) => request.route)).toEqual([
            "GET app/installations",
            "POST app/installations/7/access_tokens",
            "GET app/installations",
            "POST app/installations/7/access_tokens",
          ]);
        });

        it("returns one credential per account, whose allowance is the same across tokens", async () => {
          const key = await testKey();
          const app = new GitHubApp("Iv23test", key.pkcs8);
          const organization = app.installation({
            kind: "organization",
            name: "commonfabric",
          });

          expect(
            app.installation({ kind: "organization", name: "CommonFabric" }),
          ).toBe(organization);
          expect(organization.allowance).toBe(
            "GitHub App Iv23test on organization commonfabric",
          );
          expect(
            app.installation({ kind: "enterprise", name: "commonfabric" })
              .allowance,
          ).toBe("GitHub App Iv23test on enterprise commonfabric");
        });
      });
    });
  });

  describe("staticGitHubCredential()", () => {
    it("returns the token it was given, which is also its allowance", async () => {
      const credential = staticGitHubCredential("github_pat_example");

      expect(await credential.token()).toBe("github_pat_example");
      expect(credential.allowance).toBe("github_pat_example");
    });
  });

  describe("GitHubCredentials", () => {
    describe("instance members", () => {
      describe("for()", () => {
        const organization = {
          kind: "organization",
          name: "commonfabric",
        } as const;
        const source = (variables: Record<string, string>) => ({
          env: (key: string) => variables[key],
        });

        it("returns `undefined` when no credential is configured", () => {
          expect(new GitHubCredentials().for(source({}), organization))
            .toBeUndefined();
        });

        it("returns `GH_TOKEN`, or else `GITHUB_TOKEN`, when no app is configured", async () => {
          const credentials = new GitHubCredentials();
          const both = source({ GH_TOKEN: "first", GITHUB_TOKEN: "second" });

          expect(await credentials.for(both, organization)!.token())
            .toBe("first");
          expect(
            await credentials.for(source({ GITHUB_TOKEN: "second" }), organization)!
              .token(),
          ).toBe("second");
        });

        it("returns the same credential for the same token", () => {
          const credentials = new GitHubCredentials();
          const variables = source({ GH_TOKEN: "same" });

          expect(credentials.for(variables, organization))
            .toBe(credentials.for(variables, organization));
        });

        it("returns the app's installation when the app is configured and no token variable is set", async () => {
          const key = await testKey();
          const credentials = new GitHubCredentials();
          const variables = source({
            GH_APP_CLIENT_ID: "Iv23test",
            GH_APP_PRIVATE_KEY: key.pkcs1,
          });
          const credential: GitHubCredential = credentials.for(
            variables,
            organization,
          )!;

          expect(credential.allowance).toBe(
            "GitHub App Iv23test on organization commonfabric",
          );
          expect(credentials.for(variables, organization)).toBe(credential);
          expect(
            credentials.for(variables, {
              kind: "enterprise",
              name: "common-fabric",
            })!.allowance,
          ).toBe("GitHub App Iv23test on enterprise common-fabric");
        });

        it("returns an override that is set in preference to the app, and the app in preference to `GH_TOKEN`", async () => {
          const key = await testKey();
          const credentials = new GitHubCredentials();
          const variables = source({
            GH_APP_CLIENT_ID: "Iv23test",
            GH_APP_PRIVATE_KEY: key.pkcs1,
            GH_BILLING_TOKEN: "billing",
            GH_TOKEN: "ordinary",
          });

          expect(
            await credentials.for(variables, organization, ["GH_BILLING_TOKEN"])!
              .token(),
          ).toBe("billing");
          expect(credentials.for(variables, organization)!.allowance).toBe(
            "GitHub App Iv23test on organization commonfabric",
          );
        });

        it("returns a credential naming the missing variable when only half of the app is configured", async () => {
          const credentials = new GitHubCredentials();

          await expect(
            credentials.for(
              source({ GH_APP_CLIENT_ID: "Iv23test", GH_TOKEN: "ordinary" }),
              organization,
            )!.token(),
          ).rejects.toThrow(
            "set GH_APP_PRIVATE_KEY to authenticate as the GitHub App",
          );
          await expect(
            credentials.for(
              source({ GH_APP_PRIVATE_KEY: "key" }),
              organization,
            )!.token(),
          ).rejects.toThrow(
            "set GH_APP_CLIENT_ID to authenticate as the GitHub App",
          );
        });
      });
    });
  });
});
