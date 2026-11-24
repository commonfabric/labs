/**
 * GitHub OAuth2 provider descriptor.
 *
 * ## Setup
 *
 * 1. Go to https://github.com/settings/developers -> OAuth Apps -> New OAuth App
 * 2. Set the Authorization callback URL to:
 *      http://localhost:8000/api/integrations/github-oauth/callback
 * 3. Add to runtime/toolshed/.env:
 *      GITHUB_CLIENT_ID=<your client id>
 *      GITHUB_CLIENT_SECRET=<your client secret>
 * 4. Restart the dev servers
 */

import env from "@/env.ts";
import type { ProviderDescriptor } from "@/routes/integrations/oauth2-common/oauth2-common.types.ts";

export const GitHubDescriptor: ProviderDescriptor = {
  name: "github",
  clientId: env.GITHUB_CLIENT_ID,
  clientSecret: env.GITHUB_CLIENT_SECRET,
  authorizationEndpoint: "https://github.com/login/oauth/authorize",
  tokenEndpoint: "https://github.com/login/oauth/access_token",
  userInfoEndpoint: "https://api.github.com/user",
  userInfoMapper: (raw) => ({
    id: String(raw.id ?? ""),
    email: (raw.email as string) || "",
    name: (raw.name as string) || (raw.login as string) || "",
    picture: (raw.avatar_url as string) || "",
  }),
  defaultScopes: "read:user user:email repo",
};
