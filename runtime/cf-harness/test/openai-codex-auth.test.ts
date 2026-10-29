import {
  assertEquals,
  assertRejects,
  assertStrictEquals,
  assertStringIncludes,
  assertThrows,
} from "@std/assert";
import { join } from "@std/path";
import {
  completeOpenAICodexDeviceAuthorization,
  createOpenAICodexBrowserAuthorization,
  exchangeOpenAICodexAuthorizationCode,
  extractOpenAICodexAccountId,
  loginOpenAICodexWithBrowser,
  OPENAI_CODEX_CLIENT_ID,
  OpenAICodexAuthError,
  OpenAICodexAuthService,
  OpenAICodexCredentialResolver,
  startOpenAICodexDeviceAuthorization,
} from "../src/auth/openai-codex.ts";
import {
  FileHarnessCredentialStore,
  InMemoryHarnessCredentialStore,
} from "../src/auth/credential-store.ts";
import type { OpenAICodexOAuthCredential } from "../src/auth/types.ts";
import { HarnessControlError } from "../src/control-errors.ts";

const errorGraphText = (input: unknown): string => {
  const parts: string[] = [];
  const seen = new Set<unknown>();
  let current = input;
  while (current !== undefined && current !== null && !seen.has(current)) {
    seen.add(current);
    parts.push(current instanceof Error ? current.message : String(current));
    current = current instanceof Error ? current.cause : undefined;
  }
  return parts.join("\n");
};

const jwt = (payload: Record<string, unknown>): string => {
  const encode = (value: unknown) =>
    btoa(JSON.stringify(value)).replaceAll("+", "-").replaceAll("/", "_")
      .replace(/=+$/, "");
  return `${encode({ alg: "none" })}.${encode(payload)}.`;
};

Deno.test("Codex browser authorization pins the OpenCode/pi PKCE contract", async () => {
  const flow = await createOpenAICodexBrowserAuthorization({
    randomBytes: (length) => new Uint8Array(length).fill(7),
  });
  const url = new URL(flow.url);

  assertEquals(url.origin, "https://auth.openai.com");
  assertEquals(url.pathname, "/oauth/authorize");
  assertEquals(url.searchParams.get("client_id"), OPENAI_CODEX_CLIENT_ID);
  assertEquals(
    url.searchParams.get("redirect_uri"),
    "http://localhost:1455/auth/callback",
  );
  assertEquals(
    url.searchParams.get("scope"),
    "openid profile email offline_access",
  );
  assertEquals(url.searchParams.get("code_challenge_method"), "S256");
  assertEquals(url.searchParams.get("codex_cli_simplified_flow"), "true");
  assertEquals(url.searchParams.get("originator"), "cf-harness");
  assertEquals(flow.state.length > 20, true);
  assertEquals(flow.verifier.length > 40, true);
});

Deno.test("Codex account identity requires the pinned nested claim", () => {
  assertThrows(
    () =>
      extractOpenAICodexAccountId(jwt({
        chatgpt_account_id: "top-level-must-not-be-trusted",
      })),
    Error,
    "did not include a ChatGPT account id",
  );
});

Deno.test("Codex credential refresh is serialized per owner and persists rotation", async () => {
  const store = new InMemoryHarnessCredentialStore();
  const original: OpenAICodexOAuthCredential = {
    type: "oauth",
    providerId: "openai-codex",
    accessToken: jwt({
      "https://api.openai.com/auth": { chatgpt_account_id: "acct-1" },
    }),
    refreshToken: "refresh-old",
    expiresAt: 1,
    accountId: "acct-1",
  };
  await store.set("loom:user-1", "openai-codex", original);
  let refreshes = 0;
  const resolver = new OpenAICodexCredentialResolver({
    store,
    ownerKey: "loom:user-1",
    now: () => 10_000,
    fetchFn: (_input, init) => {
      assertEquals(init?.redirect, "error");
      refreshes += 1;
      assertEquals(String(init?.body).includes("refresh-old"), true);
      return Promise.resolve(
        new Response(
          JSON.stringify({
            access_token: jwt({
              "https://api.openai.com/auth": { chatgpt_account_id: "acct-1" },
            }),
            refresh_token: "refresh-new",
            expires_in: 3600,
          }),
          { status: 200 },
        ),
      );
    },
  });

  const [left, right] = await Promise.all([
    resolver.resolve(),
    resolver.resolve(),
  ]);

  assertEquals(refreshes, 1);
  assertEquals(left.refreshToken, "refresh-new");
  assertEquals(right.refreshToken, "refresh-new");
  assertEquals(
    (await store.get("loom:user-1", "openai-codex"))?.refreshToken,
    "refresh-new",
  );
});

