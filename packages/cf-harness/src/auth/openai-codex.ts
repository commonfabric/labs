import { isObjectOrArray } from "@commonfabric/utils/types";
import {
  defaultHarnessFetch,
  type HarnessFetch,
} from "../contracts/http-fetch.ts";
import type { HarnessCredentialStore } from "./credential-store.ts";
import {
  HARNESS_CREDENTIAL_OWNER_REF_TYPE,
  type HarnessCredentialOwnerRef,
} from "../contracts/run-manifest.ts";
import {
  type HarnessCredentialHealth,
  type HarnessCredentialStatus,
  OPENAI_CODEX_PROVIDER_ID,
  type OpenAICodexOAuthCredential,
} from "./types.ts";
import { HarnessControlError } from "../control-errors.ts";

export const OPENAI_CODEX_CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";
export const OPENAI_CODEX_AUTH_ORIGIN = "https://auth.openai.com";
export const OPENAI_CODEX_AUTHORIZE_URL =
  `${OPENAI_CODEX_AUTH_ORIGIN}/oauth/authorize`;
export const OPENAI_CODEX_TOKEN_URL = `${OPENAI_CODEX_AUTH_ORIGIN}/oauth/token`;
export const OPENAI_CODEX_DEVICE_START_URL =
  `${OPENAI_CODEX_AUTH_ORIGIN}/api/accounts/deviceauth/usercode`;
export const OPENAI_CODEX_DEVICE_TOKEN_URL =
  `${OPENAI_CODEX_AUTH_ORIGIN}/api/accounts/deviceauth/token`;
export const OPENAI_CODEX_DEVICE_VERIFICATION_URL =
  `${OPENAI_CODEX_AUTH_ORIGIN}/codex/device`;
export const OPENAI_CODEX_DEVICE_REDIRECT_URL =
  `${OPENAI_CODEX_AUTH_ORIGIN}/deviceauth/callback`;
export const OPENAI_CODEX_BROWSER_REDIRECT_URL =
  "http://localhost:1455/auth/callback";
export const OPENAI_CODEX_SCOPE = "openid profile email offline_access";
const ACCOUNT_CLAIM = "https://api.openai.com/auth";
const REFRESH_SKEW_MS = 60_000;
const activeBrowserLoginOwners = new Set<string>();

export type OpenAICodexAuthErrorKind =
  | "invalid_grant"
  | "revoked"
  | "refresh_token_reused"
  | "malformed_response"
  | "network"
  | "storage"
  | "provider";

export class OpenAICodexAuthError extends Error {
  constructor(
    readonly kind: OpenAICodexAuthErrorKind,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "OpenAICodexAuthError";
  }
}

const base64Url = (bytes: Uint8Array): string => {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(
    /=+$/,
    "",
  );
};

const randomBytes = (length: number): Uint8Array =>
  crypto.getRandomValues(new Uint8Array(length));

const sha256 = async (text: string): Promise<Uint8Array> =>
  new Uint8Array(
    await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text)),
  );

export interface OpenAICodexBrowserAuthorization {
  url: string;
  state: string;
  verifier: string;
  redirectUri: string;
}

export const createOpenAICodexBrowserAuthorization = async (
  options: {
    redirectUri?: string;
    originator?: string;
    randomBytes?: (length: number) => Uint8Array;
  } = {},
): Promise<OpenAICodexBrowserAuthorization> => {
  const generate = options.randomBytes ?? randomBytes;
  const verifier = base64Url(generate(32));
  const state = base64Url(generate(32));
  const redirectUri = options.redirectUri ?? OPENAI_CODEX_BROWSER_REDIRECT_URL;
  const url = new URL(OPENAI_CODEX_AUTHORIZE_URL);
  url.search = new URLSearchParams({
    response_type: "code",
    client_id: OPENAI_CODEX_CLIENT_ID,
    redirect_uri: redirectUri,
    scope: OPENAI_CODEX_SCOPE,
    code_challenge: base64Url(await sha256(verifier)),
    code_challenge_method: "S256",
    state,
    id_token_add_organizations: "true",
    codex_cli_simplified_flow: "true",
    originator: options.originator ?? "cf-harness",
  }).toString();
  return { url: url.toString(), state, verifier, redirectUri };
};

