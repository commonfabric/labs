import { OAuth2Client, type Tokens } from "@cmd-johnson/oauth2-client";
import type { JSONSchema } from "@commonfabric/runner";
import { getLogger } from "@commonfabric/utils/logger";
import type { Context } from "@hono/hono";

import type {
  OAuth2ProviderConfig,
  OAuth2Tokens,
  UserInfo,
} from "./oauth2-common.types.ts";
import { runtime } from "@/index.ts";
import {
  custodyIngest,
  durableSet,
  type VouchedChannel,
} from "@/lib/custody-ingest.ts";

const logger = getLogger("oauth2-common");

//
// OAuth2 Client
//

export function createOAuth2Client(
  config: OAuth2ProviderConfig,
  redirectUri: string,
  scopes?: string[],
): OAuth2Client {
  const scopeString = scopes && scopes.length > 0
    ? scopes.join(" ")
    : config.defaultScopes;

  return new OAuth2Client({
    clientId: config.clientId,
    clientSecret: config.clientSecret,
    tokenUri: config.tokenUri,
    authorizationEndpointUri: config.authorizationEndpointUri,
    redirectUri,
    defaults: { scope: scopeString },
  });
}

//
// URL helpers
//

export function getBaseUrl(url: string): string {
  try {
    const parsedUrl = new URL(url);
    const origin = parsedUrl.origin;
    return origin.startsWith("http://localhost")
      ? origin
      : origin.replace("http://", "https://");
  } catch (_) {
    return "http://localhost:8000";
  }
}

//
// Callback HTML
//

function escapeHtml(str: string): string {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

export function generateCallbackHtml(result: Record<string, unknown>): string {
  const statusMessage = result.success
    ? "You can close this window now."
    : escapeHtml(String(result.error || "An error occurred"));

  const safeJson = JSON.stringify(result).replace(/</g, "\\u003c");

  return `
    <!DOCTYPE html>
    <html>
    <head>
      <title>OAuth Callback</title>
      <style>
        body { font-family: Arial, sans-serif; text-align: center; margin-top: 50px; }
        .success { color: green; }
        .error { color: red; }
      </style>
    </head>
    <body>
      <h1 class="${result.success ? "success" : "error"}">
        ${
    result.success ? "Authentication Successful!" : "Authentication Failed"
  }
      </h1>
      <p>${statusMessage}</p>
      <script>
        if (window.opener) {
          window.opener.postMessage({
            type: 'oauth-callback',
            result: ${safeJson}
          }, window.location.origin);
          setTimeout(() => window.close(), 2000);
        }
      </script>
    </body>
    </html>
  `;
}

//
// User info
//

export async function fetchUserInfo(
  accessToken: string,
  endpoint: string,
  mapper?: (raw: Record<string, unknown>) => UserInfo,
): Promise<UserInfo> {
  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 10_000);
    const response = await fetch(endpoint, {
      headers: { Authorization: `Bearer ${accessToken}` },
      signal: controller.signal,
    });
    clearTimeout(timeoutId);
    if (!response.ok) {
      throw new Error(`Failed to fetch user info: ${response.status}`);
    }
    const raw = await response.json();
    return mapper ? mapper(raw) : raw as UserInfo;
  } catch (error) {
    logger.error("Error fetching user info:", error);
    return { error: "Failed to fetch user info" };
  }
}

//
// Auth cell CRUD
//

export async function getAuthCell(docLink: string, schema: JSONSchema) {
  try {
    const parsedDocLink = JSON.parse(docLink);
    let authCell = runtime.getCellFromLink(parsedDocLink);
    if (!authCell.schema) authCell = authCell.asSchema(schema);
    await authCell.sync();
    await runtime.storageManager.synced();
    return authCell;
  } catch (error) {
    throw new Error(`Failed to get auth cell: ${error}`);
  }
}

// Build the vouched-ingest channel for an OAuth auth cell. Pre-grant-infra the
// channel is the cell's own space (the dedicated ingest location); the presenter
// has no DID, so audience records the generic OAuth source. Both are
// recorded-not-enforced and become real channel-space / presenter DIDs once the
// owner grant lands (vouched-ingest-channel.md).
function oauthIngestChannel(
  authCell: Awaited<ReturnType<typeof getAuthCell>>,
): VouchedChannel {
  return {
    channel: authCell.getAsNormalizedFullLink().space,
    audience: "did:web:commonfabric.org#oauth2",
  };
}

