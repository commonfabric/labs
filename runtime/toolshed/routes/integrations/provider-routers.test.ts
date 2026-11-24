import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { Identity } from "@commonfabric/identity";
import { Runtime } from "@commonfabric/runner";
import { StorageManager } from "@commonfabric/runner/storage/cache.deno";

import {
  type FakeOAuth2Provider,
  startFakeOAuth2Provider,
} from "@/test/support/fake-oauth2-provider.ts";
import { AirtableDescriptor } from "./airtable-oauth/airtable.descriptor.ts";
import { DiscordDescriptor } from "./discord-oauth/discord.descriptor.ts";
import { GitHubDescriptor } from "./github-oauth/github.descriptor.ts";
import { GoogleDescriptor } from "./google-oauth/google.descriptor.ts";
import { NotionDescriptor } from "./notion-oauth/notion.descriptor.ts";
import type {
  ProviderDescriptor,
  UserInfo,
} from "./oauth2-common/oauth2-common.types.ts";
import { createProviderRouters } from "./provider-routers.ts";
import { SpotifyDescriptor } from "./spotify-oauth/spotify.descriptor.ts";
import { StravaDescriptor } from "./strava-oauth/strava.descriptor.ts";

const json = (body: unknown, status = 200) => () =>
  Response.json(body, { status });

const tokenResponse = json({
  access_token: "access-1",
  token_type: "Bearer",
  expires_in: 3600,
  refresh_token: "refresh-1",
});

// Reads the result object the callback page posts to its opener.
async function callbackResult(response: Response) {
  const match = (await response.text()).match(/result: (\{.*\})\n/);
  if (!match) throw new Error("no callback result in the page");
  return JSON.parse(match[1]);
}