const decodeJwtPayload = (
  token: string,
): Record<string, unknown> | undefined => {
  try {
    const payload = token.split(".")[1];
    if (!payload) return undefined;
    const normalized = payload.replaceAll("-", "+").replaceAll("_", "/");
    const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, "=");
    return JSON.parse(atob(padded)) as Record<string, unknown>;
  } catch {
    return undefined;
  }
};

export const extractOpenAICodexAccountId = (
  ...tokens: Array<string | undefined>
): string => {
  for (const token of tokens) {
    if (!token) continue;
    const payload = decodeJwtPayload(token);
    const nested = payload?.[ACCOUNT_CLAIM];
    const accountId = isObjectOrArray(nested)
      ? (nested as Record<string, unknown>).chatgpt_account_id
      : undefined;
    if (typeof accountId === "string" && accountId.length > 0) return accountId;
  }
  throw new Error("OpenAI Codex token did not include a ChatGPT account id");
};

interface TokenResponse {
  access_token?: unknown;
  refresh_token?: unknown;
  expires_in?: unknown;
  id_token?: unknown;
}

const readTokenResponse = async (
  response: Response,
  operation: "exchange" | "refresh",
  now: number,
  existingRefreshToken?: string,
): Promise<OpenAICodexOAuthCredential> => {
  if (!response.ok) {
    let code: string | undefined;
    try {
      const body = await response.json() as Record<string, unknown>;
      const error = body.error;
      if (typeof error === "string") code = error;
      else if (isObjectOrArray(error)) {
        const record = error as Record<string, unknown>;
        code = typeof record.code === "string"
          ? record.code
          : typeof record.type === "string"
          ? record.type
          : undefined;
      }
    } catch {
      // The status remains enough to report a bounded, secret-free failure.
    }
    const kind: OpenAICodexAuthErrorKind = code === "invalid_grant"
      ? "invalid_grant"
      : code === "refresh_token_reused"
      ? "refresh_token_reused"
      : response.status === 401
      ? "revoked"
      : "provider";
    throw new OpenAICodexAuthError(
      kind,
      `OpenAI Codex token ${operation} failed (${response.status})`,
    );
  }
  let json: TokenResponse;
  try {
    json = await response.json() as TokenResponse;
  } catch {
    throw new OpenAICodexAuthError(
      "malformed_response",
      `OpenAI Codex token ${operation} returned invalid JSON`,
    );
  }
  const refreshToken = json.refresh_token === undefined &&
      operation === "refresh"
    ? existingRefreshToken
    : json.refresh_token;
  if (
    typeof json.access_token !== "string" ||
    typeof refreshToken !== "string" ||
    typeof json.expires_in !== "number" || !Number.isFinite(json.expires_in)
  ) {
    throw new OpenAICodexAuthError(
      "malformed_response",
      `OpenAI Codex token ${operation} response is missing required fields`,
    );
  }
  const idToken = typeof json.id_token === "string" ? json.id_token : undefined;
  return {
    type: "oauth",
    providerId: OPENAI_CODEX_PROVIDER_ID,
    accessToken: json.access_token,
    refreshToken,
    expiresAt: now + json.expires_in * 1000,
    accountId: extractOpenAICodexAccountId(idToken, json.access_token),
  };
};