export async function persistTokens(
  tokenData: Record<string, unknown>,
  authCellDocLink: string,
  schema: JSONSchema,
) {
  try {
    const authCell = await getAuthCell(authCellDocLink, schema);
    if (!authCell) throw new Error("Auth cell not found");

    // Tokens arrive from the OAuth provider — external bytes deposited into the
    // fabric — so this is a vouched ingest: custodyIngest mints the
    // ExternalIngest mark and split-mints it safely. channel/audience are
    // recorded-not-enforced provenance; pre-grant-infra they identify the
    // ingest location and source. They become the channel-space / presenter
    // DIDs once the owner-grant lands (see vouched-ingest-channel.md).
    await custodyIngest.set(authCell, tokenData, oauthIngestChannel(authCell));

    return tokenData;
  } catch (error) {
    logger.error("Error persisting tokens:", error);
    throw new Error(`Error persisting tokens: ${error}`);
  }
}

export async function clearAuthData(
  authCellDocLink: string,
  schema: JSONSchema,
  emptyData: Record<string, unknown>,
) {
  try {
    const authCell = await getAuthCell(authCellDocLink, schema);
    if (!authCell) throw new Error("Auth cell not found");

    // Clearing tokens on logout is an operator/user action, NOT external
    // ingest — a governed durable write, but no provenance mark.
    await durableSet(authCell, emptyData);
    return emptyData;
  } catch (error) {
    logger.error("Error clearing auth data:", error);
    throw new Error(`Error clearing auth data: ${error}`);
  }
}

//
// Token mapping (generic: uses accessToken field)
//

export function tokenToGenericAuthData(
  token: Tokens | OAuth2Tokens,
): Record<string, unknown> {
  return {
    accessToken: token.accessToken,
    tokenType: token.tokenType,
    scope: token.scope,
    expiresIn: token.expiresIn,
    refreshToken: token.refreshToken,
    expiresAt: token.expiresIn
      ? Date.now() + token.expiresIn * 1000
      : undefined,
  };
}

//
// Response helpers
//

export function createCallbackResponse(
  result: Record<string, unknown>,
): Response {
  return new Response(generateCallbackHtml(result), {
    headers: {
      "Content-Type": "text/html",
      "Content-Security-Policy":
        "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'",
      "X-Content-Type-Options": "nosniff",
    },
  });
}

export function createLoginSuccessResponse(c: Context, url: string) {
  return c.json({ url }, 200);
}

export function createLoginErrorResponse(c: Context, errorMessage: string) {
  return c.json({ error: errorMessage }, 400);
}

export function createRefreshSuccessResponse(
  c: Context,
  message: string,
  tokenInfo: Record<string, unknown>,
) {
  return c.json({ success: true, message, tokenInfo }, 200);
}

export function createRefreshErrorResponse(
  c: Context,
  errorMessage: string,
  status: 400 | 401 | 500 = 400,
) {
  return c.json({ error: errorMessage }, status);
}

export function createLogoutSuccessResponse(c: Context, message: string) {
  return c.json({ success: true, message }, 200);
}

export function createLogoutErrorResponse(
  c: Context,
  errorMessage: string,
  status: 400 | 500 = 400,
) {
  return c.json({ success: false, error: errorMessage }, status);
}

//
// Provider metadata discovery (RFC 8414 / OIDC)
//

// In-memory cache: metadataUrl → discovered endpoints
const metadataCache = new Map<string, {
  authorizationEndpoint: string;
  tokenEndpoint: string;
}>();

/**
 * Fetch well-known OAuth metadata (RFC 8414 / OIDC) and return resolved
 * endpoints. Results are cached for the lifetime of the process.
 */
export async function discoverProviderConfig(metadataUrl: string): Promise<{
  authorizationEndpoint: string;
  tokenEndpoint: string;
}> {
  const cached = metadataCache.get(metadataUrl);
  if (cached) return cached;

  const response = await fetch(metadataUrl);
  if (!response.ok) {
    throw new Error(
      `Metadata discovery failed for ${metadataUrl}: ${response.status}`,
    );
  }
  const doc = await response.json();
  const result = {
    authorizationEndpoint: doc.authorization_endpoint as string,
    tokenEndpoint: doc.token_endpoint as string,
  };
  if (!result.authorizationEndpoint || !result.tokenEndpoint) {
    throw new Error(
      `Metadata document at ${metadataUrl} missing required fields`,
    );
  }
  metadataCache.set(metadataUrl, result);
  return result;
}