Deno.test("Codex credential refresh preserves a token when rotation is omitted", async () => {
  const store = new InMemoryHarnessCredentialStore();
  await store.set("local", "openai-codex", {
    type: "oauth",
    providerId: "openai-codex",
    accessToken: "expired-access",
    refreshToken: "refresh-still-valid",
    expiresAt: 1,
    accountId: "acct-1",
  });
  const resolver = new OpenAICodexCredentialResolver({
    store,
    ownerKey: "local",
    now: () => 10_000,
    fetchFn: () =>
      Promise.resolve(
        new Response(
          JSON.stringify({
            access_token: jwt({
              "https://api.openai.com/auth": {
                chatgpt_account_id: "acct-1",
              },
            }),
            expires_in: 3600,
          }),
          { status: 200 },
        ),
      ),
  });

  const credential = await resolver.resolve();

  assertEquals(credential.refreshToken, "refresh-still-valid");
  assertEquals(
    (await store.get("local", "openai-codex"))?.refreshToken,
    "refresh-still-valid",
  );
});

Deno.test("Codex credential refresh persists rotation before reporting a late abort", async () => {
  const store = new InMemoryHarnessCredentialStore();
  await store.set("local", "openai-codex", {
    type: "oauth",
    providerId: "openai-codex",
    accessToken: "expired-access",
    refreshToken: "refresh-old",
    expiresAt: 1,
    accountId: "acct-1",
  });
  const controller = new AbortController();
  const reason = new Error("abort after refresh response");
  const resolver = new OpenAICodexCredentialResolver({
    store,
    ownerKey: "local",
    now: () => 10_000,
    fetchFn: () => {
      controller.abort(reason);
      return Promise.resolve(
        new Response(
          JSON.stringify({
            access_token: jwt({
              "https://api.openai.com/auth": {
                chatgpt_account_id: "acct-1",
              },
            }),
            refresh_token: "refresh-new",
            expires_in: 3600,
          }),
          { status: 200 },
        ),
      );
    },
  });

  const error = await assertRejects(() => resolver.resolve(controller.signal));
  assertStrictEquals(error, reason);
  assertEquals(
    (await store.get("local", "openai-codex"))?.refreshToken,
    "refresh-new",
  );
});

Deno.test("Codex credential resolution never falls back after revocation", async () => {
  const store = new InMemoryHarnessCredentialStore();
  await store.set("local", "openai-codex", {
    type: "oauth",
    providerId: "openai-codex",
    accessToken: "expired-access",
    refreshToken: "secret-refresh-token",
    expiresAt: 1,
    accountId: "acct-1",
  });
  const resolver = new OpenAICodexCredentialResolver({
    store,
    ownerKey: "local",
    now: () => 10_000,
    fetchFn: () => Promise.resolve(new Response("revoked", { status: 400 })),
  });

  const error = await assertRejects(() => resolver.resolve()) as Error;
  assertEquals(error instanceof HarnessControlError, true);
  assertEquals((error as HarnessControlError).code, "provider-unavailable");
  assertEquals(error.message.includes("secret-refresh-token"), false);
  assertEquals(error.message, "OpenAI Codex token refresh failed (400)");
});