export const exchangeOpenAICodexAuthorizationCode = async (options: {
  code: string;
  verifier: string;
  redirectUri: string;
  fetchFn?: HarnessFetch;
  signal?: AbortSignal;
  now?: () => number;
}): Promise<OpenAICodexOAuthCredential> => {
  let response: Response;
  try {
    response = await (options.fetchFn ?? defaultHarnessFetch)(
      OPENAI_CODEX_TOKEN_URL,
      {
        method: "POST",
        redirect: "error",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          grant_type: "authorization_code",
          client_id: OPENAI_CODEX_CLIENT_ID,
          code: options.code,
          code_verifier: options.verifier,
          redirect_uri: options.redirectUri,
        }),
        signal: options.signal,
      },
    );
  } catch {
    if (options.signal?.aborted) throw abortReason(options.signal);
    throw new OpenAICodexAuthError(
      "network",
      "OpenAI Codex token exchange failed before receiving a response",
    );
  }
  const credential = await readTokenResponse(
    response,
    "exchange",
    (options.now ?? Date.now)(),
  );
  if (options.signal?.aborted) throw abortReason(options.signal);
  return credential;
};

export interface OpenAICodexCredentialResolverOptions {
  store: HarnessCredentialStore;
  ownerKey: string;
  credentialOwner?: HarnessCredentialOwnerRef;
  fetchFn?: HarnessFetch;
  now?: () => number;
  refreshSkewMs?: number;
}

export class OpenAICodexCredentialResolver {
  readonly #store: HarnessCredentialStore;
  readonly #ownerKey: string;
  readonly #credentialOwner: HarnessCredentialOwnerRef;
  readonly #fetchFn: HarnessFetch;
  readonly #now: () => number;
  readonly #refreshSkewMs: number;

  constructor(options: OpenAICodexCredentialResolverOptions) {
    this.#store = options.store;
    this.#ownerKey = options.ownerKey;
    this.#credentialOwner = structuredClone(
      options.credentialOwner ?? {
        type: HARNESS_CREDENTIAL_OWNER_REF_TYPE,
        version: 1,
        ownerKey: options.ownerKey,
      },
    );
    if (this.#credentialOwner.ownerKey !== options.ownerKey) {
      throw new Error("credential owner reference does not match owner key");
    }
    this.#fetchFn = options.fetchFn ?? defaultHarnessFetch;
    this.#now = options.now ?? Date.now;
    this.#refreshSkewMs = options.refreshSkewMs ?? REFRESH_SKEW_MS;
  }

  get ownerKey(): string {
    return this.#ownerKey;
  }

  get credentialOwner(): HarnessCredentialOwnerRef {
    return structuredClone(this.#credentialOwner);
  }

  async resolve(signal?: AbortSignal): Promise<OpenAICodexOAuthCredential> {
    if (signal?.aborted) throw abortReason(signal);
    let current: OpenAICodexOAuthCredential | undefined;
    let health: HarnessCredentialHealth | undefined;
    try {
      const record = await this.#store.getRecord(
        this.#ownerKey,
        OPENAI_CODEX_PROVIDER_ID,
      );
      current = record.credential;
      health = record.health;
    } catch {
      if (signal?.aborted) throw abortReason(signal);
      throw new HarnessControlError(
        "provider-unavailable",
        "OpenAI Codex credential storage could not be read",
      );
    }
    if (signal?.aborted) throw abortReason(signal);
    if (!current) {
      throw new HarnessControlError(
        "provider-auth-required",
        "OpenAI Codex is not connected for this credential owner",
      );
    }
    if (health !== undefined) {
      throw new HarnessControlError(
        "provider-auth-required",
        `OpenAI Codex must be reconnected (${health.reason})`,
      );
    }
    if (current.expiresAt - this.#refreshSkewMs > this.#now()) return current;
    let refreshed: OpenAICodexOAuthCredential | undefined;
    try {
      const record = await this.#store.updateRecord(
        this.#ownerKey,
        OPENAI_CODEX_PROVIDER_ID,
        async (currentRecord) => {
          if (signal?.aborted) throw abortReason(signal);
          const latest = currentRecord.credential;
          if (!latest) {
            throw new HarnessControlError(
              "provider-auth-required",
              "OpenAI Codex credential was disconnected",
            );
          }
          if (currentRecord.health !== undefined) {
            throw new HarnessControlError(
              "provider-auth-required",
              `OpenAI Codex must be reconnected (${currentRecord.health.reason})`,
            );
          }
          if (latest.expiresAt - this.#refreshSkewMs > this.#now()) {
            return currentRecord;
          }
          let response: Response;
          try {
            response = await this.#fetchFn(OPENAI_CODEX_TOKEN_URL, {
              method: "POST",
              redirect: "error",
              headers: { "Content-Type": "application/x-www-form-urlencoded" },
              body: new URLSearchParams({
                grant_type: "refresh_token",
                refresh_token: latest.refreshToken,
                client_id: OPENAI_CODEX_CLIENT_ID,
              }),
              signal,
            });
          } catch {
            if (signal?.aborted) throw abortReason(signal);
            throw new OpenAICodexAuthError(
              "network",
              "OpenAI Codex token refresh failed before receiving a response",
            );
          }
          try {
            const credential = await readTokenResponse(
              response,
              "refresh",
              this.#now(),
              latest.refreshToken,
            );
            return { credential };
          } catch (error) {
            const terminal = terminalHealthOf(error);
            if (terminal === undefined) throw error;
            return { credential: latest, health: terminal };
          }
        },
        signal,
      );
      if (record.health !== undefined) {
        throw new HarnessControlError(
          "provider-auth-required",
          `OpenAI Codex must be reconnected (${record.health.reason})`,
        );
      }
      refreshed = record.credential;
      if (signal?.aborted) throw abortReason(signal);
    } catch (error) {
      if (signal?.aborted) throw abortReason(signal);
      if (error instanceof HarnessControlError) throw error;
      if (error instanceof OpenAICodexAuthError) {
        throw new HarnessControlError(
          "provider-unavailable",
          error.message,
        );
      }
      throw new HarnessControlError(
        "provider-unavailable",
        "OpenAI Codex credential storage could not be updated",
      );
    }
    if (!refreshed) {
      throw new HarnessControlError(
        "provider-auth-required",
        "OpenAI Codex credential was disconnected",
      );
    }
    return refreshed;
  }
}

