/**
 * Strava OAuth2 provider descriptor.
 *
 * ## Setup
 *
 * 1. Go to https://www.strava.com/settings/api -> Create Application
 * 2. Set the Authorization Callback Domain to match your dev server
 *    (e.g., localhost for local dev)
 * 3. Add to runtime/toolshed/.env:
 *      STRAVA_CLIENT_ID=<your client id>
 *      STRAVA_CLIENT_SECRET=<your client secret>
 * 4. Restart the dev servers
 *
 * Note: Strava uses comma-separated scopes (not space-separated).
 */

import env from "@/env.ts";
import type { ProviderDescriptor } from "@/routes/integrations/oauth2-common/oauth2-common.types.ts";

export const StravaDescriptor: ProviderDescriptor = {
  name: "strava",
  clientId: env.STRAVA_CLIENT_ID,
  clientSecret: env.STRAVA_CLIENT_SECRET,
  authorizationEndpoint: "https://www.strava.com/oauth/authorize",
  tokenEndpoint: "https://www.strava.com/oauth/token",
  userInfoEndpoint: "https://www.strava.com/api/v3/athlete",
  userInfoMapper: (raw) => ({
    id: String(raw.id ?? ""),
    email: (raw.email as string) || "",
    name: `${(raw.firstname as string) || ""} ${(raw.lastname as string) || ""}`
      .trim(),
    picture: (raw.profile as string) || "",
  }),
  defaultScopes: "read,activity:read_all,profile:read_all",
};