Deno.test("Codex credential resolution fails before traffic when disconnected or unhealthy", async () => {
  const disconnected = new InMemoryHarnessCredentialStore();
  let requests = 0;
  const disconnectedResolver = new OpenAICodexCredentialResolver({
    store: disconnected,
    ownerKey: "local",
    fetchFn: () => {
      requests++;
      return Promise.reject(new Error("unexpected request"));
    },
  });
  await assertRejects(
    () => disconnectedResolver.resolve(),
    HarnessControlError,
    "not connected",
  );

  const unhealthy = new InMemoryHarnessCredentialStore();
  await unhealthy.updateRecord("local", "openai-codex", () => ({
    credential: {
      type: "oauth",
      providerId: "openai-codex",
      accessToken: "access",
      refreshToken: "refresh",
      expiresAt: 1,
      accountId: "account",
    },
    health: { status: "reconnect-required", reason: "revoked" },
  }));
  const unhealthyResolver = new OpenAICodexCredentialResolver({
    store: unhealthy,
    ownerKey: "local",
    fetchFn: () => {
      requests++;
      return Promise.reject(new Error("unexpected request"));
    },
  });
  await assertRejects(
    () => unhealthyResolver.resolve(),
    HarnessControlError,
    "must be reconnected",
  );
  assertEquals(requests, 0);
});

Deno.test("Codex browser login validates state and persists only after exchange", async () => {
  const store = new InMemoryHarnessCredentialStore();
  const auth = new OpenAICodexAuthService(store, "local");
  const result = await loginOpenAICodexWithBrowser({
    authService: auth,
    onAuthorizationUrl: async (authorizationUrl) => {
      const state = new URL(authorizationUrl).searchParams.get("state");
      const response = await fetch(
        `http://localhost:1455/auth/callback?code=browser-code&state=${state}`,
      );
      assertEquals(response.status, 200);
    },
    fetchFn: (_input, init) => {
      assertEquals(init?.redirect, "error");
      assertStringIncludes(String(init?.body), "code=browser-code");
      return Promise.resolve(
        new Response(
          JSON.stringify({
            access_token: jwt({
              "https://api.openai.com/auth": {
                chatgpt_account_id: "acct-browser",
              },
            }),
            refresh_token: "refresh-browser",
            expires_in: 3600,
          }),
          { status: 200 },
        ),
      );
    },
    now: () => 1_000,
  });

  assertEquals(result.accountId, "acct-browser");
  assertEquals(
    (await store.get("local", "openai-codex"))?.refreshToken,
    "refresh-browser",
  );
});

Deno.test("Codex credential refresh honors pre-abort and releases its owner lock on mid-refresh abort", async () => {
  const store = new InMemoryHarnessCredentialStore();
  await store.set("local", "openai-codex", {
    type: "oauth",
    providerId: "openai-codex",
    accessToken: "expired-access",
    refreshToken: "refresh-secret",
    expiresAt: 0,
    accountId: "acct-1",
  });
  let fetches = 0;
  let markStarted!: () => void;
  const started = new Promise<void>((resolve) => {
    markStarted = resolve;
  });
  const resolver = new OpenAICodexCredentialResolver({
    store,
    ownerKey: "local",
    now: () => 100_000,
    fetchFn: (_input, init) => {
      fetches += 1;
      assertEquals(init?.redirect, "error");
      markStarted();
      return new Promise((_resolve, reject) => {
        const signal = init?.signal;
        signal?.addEventListener("abort", () => reject(signal.reason), {
          once: true,
        });
      });
    },
  });
  const preAborted = new AbortController();
  preAborted.abort(new DOMException("pre-aborted refresh", "AbortError"));
  await assertRejects(
    () => resolver.resolve(preAborted.signal),
    DOMException,
    "pre-aborted refresh",
  );
  assertEquals(fetches, 0);

  const midRefresh = new AbortController();
  const resolving = resolver.resolve(midRefresh.signal);
  await started;
  midRefresh.abort(new DOMException("mid-refresh abort", "AbortError"));
  await assertRejects(
    () => resolving,
    DOMException,
    "mid-refresh abort",
  );
  assertEquals(fetches, 1);
  await store.set("local", "openai-codex", {
    type: "oauth",
    providerId: "openai-codex",
    accessToken: "other-access",
    refreshToken: "other-refresh",
    expiresAt: 4_000_000_000_000,
    accountId: "other-account",
  });
});

