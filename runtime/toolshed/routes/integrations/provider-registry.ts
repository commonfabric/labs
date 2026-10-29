/**
 * OAuth2 Provider Registry
 *
 * Auto-wires OAuth2 provider routes from ProviderDescriptor objects,
 * replacing per-provider boilerplate (handlers.ts, routes.ts, index.ts).
 *
 * To add a new OAuth2 provider, create a descriptor in its own directory
 * (see airtable.descriptor.ts or google.descriptor.ts for examples) and
 * add it to the DESCRIPTORS array below.
 *
 * Note: Plaid uses a non-standard OAuth flow and remains a manual import
 * in app.ts.
 */

import { getLogger } from "@commonfabric/utils/logger";
import { cors } from "@hono/hono/cors";

import { AirtableDescriptor } from "./airtable-oauth/airtable.descriptor.ts";
import { DiscordDescriptor } from "./discord-oauth/discord.descriptor.ts";
import { GitHubDescriptor } from "./github-oauth/github.descriptor.ts";
import { GoogleDescriptor } from "./google-oauth/google.descriptor.ts";
import { LinearDescriptor } from "./linear-oauth/linear.descriptor.ts";
import { NotionDescriptor } from "./notion-oauth/notion.descriptor.ts";
import {
  createOAuth2Handlers,
} from "./oauth2-common/oauth2-common.handlers.ts";
import {
  createOAuth2Routes,
  type OAuth2CallbackRoute,
  type OAuth2LoginRoute,
  type OAuth2LogoutRoute,
  type OAuth2RefreshRoute,
} from "./oauth2-common/oauth2-common.routes.ts";
import type {
  OAuth2ProviderConfig,
  ProviderDescriptor,
} from "./oauth2-common/oauth2-common.types.ts";
import { discoverProviderConfig } from "./oauth2-common/oauth2-common.utils.ts";
import { SpotifyDescriptor } from "./spotify-oauth/spotify.descriptor.ts";
import { StravaDescriptor } from "./strava-oauth/strava.descriptor.ts";
import { createRouter } from "@/lib/create-app.ts";
import type { AppRouteHandler } from "@/lib/types.ts";

const logger = getLogger("provider-registry");

//
// Shared CORS configuration for all OAuth2 provider routes
//

const OAUTH_CORS_CONFIG = {
  origin: "*",
  allowMethods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
  allowHeaders: ["Content-Type", "Authorization"],
  exposeHeaders: ["Content-Length", "X-Disk-Cache"],
  maxAge: 3600,
  credentials: true,
};

//
// Descriptor catalog — add new OAuth2 providers here
//

const DESCRIPTORS: ProviderDescriptor[] = [
  GoogleDescriptor,
  AirtableDescriptor,
  GitHubDescriptor,
  NotionDescriptor,
  LinearDescriptor,
  SpotifyDescriptor,
  DiscordDescriptor,
  StravaDescriptor,
];

//
// Descriptor → OAuth2ProviderConfig
//

/**
 * Resolve a ProviderDescriptor to a fully populated OAuth2ProviderConfig.
 * If endpoints are missing, attempts RFC 8414 metadata discovery.
 */
async function resolveProviderConfig(
  descriptor: ProviderDescriptor,
): Promise<OAuth2ProviderConfig> {
  let authorizationEndpoint = descriptor.authorizationEndpoint;
  let tokenEndpoint = descriptor.tokenEndpoint;

  if ((!authorizationEndpoint || !tokenEndpoint) && descriptor.metadataUrl) {
    logger.info(
      "Discovering OAuth2 endpoints from metadata",
      descriptor.name,
      descriptor.metadataUrl,
    );
    const discovered = await discoverProviderConfig(descriptor.metadataUrl);
    authorizationEndpoint = authorizationEndpoint ??
      discovered.authorizationEndpoint;
    tokenEndpoint = tokenEndpoint ?? discovered.tokenEndpoint;
  }

  if (!authorizationEndpoint || !tokenEndpoint) {
    throw new Error(
      `Provider "${descriptor.name}": missing authorizationEndpoint or tokenEndpoint ` +
        `and no metadataUrl for discovery`,
    );
  }

  return {
    name: descriptor.name,
    clientId: descriptor.clientId,
    clientSecret: descriptor.clientSecret,
    authorizationEndpointUri: authorizationEndpoint,
    tokenUri: tokenEndpoint,
    userInfoEndpoint: descriptor.userInfoEndpoint,
    userInfoMapper: descriptor.userInfoMapper,
    defaultScopes: descriptor.defaultScopes,
    extraAuthParams: descriptor.extraAuthParams,
    tokenAuthMethod: descriptor.tokenAuthMethod,
  };
}

//
// Single-provider router factory
//

/**
 * Create a fully wired Hono router for a single OAuth2 provider.
 * Returns `null` if credentials are missing (logs a warning).
 */
async function createProviderRouter(descriptor: ProviderDescriptor) {
  if (!descriptor.clientId || !descriptor.clientSecret) {
    logger.warn(
      "Missing OAuth credentials (clientId/clientSecret), skipping provider",
      descriptor.name,
    );
    return null;
  }

  const config = await resolveProviderConfig(descriptor);
  const routes = createOAuth2Routes(descriptor.name);
  const handlers = createOAuth2Handlers(config, {
    tokenMapper: descriptor.tokenMapper,
    authSchema: descriptor.authSchema,
    emptyAuthData: descriptor.emptyAuthData,
  });

  // The generic factory handlers return broader types than the route schemas
  // declare (e.g. Record<string, unknown> vs specific fields). We cast to the
  // route-specific handler types here; runtime behavior is correct.
  const router = createRouter()
    .openapi(routes.login, handlers.login as AppRouteHandler<OAuth2LoginRoute>)
    .openapi(
      routes.callback,
      handlers.callback as AppRouteHandler<OAuth2CallbackRoute>,
    )
    .openapi(
      routes.refresh,
      handlers.refresh as AppRouteHandler<OAuth2RefreshRoute>,
    )
    .openapi(
      routes.logout,
      handlers.logout as AppRouteHandler<OAuth2LogoutRoute>,
    );

  router.use(
    `/api/integrations/${descriptor.name}-oauth/*`,
    cors(OAUTH_CORS_CONFIG),
  );

  logger.info("Registered OAuth2 provider routes", descriptor.name);

  return router;
}

//
// Public API
//

/**
 * Build routers for all registered OAuth2 provider descriptors.
 *
 * Uses `Promise.allSettled` so one provider's failure doesn't block others.
 * Providers with missing credentials are silently skipped (logged as warning).
 */
export async function buildProviderRouters() {
  const results = await Promise.allSettled(
    DESCRIPTORS.map((descriptor) => createProviderRouter(descriptor)),
  );

  const routers = [];
  for (let i = 0; i < results.length; i++) {
    const result = results[i];
    if (result.status === "fulfilled" && result.value) {
      routers.push(result.value);
    } else if (result.status === "rejected") {
      logger.error(
        "Failed to build provider router",
        DESCRIPTORS[i].name,
        result.reason,
      );
    }
  }

  return routers;
}

export { DESCRIPTORS };
