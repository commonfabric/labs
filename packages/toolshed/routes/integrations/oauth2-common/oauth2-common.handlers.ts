import type { Tokens } from "@cmd-johnson/oauth2-client";
import { OAuth2TokenSchema } from "@commonfabric/runner";
import type { JSONSchema } from "@commonfabric/runner";
import { getLogger } from "@commonfabric/utils/logger";
import type { Context } from "@hono/hono";

import type {
  CallbackResult,
  OAuth2HandlerOptions,
  OAuth2ProviderConfig,
  UserInfo,
} from "./oauth2-common.types.ts";
import {
  clearAuthData,
  createCallbackResponse,
  createLoginErrorResponse,
  createLoginSuccessResponse,
  createLogoutErrorResponse,
  createLogoutSuccessResponse,
  createOAuth2Client,
  createRefreshErrorResponse,
  createRefreshSuccessResponse,
  fetchUserInfo,
  getBaseUrl,
  persistTokens,
  tokenToGenericAuthData,
} from "./oauth2-common.utils.ts";

/**
 * Strip the `schema` field from a serialized cell-link JSON string.
 *
 * The frontend sends the full CellRef (including the JSON Schema) inside
 * `authCellId`.  The schema is large and redundant here – the callback
 * handler already receives the correct schema from the provider descriptor's
 * `authSchema` option.  Removing it keeps the OAuth `state` parameter small
 * enough for providers with strict URL-length limits (e.g. Airtable).
 *
 * This is safe because `getAuthCell()` falls back to `cell.asSchema(schema)`
 * using the separately-provided schema when the link itself has none.
 */
function stripSchemaFromCellId(authCellId: string): string {
  try {
    const parsed = JSON.parse(authCellId);
    if (parsed && typeof parsed === "object" && "schema" in parsed) {
      const { schema: _, ...rest } = parsed;
      return JSON.stringify(rest);
    }
    return authCellId;
  } catch {
    return authCellId;
  }
}

/**
 * Encode OAuth2 state as a base64 string for the `state` query parameter.
 *
 * Uses short field names and strips the bulky JSON Schema from the cell
 * reference to keep the encoded value compact (~200-400 bytes of base64).
 * This is fully stateless – no server-side store required – so it works
 * correctly when multiple server instances sit behind a load balancer.
 */
function encodeOAuthState(data: {
  authCellId: string;
  codeVerifier: string;
  scopes?: string[];
}): string {
  // Single-letter keys to minimize payload:
  // a = authCellId (schema-stripped), v = codeVerifier, s = scopes
  const compact: Record<string, unknown> = {
    a: stripSchemaFromCellId(data.authCellId),
    v: data.codeVerifier,
  };
  if (data.scopes && data.scopes.length > 0) {
    compact.s = data.scopes;
  }
  return btoa(JSON.stringify(compact));
}

/**
 * Decode an OAuth2 state string back into the original fields.
 *
 * Supports both the compact format (single-letter keys) and the legacy
 * format (full field names) for backward compatibility with any in-flight
 * OAuth flows that were started before this change was deployed.
 */
function decodeOAuthState(state: string): {
  authCellId: string;
  codeVerifier: string;
  scopes?: string[];
} | null {
  try {
    const parsed = JSON.parse(atob(state));

    // New compact format (single-letter keys)
    if (parsed.a && parsed.v) {
      return {
        authCellId: parsed.a,
        codeVerifier: parsed.v,
        scopes: parsed.s,
      };
    }

    // Legacy format (full field names)
    if (parsed.authCellId && parsed.codeVerifier) {
      return parsed as {
        authCellId: string;
        codeVerifier: string;
        scopes?: string[];
      };
    }

    return null;
  } catch {
    return null;
  }
}

const EMPTY_OAUTH2_DATA: Record<string, unknown> = {
  accessToken: "",
  tokenType: "",
  scope: [],
  expiresIn: 0,
  expiresAt: 0,
  refreshToken: "",
  user: { email: "", name: "", picture: "" },
};

/**
 * Create a set of OAuth2 route handlers for a given provider.
 *
 * Returns plain async handler functions (not Hono-typed AppRouteHandler).
 * The caller wires them to the appropriate route definitions.
 */