Deno.test("Codex credential resolution preserves abort during credential reads", async () => {
  const credential: OpenAICodexOAuthCredential = {
    type: "oauth",
    providerId: "openai-codex",
    accessToken: "access",
    refreshToken: "refresh",
    expiresAt: 4_000_000_000_000,
    accountId: "account",
  };
  let releaseRead!: () => void;
  const readHeld = new Promise<void>((resolve) => {
    releaseRead = resolve;
  });
  let markReadStarted!: () => void;
  const readStarted = new Promise<void>((resolve) => {
    markReadStarted = resolve;
  });
  const store = new InMemoryHarnessCredentialStore();
  await store.set("local", "openai-codex", credential);
  const originalGetRecord = store.getRecord.bind(store);
  store.getRecord = async (ownerKey, providerId) => {
    markReadStarted();
    await readHeld;
    return await originalGetRecord(ownerKey, providerId);
  };
  const resolver = new OpenAICodexCredentialResolver({
    store,
    ownerKey: "local",
  });
  const controller = new AbortController();
  const resolving = resolver.resolve(controller.signal);
  await readStarted;
  const reason = new Error("abort during credential read");
  controller.abort(reason);
  releaseRead();

  const error = await assertRejects(() => resolving);
  assertStrictEquals(error, reason);
});

Deno.test("Codex browser login preserves abort during PKCE generation", async () => {
  const controller = new AbortController();
  let authorizationUrls = 0;
  const login = loginOpenAICodexWithBrowser({
    authService: new OpenAICodexAuthService(
      new InMemoryHarnessCredentialStore(),
      "local",
    ),
    signal: controller.signal,
    onAuthorizationUrl: () => {
      authorizationUrls += 1;
    },
  });
  const reason = new Error("abort during PKCE");
  controller.abort(reason);

  const error = await assertRejects(() => login);
  assertStrictEquals(error, reason);
  assertEquals(authorizationUrls, 0);
});

Deno.test("Codex exchange and refresh network errors have secret-free cause graphs", async () => {
  const exchangeError = await assertRejects(() =>
    exchangeOpenAICodexAuthorizationCode({
      code: "exchange-code-secret",
      verifier: "exchange-verifier-secret",
      redirectUri: "http://localhost:1455/auth/callback",
      fetchFn: () =>
        Promise.reject(
          new Error("exchange-code-secret exchange-verifier-secret"),
        ),
    })
  );
  assertEquals(
    errorGraphText(exchangeError).includes("exchange-code-secret"),
    false,
  );
  assertEquals(
    errorGraphText(exchangeError).includes("exchange-verifier-secret"),
    false,
  );

  const store = new InMemoryHarnessCredentialStore();
  await store.set("local", "openai-codex", {
    type: "oauth",
    providerId: "openai-codex",
    accessToken: "access-secret-in-cause",
    refreshToken: "refresh-secret-in-cause",
    expiresAt: 0,
    accountId: "account-secret-in-cause",
  });
  const refreshError = await assertRejects(() =>
    new OpenAICodexCredentialResolver({
      store,
      ownerKey: "local",
      now: () => 100_000,
      fetchFn: () =>
        Promise.reject(
          new Error(
            "access-secret-in-cause refresh-secret-in-cause account-secret-in-cause",
          ),
        ),
    }).resolve()
  );
  const refreshGraph = errorGraphText(refreshError);
  assertEquals(refreshGraph.includes("access-secret-in-cause"), false);
  assertEquals(refreshGraph.includes("refresh-secret-in-cause"), false);
  assertEquals(refreshGraph.includes("account-secret-in-cause"), false);
});

