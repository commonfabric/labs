/**
 * Notion OAuth2 provider descriptor.
 *
 * ## Setup
 *
 * 1. Go to https://www.notion.so/my-integrations -> Create new integration
 * 2. Under "Distribution", enable "Public integration"
 * 3. Set the OAuth redirect URI to:
 *      http://localhost:8000/api/integrations/notion-oauth/callback
 * 4. Add to runtime/toolshed/.env:
 *      NOTION_CLIENT_ID=<your OAuth client ID>
 *      NOTION_CLIENT_SECRET=<your OAuth client secret>
 * 5. Restart the dev servers
 *
 * Note: Notion requires HTTP Basic auth for the token endpoint and does not
 * use scopes — capabilities are configured in the integration dashboard.
 * Notion embeds owner info in the token response; we extract it via tokenMapper.
 */

import env from "@/env.ts";
import type { ProviderDescriptor } from "@/routes/integrations/oauth2-common/oauth2-common.types.ts";

export const NotionDescriptor: ProviderDescriptor = {
  name: "notion",
  clientId: env.NOTION_CLIENT_ID,
  clientSecret: env.NOTION_CLIENT_SECRET,
  authorizationEndpoint: "https://api.notion.com/v1/oauth/authorize",
  tokenEndpoint: "https://api.notion.com/v1/oauth/token",
  defaultScopes: "",
  tokenAuthMethod: "basic",
  extraAuthParams: { owner: "user" },
};