describe("provider-routers", () => {
  let signer: Identity;
  let storageManager: ReturnType<typeof StorageManager.emulate>;
  let runtime: Runtime;
  let causeCount = 0;

  beforeEach(async () => {
    signer = await Identity.fromPassphrase("provider-routers-test");
    storageManager = StorageManager.emulate({ as: signer });
    runtime = new Runtime({
      apiUrl: new URL("https://provider-routers-test.invalid"),
      storageManager,
    });
  });

  afterEach(async () => {
    await runtime.dispose();
    await storageManager.close();
  });

  function build(descriptors: ProviderDescriptor[]) {
    return createProviderRouters(descriptors, { runtime: () => runtime });
  }

  // Returns `descriptor` with credentials set and its token and user-info
  // endpoints on `provider`.
  function local(
    descriptor: ProviderDescriptor,
    provider: FakeOAuth2Provider,
  ): ProviderDescriptor {
    return {
      ...descriptor,
      clientId: "client-id",
      clientSecret: "client-secret",
      tokenEndpoint: provider.url("/token"),
      userInfoEndpoint: descriptor.userInfoEndpoint && provider.url("/user"),
    };
  }

  function login(
    router: Awaited<ReturnType<typeof build>>[number],
    name: string,
    authCellId: string,
  ) {
    return router.request(`/api/integrations/${name}-oauth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ authCellId }),
    });
  }

  // Runs a login and its callback against `descriptor`, and returns the
  // callback's result, the value the auth cell holds afterwards, the login's
  // authorization URL, and the router.
  async function signIn(descriptor: ProviderDescriptor) {
    const [router] = await build([descriptor]);
    const cell = runtime.getCell<Record<string, unknown>>(
      signer.did(),
      `provider-auth-${causeCount++}`,
    );
    const authCellId = JSON.stringify(cell.getAsNormalizedFullLink());
    const { url } = await (await login(router, descriptor.name, authCellId))
      .json();
    const authorizationUrl = new URL(url);
    const state = authorizationUrl.searchParams.get("state")!;
    const result = await callbackResult(
      await router.request(
        `/api/integrations/${descriptor.name}-oauth/callback?${new URLSearchParams(
          { code: "code", state },
        )}`,
      ),
    );
    await runtime.storageManager.synced();
    return { result, stored: cell.get(), authorizationUrl, router, authCellId };
  }

  describe("createProviderRouters()", () => {
    it("returns a router for each descriptor with credentials and none for one without", async () => {
      await using provider = startFakeOAuth2Provider({});
      const routers = await build([
        { ...GitHubDescriptor, clientId: "", clientSecret: "" },
        local(DiscordDescriptor, provider),
      ]);

      expect(routers.length).toBe(1);
      const response = await login(routers[0], "discord", "{}");
      expect(response.status).toBe(200);
      expect((await login(routers[0], "github", "{}")).status).toBe(404);
    });

    it("returns no router for a descriptor whose endpoints cannot be resolved", async () => {
      await using provider = startFakeOAuth2Provider({});
      const routers = await build([
        {
          ...local(DiscordDescriptor, provider),
          name: "nowhere",
          authorizationEndpoint: undefined,
        },
        {
          ...local(DiscordDescriptor, provider),
          name: "undiscoverable",
          authorizationEndpoint: undefined,
          metadataUrl: provider.url("/missing-metadata"),
        },
        local(DiscordDescriptor, provider),
      ]);

      expect(routers.length).toBe(1);
      expect((await login(routers[0], "discord", "{}")).status).toBe(200);
    });

    it("uses the endpoints the metadata document names for those the descriptor omits", async () => {
      await using provider = startFakeOAuth2Provider({
        "/metadata": json({
          authorization_endpoint: "https://discovered.invalid/authorize",
          token_endpoint: "https://discovered.invalid/token",
        }),
        "/token": tokenResponse,
        "/user": json({ id: "1", username: "ada" }),
      });

      const { result, authorizationUrl } = await signIn({
        ...local(DiscordDescriptor, provider),
        authorizationEndpoint: undefined,
        metadataUrl: provider.url("/metadata"),
      });

      expect(`${authorizationUrl.origin}${authorizationUrl.pathname}`).toBe(
        "https://discovered.invalid/authorize",
      );
      expect(result.success).toBe(true);
      expect(provider.requests.map((r) => r.path)).toEqual([
        "/metadata",
        "/token",
        "/user",
      ]);
    });

    it("returns CORS headers allowing any origin on the provider's routes", async () => {
      await using provider = startFakeOAuth2Provider({});
      const [router] = await build([local(DiscordDescriptor, provider)]);

      const response = await router.request(
        "/api/integrations/discord-oauth/login",
        {
          method: "OPTIONS",
          headers: {
            Origin: "https://app.example.com",
            "Access-Control-Request-Method": "POST",
          },
        },
      );

      expect(response.headers.get("Access-Control-Allow-Origin")).toBe("*");
      expect(response.headers.get("Access-Control-Allow-Methods")).toContain(
        "POST",
      );
    });

    it("returns the CORS origin header on a route's own response, and not on another provider's path", async () => {
      await using provider = startFakeOAuth2Provider({});
      const [router] = await build([local(DiscordDescriptor, provider)]);
      const post = (name: string) =>
        router.request(`/api/integrations/${name}-oauth/login`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Origin: "https://app.example.com",
          },
          body: JSON.stringify({ authCellId: "{}" }),
        });

      const response = await post("discord");
      expect(response.status).toBe(200);
      expect(response.headers.get("Access-Control-Allow-Origin")).toBe("*");

      const unmounted = await post("github");
      expect(unmounted.status).toBe(404);
      expect(unmounted.headers.get("Access-Control-Allow-Origin")).toBe(null);
    });
  });

  describe("descriptors", () => {
    const cases: {
      title: string;
      descriptor: ProviderDescriptor;
      raw: Record<string, unknown>;
      expected: UserInfo;
    }[] = [
      {
        title: "Airtable names the user by email",
        descriptor: AirtableDescriptor,
        raw: { id: "usr1", email: "ada@example.com" },
        expected: {
          id: "usr1",
          email: "ada@example.com",
          name: "ada@example.com",
        },
      },
      {
        title: "Airtable leaves the name empty for a user without an email",
        descriptor: AirtableDescriptor,
        raw: { id: "usr1" },
        expected: { id: "usr1", name: "" },
      },
      {
        title: "Discord builds the avatar URL from the user and avatar ids",
        descriptor: DiscordDescriptor,
        raw: {
          id: "42",
          email: "ada@example.com",
          username: "ada",
          avatar: "av",
        },
        expected: {
          id: "42",
          email: "ada@example.com",
          name: "ada",
          picture: "https://cdn.discordapp.com/avatars/42/av.png",
        },
      },
      {
        title: "Discord leaves the picture empty for a user without an avatar",
        descriptor: DiscordDescriptor,
        raw: { id: "42", username: "ada" },
        expected: { id: "42", email: "", name: "ada", picture: "" },
      },
      {
        title: "GitHub names the user by display name",
        descriptor: GitHubDescriptor,
        raw: {
          id: 7,
          email: "ada@example.com",
          name: "Ada",
          login: "ada",
          avatar_url: "https://example.com/a.png",
        },
        expected: {
          id: "7",
          email: "ada@example.com",
          name: "Ada",
          picture: "https://example.com/a.png",
        },
      },
      {
        title: "GitHub names the user by login when there is no display name",
        descriptor: GitHubDescriptor,
        raw: { id: 7, login: "ada" },
        expected: { id: "7", email: "", name: "ada", picture: "" },
      },
      {
        title: "Spotify takes the first image as the picture",
        descriptor: SpotifyDescriptor,
        raw: {
          id: "sp",
          email: "ada@example.com",
          display_name: "Ada",
          images: [{ url: "https://example.com/1.png" }, {
            url: "https://example.com/2.png",
          }],
        },
        expected: {
          id: "sp",
          email: "ada@example.com",
          name: "Ada",
          picture: "https://example.com/1.png",
        },
      },
      {
        title: "Spotify leaves the picture empty for a user without images",
        descriptor: SpotifyDescriptor,
        raw: { id: "sp", display_name: "Ada" },
        expected: { id: "sp", email: "", name: "Ada", picture: "" },
      },
      {
        title: "Strava joins the first and last names",
        descriptor: StravaDescriptor,
        raw: {
          id: 9,
          firstname: "Ada",
          lastname: "Lovelace",
          profile: "https://example.com/p.png",
        },
        expected: {
          id: "9",
          email: "",
          name: "Ada Lovelace",
          picture: "https://example.com/p.png",
        },
      },
      {
        title:
          "Strava names the user by first name alone when there is no last name",
        descriptor: StravaDescriptor,
        raw: { id: 9, firstname: "Ada" },
        expected: { id: "9", email: "", name: "Ada", picture: "" },
      },
    ];

    for (const { title, descriptor, raw, expected } of cases) {
      it(`maps the user info: ${title}`, async () => {
        await using provider = startFakeOAuth2Provider({
          "/token": tokenResponse,
          "/user": json(raw),
        });

        const { result, stored } = await signIn(local(descriptor, provider));

        expect(result.details.userInfo).toEqual(expected);
        expect(stored.user).toEqual({
          email: expected.email ?? "",
          name: expected.name,
          picture: expected.picture ?? "",
        });
      });
    }

    it("stores Google's access token under `token` and writes Google's empty auth data on logout", async () => {
      await using provider = startFakeOAuth2Provider({
        "/token": tokenResponse,
        "/user": json({ email: "ada@example.com", name: "Ada" }),
      });

      const { stored, authorizationUrl, router, authCellId } = await signIn(
        local(GoogleDescriptor, provider),
      );

      expect(authorizationUrl.searchParams.get("access_type")).toBe("offline");
      expect(authorizationUrl.searchParams.get("prompt")).toBe("consent");
      expect(stored).toMatchObject({
        token: "access-1",
        tokenType: "Bearer",
        refreshToken: "refresh-1",
        expiresIn: 3600,
        user: { email: "ada@example.com", name: "Ada", picture: "" },
      });
      expect(stored.accessToken).toBeUndefined();
      expect(stored.expiresAt).toBeGreaterThan(Date.now());

      await router.request("/api/integrations/google-oauth/logout", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ authCellId }),
      });
      await runtime.storageManager.synced();
      const cleared = runtime.getCellFromLink(JSON.parse(authCellId)).get();
      expect(cleared).toEqual({
        token: "",
        tokenType: "",
        scope: [],
        expiresIn: 0,
        expiresAt: 0,
        refreshToken: "",
        user: { email: "", name: "", picture: "" },
      });
    });

    it("leaves Google's expiry unset when the provider gives no lifetime", async () => {
      await using provider = startFakeOAuth2Provider({
        "/token": json({ access_token: "access-1", token_type: "Bearer" }),
        "/user": json({}),
      });

      const { stored } = await signIn(local(GoogleDescriptor, provider));

      expect(stored.token).toBe("access-1");
      expect(stored.expiresAt).toBeUndefined();
    });

    it("asks Notion for a user-owned grant with HTTP Basic client authentication", async () => {
      await using provider = startFakeOAuth2Provider({
        "/token": json({ access_token: "notion-access" }),
      });

      const { stored, authorizationUrl } = await signIn(
        local(NotionDescriptor, provider),
      );

      expect(authorizationUrl.searchParams.get("owner")).toBe("user");
      expect(provider.requests[0].headers.get("Authorization")).toBe(
        `Basic ${btoa("client-id:client-secret")}`,
      );
      expect(stored.accessToken).toBe("notion-access");
    });
  });
});