Deno.test("Codex authorization-code exchange preserves non-DOM abort reasons", async () => {
  const controller = new AbortController();
  let markStarted!: () => void;
  const started = new Promise<void>((resolve) => {
    markStarted = resolve;
  });
  const exchange = exchangeOpenAICodexAuthorizationCode({
    code: "code",
    verifier: "verifier",
    redirectUri: "http://localhost:1455/auth/callback",
    signal: controller.signal,
    fetchFn: (_input, init) => {
      markStarted();
      return new Promise((_resolve, reject) => {
        init?.signal?.addEventListener(
          "abort",
          () => reject(init.signal?.reason),
          { once: true },
        );
      });
    },
  });
  await started;
  const reason = new Error("custom exchange abort");
  controller.abort(reason);
  const error = await assertRejects(() => exchange);
  assertStrictEquals(error, reason);
});

Deno.test("Codex browser login ignores wrong-state callbacks and accepts the valid callback", async () => {
  const store = new InMemoryHarnessCredentialStore();
  let exchanges = 0;
  const result = await loginOpenAICodexWithBrowser({
    authService: new OpenAICodexAuthService(store, "local"),
    onAuthorizationUrl: async (authorizationUrl) => {
      const wrong = await fetch(
        "http://localhost:1455/auth/callback?code=bad&state=wrong",
      );
      assertEquals(wrong.status, 400);
      const state = new URL(authorizationUrl).searchParams.get("state");
      const valid = await fetch(
        `http://localhost:1455/auth/callback?code=good&state=${state}`,
      );
      assertEquals(valid.status, 200);
    },
    fetchFn: (_input, init) => {
      exchanges += 1;
      assertStringIncludes(String(init?.body), "code=good");
      return Promise.resolve(
        new Response(JSON.stringify({
          access_token: jwt({
            "https://api.openai.com/auth": {
              chatgpt_account_id: "acct-after-wrong-state",
            },
          }),
          refresh_token: "refresh-after-wrong-state",
          expires_in: 3600,
        })),
      );
    },
  });
  assertEquals(exchanges, 1);
  assertEquals(result.accountId, "acct-after-wrong-state");
});

Deno.test("Codex browser login cancellation closes the callback listener", async () => {
  const controller = new AbortController();
  await assertRejects(
    () =>
      loginOpenAICodexWithBrowser({
        authService: new OpenAICodexAuthService(
          new InMemoryHarnessCredentialStore(),
          "local",
        ),
        signal: controller.signal,
        onAuthorizationUrl: () => controller.abort(),
      }),
    DOMException,
  );
});

Deno.test("Codex browser login rejects a pre-aborted signal before opening the listener", async () => {
  const controller = new AbortController();
  const reason = new DOMException("already canceled", "AbortError");
  controller.abort(reason);
  let authorizationUrls = 0;

  await assertRejects(
    () =>
      loginOpenAICodexWithBrowser({
        authService: new OpenAICodexAuthService(
          new InMemoryHarnessCredentialStore(),
          "local",
        ),
        signal: controller.signal,
        onAuthorizationUrl: () => {
          authorizationUrls += 1;
        },
      }),
    DOMException,
    "already canceled",
  );
  assertEquals(authorizationUrls, 0);
});

Deno.test("Codex browser login rejects concurrent transactions for one owner", async () => {
  const controller = new AbortController();
  let markReady!: () => void;
  const ready = new Promise<void>((resolve) => {
    markReady = resolve;
  });
  const authService = new OpenAICodexAuthService(
    new InMemoryHarnessCredentialStore(),
    "local",
  );
  const first = loginOpenAICodexWithBrowser({
    authService,
    signal: controller.signal,
    onAuthorizationUrl: () => markReady(),
  });
  await ready;

  await assertRejects(
    () =>
      loginOpenAICodexWithBrowser({
        authService,
        onAuthorizationUrl: () => {},
      }),
    Error,
    "already in progress",
  );
  controller.abort(new DOMException("cancel first", "AbortError"));
  await assertRejects(() => first, DOMException, "cancel first");
});