export interface OpenAICodexDeviceAuthorization {
  deviceAuthId: string;
  userCode: string;
  intervalMs: number;
  verificationUrl: string;
}

export const startOpenAICodexDeviceAuthorization = async (options: {
  fetchFn?: HarnessFetch;
  signal?: AbortSignal;
} = {}): Promise<OpenAICodexDeviceAuthorization> => {
  const response = await (options.fetchFn ?? defaultHarnessFetch)(
    OPENAI_CODEX_DEVICE_START_URL,
    {
      method: "POST",
      redirect: "error",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ client_id: OPENAI_CODEX_CLIENT_ID }),
      signal: options.signal,
    },
  );
  if (!response.ok) {
    throw new Error(
      `OpenAI Codex device authorization failed (${response.status})`,
    );
  }
  let json: Record<string, unknown>;
  try {
    json = await response.json() as Record<string, unknown>;
  } catch {
    throw new Error("OpenAI Codex device authorization returned invalid JSON");
  }
  const interval = typeof json.interval === "string"
    ? Number(json.interval)
    : json.interval;
  if (
    typeof json.device_auth_id !== "string" ||
    typeof json.user_code !== "string" ||
    typeof interval !== "number" || !Number.isFinite(interval) || interval < 0
  ) {
    throw new Error(
      "OpenAI Codex device authorization response is missing required fields",
    );
  }
  return {
    deviceAuthId: json.device_auth_id,
    userCode: json.user_code,
    intervalMs: Math.max(1, interval) * 1000,
    verificationUrl: OPENAI_CODEX_DEVICE_VERIFICATION_URL,
  };
};

const abortReason = (signal: AbortSignal): unknown =>
  signal.reason ?? new DOMException("operation aborted", "AbortError");

export const waitForOpenAICodexDeviceInterval = (
  milliseconds: number,
  signal?: AbortSignal,
): Promise<void> => {
  if (signal?.aborted) return Promise.reject(abortReason(signal));
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, milliseconds);
    const onAbort = () => {
      clearTimeout(timer);
      reject(abortReason(signal!));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
};

