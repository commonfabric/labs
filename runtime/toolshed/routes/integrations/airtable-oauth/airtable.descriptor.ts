/**
 * Airtable OAuth2 provider descriptor.
 *
 * ## Setup
 *
 * 1. Go to https://airtable.com/create/oauth (Builder Hub -> OAuth integrations)
 * 2. Create a new integration (or edit an existing one)
 * 3. Set the OAuth redirect URL to:
 *      http://localhost:8000/api/integrations/airtable-oauth/callback
 * 4. Under "Scopes", enable at minimum:
 *      - data.records:read (see the data in records)
 *      - schema.bases:read (see the structure of a base)
 *      - user.email:read (see the user's email address)
 * 5. Generate a Client Secret (needed for server-side token exchange)
 * 6. Add to runtime/toolshed/.env:
 *      AIRTABLE_CLIENT_ID=<your client id>
 *      AIRTABLE_CLIENT_SECRET=<your client secret>
 * 7. Restart the dev servers
 *
 * Note: Airtable uses HTTP Basic auth for the token endpoint (client_id:client_secret
 * base64-encoded in the Authorization header), hence tokenAuthMethod: "basic".
 */

import env from "@/env.ts";
import type { ProviderDescriptor } from "@/routes/integrations/oauth2-common/oauth2-common.types.ts";

export const AirtableDescriptor: ProviderDescriptor = {
  name: "airtable",
  clientId: env.AIRTABLE_CLIENT_ID,
  clientSecret: env.AIRTABLE_CLIENT_SECRET,
  authorizationEndpoint: "https://airtable.com/oauth2/v1/authorize",
  tokenEndpoint: "https://airtable.com/oauth2/v1/token",
  userInfoEndpoint: "https://api.airtable.com/v0/meta/whoami",
  userInfoMapper: (raw) => ({
    id: raw.id as string,
    email: raw.email as string,
    name: (raw.email as string) || "",
  }),
  defaultScopes: "data.records:read schema.bases:read user.email:read",
  tokenAuthMethod: "basic",
};