Deno.test("Codex device login honors pending and slow_down intervals", async () => {
  const device = await startOpenAICodexDeviceAuthorization({
    fetchFn: () =>
      Promise.resolve(
        new Response(
          JSON.stringify({
            device_auth_id: "device-1",
            user_code: "ABCD-EFGH",
            interval: 1,
          }),
          { status: 200 },
        ),
      ),
  });
  let clock = 0;
  const waits: number[] = [];
  let polls = 0;
  const result = await completeOpenAICodexDeviceAuthorization({
    device,
    now: () => clock,
    wait: (milliseconds) => {
      waits.push(milliseconds);
      clock += milliseconds;
      return Promise.resolve();
    },
    fetchFn: (_input, init) => {
      const body = String(init?.body);
      if (body.includes("device_auth_id")) {
        polls += 1;
        if (polls === 1) {
          return Promise.resolve(
            new Response(
              JSON.stringify({
                error: { code: "deviceauth_authorization_pending" },
              }),
              { status: 403 },
            ),
          );
        }
        if (polls === 2) {
          return Promise.resolve(
            new Response(
              JSON.stringify({
                error: { code: "slow_down" },
              }),
              { status: 400 },
            ),
          );
        }
        return Promise.resolve(
          new Response(
            JSON.stringify({
              authorization_code: "device-code",
              code_verifier: "device-verifier",
            }),
            { status: 200 },
          ),
        );
      }
      return Promise.resolve(
        new Response(
          JSON.stringify({
            access_token: jwt({
              "https://api.openai.com/auth": {
                chatgpt_account_id: "acct-device",
              },
            }),
            refresh_token: "refresh-device",
            expires_in: 3600,
          }),
          { status: 200 },
        ),
      );
    },
  });

  assertEquals(waits, [1_000, 1_000, 6_000]);
  assertEquals(result.accountId, "acct-device");
});

Deno.test("Codex device login stops on a terminal provider denial", async () => {
  let waits = 0;
  await assertRejects(
    () =>
      completeOpenAICodexDeviceAuthorization({
        device: {
          deviceAuthId: "device-denied",
          userCode: "DENIED",
          intervalMs: 1_000,
          verificationUrl: "https://auth.openai.com/codex/device",
        },
        now: () => 0,
        wait: () => {
          waits += 1;
          return Promise.resolve();
        },
        fetchFn: () =>
          Promise.resolve(
            new Response(
              JSON.stringify({ error: { code: "access_denied" } }),
              { status: 403 },
            ),
          ),
      }),
    Error,
    "device authorization failed (403)",
  );
  assertEquals(waits, 1);
});

Deno.test("Codex refresh classifies invalid grants without exposing tokens", async () => {
  const store = new InMemoryHarnessCredentialStore();
  await store.set("local", "openai-codex", {
    type: "oauth",
    providerId: "openai-codex",
    accessToken: "expired-access",
    refreshToken: "do-not-print-refresh",
    expiresAt: 0,
    accountId: "acct",
  });
  const resolver = new OpenAICodexCredentialResolver({
    store,
    ownerKey: "local",
    now: () => 100_000,
    fetchFn: () =>
      Promise.resolve(
        new Response(
          JSON.stringify({
            error: { code: "invalid_grant" },
          }),
          { status: 400 },
        ),
      ),
  });

  const error = await assertRejects(() => resolver.resolve());
  assertEquals(error instanceof HarnessControlError, true);
  assertEquals((error as HarnessControlError).code, "provider-auth-required");
  assertEquals(
    (error as Error).message.includes("do-not-print-refresh"),
    false,
  );
});

