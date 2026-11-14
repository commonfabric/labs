import { describeFailure } from "@commonfabric/js-values/describe-failure";
import { OAuth2TokenSchema } from "@commonfabric/runner";
import type { JSONSchema, Runtime } from "@commonfabric/runner";
import { getLogger } from "@commonfabric/logger";
import type { Context } from "@hono/hono";

import type {
  CallbackResult,
  OAuth2HandlerOptions,
  OAuth2ProviderConfig,
  OAuth2Tokens,
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
  const { schema: _, ...rest } = JSON.parse(authCellId);
  return JSON.stringify(rest);
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
 * Decode an OAuth2 state string back into the original fields, or return
 * `null` when it is not a state `encodeOAuthState()` produced.
 */
function decodeOAuthState(state: string): {
  authCellId: string;
  codeVerifier: string;
  scopes?: string[];
} | null {
  try {
    const parsed = JSON.parse(atob(state));
    if (!parsed.a || !parsed.v) return null;
    return { authCellId: parsed.a, codeVerifier: parsed.v, scopes: parsed.s };
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

export interface OAuth2HandlerDeps {
  /** The runtime the auth cells are read and written through. */
  runtime: () => Runtime;
}

/**
 * Create a set of OAuth2 route handlers for a given provider.
 *
 * Returns plain async handler functions (not Hono-typed AppRouteHandler).
 * The caller wires them to the appropriate route definitions.
 */
export function createOAuth2Handlers(
  config: OAuth2ProviderConfig,
  deps: OAuth2HandlerDeps,
  options: OAuth2HandlerOptions = {},
) {
  const logger = getLogger(`${config.name}-oauth`);
  const tokenMapper = options.tokenMapper ?? tokenToGenericAuthData;
  const authSchema: JSONSchema = options.authSchema ?? OAuth2TokenSchema;
  const emptyAuthData = options.emptyAuthData ?? EMPTY_OAUTH2_DATA;

  function redirectUriFor(c: Context): string {
    return `${
      getBaseUrl(c.req.url)
    }/api/integrations/${config.name}-oauth/callback`;
  }

  // Requests tokens from the provider's token endpoint with HTTP Basic client
  // authentication, for providers configured with `tokenAuthMethod: "basic"`.
  async function requestBasicTokens(
    params: Record<string, string>,
  ): Promise<OAuth2Tokens> {
    const response = await fetch(config.tokenUri, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        "Authorization": `Basic ${
          btoa(`${config.clientId}:${config.clientSecret}`)
        }`,
      },
      body: new URLSearchParams(params),
    });
    if (!response.ok) {
      throw new Error(
        `Token request failed: ${response.status} ${await response.text()}`,
      );
    }
    const raw = await response.json();
    return {
      accessToken: raw.access_token,
      tokenType: raw.token_type ?? "Bearer",
      scope: raw.scope?.split(" "),
      expiresIn: raw.expires_in,
      refreshToken: raw.refresh_token,
    };
  }

  async function login(c: Context) {
    try {
      const payload = await c.req.json();
      logger.info(`Received ${config.name} OAuth login request`, payload);

      if (!payload.authCellId) {
        logger.error("Missing authCellId in request payload");
        return createLoginErrorResponse(c, "Missing authCellId in request");
      }

      const client = createOAuth2Client(
        config,
        redirectUriFor(c),
        payload.scopes,
      );
      const { uri, codeVerifier } = await client.code.getAuthorizationUri();

      uri.searchParams.set(
        "state",
        encodeOAuthState({
          authCellId: payload.authCellId,
          codeVerifier,
          scopes: payload.scopes,
        }),
      );
      for (const [key, value] of Object.entries(config.extraAuthParams ?? {})) {
        uri.searchParams.set(key, value);
      }

      logger.info("Generated OAuth URL", uri.toString());
      return createLoginSuccessResponse(c, uri.toString());
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

      const decodedState = decodeOAuthState(state);
      if (!decodedState) {
        return createCallbackResponse({
          success: false,
          error: "Invalid or expired state parameter",
        });
      }

      const { codeVerifier } = decodedState;
      const redirectUri = redirectUriFor(c);

      let tokens: OAuth2Tokens;
      try {
        tokens = config.tokenAuthMethod === "basic"
          ? await requestBasicTokens({
            grant_type: "authorization_code",
            code,
            redirect_uri: redirectUri,
            code_verifier: codeVerifier,
          })
          : await createOAuth2Client(config, redirectUri, decodedState.scopes)
            .code.getToken(
              `${redirectUri}?code=${encodeURIComponent(code)}`,
              { codeVerifier },
            );
      } catch (error) {
        logger.error("Token exchange failed", error);
        return createCallbackResponse({
          success: false,
          error: "Token exchange failed",
        });
      }

      const userInfo: UserInfo = config.userInfoEndpoint
        ? await fetchUserInfo(
          tokens.accessToken,
          config.userInfoEndpoint,
          config.userInfoMapper,
        )
        : {};

      // Map tokens to the auth cell data shape
      const tokenData = tokenMapper(tokens);
      if (!userInfo.error) {
        tokenData.user = {
          email: userInfo.email || "",
          name: userInfo.name || "",
          picture: userInfo.picture || "",
        };
      }

      await persistTokens(
        deps.runtime(),
        tokenData,
        decodedState.authCellId,
        authSchema,
      );

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

      let tokens: OAuth2Tokens;
      try {
        tokens = config.tokenAuthMethod === "basic"
          ? await requestBasicTokens({
            grant_type: "refresh_token",
            refresh_token: refreshToken,
          })
          : await createOAuth2Client(config, redirectUriFor(c)).refreshToken
            .refresh(refreshToken);
      } catch (error) {
        logger.error("Token refresh failed", error);
        return createRefreshErrorResponse(c, "Failed to refresh token");
      }

      const newTokenData = tokenMapper(tokens);
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
        await clearAuthData(
          deps.runtime(),
          payload.authCellId,
          authSchema,
          emptyAuthData,
        );
        return createLogoutSuccessResponse(c, "Successfully logged out");
      } catch (error: unknown) {
        const errorMessage = describeFailure(error);
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
