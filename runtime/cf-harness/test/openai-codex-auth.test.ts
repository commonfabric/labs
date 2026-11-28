import {
  assertEquals,
  assertRejects,
  assertStrictEquals,
  assertStringIncludes,
  assertThrows,
} from "@std/assert";
import { join } from "@std/path";
import { expect } from "@std/expect";
import { FakeTime } from "@std/testing/time";
import { describeFailure } from "@commonfabric/js-values/describe-failure";
import { describe, it, test } from "@commonfabric/test-support/test";
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
  waitForOpenAICodexDeviceInterval,
} from "../src/auth/openai-codex.ts";
import {
  FileHarnessCredentialStore,
  type HarnessCredentialRecord,
  InMemoryHarnessCredentialStore,
} from "../src/auth/credential-store.ts";
import type { OpenAICodexOAuthCredential } from "../src/auth/types.ts";
import { HarnessControlError } from "../src/control-errors.ts";
import { HARNESS_CREDENTIAL_OWNER_REF_TYPE } from "../src/contracts/run-manifest.ts";

const errorGraphText = (input: unknown): string => {
  const parts: string[] = [];
  const seen = new Set<unknown>();
  let current = input;
  while (current !== undefined && current !== null && !seen.has(current)) {
    seen.add(current);
    parts.push(describeFailure(current));
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

// The origin of the redirect URI an authorization URL names, which is where
// the browser login listens for the callback.
const callbackOrigin = (authorizationUrl: string): string =>
  new URL(new URL(authorizationUrl).searchParams.get("redirect_uri") ?? "")
    .origin;

test("Codex browser authorization pins the OpenCode/pi PKCE contract", async () => {
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

test("Codex account identity requires the pinned nested claim", () => {
  assertThrows(
    () =>
      extractOpenAICodexAccountId(jwt({
        chatgpt_account_id: "top-level-must-not-be-trusted",
      })),
    Error,
    "did not include a ChatGPT account id",
  );
});

test("Codex credential refresh is serialized per owner and persists rotation", async () => {
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

test("Codex credential refresh preserves a token when rotation is omitted", async () => {
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

test("Codex credential refresh persists rotation before reporting a late abort", async () => {
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

test("Codex credential resolution never falls back after revocation", async () => {
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

test("Codex credential resolution fails before traffic when disconnected or unhealthy", async () => {
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

test("Codex browser login validates state and persists only after exchange", async () => {
  const store = new InMemoryHarnessCredentialStore();
  const auth = new OpenAICodexAuthService(store, "local");
  let redirectUri: string | null = null;
  const result = await loginOpenAICodexWithBrowser({
    authService: auth,
    port: 0,
    onAuthorizationUrl: async (authorizationUrl) => {
      const params = new URL(authorizationUrl).searchParams;
      redirectUri = params.get("redirect_uri");
      const response = await fetch(
        `${
          callbackOrigin(authorizationUrl)
        }/auth/callback?code=browser-code&state=${params.get("state")}`,
      );
      assertEquals(response.status, 200);
    },
    fetchFn: (_input, init) => {
      assertEquals(init?.redirect, "error");
      const body = new URLSearchParams(String(init?.body));
      assertEquals(body.get("code"), "browser-code");
      // The exchange names the redirect URI of the port actually bound.
      assertEquals(body.get("redirect_uri"), redirectUri);
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

test("Codex credential refresh honors pre-abort and releases its owner lock on mid-refresh abort", async () => {
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

test("Codex credential resolution preserves abort during credential reads", async () => {
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

test("Codex browser login preserves abort during PKCE generation", async () => {
  const controller = new AbortController();
  let authorizationUrls = 0;
  const login = loginOpenAICodexWithBrowser({
    authService: new OpenAICodexAuthService(
      new InMemoryHarnessCredentialStore(),
      "local",
    ),
    port: 0,
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

test("Codex exchange and refresh network errors have secret-free cause graphs", async () => {
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

test("Codex authorization-code exchange preserves non-DOM abort reasons", async () => {
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

test("Codex browser login ignores wrong-state callbacks and accepts the valid callback", async () => {
  const store = new InMemoryHarnessCredentialStore();
  let exchanges = 0;
  const result = await loginOpenAICodexWithBrowser({
    authService: new OpenAICodexAuthService(store, "local"),
    port: 0,
    onAuthorizationUrl: async (authorizationUrl) => {
      const origin = callbackOrigin(authorizationUrl);
      const wrong = await fetch(
        `${origin}/auth/callback?code=bad&state=wrong`,
      );
      assertEquals(wrong.status, 400);
      const state = new URL(authorizationUrl).searchParams.get("state");
      const valid = await fetch(
        `${origin}/auth/callback?code=good&state=${state}`,
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

test("Codex browser login cancellation closes the callback listener", async () => {
  const controller = new AbortController();
  await assertRejects(
    () =>
      loginOpenAICodexWithBrowser({
        authService: new OpenAICodexAuthService(
          new InMemoryHarnessCredentialStore(),
          "local",
        ),
        port: 0,
        signal: controller.signal,
        onAuthorizationUrl: () => controller.abort(),
      }),
    DOMException,
  );
});

test("Codex browser login rejects a pre-aborted signal before opening the listener", async () => {
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

test("Codex browser login rejects concurrent transactions for one owner", async () => {
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
    port: 0,
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

test("Codex device login honors pending and slow_down intervals", async () => {
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

test("Codex device login stops on a terminal provider denial", async () => {
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

const codexTestDevice = {
  deviceAuthId: "device-1",
  userCode: "ABCD-EFGH",
  intervalMs: 1_000,
  verificationUrl: "https://auth.openai.com/codex/device",
};

test("Codex device login keeps polling through status-only pending replies until it expires", async () => {
  let clock = 0;
  const statuses = [404, 403, 404];
  const polled: number[] = [];
  await assertRejects(
    () =>
      completeOpenAICodexDeviceAuthorization({
        device: codexTestDevice,
        expiresInMs: statuses.length * 1_000,
        now: () => clock,
        wait: (milliseconds) => {
          clock += milliseconds;
          return Promise.resolve();
        },
        fetchFn: () => {
          const status = statuses[polled.length];
          polled.push(status);
          return Promise.resolve(new Response("not json", { status }));
        },
      }),
    Error,
    "OpenAI Codex device authorization expired",
  );
  assertEquals(polled, statuses);
});

test("Codex device login fails on a status-only reply that is not pending", async () => {
  let polls = 0;
  await assertRejects(
    () =>
      completeOpenAICodexDeviceAuthorization({
        device: codexTestDevice,
        now: () => 0,
        wait: () => Promise.resolve(),
        fetchFn: () => {
          polls += 1;
          return Promise.resolve(new Response("not json", { status: 500 }));
        },
      }),
    Error,
    "device authorization failed (500)",
  );
  assertEquals(polls, 1);
});

test("Codex device login rejects a token reply without the authorization code", async () => {
  let requests = 0;
  await assertRejects(
    () =>
      completeOpenAICodexDeviceAuthorization({
        device: codexTestDevice,
        now: () => 0,
        wait: () => Promise.resolve(),
        fetchFn: () => {
          requests += 1;
          return Promise.resolve(
            new Response(
              JSON.stringify({ code_verifier: "device-verifier" }),
              { status: 200 },
            ),
          );
        },
      }),
    Error,
    "OpenAI Codex device token response is missing required fields",
  );
  assertEquals(requests, 1);
});

test("Codex refresh classifies invalid grants without exposing tokens", async () => {
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

test("Codex terminal refresh health persists and prevents another request", async () => {
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

test("Codex refresh rotation and terminal health survive file-store reopen", async () => {
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

test("Codex transient refresh failures leave credential health unchanged", async () => {
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

test("Codex login clears terminal credential health", async () => {
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

test("Codex login cancellation while queued preserves prior auth", async () => {
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

test("Codex login reports late cancellation after its atomic save", async () => {
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

test("Codex token exchange rejects malformed token responses before persistence", async () => {
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

describe("openai-codex", () => {
  const accountToken = (accountId: string): string =>
    jwt({ "https://api.openai.com/auth": { chatgpt_account_id: accountId } });

  const expiredCredential = (
    refreshToken = "refresh-old",
  ): OpenAICodexOAuthCredential => ({
    type: "oauth",
    providerId: "openai-codex",
    accessToken: "expired-access",
    refreshToken,
    expiresAt: 0,
    accountId: "acct-1",
  });

  const tokenResponse = (body: Record<string, unknown>, status = 200) =>
    Promise.resolve(new Response(JSON.stringify(body), { status }));

  const unexpectedFetch = () =>
    Promise.reject(new Error("unexpected token request"));

  describe("extractOpenAICodexAccountId()", () => {
    it("returns the account id of the first token with a decodable claim", () => {
      expect(
        extractOpenAICodexAccountId(
          "no-payload-segment",
          "header.!!!not-base64!!!.signature",
          undefined,
          accountToken("acct-decodable"),
        ),
      ).toBe("acct-decodable");
    });

    it("throws when no token has a decodable payload", () => {
      expect(() =>
        extractOpenAICodexAccountId(
          "no-payload-segment",
          "header.!!!not-base64!!!.signature",
        )
      ).toThrow("did not include a ChatGPT account id");
    });
  });

  describe("exchangeOpenAICodexAuthorizationCode()", () => {
    const exchange = (
      fetchFn: () => Promise<Response>,
      signal?: AbortSignal,
    ) =>
      exchangeOpenAICodexAuthorizationCode({
        code: "code",
        verifier: "verifier",
        redirectUri: "http://localhost:1455/auth/callback",
        fetchFn,
        signal,
        now: () => 1_000,
      });

    it("returns the account id from the ID token when the access token has none", async () => {
      const credential = await exchange(() =>
        tokenResponse({
          access_token: "opaque-access",
          id_token: accountToken("acct-from-id-token"),
          refresh_token: "refresh",
          expires_in: 60,
        })
      );
      expect(credential).toEqual({
        type: "oauth",
        providerId: "openai-codex",
        accessToken: "opaque-access",
        refreshToken: "refresh",
        expiresAt: 61_000,
        accountId: "acct-from-id-token",
      });
    });

    it("throws a malformed_response error for a token without an account id", async () => {
      const error = await exchange(() =>
        tokenResponse({
          access_token: "opaque-access",
          refresh_token: "refresh",
          expires_in: 60,
        })
      ).catch((caught) => caught);
      expect(error).toBeInstanceOf(OpenAICodexAuthError);
      expect(error).toMatchObject({
        kind: "malformed_response",
        message: "OpenAI Codex token did not include a ChatGPT account id",
      });
    });

    it("throws a malformed_response error for a successful response that is not JSON", async () => {
      const error = await exchange(() =>
        Promise.resolve(new Response("<html>not json</html>"))
      ).catch((caught) => caught);
      expect(error).toBeInstanceOf(OpenAICodexAuthError);
      expect(error).toMatchObject({
        kind: "malformed_response",
        message: "OpenAI Codex token exchange returned invalid JSON",
      });
    });

    it("throws the abort reason when the signal aborts while the response arrives", async () => {
      const controller = new AbortController();
      const reason = new Error("abort while the token arrives");
      await expect(
        exchange(() => {
          controller.abort(reason);
          return tokenResponse({
            access_token: accountToken("acct-1"),
            refresh_token: "refresh",
            expires_in: 60,
          });
        }, controller.signal),
      ).rejects.toBe(reason);
    });
  });

  describe("OpenAICodexCredentialResolver", () => {
    it("throws when the credential owner reference names another owner key", () => {
      expect(() =>
        new OpenAICodexCredentialResolver({
          store: new InMemoryHarnessCredentialStore(),
          ownerKey: "local",
          credentialOwner: {
            type: HARNESS_CREDENTIAL_OWNER_REF_TYPE,
            version: 1,
            ownerKey: "someone-else",
          },
        })
      ).toThrow("credential owner reference does not match owner key");
    });

    it("returns a copy of the default credential owner reference", () => {
      const resolver = new OpenAICodexCredentialResolver({
        store: new InMemoryHarnessCredentialStore(),
        ownerKey: "local",
      });
      const owner = resolver.credentialOwner;
      expect(resolver.ownerKey).toBe("local");
      expect(owner).toEqual({
        type: HARNESS_CREDENTIAL_OWNER_REF_TYPE,
        version: 1,
        ownerKey: "local",
      });
      owner.ownerKey = "mutated";
      expect(resolver.credentialOwner.ownerKey).toBe("local");
    });

    it("returns an unexpired credential without a token request", async () => {
      const store = new InMemoryHarnessCredentialStore();
      const credential = {
        ...expiredCredential(),
        expiresAt: 4_000_000_000_000,
      };
      await store.set("local", "openai-codex", credential);
      const resolver = new OpenAICodexCredentialResolver({
        store,
        ownerKey: "local",
        fetchFn: unexpectedFetch,
      });
      expect(await resolver.resolve()).toEqual(credential);
    });

    it("throws provider-unavailable when the credential store cannot be read", async () => {
      const store = new InMemoryHarnessCredentialStore();
      store.getRecord = () =>
        Promise.reject(new Error("read failure quoting refresh-secret"));
      const error = await new OpenAICodexCredentialResolver({
        store,
        ownerKey: "local",
        fetchFn: unexpectedFetch,
      }).resolve().catch((caught) => caught);
      expect(error).toBeInstanceOf(HarnessControlError);
      expect(error).toMatchObject({
        code: "provider-unavailable",
        message: "OpenAI Codex credential storage could not be read",
      });
      expect(errorGraphText(error)).not.toContain("refresh-secret");
    });

    it("throws the abort reason when the signal aborts during a failed credential read", async () => {
      const store = new InMemoryHarnessCredentialStore();
      const controller = new AbortController();
      const reason = new Error("abort during a failed read");
      store.getRecord = () => {
        controller.abort(reason);
        return Promise.reject(new Error("read failure"));
      };
      await expect(
        new OpenAICodexCredentialResolver({
          store,
          ownerKey: "local",
          fetchFn: unexpectedFetch,
        }).resolve(controller.signal),
      ).rejects.toBe(reason);
    });

    it("throws the abort reason without a token request when the signal aborts before the update runs", async () => {
      // A file store reads the document inside its lock, so an abort can land
      // after the store admitted the update but before the updater runs.
      const store = new InMemoryHarnessCredentialStore();
      await store.set("local", "openai-codex", expiredCredential());
      const controller = new AbortController();
      const reason = new Error("abort inside the store transaction");
      const originalUpdateRecord = store.updateRecord.bind(store);
      store.updateRecord = (ownerKey, providerId, updater) =>
        originalUpdateRecord(ownerKey, providerId, (record) => {
          controller.abort(reason);
          return updater(record);
        });
      let requests = 0;
      const resolver = new OpenAICodexCredentialResolver({
        store,
        ownerKey: "local",
        now: () => 100_000,
        fetchFn: () => {
          requests++;
          return unexpectedFetch();
        },
      });

      await expect(resolver.resolve(controller.signal)).rejects.toBe(reason);
      expect(requests).toBe(0);
      expect(await store.get("local", "openai-codex")).toEqual(
        expiredCredential(),
      );
    });

    describe("when another mutation lands while the refresh waits", () => {
      const resolveAfterConcurrentMutation = async (
        mutate: () => HarnessCredentialRecord,
      ) => {
        const store = new InMemoryHarnessCredentialStore();
        await store.set("local", "openai-codex", expiredCredential());
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
          async () => {
            markMutationStarted();
            await mutationHeld;
            return mutate();
          },
        );
        await mutationStarted;
        let markRefreshQueued!: () => void;
        const refreshQueued = new Promise<void>((resolve) => {
          markRefreshQueued = resolve;
        });
        const originalUpdateRecord = store.updateRecord.bind(store);
        store.updateRecord = (...args) => {
          markRefreshQueued();
          return originalUpdateRecord(...args);
        };
        let requests = 0;
        const resolving = new OpenAICodexCredentialResolver({
          store,
          ownerKey: "local",
          now: () => 100_000,
          fetchFn: () => {
            requests++;
            return unexpectedFetch();
          },
        }).resolve().catch((caught) => caught);
        await refreshQueued;
        releaseMutation();
        await holding;
        return { error: await resolving, requests };
      };

      it("throws provider-auth-required after a concurrent logout", async () => {
        const { error, requests } = await resolveAfterConcurrentMutation(
          () => ({}),
        );
        expect(error).toBeInstanceOf(HarnessControlError);
        expect(error).toMatchObject({
          code: "provider-auth-required",
          message: "OpenAI Codex credential was disconnected",
        });
        expect(requests).toBe(0);
      });

      it("throws provider-auth-required naming concurrently recorded health", async () => {
        const { error, requests } = await resolveAfterConcurrentMutation(
          () => ({
            credential: expiredCredential(),
            health: { status: "reconnect-required", reason: "invalid-grant" },
          }),
        );
        expect(error).toBeInstanceOf(HarnessControlError);
        expect(error).toMatchObject({
          code: "provider-auth-required",
          message: "OpenAI Codex must be reconnected (invalid-grant)",
        });
        expect(requests).toBe(0);
      });
    });

    it("throws provider-unavailable when the credential store cannot be updated", async () => {
      const store = new InMemoryHarnessCredentialStore();
      await store.set("local", "openai-codex", expiredCredential());
      store.updateRecord = () =>
        Promise.reject(new Error("disk full writing refresh-secret"));
      const error = await new OpenAICodexCredentialResolver({
        store,
        ownerKey: "local",
        now: () => 100_000,
        fetchFn: unexpectedFetch,
      }).resolve().catch((caught) => caught);
      expect(error).toBeInstanceOf(HarnessControlError);
      expect(error).toMatchObject({
        code: "provider-unavailable",
        message: "OpenAI Codex credential storage could not be updated",
      });
      expect(errorGraphText(error)).not.toContain("refresh-secret");
    });

    it("throws provider-auth-required when the store's update returns no credential", async () => {
      // The Loom adapter implements the store interface outside this package;
      // a record without a credential must not be treated as a refresh.
      const store = new InMemoryHarnessCredentialStore();
      await store.set("local", "openai-codex", expiredCredential());
      store.updateRecord = () => Promise.resolve({});
      await expect(
        new OpenAICodexCredentialResolver({
          store,
          ownerKey: "local",
          now: () => 100_000,
          fetchFn: unexpectedFetch,
        }).resolve(),
      ).rejects.toMatchObject({
        code: "provider-auth-required",
        message: "OpenAI Codex credential was disconnected",
      });
    });

    it("records revoked health for a 401 refresh response without an error code", async () => {
      const store = new InMemoryHarnessCredentialStore();
      await store.set("local", "openai-codex", expiredCredential());
      const resolver = new OpenAICodexCredentialResolver({
        store,
        ownerKey: "local",
        now: () => 100_000,
        fetchFn: () => tokenResponse({}, 401),
      });

      await expect(resolver.resolve()).rejects.toMatchObject({
        code: "provider-auth-required",
        message: "OpenAI Codex must be reconnected (revoked)",
      });
      expect(await store.getHealth("local", "openai-codex")).toEqual({
        status: "reconnect-required",
        reason: "revoked",
      });
    });

    it("records no health for a 500 refresh response", async () => {
      const store = new InMemoryHarnessCredentialStore();
      await store.set("local", "openai-codex", expiredCredential());
      const resolver = new OpenAICodexCredentialResolver({
        store,
        ownerKey: "local",
        now: () => 100_000,
        fetchFn: () => tokenResponse({}, 500),
      });

      await expect(resolver.resolve()).rejects.toMatchObject({
        code: "provider-unavailable",
        message: "OpenAI Codex token refresh failed (500)",
      });
      expect(await store.getHealth("local", "openai-codex")).toBeUndefined();
    });

    it("throws provider-unavailable naming the response for a refreshed token without an account id", async () => {
      const store = new InMemoryHarnessCredentialStore();
      await store.set("local", "openai-codex", expiredCredential());
      const resolver = new OpenAICodexCredentialResolver({
        store,
        ownerKey: "local",
        now: () => 100_000,
        fetchFn: () =>
          tokenResponse({
            access_token: "opaque-access",
            refresh_token: "refresh-new",
            expires_in: 3600,
          }),
      });

      await expect(resolver.resolve()).rejects.toMatchObject({
        code: "provider-unavailable",
        message: "OpenAI Codex token did not include a ChatGPT account id",
      });
      expect(await store.getRecord("local", "openai-codex")).toEqual({
        credential: expiredCredential(),
      });
    });
  });

  describe("startOpenAICodexDeviceAuthorization()", () => {
    const start = (response: Response) =>
      startOpenAICodexDeviceAuthorization({
        fetchFn: () => Promise.resolve(response),
      });

    it("returns the interval in milliseconds from a string interval", async () => {
      expect(
        await start(
          new Response(JSON.stringify({
            device_auth_id: "device-1",
            user_code: "ABCD",
            interval: "5",
          })),
        ),
      ).toEqual({
        deviceAuthId: "device-1",
        userCode: "ABCD",
        intervalMs: 5_000,
        verificationUrl: "https://auth.openai.com/codex/device",
      });
    });

    it("throws the status of a failed request", async () => {
      await expect(start(new Response("busy", { status: 503 }))).rejects
        .toThrow("OpenAI Codex device authorization failed (503)");
    });

    it("throws for a response that is not JSON", async () => {
      await expect(start(new Response("<html></html>"))).rejects.toThrow(
        "OpenAI Codex device authorization returned invalid JSON",
      );
    });

    it("throws for a response with a negative interval", async () => {
      await expect(
        start(
          new Response(JSON.stringify({
            device_auth_id: "device-1",
            user_code: "ABCD",
            interval: -1,
          })),
        ),
      ).rejects.toThrow(
        "OpenAI Codex device authorization response is missing required fields",
      );
    });
  });

  describe("waitForOpenAICodexDeviceInterval()", () => {
    it("resolves once the interval has elapsed", async () => {
      using time = new FakeTime();
      let resolved = false;
      const waiting = waitForOpenAICodexDeviceInterval(1_000).then(() => {
        resolved = true;
      });
      await time.tickAsync(999);
      expect(resolved).toBe(false);
      await time.tickAsync(1);
      await waiting;
      expect(resolved).toBe(true);
    });

    it("rejects with the reason of an already-aborted signal", async () => {
      const reason = new Error("aborted before waiting");
      await expect(
        waitForOpenAICodexDeviceInterval(1_000, AbortSignal.abort(reason)),
      ).rejects.toBe(reason);
    });

    it("rejects with the abort reason when the signal aborts during the wait", async () => {
      using time = new FakeTime();
      const controller = new AbortController();
      const waiting = waitForOpenAICodexDeviceInterval(
        1_000,
        controller.signal,
      );
      await time.tickAsync(500);
      const reason = new Error("aborted while waiting");
      controller.abort(reason);
      await expect(waiting).rejects.toBe(reason);
    });
  });

  describe("loginOpenAICodexWithBrowser()", () => {
    it("answers 404 off the callback path and rejects a callback without a code", async () => {
      const store = new InMemoryHarnessCredentialStore();
      const statuses: number[] = [];
      const login = loginOpenAICodexWithBrowser({
        authService: new OpenAICodexAuthService(store, "local"),
        port: 0,
        fetchFn: unexpectedFetch,
        onAuthorizationUrl: async (authorizationUrl) => {
          const state = new URL(authorizationUrl).searchParams.get("state");
          for (
            const path of [
              `/elsewhere?code=code&state=${state}`,
              `/auth/callback?state=${state}`,
            ]
          ) {
            const response = await fetch(
              `${callbackOrigin(authorizationUrl)}${path}`,
            );
            await response.body?.cancel();
            statuses.push(response.status);
          }
        },
      });

      await expect(login).rejects.toThrow(
        "OAuth callback is missing an authorization code",
      );
      expect(statuses).toEqual([404, 400]);
      expect(await store.getRecord("local", "openai-codex")).toEqual({});
    });

    it("releases the owner when the callback port cannot be bound", async () => {
      const occupant = Deno.listen({ hostname: "localhost", port: 0 });
      try {
        const authService = new OpenAICodexAuthService(
          new InMemoryHarnessCredentialStore(),
          "local",
        );
        let authorizationUrls = 0;
        const attempt = () =>
          loginOpenAICodexWithBrowser({
            authService,
            port: occupant.addr.port,
            onAuthorizationUrl: () => {
              authorizationUrls++;
            },
          });
        // The second attempt failing on the port, not on "already in
        // progress", shows the first released its owner.
        await expect(attempt()).rejects.toBeInstanceOf(Deno.errors.AddrInUse);
        await expect(attempt()).rejects.toBeInstanceOf(Deno.errors.AddrInUse);
        expect(authorizationUrls).toBe(0);
      } finally {
        occupant.close();
      }
    });
  });

  describe("OpenAICodexAuthService", () => {
    it("reports reconnect-required with the recorded reason", async () => {
      const store = new InMemoryHarnessCredentialStore();
      await store.updateRecord("local", "openai-codex", () => ({
        credential: expiredCredential(),
        health: { status: "reconnect-required", reason: "revoked" },
      }));
      expect(await new OpenAICodexAuthService(store, "local").status()).toEqual(
        {
          providerId: "openai-codex",
          status: "reconnect-required",
          refreshHealth: "reconnect-required",
          reason: "revoked",
        },
      );
    });

    it("reports refresh-on-use for an expired credential and disconnected after logout", async () => {
      const store = new InMemoryHarnessCredentialStore();
      await store.set("local", "openai-codex", expiredCredential());
      const auth = new OpenAICodexAuthService(store, "local");
      expect(await auth.status(1)).toEqual({
        providerId: "openai-codex",
        status: "connected",
        refreshHealth: "refresh-on-use",
      });

      await auth.logout();

      expect(await auth.status(1)).toEqual({
        providerId: "openai-codex",
        status: "disconnected",
      });
      expect(await store.getRecord("local", "openai-codex")).toEqual({});
    });
  });
});

const unexpiredCodexCredential = (
  accessToken: string,
): OpenAICodexOAuthCredential => ({
  type: "oauth",
  providerId: "openai-codex",
  accessToken,
  refreshToken: "refresh-old",
  // far from expiry by the stored estimate
  expiresAt: 10_000 + 24 * 60 * 60 * 1000,
  accountId: "acct-1",
});

const rejectionResolver = (
  store: InMemoryHarnessCredentialStore,
  reply: () => Response,
) => {
  const seen = { refreshes: 0 };
  const resolver = new OpenAICodexCredentialResolver({
    store,
    ownerKey: "local",
    now: () => 10_000,
    fetchFn: () => {
      seen.refreshes += 1;
      return Promise.resolve(reply());
    },
  });
  return { resolver, seen };
};

const refreshedTokenReply = (): Response =>
  new Response(
    JSON.stringify({
      access_token: jwt({
        "https://api.openai.com/auth": { chatgpt_account_id: "acct-1" },
        refreshed: true,
      }),
      refresh_token: "refresh-new",
      expires_in: 3600,
    }),
    { status: 200 },
  );

test("a Codex token the provider refused is refreshed though its expiry is ahead", async () => {
  const store = new InMemoryHarnessCredentialStore();
  const refused = unexpiredCodexCredential("access-refused");
  await store.set("local", "openai-codex", refused);
  const { resolver, seen } = rejectionResolver(store, refreshedTokenReply);

  // the stored expiry alone asks for no refresh
  assertEquals((await resolver.resolve()).accessToken, "access-refused");
  assertEquals(seen.refreshes, 0);

  const next = await resolver.refreshRejected(refused);

  assertEquals(seen.refreshes, 1);
  assertEquals(next?.fresh, true);
  assertEquals(next?.credential.refreshToken, "refresh-new");
  assertEquals(
    (await store.get("local", "openai-codex"))?.accessToken,
    next?.credential.accessToken,
  );
  assertEquals(
    (await new OpenAICodexAuthService(store, "local").status()).status,
    "connected",
  );
});

test("a refused Codex token already replaced is not refreshed again", async () => {
  const store = new InMemoryHarnessCredentialStore();
  await store.set(
    "local",
    "openai-codex",
    unexpiredCodexCredential("access-newer"),
  );
  const { resolver, seen } = rejectionResolver(store, refreshedTokenReply);

  const next = await resolver.refreshRejected(
    unexpiredCodexCredential("access-refused"),
  );

  assertEquals(seen.refreshes, 0);
  assertEquals(next?.fresh, false);
  assertEquals(next?.credential.accessToken, "access-newer");
});

test("a refused Codex token whose refresh is refused for good needs reconnection", async () => {
  const store = new InMemoryHarnessCredentialStore();
  const refused = unexpiredCodexCredential("access-refused");
  await store.set("local", "openai-codex", refused);
  const { resolver } = rejectionResolver(
    store,
    () =>
      new Response(JSON.stringify({ error: "invalid_grant" }), { status: 400 }),
  );

  assertEquals(await resolver.refreshRejected(refused), undefined);
  assertEquals(
    await new OpenAICodexAuthService(store, "local").status(),
    {
      providerId: "openai-codex",
      status: "reconnect-required",
      refreshHealth: "reconnect-required",
      reason: "invalid-grant",
    },
  );
});

test("a refused Codex token whose refresh cannot be completed stays connected", async () => {
  const store = new InMemoryHarnessCredentialStore();
  const refused = unexpiredCodexCredential("access-refused");
  await store.set("local", "openai-codex", refused);
  const { resolver } = rejectionResolver(
    store,
    () => new Response("unavailable", { status: 503 }),
  );

  const error = await assertRejects(() => resolver.refreshRejected(refused));
  assertEquals(error instanceof HarnessControlError, true);
  assertEquals((error as HarnessControlError).code, "provider-unavailable");
  assertEquals(
    (await new OpenAICodexAuthService(store, "local").status()).status,
    "connected",
  );
  assertEquals(
    (await store.get("local", "openai-codex"))?.accessToken,
    "access-refused",
  );
});

test("a refresh that returns a token with no account id is reported as the refresh's failure", async () => {
  const store = new InMemoryHarnessCredentialStore();
  const refused = unexpiredCodexCredential("access-refused");
  await store.set("local", "openai-codex", refused);
  const { resolver } = rejectionResolver(
    store,
    () =>
      new Response(
        JSON.stringify({
          access_token: jwt({ refreshed: true }),
          refresh_token: "refresh-new",
          expires_in: 3600,
        }),
        { status: 200 },
      ),
  );

  const error = await assertRejects(() => resolver.refreshRejected(refused));
  assertEquals((error as HarnessControlError).code, "provider-unavailable");
  assertEquals(
    (error as HarnessControlError).message,
    "OpenAI Codex token did not include a ChatGPT account id",
  );
  assertEquals(
    (await store.get("local", "openai-codex"))?.accessToken,
    "access-refused",
  );
});

test("marking a refused Codex token needs reconnection only while it is the stored one", async () => {
  const store = new InMemoryHarnessCredentialStore();
  const stored = unexpiredCodexCredential("access-stored");
  await store.set("local", "openai-codex", stored);
  const { resolver, seen } = rejectionResolver(store, refreshedTokenReply);
  const status = () => new OpenAICodexAuthService(store, "local").status();

  await resolver.markRejected(unexpiredCodexCredential("access-other"));
  assertEquals((await status()).status, "connected");

  await resolver.markRejected(stored);
  assertEquals(await status(), {
    providerId: "openai-codex",
    status: "reconnect-required",
    refreshHealth: "reconnect-required",
    reason: "revoked",
  });
  assertEquals(seen.refreshes, 0);
});

test("a refused Codex token is not refreshed when the signal aborts before the update runs", async () => {
  const store = new InMemoryHarnessCredentialStore();
  const refused = unexpiredCodexCredential("access-refused");
  await store.set("local", "openai-codex", refused);
  const controller = new AbortController();
  const reason = new Error("abort inside the store transaction");
  const originalUpdateRecord = store.updateRecord.bind(store);
  store.updateRecord = (ownerKey, providerId, updater) =>
    originalUpdateRecord(ownerKey, providerId, (record) => {
      controller.abort(reason);
      return updater(record);
    });
  const { resolver, seen } = rejectionResolver(store, refreshedTokenReply);

  const error = await assertRejects(() =>
    resolver.refreshRejected(refused, controller.signal)
  );

  assertStrictEquals(error, reason);
  assertEquals(seen.refreshes, 0);
  assertEquals(await store.get("local", "openai-codex"), refused);
});

test("a refused Codex token's refresh is kept when the signal aborts as the refresh lands", async () => {
  const store = new InMemoryHarnessCredentialStore();
  const refused = unexpiredCodexCredential("access-refused");
  await store.set("local", "openai-codex", refused);
  const controller = new AbortController();
  const reason = new Error("abort after refresh response");
  const { resolver, seen } = rejectionResolver(store, () => {
    controller.abort(reason);
    return refreshedTokenReply();
  });

  const error = await assertRejects(() =>
    resolver.refreshRejected(refused, controller.signal)
  );

  assertStrictEquals(error, reason);
  assertEquals(seen.refreshes, 1);
  assertEquals(
    (await store.get("local", "openai-codex"))?.refreshToken,
    "refresh-new",
  );
});

test("a refused Codex token whose store cannot be updated is reported as unavailable storage", async () => {
  const store = new InMemoryHarnessCredentialStore();
  const refused = unexpiredCodexCredential("access-refused");
  await store.set("local", "openai-codex", refused);
  store.updateRecord = () =>
    Promise.reject(
      new HarnessControlError("provider-auth-required", "store refusal"),
    );
  const { resolver, seen } = rejectionResolver(store, refreshedTokenReply);

  const error = await assertRejects(() => resolver.refreshRejected(refused));

  assertEquals(error instanceof HarnessControlError, true);
  assertEquals((error as HarnessControlError).code, "provider-unavailable");
  assertEquals(
    (error as HarnessControlError).message,
    "OpenAI Codex credential storage could not be updated",
  );
  assertEquals(seen.refreshes, 0);
});

test("marking a refused Codex token tolerates a store that cannot be written unless aborted", async () => {
  const store = new InMemoryHarnessCredentialStore();
  const stored = unexpiredCodexCredential("access-stored");
  await store.set("local", "openai-codex", stored);
  const controller = new AbortController();
  const reason = new Error("abort during the mark");
  store.updateRecord = () => Promise.reject(new Error("write failure"));
  const { resolver } = rejectionResolver(store, refreshedTokenReply);

  assertEquals(
    await resolver.markRejected(stored, controller.signal),
    undefined,
  );
  assertEquals(
    (await new OpenAICodexAuthService(store, "local").status()).status,
    "connected",
  );

  controller.abort(reason);
  const error = await assertRejects(() =>
    resolver.markRejected(stored, controller.signal)
  );
  assertStrictEquals(error, reason);
});
