/**
 * Spotify OAuth2 provider descriptor.
 *
 * ## Setup
 *
 * 1. Go to https://developer.spotify.com/dashboard -> Create App
 * 2. Set the Redirect URI to:
 *      http://localhost:8000/api/integrations/spotify-oauth/callback
 * 3. Add to runtime/toolshed/.env:
 *      SPOTIFY_CLIENT_ID=<your client id>
 *      SPOTIFY_CLIENT_SECRET=<your client secret>
 * 4. Restart the dev servers
 *
 * Note: Spotify requires HTTP Basic auth for the token endpoint.
 */

import env from "@/env.ts";
import type { ProviderDescriptor } from "@/routes/integrations/oauth2-common/oauth2-common.types.ts";

export const SpotifyDescriptor: ProviderDescriptor = {
  name: "spotify",
  clientId: env.SPOTIFY_CLIENT_ID,
  clientSecret: env.SPOTIFY_CLIENT_SECRET,
  authorizationEndpoint: "https://accounts.spotify.com/authorize",
  tokenEndpoint: "https://accounts.spotify.com/api/token",
  userInfoEndpoint: "https://api.spotify.com/v1/me",
  userInfoMapper: (raw) => ({
    id: (raw.id as string) || "",
    email: (raw.email as string) || "",
    name: (raw.display_name as string) || "",
    picture: ((raw.images as Array<{ url: string }>)?.[0]?.url as string) || "",
  }),
  defaultScopes:
    "user-read-private user-read-email user-library-read playlist-read-private",
  tokenAuthMethod: "basic",
};
