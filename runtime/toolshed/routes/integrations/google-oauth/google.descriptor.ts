/**
 * Google OAuth2 provider descriptor.
 *
 * Google uses the legacy `token` field (not `accessToken`) for backward
 * compatibility with existing consuming patterns. The custom tokenMapper
 * and emptyAuthData handle this.
 */

import { AuthSchema } from "@commonfabric/runner";
import type { JSONSchema } from "@commonfabric/runner";

import env from "@/env.ts";
import type {
  OAuth2Tokens,
  ProviderDescriptor,
} from "@/routes/integrations/oauth2-common/oauth2-common.types.ts";

function tokenToAuthData(
  token: OAuth2Tokens,
): Record<string, unknown> {
  return {
    token: token.accessToken, // "token" not "accessToken" — legacy field name
    tokenType: token.tokenType,
    scope: token.scope,
    expiresIn: token.expiresIn,
    refreshToken: token.refreshToken,
    expiresAt: token.expiresIn
      ? Date.now() + token.expiresIn * 1000
      : undefined,
  };
}

const EMPTY_GOOGLE_AUTH_DATA = {
  token: "",
  tokenType: "",
  scope: [],
  expiresIn: 0,
  expiresAt: 0,
  refreshToken: "",
  user: { email: "", name: "", picture: "" },
};

export const GoogleDescriptor: ProviderDescriptor = {
  name: "google",
  clientId: env.GOOGLE_CLIENT_ID,
  clientSecret: env.GOOGLE_CLIENT_SECRET,
  authorizationEndpoint: "https://accounts.google.com/o/oauth2/v2/auth",
  tokenEndpoint: "https://oauth2.googleapis.com/token",
  userInfoEndpoint: "https://www.googleapis.com/oauth2/v2/userinfo",
  defaultScopes:
    "email profile https://www.googleapis.com/auth/gmail.readonly https://www.googleapis.com/auth/calendar.readonly",
  extraAuthParams: {
    access_type: "offline",
    prompt: "consent",
  },
  tokenMapper: tokenToAuthData,
  authSchema: AuthSchema as unknown as JSONSchema,
  emptyAuthData: EMPTY_GOOGLE_AUTH_DATA,
};
