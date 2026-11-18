import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { encodeBase64Url } from "@std/encoding/base64url";
import { Identity } from "@commonfabric/identity";
import { OAuth2TokenSchema, Runtime } from "@commonfabric/runner";
import { StorageManager } from "@commonfabric/runner/storage/cache.deno";

import { startFakeOAuth2Provider } from "@/test/support/fake-oauth2-provider.ts";
import { createProviderRouters } from "@/routes/integrations/provider-routers.ts";
import type { ProviderDescriptor } from "./oauth2-common.types.ts";
import { discoverProviderConfig, getBaseUrl } from "./oauth2-common.utils.ts";

const BASE = "/api/integrations/acme-oauth";
const REDIRECT_URI = `http://localhost${BASE}/callback`;

const json = (body: unknown, status = 200) => () =>
  Response.json(body, { status });

const tokenResponse = json({
  access_token: "access-1",
  token_type: "Bearer",
  expires_in: 3600,
  refresh_token: "refresh-1",
  scope: "read write",
});

const userInfoResponse = json({
  email: "ada@example.com",
  name: "Ada",
  picture: "https://example.com/ada.png",
});

// Reads the result object the callback page posts to its opener.
async function callbackResult(response: Response) {
  const match = (await response.text()).match(/result: (\{.*\})\n/);
  if (!match) throw new Error("no callback result in the page");
  return JSON.parse(match[1]);
}

async function sha256Base64Url(text: string): Promise<string> {
  return encodeBase64Url(
    await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text)),
  );
}