export const completeOpenAICodexDeviceAuthorization = async (options: {
  device: OpenAICodexDeviceAuthorization;
  fetchFn?: HarnessFetch;
  signal?: AbortSignal;
  now?: () => number;
  wait?: (milliseconds: number, signal?: AbortSignal) => Promise<void>;
  expiresInMs?: number;
}): Promise<OpenAICodexOAuthCredential> => {
  const fetchFn = options.fetchFn ?? defaultHarnessFetch;
  const now = options.now ?? Date.now;
  const wait = options.wait ?? waitForOpenAICodexDeviceInterval;
  const expiresAt = now() + (options.expiresInMs ?? 15 * 60_000);
  let intervalMs = options.device.intervalMs;
  while (now() < expiresAt) {
    await wait(intervalMs, options.signal);
    const response = await fetchFn(OPENAI_CODEX_DEVICE_TOKEN_URL, {
      method: "POST",
      redirect: "error",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        device_auth_id: options.device.deviceAuthId,
        user_code: options.device.userCode,
      }),
      signal: options.signal,
    });
    if (response.ok) {
      const json = await response.json() as Record<string, unknown>;
      if (
        typeof json.authorization_code !== "string" ||
        typeof json.code_verifier !== "string"
      ) {
        throw new Error(
          "OpenAI Codex device token response is missing required fields",
        );
      }
      return await exchangeOpenAICodexAuthorizationCode({
        code: json.authorization_code,
        verifier: json.code_verifier,
        redirectUri: OPENAI_CODEX_DEVICE_REDIRECT_URL,
        fetchFn,
        signal: options.signal,
        now,
      });
    }
    const body = await response.text();
    let errorCode: unknown;
    try {
      const parsed = JSON.parse(body) as Record<string, unknown>;
      const error = parsed.error;
      errorCode = isObjectOrArray(error)
        ? (error as Record<string, unknown>).code
        : error;
    } catch {
      // Status alone is sufficient and avoids reflecting an untrusted body.
    }
    if (errorCode === "deviceauth_authorization_pending") continue;
    if (errorCode === "slow_down") {
      intervalMs += 5_000;
      continue;
    }
    // The compared clients tolerate status-only pending responses from older
    // device endpoints. A named error is authoritative, though: terminal
    // denial/expiry codes must fail now rather than polling until local expiry.
    if (
      errorCode === undefined &&
      (response.status === 403 || response.status === 404)
    ) continue;
    throw new Error(
      `OpenAI Codex device authorization failed (${response.status})`,
    );
  }
  throw new Error("OpenAI Codex device authorization expired");
};

