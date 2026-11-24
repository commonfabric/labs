/**
 * Linear OAuth2 provider descriptor.
 *
 * ## Setup
 *
 * 1. Go to https://linear.app/settings/api -> OAuth Applications -> New
 * 2. Set the callback URL to:
 *      http://localhost:8000/api/integrations/linear-oauth/callback
 * 3. Add to runtime/toolshed/.env:
 *      LINEAR_CLIENT_ID=<your client id>
 *      LINEAR_CLIENT_SECRET=<your client secret>
 * 4. Restart the dev servers
 *
 * Note: Linear's user info requires a GraphQL POST to /graphql which the
 * common handler doesn't support, so userInfoEndpoint is omitted for now.
 */

import env from "@/env.ts";
import type { ProviderDescriptor } from "@/routes/integrations/oauth2-common/oauth2-common.types.ts";

export const LinearDescriptor: ProviderDescriptor = {
  name: "linear",
  clientId: env.LINEAR_CLIENT_ID,
  clientSecret: env.LINEAR_CLIENT_SECRET,
  authorizationEndpoint: "https://linear.app/oauth/authorize",
  tokenEndpoint: "https://api.linear.app/oauth/token",
  defaultScopes: "read write",
};