Deno.test("Codex terminal refresh health persists and prevents another request", async () => {
  const store = new InMemoryHarnessCredentialStore();
  await store.set("local", "openai-codex", {
    type: "oauth",
    providerId: "openai-codex",
    accessToken: "expired-access",
    refreshToken: "terminal-refresh-secret",
    expiresAt: 0,
    accountId: "account-secret",
  });
  let requests = 0;
  const resolver = new OpenAICodexCredentialResolver({
    store,
    ownerKey: "local",
    now: () => 100_000,
    fetchFn: () => {
      requests += 1;
      return Promise.resolve(
        new Response(
          JSON.stringify({
            error: {
              code: "refresh_token_reused",
              detail: "secret-provider-detail",
            },
          }),
          { status: 400 },
        ),
      );
    },
  });

  const first = await assertRejects(() => resolver.resolve());
  assertEquals((first as HarnessControlError).code, "provider-auth-required");
  assertEquals(errorGraphText(first).includes("secret"), false);
  assertEquals(await store.getHealth("local", "openai-codex"), {
    status: "reconnect-required",
    reason: "refresh-token-reused",
  });
  const second = await assertRejects(() => resolver.resolve());
  assertEquals((second as HarnessControlError).code, "provider-auth-required");
  assertEquals(requests, 1);
});

Deno.test("Codex refresh rotation and terminal health survive file-store reopen", async () => {
  const root = await Deno.makeTempDir();
  const path = join(root, "auth.json");
  const store = new FileHarnessCredentialStore({ path });
  await store.set("local", "openai-codex", {
    type: "oauth",
    providerId: "openai-codex",
    accessToken: "expired-access",
    refreshToken: "refresh-old",
    expiresAt: 1,
    accountId: "acct-1",
  });
  const rotating = new OpenAICodexCredentialResolver({
    store,
    ownerKey: "local",
    now: () => 10_000,
    fetchFn: () =>
      Promise.resolve(
        new Response(
          JSON.stringify({
            access_token: jwt({
              "https://api.openai.com/auth": { chatgpt_account_id: "acct-1" },
            }),
            refresh_token: "refresh-new",
            expires_in: 3600,
          }),
          { status: 200 },
        ),
      ),
  });
  await rotating.resolve();
  assertEquals(
    (await new FileHarnessCredentialStore({ path }).get(
      "local",
      "openai-codex",
    ))?.refreshToken,
    "refresh-new",
  );

  await store.updateRecord("local", "openai-codex", (record) => ({
    credential: { ...record.credential!, expiresAt: 1 },
  }));
  const terminal = new OpenAICodexCredentialResolver({
    store,
    ownerKey: "local",
    now: () => 10_000,
    fetchFn: () =>
      Promise.resolve(
        new Response(JSON.stringify({ error: "invalid_grant" }), {
          status: 400,
        }),
      ),
  });
  await assertRejects(() => terminal.resolve(), HarnessControlError);
  assertEquals(
    (await new FileHarnessCredentialStore({ path }).getRecord(
      "local",
      "openai-codex",
    )).health,
    { status: "reconnect-required", reason: "invalid-grant" },
  );
});

Deno.test("Codex transient refresh failures leave credential health unchanged", async () => {
  const store = new InMemoryHarnessCredentialStore();
  await store.set("local", "openai-codex", {
    type: "oauth",
    providerId: "openai-codex",
    accessToken: "expired-access",
    refreshToken: "transient-refresh-secret",
    expiresAt: 0,
    accountId: "account-secret",
  });
  const resolver = new OpenAICodexCredentialResolver({
    store,
    ownerKey: "local",
    now: () => 100_000,
    fetchFn: () => Promise.reject(new Error("transient-refresh-secret")),
  });

  const error = await assertRejects(() => resolver.resolve());
  assertEquals(error instanceof HarnessControlError, true);
  assertEquals((error as HarnessControlError).code, "provider-unavailable");
  assertEquals(
    errorGraphText(error).includes("transient-refresh-secret"),
    false,
  );
  assertEquals(await store.getHealth("local", "openai-codex"), undefined);
  assertEquals(
    (await store.get("local", "openai-codex"))?.refreshToken,
    "transient-refresh-secret",
  );
});

