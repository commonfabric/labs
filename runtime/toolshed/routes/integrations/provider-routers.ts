/**
 * Builds the Hono routers for OAuth2 providers from their ProviderDescriptor
 * objects. `provider-registry.ts` holds the catalog of descriptors and wires
 * them to the server's runtime.
 */

import { getLogger } from "@commonfabric/logger";
import { cors } from "@hono/hono/cors";

import {
  createOAuth2Handlers,
  type OAuth2HandlerDeps,
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
async function createProviderRouter(
  descriptor: ProviderDescriptor,
  deps: OAuth2HandlerDeps,
) {
  if (!descriptor.clientId || !descriptor.clientSecret) {
    logger.warn(
      "Missing OAuth credentials (clientId/clientSecret), skipping provider",
      descriptor.name,
    );
    return null;
  }

  const config = await resolveProviderConfig(descriptor);
  const routes = createOAuth2Routes(descriptor.name);
  const handlers = createOAuth2Handlers(config, deps, {
    tokenMapper: descriptor.tokenMapper,
    authSchema: descriptor.authSchema,
    emptyAuthData: descriptor.emptyAuthData,
  });

  const router = createRouter();
  router.use(
    `/api/integrations/${descriptor.name}-oauth/*`,
    cors(OAUTH_CORS_CONFIG),
  );
  // The generic factory handlers return broader types than the route schemas
  // declare (e.g. Record<string, unknown> vs specific fields). We cast to the
  // route-specific handler types here; runtime behavior is correct.
  router
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

  logger.info("Registered OAuth2 provider routes", descriptor.name);

  return router;
}

//
// Public API
//

/**
 * Build routers for the given OAuth2 provider descriptors.
 *
 * Uses `Promise.allSettled` so one provider's failure doesn't block others.
 * Providers with missing credentials are silently skipped (logged as warning).
 */
export async function createProviderRouters(
  descriptors: ProviderDescriptor[],
  deps: OAuth2HandlerDeps,
) {
  const results = await Promise.allSettled(
    descriptors.map((descriptor) => createProviderRouter(descriptor, deps)),
  );

  const routers = [];
  for (let i = 0; i < results.length; i++) {
    const result = results[i];
    if (result.status === "fulfilled" && result.value) {
      routers.push(result.value);
    } else if (result.status === "rejected") {
      logger.error(
        "Failed to build provider router",
        descriptors[i].name,
        result.reason,
      );
    }
  }

  return routers;
}
