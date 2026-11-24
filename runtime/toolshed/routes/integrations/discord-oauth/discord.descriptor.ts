/**
 * Discord OAuth2 provider descriptor.
 *
 * ## Setup
 *
 * 1. Go to https://discord.com/developers/applications -> New Application
 * 2. Under OAuth2, add the redirect URL:
 *      http://localhost:8000/api/integrations/discord-oauth/callback
 * 3. Add to runtime/toolshed/.env:
 *      DISCORD_CLIENT_ID=<your client id>
 *      DISCORD_CLIENT_SECRET=<your client secret>
 * 4. Restart the dev servers
 */

import env from "@/env.ts";
import type { ProviderDescriptor } from "@/routes/integrations/oauth2-common/oauth2-common.types.ts";

export const DiscordDescriptor: ProviderDescriptor = {
  name: "discord",
  clientId: env.DISCORD_CLIENT_ID,
  clientSecret: env.DISCORD_CLIENT_SECRET,
  authorizationEndpoint: "https://discord.com/oauth2/authorize",
  tokenEndpoint: "https://discord.com/api/oauth2/token",
  userInfoEndpoint: "https://discord.com/api/users/@me",
  userInfoMapper: (raw) => ({
    id: (raw.id as string) || "",
    email: (raw.email as string) || "",
    name: (raw.username as string) || "",
    picture: raw.avatar
      ? `https://cdn.discordapp.com/avatars/${raw.id}/${raw.avatar}.png`
      : "",
  }),
  defaultScopes: "identify email guilds",
};