Deno.test("Codex login clears terminal credential health", async () => {
  const store = new InMemoryHarnessCredentialStore();
  await store.updateRecord("local", "openai-codex", () => ({
    credential: {
      type: "oauth",
      providerId: "openai-codex",
      accessToken: "old-access",
      refreshToken: "old-refresh",
      expiresAt: 0,
      accountId: "old-account",
    },
    health: { status: "reconnect-required", reason: "revoked" },
  }));
  const auth = new OpenAICodexAuthService(store, "local");

  await auth.save({
    type: "oauth",
    providerId: "openai-codex",
    accessToken: "new-access",
    refreshToken: "new-refresh",
    expiresAt: 4_000_000_000_000,
    accountId: "new-account",
  });

  assertEquals(await store.getHealth("local", "openai-codex"), undefined);
  assertEquals(await auth.status(), {
    providerId: "openai-codex",
    status: "connected",
    refreshHealth: "ready",
  });
});

Deno.test("Codex login cancellation while queued preserves prior auth", async () => {
  const store = new InMemoryHarnessCredentialStore();
  const previous: OpenAICodexOAuthCredential = {
    type: "oauth",
    providerId: "openai-codex",
    accessToken: "old-access",
    refreshToken: "old-refresh",
    expiresAt: 4_000_000_000_000,
    accountId: "old-account",
  };
  await store.set("local", "openai-codex", previous);
  let releaseMutation!: () => void;
  const mutationHeld = new Promise<void>((resolve) => {
    releaseMutation = resolve;
  });
  let markMutationStarted!: () => void;
  const mutationStarted = new Promise<void>((resolve) => {
    markMutationStarted = resolve;
  });
  const holding = store.updateRecord(
    "local",
    "openai-codex",
    async (record) => {
      markMutationStarted();
      await mutationHeld;
      return record;
    },
  );
  await mutationStarted;
  const auth = new OpenAICodexAuthService(store, "local");
  const controller = new AbortController();
  const saving = auth.save({
    ...previous,
    accessToken: "new-access",
    refreshToken: "new-refresh",
  }, controller.signal);
  const reason = new DOMException("login canceled", "AbortError");
  controller.abort(reason);

  await assertRejects(() => saving, DOMException, "login canceled");
  releaseMutation();
  await holding;
  assertEquals(await store.get("local", "openai-codex"), previous);
});

Deno.test("Codex login reports late cancellation after its atomic save", async () => {
  const store = new InMemoryHarnessCredentialStore();
  const controller = new AbortController();
  const reason = new Error("login canceled after commit");
  const originalUpdateRecord = store.updateRecord.bind(store);
  store.updateRecord = async (...args) => {
    const result = await originalUpdateRecord(...args);
    controller.abort(reason);
    return result;
  };
  const auth = new OpenAICodexAuthService(store, "local");
  const credential: OpenAICodexOAuthCredential = {
    type: "oauth",
    providerId: "openai-codex",
    accessToken: "new-access",
    refreshToken: "new-refresh",
    expiresAt: 4_000_000_000_000,
    accountId: "new-account",
  };

  const error = await assertRejects(() =>
    auth.save(credential, controller.signal)
  );
  assertStrictEquals(error, reason);
  assertEquals(await store.get("local", "openai-codex"), credential);
});

Deno.test("Codex token exchange rejects malformed token responses before persistence", async () => {
  const error = await assertRejects(() =>
    exchangeOpenAICodexAuthorizationCode({
      code: "code",
      verifier: "verifier",
      redirectUri: "http://localhost:1455/auth/callback",
      fetchFn: () =>
        Promise.resolve(
          new Response(
            JSON.stringify({
              access_token: "access-only",
            }),
            { status: 200 },
          ),
        ),
    })
  );
  assertEquals(error instanceof OpenAICodexAuthError, true);
  assertEquals((error as OpenAICodexAuthError).kind, "malformed_response");
});