export function createOAuth2Handlers(
  config: OAuth2ProviderConfig,
  options: OAuth2HandlerOptions = {},
) {
  const logger = getLogger(`${config.name}-oauth`);
  const tokenMapper = options.tokenMapper ?? tokenToGenericAuthData;
  const authSchema: JSONSchema = options.authSchema ??
    (OAuth2TokenSchema as unknown as JSONSchema);
  const emptyAuthData = options.emptyAuthData ?? EMPTY_OAUTH2_DATA;

  async function login(c: Context) {
    try {
      const payload = await c.req.json();
      logger.info(`Received ${config.name} OAuth login request`, payload);

      if (!payload.authCellId) {
        logger.error("Missing authCellId in request payload");
        return createLoginErrorResponse(c, "Missing authCellId in request");
      }

      const redirectUri = `${
        getBaseUrl(c.req.url)
      }/api/integrations/${config.name}-oauth/callback`;
      const client = createOAuth2Client(config, redirectUri, payload.scopes);
      const scopeString = payload.scopes ? payload.scopes.join(" ") : undefined;

      const { uri, codeVerifier } = await client.code.getAuthorizationUri({
        scope: scopeString,
      });

      const stateParam = encodeOAuthState({
        authCellId: payload.authCellId,
        codeVerifier,
        scopes: payload.scopes,
      });

      const authUrl = new URL(uri.toString());
      authUrl.searchParams.set("state", stateParam);

      // Apply provider-specific extra params (e.g. access_type=offline)
      if (config.extraAuthParams) {
        for (const [key, value] of Object.entries(config.extraAuthParams)) {
          authUrl.searchParams.set(key, value);
        }
      }

      if (scopeString) {
        authUrl.searchParams.set("scope", scopeString);
      }

      logger.info("Generated OAuth URL", authUrl.toString());
      return createLoginSuccessResponse(c, authUrl.toString());
    } catch (error) {
      logger.error("Failed to process login request", error);
      return createLoginErrorResponse(c, "Failed to process login request");
    }
  }

  async function callback(c: Context) {
    const query = c.req.query();
    logger.info(`Received ${config.name} OAuth callback`, query);

    try {
      const { code, state, scope, error: oauthError } = query;

      if (oauthError) {
        logger.error("OAuth error received", oauthError);
        return createCallbackResponse({
          success: false,
          error: `Authentication failed: ${oauthError}`,
        });
      }

      if (!code || !state) {
        const errorMsg = !code
          ? "No authorization code received"
          : "No state parameter received";
        return createCallbackResponse({ success: false, error: errorMsg });
      }

      // Decode the base64-encoded state parameter. Supports both the new
      // compact format (single-letter keys) and the legacy format (full
      // field names) for backward compatibility.
      const decodedState = decodeOAuthState(state);

      if (!decodedState) {
        return createCallbackResponse({
          success: false,
          error: "Invalid or expired state parameter",
        });
      }

      const codeVerifier = decodedState.codeVerifier;
      if (!codeVerifier) {
        return createCallbackResponse({
          success: false,
          error: "Invalid state parameter: missing code verifier",
        });
      }

      const baseUrl = getBaseUrl(c.req.url);
      const redirectUri =
        `${baseUrl}/api/integrations/${config.name}-oauth/callback`;
      const client = createOAuth2Client(
        config,
        redirectUri,
        decodedState.scopes,
      );

      let tokens: Tokens;

      if (config.tokenAuthMethod === "basic") {
        // Some providers (e.g. Airtable) require Basic auth on the token endpoint
        const basicAuth = btoa(`${config.clientId}:${config.clientSecret}`);
        const tokenResponse = await fetch(config.tokenUri, {
          method: "POST",
          headers: {
            "Content-Type": "application/x-www-form-urlencoded",
            "Authorization": `Basic ${basicAuth}`,
          },
          body: new URLSearchParams({
            grant_type: "authorization_code",
            code,
            redirect_uri: redirectUri,
            code_verifier: codeVerifier,
          }),
        });
        if (!tokenResponse.ok) {
          const errText = await tokenResponse.text();
          logger.error(
            "Token exchange failed",
            tokenResponse.status,
            errText,
          );
          return createCallbackResponse({
            success: false,
            error: "Token exchange failed",
          });
        }
        const tokenData = await tokenResponse.json();
        tokens = {
          accessToken: tokenData.access_token,
          tokenType: tokenData.token_type ?? "Bearer",
          scope: tokenData.scope?.split(" "),
          expiresIn: tokenData.expires_in,
          refreshToken: tokenData.refresh_token,
        } as Tokens;
      } else {
        tokens = await client.code.getToken(
          new URL(`${redirectUri}?code=${code}`),
          { codeVerifier },
        );
      }

      // Fetch user info if endpoint is configured
      let userInfo: UserInfo = {};
      if (config.userInfoEndpoint) {
        userInfo = await fetchUserInfo(
          tokens.accessToken,
          config.userInfoEndpoint,
          config.userInfoMapper,
        );
      }

      // Map tokens to the auth cell data shape
      const tokenData = tokenMapper(tokens);
      if (userInfo && !userInfo.error) {
        tokenData.user = {
          email: userInfo.email || "",
          name: userInfo.name || "",
          picture: userInfo.picture || "",
        };
      }

      await persistTokens(tokenData, decodedState.authCellId, authSchema);

      const callbackResult: CallbackResult = {
        success: true,
        message: "Authentication successful",
        details: {
          state: decodedState,
          scope,
          tokenInfo: tokenData,
          userInfo,
          timestamp: new Date().toISOString(),
        },
      };
      return createCallbackResponse(callbackResult);
    } catch (error) {
      logger.error("Failed to process callback", error);
      return createCallbackResponse({
        success: false,
        error: "Failed to process callback",
      });
    }
  }

  async function refresh(c: Context) {
    try {
      const payload = await c.req.json();
      if (!payload.refreshToken) {
        return createRefreshErrorResponse(c, "No refreshToken provided");
      }
      const refreshToken: string = payload.refreshToken;

      const baseUrl = getBaseUrl(c.req.url);
      const redirectUri =
        `${baseUrl}/api/integrations/${config.name}-oauth/callback`;

      let newTokenData: Record<string, unknown>;

      if (config.tokenAuthMethod === "basic") {
        const basicAuth = btoa(`${config.clientId}:${config.clientSecret}`);
        const tokenResponse = await fetch(config.tokenUri, {
          method: "POST",
          headers: {
            "Content-Type": "application/x-www-form-urlencoded",
            "Authorization": `Basic ${basicAuth}`,
          },
          body: new URLSearchParams({
            grant_type: "refresh_token",
            refresh_token: refreshToken,
          }),
        });
        if (!tokenResponse.ok) {
          return createRefreshErrorResponse(c, "Failed to refresh token");
        }
        const raw = await tokenResponse.json();
        newTokenData = tokenMapper({
          accessToken: raw.access_token,
          tokenType: raw.token_type ?? "Bearer",
          scope: raw.scope?.split(" "),
          expiresIn: raw.expires_in,
          refreshToken: raw.refresh_token,
        });
      } else {
        const client = createOAuth2Client(config, redirectUri);
        let newToken: Tokens;
        try {
          newToken = await client.refreshToken.refresh(refreshToken);
        } catch (_error) {
          return createRefreshErrorResponse(c, "Failed to refresh token");
        }
        newTokenData = tokenMapper(newToken);
      }

      // Preserve existing refresh token if not returned
      if (!newTokenData.refreshToken) {
        newTokenData.refreshToken = refreshToken;
      }

      return createRefreshSuccessResponse(c, "success", newTokenData);
    } catch (_error) {
      return createRefreshErrorResponse(
        c,
        "Failed to process refresh request",
      );
    }
  }

  async function logout(c: Context) {
    try {
      const payload = await c.req.json();
      if (!payload.authCellId) {
        return createLogoutErrorResponse(c, "No authCellId provided", 400);
      }

      try {
        await clearAuthData(payload.authCellId, authSchema, emptyAuthData);
        return createLogoutSuccessResponse(c, "Successfully logged out");
      } catch (error: unknown) {
        const errorMessage = error instanceof Error
          ? error.message
          : String(error);
        return createLogoutErrorResponse(
          c,
          `Failed to clear authentication data: ${errorMessage}`,
          500,
        );
      }
    } catch (_error: unknown) {
      return createLogoutErrorResponse(
        c,
        "Failed to process logout request",
        400,
      );
    }
  }

  return { login, callback, refresh, logout };
}

// Re-export response helpers and utils needed by provider-specific code
export {
  createLogoutErrorResponse,
  createLogoutSuccessResponse,
} from "./oauth2-common.utils.ts";