export const loginOpenAICodexWithBrowser = async (options: {
  authService: OpenAICodexAuthService;
  fetchFn?: HarnessFetch;
  signal?: AbortSignal;
  onAuthorizationUrl: (url: string) => void | Promise<void>;
  now?: () => number;
}): Promise<OpenAICodexOAuthCredential> => {
  if (options.signal?.aborted) {
    throw abortReason(options.signal);
  }
  if (activeBrowserLoginOwners.has(options.authService.ownerKey)) {
    throw new Error(
      "OpenAI Codex login is already in progress for this credential owner",
    );
  }
  activeBrowserLoginOwners.add(options.authService.ownerKey);
  let flow: OpenAICodexBrowserAuthorization;
  try {
    flow = await createOpenAICodexBrowserAuthorization();
  } catch (error) {
    activeBrowserLoginOwners.delete(options.authService.ownerKey);
    throw error;
  }
  if (options.signal?.aborted) {
    activeBrowserLoginOwners.delete(options.authService.ownerKey);
    throw abortReason(options.signal);
  }
  const closeController = new AbortController();
  type CallbackResult =
    | { status: "received"; code: string }
    | { status: "failed"; error: unknown };
  let settle!: (value: CallbackResult) => void;
  const callback = new Promise<CallbackResult>((resolve) => {
    settle = resolve;
  });
  const onAbort = () =>
    settle({ status: "failed", error: abortReason(options.signal!) });
  options.signal?.addEventListener("abort", onAbort, { once: true });
  let server: ReturnType<typeof Deno.serve>;
  try {
    server = Deno.serve({
      hostname: "localhost",
      port: 1455,
      signal: closeController.signal,
      onListen: () => {},
    }, (request) => {
      const url = new URL(request.url);
      if (url.pathname !== "/auth/callback") {
        return new Response("Not found", { status: 404 });
      }
      if (url.searchParams.get("state") !== flow.state) {
        return new Response("State mismatch", { status: 400 });
      }
      const code = url.searchParams.get("code");
      if (!code) {
        settle({
          status: "failed",
          error: new Error("OAuth callback is missing an authorization code"),
        });
        return new Response("Missing authorization code", { status: 400 });
      }
      settle({ status: "received", code });
      return new Response(
        "OpenAI authorization received. Return to cf-harness to confirm the connection.",
        {
          headers: { "content-type": "text/plain; charset=utf-8" },
        },
      );
    });
  } catch (error) {
    activeBrowserLoginOwners.delete(options.authService.ownerKey);
    throw error;
  }
  try {
    await options.onAuthorizationUrl(flow.url);
    const received = await callback;
    if (received.status === "failed") throw received.error;
    const credential = await exchangeOpenAICodexAuthorizationCode({
      code: received.code,
      verifier: flow.verifier,
      redirectUri: flow.redirectUri,
      fetchFn: options.fetchFn,
      signal: options.signal,
      now: options.now,
    });
    await options.authService.save(credential, options.signal);
    return credential;
  } finally {
    activeBrowserLoginOwners.delete(options.authService.ownerKey);
    options.signal?.removeEventListener("abort", onAbort);
    closeController.abort();
    await server.finished.catch((error) => {
      if (!(error instanceof DOMException && error.name === "AbortError")) {
        throw error;
      }
    });
  }
};

export class OpenAICodexAuthService {
  constructor(
    readonly store: HarnessCredentialStore,
    readonly ownerKey: string,
  ) {}

  async save(
    credential: OpenAICodexOAuthCredential,
    signal?: AbortSignal,
  ): Promise<void> {
    await this.store.updateRecord(
      this.ownerKey,
      OPENAI_CODEX_PROVIDER_ID,
      () => {
        signal?.throwIfAborted();
        return { credential };
      },
      signal,
    );
    signal?.throwIfAborted();
  }

  async status(now = Date.now()): Promise<HarnessCredentialStatus> {
    const record = await this.store.getRecord(
      this.ownerKey,
      OPENAI_CODEX_PROVIDER_ID,
    );
    const { credential, health } = record;
    if (health !== undefined) {
      return {
        providerId: OPENAI_CODEX_PROVIDER_ID,
        status: "reconnect-required",
        refreshHealth: "reconnect-required",
        reason: health.reason,
      };
    }
    return credential === undefined
      ? { providerId: OPENAI_CODEX_PROVIDER_ID, status: "disconnected" }
      : {
        providerId: OPENAI_CODEX_PROVIDER_ID,
        status: "connected",
        refreshHealth: credential.expiresAt <= now ? "refresh-on-use" : "ready",
      };
  }

  async logout(): Promise<void> {
    await this.store.delete(this.ownerKey, OPENAI_CODEX_PROVIDER_ID);
  }
}

const terminalHealthOf = (
  error: unknown,
): HarnessCredentialHealth | undefined => {
  if (!(error instanceof OpenAICodexAuthError)) return undefined;
  if (error.kind === "invalid_grant") {
    return { status: "reconnect-required", reason: "invalid-grant" };
  }
  if (error.kind === "revoked") {
    return { status: "reconnect-required", reason: "revoked" };
  }
  if (error.kind === "refresh_token_reused") {
    return { status: "reconnect-required", reason: "refresh-token-reused" };
  }
  return undefined;
};
