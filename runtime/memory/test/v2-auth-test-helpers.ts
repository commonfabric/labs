import type { SessionOpenAuthFactory } from "../v2/client.ts";

export const TEST_SESSION_OPEN_AUDIENCE =
  "did:key:z6Mk-memory-v2-test-audience";
export const TEST_SESSION_OPEN_PRINCIPAL =
  "did:key:z6Mk-memory-v2-test-principal";

export const testSessionOpenAuth = {
  audience: TEST_SESSION_OPEN_AUDIENCE,
} as const;

export const testAuthorizeSessionOpen = () => TEST_SESSION_OPEN_PRINCIPAL;

export const testSessionOpenServerOptions = {
  authorizeSessionOpen: testAuthorizeSessionOpen,
  sessionOpenAuth: testSessionOpenAuth,
} as const;

export const testSessionOpenAuthFactory: SessionOpenAuthFactory = (
  _space,
  _session,
  context,
) => {
  return {
    invocation: {
      aud: context.audience,
      challenge: context.challenge.value,
    },
    authorization: {},
  };
};