describe("oauth2-common", () => {
  let signer: Identity;
  let storageManager: ReturnType<typeof StorageManager.emulate>;
  let runtime: Runtime;
  let causeCount = 0;

  beforeEach(async () => {
    signer = await Identity.fromPassphrase("oauth2-common-test");
    storageManager = StorageManager.emulate({ as: signer });
    runtime = new Runtime({
      apiUrl: new URL("https://oauth2-common-test.invalid"),
      storageManager,
    });
  });

  afterEach(async () => {
    await runtime.dispose();
    await storageManager.close();
  });

  // Returns a fresh auth cell, read without a schema so the stored value comes
  // back as written, and the link to it the way the browser sends it: a
  // normalized link carrying the cell's schema.
  function newAuthCell() {
    const cell = runtime.getCell<Record<string, unknown>>(
      signer.did(),
      `oauth2-auth-${causeCount++}`,
    );
    const link = cell.getAsNormalizedFullLink();
    return {
      cell,
      bareLink: JSON.stringify(link),
      authCellId: JSON.stringify({ ...link, schema: OAuth2TokenSchema }),
    };
  }

  async function storedValue(cell: ReturnType<typeof newAuthCell>["cell"]) {
    await runtime.storageManager.synced();
    return cell.get();
  }

  async function routerFor(descriptor: Partial<ProviderDescriptor>) {
    const [router] = await createProviderRouters([{
      name: "acme",
      clientId: "client-id",
      clientSecret: "client-secret",
      authorizationEndpoint: "https://auth.acme.invalid/authorize",
      tokenEndpoint: "https://auth.acme.invalid/token",
      defaultScopes: "profile email",
      ...descriptor,
    }], { runtime: () => runtime });
    return router;
  }

  function post(
    router: Awaited<ReturnType<typeof routerFor>>,
    action: string,
    body: unknown,
  ) {
    return router.request(`${BASE}/${action}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  }

  function callback(
    router: Awaited<ReturnType<typeof routerFor>>,
    params: Record<string, string>,
  ) {
    return router.request(`${BASE}/callback?${new URLSearchParams(params)}`);
  }

  // Starts a login and returns the state and verifier it issued.
  async function startLogin(
    router: Awaited<ReturnType<typeof routerFor>>,
    authCellId: string,
  ) {
    const { url } = await (await post(router, "login", { authCellId })).json();
    const state = new URL(url).searchParams.get("state")!;
    return { state, verifier: JSON.parse(atob(state)).v as string };
  }

  describe("login", () => {
    it("returns an authorization URL with a PKCE challenge and a state carrying the auth cell and the verifier", async () => {
      const router = await routerFor({
        extraAuthParams: { access_type: "offline" },
      });
      const { authCellId, bareLink } = newAuthCell();

      const response = await post(router, "login", {
        authCellId,
        scopes: ["read", "write"],
      });

      expect(response.status).toBe(200);
      const url = new URL((await response.json()).url);
      expect(`${url.origin}${url.pathname}`).toBe(
        "https://auth.acme.invalid/authorize",
      );
      const params = url.searchParams;
      expect(params.get("response_type")).toBe("code");
      expect(params.get("client_id")).toBe("client-id");
      expect(params.get("redirect_uri")).toBe(REDIRECT_URI);
      expect(params.get("scope")).toBe("read write");
      expect(params.get("access_type")).toBe("offline");
      expect(params.get("code_challenge_method")).toBe("S256");

      const state = JSON.parse(atob(params.get("state")!));
      expect(state.a).toBe(bareLink);
      expect(state.s).toEqual(["read", "write"]);
      expect(params.get("code_challenge")).toBe(await sha256Base64Url(state.v));
    });

    it("requests the provider's default scopes when the request names none", async () => {
      const router = await routerFor({});

      const response = await post(router, "login", {
        authCellId: newAuthCell().authCellId,
      });

      const url = new URL((await response.json()).url);
      expect(url.searchParams.get("scope")).toBe("profile email");
      expect(JSON.parse(atob(url.searchParams.get("state")!)).s)
        .toBeUndefined();
    });

    it("returns a 400 when the auth cell is empty", async () => {
      const router = await routerFor({});

      const response = await post(router, "login", { authCellId: "" });

      expect(response.status).toBe(400);
      expect(await response.json()).toEqual({
        error: "Missing authCellId in request",
      });
    });

    it("returns a 400 when the auth cell is not JSON", async () => {
      const router = await routerFor({});

      const response = await post(router, "login", { authCellId: "not json" });

      expect(response.status).toBe(400);
      expect(await response.json()).toEqual({
        error: "Failed to process login request",
      });
    });

    it("returns a 400 when the body is not JSON", async () => {
      const router = await routerFor({});

      const response = await router.request(`${BASE}/login`, {
        method: "POST",
        body: "not json",
      });

      expect(response.status).toBe(400);
      expect(await response.json()).toEqual({
        error: "Failed to process login request",
      });
    });
  });

  describe("callback", () => {
    it("exchanges the code, fetches the user, and persists both in the auth cell", async () => {
      await using provider = startFakeOAuth2Provider({
        "/token": tokenResponse,
        "/user": userInfoResponse,
      });
      const router = await routerFor({
        tokenEndpoint: provider.url("/token"),
        userInfoEndpoint: provider.url("/user"),
      });
      const { cell, authCellId } = newAuthCell();
      const { state, verifier } = await startLogin(router, authCellId);
      const before = Date.now();

      const response = await callback(router, { code: "c+d&e", state });

      expect(response.headers.get("Content-Type")).toBe("text/html");
      expect(response.headers.get("Content-Security-Policy")).toBe(
        "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'",
      );
      expect(response.headers.get("X-Content-Type-Options")).toBe("nosniff");
      const result = await callbackResult(response.clone());
      expect(result.success).toBe(true);
      expect(result.details.userInfo.email).toBe("ada@example.com");
      expect(await response.text()).toContain("Authentication Successful!");

      const [tokenRequest, userRequest] = provider.requests;
      expect(tokenRequest.method).toBe("POST");
      expect(Object.fromEntries(new URLSearchParams(tokenRequest.body)))
        .toEqual({
          grant_type: "authorization_code",
          code: "c+d&e",
          code_verifier: verifier,
          redirect_uri: REDIRECT_URI,
        });
      expect(userRequest.path).toBe("/user");
      expect(userRequest.headers.get("Authorization")).toBe("Bearer access-1");

      const stored = await storedValue(cell);
      expect(stored).toMatchObject({
        accessToken: "access-1",
        tokenType: "Bearer",
        scope: ["read", "write"],
        expiresIn: 3600,
        refreshToken: "refresh-1",
        user: {
          email: "ada@example.com",
          name: "Ada",
          picture: "https://example.com/ada.png",
        },
      });
      expect(stored.expiresAt).toBeGreaterThanOrEqual(before + 3600_000);
      expect(stored.expiresAt).toBeLessThanOrEqual(Date.now() + 3600_000);
    });

    it("persists the tokens without a user when the user-info request fails", async () => {
      await using provider = startFakeOAuth2Provider({
        "/token": tokenResponse,
        "/user": json({ error: "nope" }, 500),
      });
      const router = await routerFor({
        tokenEndpoint: provider.url("/token"),
        userInfoEndpoint: provider.url("/user"),
      });
      const { cell, authCellId } = newAuthCell();
      const { state } = await startLogin(router, authCellId);

      const result = await callbackResult(
        await callback(router, { code: "code", state }),
      );

      expect(result.success).toBe(true);
      expect(result.details.userInfo).toEqual({
        error: "Failed to fetch user info",
      });
      const stored = await storedValue(cell);
      expect(stored.accessToken).toBe("access-1");
      expect(stored.user).toBeUndefined();
    });

    it("persists an empty user when the provider has no user-info endpoint", async () => {
      await using provider = startFakeOAuth2Provider({
        "/token": tokenResponse,
      });
      const router = await routerFor({ tokenEndpoint: provider.url("/token") });
      const { cell, authCellId } = newAuthCell();
      const { state } = await startLogin(router, authCellId);

      await callback(router, { code: "code", state });

      expect(provider.requests.map((r) => r.path)).toEqual(["/token"]);
      expect((await storedValue(cell)).user).toEqual({
        email: "",
        name: "",
        picture: "",
      });
    });

    it("exchanges the code with HTTP Basic client authentication for a `basic` provider", async () => {
      await using provider = startFakeOAuth2Provider({
        "/token": json({ access_token: "basic-access", scope: "a b" }),
      });
      const router = await routerFor({
        tokenEndpoint: provider.url("/token"),
        tokenAuthMethod: "basic",
      });
      const { cell, authCellId } = newAuthCell();
      const { state, verifier } = await startLogin(router, authCellId);

      const result = await callbackResult(
        await callback(router, { code: "code", state }),
      );

      expect(result.success).toBe(true);
      const [tokenRequest] = provider.requests;
      expect(tokenRequest.headers.get("Authorization")).toBe(
        `Basic ${btoa("client-id:client-secret")}`,
      );
      expect(Object.fromEntries(new URLSearchParams(tokenRequest.body)))
        .toEqual({
          grant_type: "authorization_code",
          code: "code",
          redirect_uri: REDIRECT_URI,
          code_verifier: verifier,
        });
      expect(await storedValue(cell)).toMatchObject({
        accessToken: "basic-access",
        tokenType: "Bearer",
        scope: ["a", "b"],
      });
    });

    for (const tokenAuthMethod of ["body", "basic"] as const) {
      it(`reports a failed token exchange and persists nothing (\`${tokenAuthMethod}\`)`, async () => {
        await using provider = startFakeOAuth2Provider({
          "/token": json({ error: "invalid_grant" }, 400),
          "/user": userInfoResponse,
        });
        const router = await routerFor({
          tokenEndpoint: provider.url("/token"),
          userInfoEndpoint: provider.url("/user"),
          tokenAuthMethod,
        });
        const { cell, authCellId } = newAuthCell();
        const { state } = await startLogin(router, authCellId);

        const result = await callbackResult(
          await callback(router, { code: "code", state }),
        );

        expect(result).toEqual({
          success: false,
          error: "Token exchange failed",
        });
        expect(provider.requests.map((r) => r.path)).toEqual(["/token"]);
        expect(await storedValue(cell)).toBeUndefined();
      });
    }

    it("reports the provider's error parameter, escaped, without exchanging a code", async () => {
      await using provider = startFakeOAuth2Provider({
        "/token": tokenResponse,
      });
      const router = await routerFor({ tokenEndpoint: provider.url("/token") });

      const response = await callback(router, {
        error: "<b>access_denied</b>",
        code: "code",
      });

      const html = await response.clone().text();
      expect(html).toContain("Authentication Failed");
      expect(html).toContain("&lt;b&gt;access_denied&lt;/b&gt;");
      expect(html).not.toContain("<b>");
      expect(await callbackResult(response)).toEqual({
        success: false,
        error: "Authentication failed: <b>access_denied</b>",
      });
      expect(provider.requests).toEqual([]);
    });

    it("reports a missing code", async () => {
      const router = await routerFor({});

      const result = await callbackResult(
        await callback(router, { state: "state" }),
      );

      expect(result.error).toBe("No authorization code received");
    });

    it("reports a missing state", async () => {
      const router = await routerFor({});

      const result = await callbackResult(
        await callback(router, { code: "code" }),
      );

      expect(result.error).toBe("No state parameter received");
    });

    it("reports a state that is not one login issued", async () => {
      const router = await routerFor({});
      const { bareLink } = newAuthCell();

      for (const state of ["%%%", btoa(JSON.stringify({ a: bareLink }))]) {
        const result = await callbackResult(
          await callback(router, { code: "code", state }),
        );
        expect(result.error).toBe("Invalid or expired state parameter");
      }
    });

    it("reports a failure when the state names no reachable auth cell", async () => {
      await using provider = startFakeOAuth2Provider({
        "/token": tokenResponse,
      });
      const router = await routerFor({ tokenEndpoint: provider.url("/token") });
      const state = btoa(JSON.stringify({ a: "not a link", v: "verifier" }));

      const result = await callbackResult(
        await callback(router, { code: "code", state }),
      );

      expect(result).toEqual({
        success: false,
        error: "Failed to process callback",
      });
    });
  });

  describe("refresh", () => {
    it("returns the new tokens and keeps the old refresh token when the provider returns none", async () => {
      await using provider = startFakeOAuth2Provider({
        "/token": json({ access_token: "access-2", token_type: "Bearer" }),
      });
      const router = await routerFor({ tokenEndpoint: provider.url("/token") });

      const response = await post(router, "refresh", {
        refreshToken: "refresh-1",
      });

      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body.success).toBe(true);
      expect(body.tokenInfo).toMatchObject({
        accessToken: "access-2",
        refreshToken: "refresh-1",
      });
      expect(Object.fromEntries(new URLSearchParams(provider.requests[0].body)))
        .toMatchObject({
          grant_type: "refresh_token",
          refresh_token: "refresh-1",
        });
    });

    it("returns the provider's new refresh token for a `basic` provider", async () => {
      await using provider = startFakeOAuth2Provider({
        "/token": json({
          access_token: "access-2",
          refresh_token: "refresh-2",
        }),
      });
      const router = await routerFor({
        tokenEndpoint: provider.url("/token"),
        tokenAuthMethod: "basic",
      });

      const response = await post(router, "refresh", {
        refreshToken: "refresh-1",
      });

      expect((await response.json()).tokenInfo).toMatchObject({
        accessToken: "access-2",
        refreshToken: "refresh-2",
      });
      const [request] = provider.requests;
      expect(request.headers.get("Authorization")).toBe(
        `Basic ${btoa("client-id:client-secret")}`,
      );
      expect(Object.fromEntries(new URLSearchParams(request.body))).toEqual({
        grant_type: "refresh_token",
        refresh_token: "refresh-1",
      });
    });

    for (const tokenAuthMethod of ["body", "basic"] as const) {
      it(`returns a 400 when the provider refuses the refresh (\`${tokenAuthMethod}\`)`, async () => {
        await using provider = startFakeOAuth2Provider({
          "/token": json({ error: "invalid_grant" }, 400),
        });
        const router = await routerFor({
          tokenEndpoint: provider.url("/token"),
          tokenAuthMethod,
        });

        const response = await post(router, "refresh", {
          refreshToken: "refresh-1",
        });

        expect(response.status).toBe(400);
        expect(await response.json()).toEqual({
          error: "Failed to refresh token",
        });
      });
    }

    it("returns a 400 when the refresh token is empty", async () => {
      const router = await routerFor({});

      const response = await post(router, "refresh", { refreshToken: "" });

      expect(response.status).toBe(400);
      expect(await response.json()).toEqual({
        error: "No refreshToken provided",
      });
    });

    it("returns a 400 when the body is not JSON", async () => {
      const router = await routerFor({});

      const response = await router.request(`${BASE}/refresh`, {
        method: "POST",
        body: "not json",
      });

      expect(response.status).toBe(400);
      expect(await response.json()).toEqual({
        error: "Failed to process refresh request",
      });
    });
  });

  describe("logout", () => {
    it("writes the empty auth data over the stored tokens", async () => {
      await using provider = startFakeOAuth2Provider({
        "/token": tokenResponse,
      });
      const router = await routerFor({ tokenEndpoint: provider.url("/token") });
      const { cell, authCellId } = newAuthCell();
      const { state } = await startLogin(router, authCellId);
      await callback(router, { code: "code", state });

      const response = await post(router, "logout", { authCellId });

      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({
        success: true,
        message: "Successfully logged out",
      });
      expect(await storedValue(cell)).toEqual({
        accessToken: "",
        tokenType: "",
        scope: [],
        expiresIn: 0,
        expiresAt: 0,
        refreshToken: "",
        user: { email: "", name: "", picture: "" },
      });
    });

    it("writes the descriptor's own empty auth data", async () => {
      const router = await routerFor({ emptyAuthData: { cleared: true } });
      const { cell, authCellId } = newAuthCell();

      await post(router, "logout", { authCellId });

      expect(await storedValue(cell)).toEqual({ cleared: true });
    });

    it("returns a 400 when the auth cell is empty", async () => {
      const router = await routerFor({});

      const response = await post(router, "logout", { authCellId: "" });

      expect(response.status).toBe(400);
      expect(await response.json()).toEqual({
        success: false,
        error: "No authCellId provided",
      });
    });

    it("returns a 500 when the auth cell cannot be reached", async () => {
      const router = await routerFor({});

      const response = await post(router, "logout", {
        authCellId: "not a link",
      });

      expect(response.status).toBe(500);
      const body = await response.json();
      expect(body.success).toBe(false);
      expect(body.error).toMatch(
        /^Failed to clear authentication data: .*Failed to get auth cell/,
      );
    });

    it("returns a 400 when the body is not JSON", async () => {
      const router = await routerFor({});

      const response = await router.request(`${BASE}/logout`, {
        method: "POST",
        body: "not json",
      });

      expect(response.status).toBe(400);
      expect(await response.json()).toEqual({
        success: false,
        error: "Failed to process logout request",
      });
    });
  });

  describe("getBaseUrl()", () => {
    it("returns the origin upgraded to `https:`", () => {
      expect(getBaseUrl("http://toolshed.example.com:8000/a/b?c=d")).toBe(
        "https://toolshed.example.com:8000",
      );
    });

    it("returns a `localhost` origin unchanged", () => {
      expect(getBaseUrl("http://localhost:8000/a")).toBe(
        "http://localhost:8000",
      );
    });

    it("returns an `https:` origin unchanged", () => {
      expect(getBaseUrl("https://toolshed.example.com/a")).toBe(
        "https://toolshed.example.com",
      );
    });
  });

  describe("discoverProviderConfig()", () => {
    it("returns the endpoints the metadata document names, fetching it once", async () => {
      await using provider = startFakeOAuth2Provider({
        "/.well-known/oauth-authorization-server": json({
          authorization_endpoint: "https://auth.acme.invalid/authorize",
          token_endpoint: "https://auth.acme.invalid/token",
        }),
      });
      const metadataUrl = provider.url(
        "/.well-known/oauth-authorization-server",
      );

      const expected = {
        authorizationEndpoint: "https://auth.acme.invalid/authorize",
        tokenEndpoint: "https://auth.acme.invalid/token",
      };
      expect(await discoverProviderConfig(metadataUrl)).toEqual(expected);
      expect(await discoverProviderConfig(metadataUrl)).toEqual(expected);
      expect(provider.requests.length).toBe(1);
    });

    it("throws when the metadata request fails", async () => {
      await using provider = startFakeOAuth2Provider({});
      const metadataUrl = provider.url("/missing");

      await expect(discoverProviderConfig(metadataUrl)).rejects.toThrow(
        `Metadata discovery failed for ${metadataUrl}: 404`,
      );
    });

    it("throws when the metadata document lacks an endpoint", async () => {
      await using provider = startFakeOAuth2Provider({
        "/meta": json({ authorization_endpoint: "https://a.invalid/auth" }),
      });
      const metadataUrl = provider.url("/meta");

      await expect(discoverProviderConfig(metadataUrl)).rejects.toThrow(
        `Metadata document at ${metadataUrl} missing required fields`,
      );
    });
  });
});
