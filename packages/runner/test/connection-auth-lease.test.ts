import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { Identity } from "@commonfabric/identity";
import {
  MAX_ROUTED_LEASE_SECONDS,
  readRoutedBase64,
  readRoutedStatement,
  ROUTED_CHALLENGE_SECONDS,
} from "@commonfabric/memory/v2/routed-wire";
import {
  CONNECTION_AUTH_LEASE_SECONDS,
  createSignedConnectionAuth,
} from "../src/storage/v2-remote-session.ts";

describe("signed connection auth leases", () => {
  it("asks a router for ten minutes and a direct server for an hour", async () => {
    const signer = await Identity.fromPassphrase("connection-auth-lease");
    const now = Math.floor(Date.now() / 1000);
    // A challenge issued thirty seconds ago: the router received the
    // statement no earlier than that, so its lease runs ten minutes from it.
    const challenge = { value: "11".repeat(32), expiresAt: now + 30 };
    const routed = await createSignedConnectionAuth(signer, {
      audience: signer.did(),
      deployment: "lease-test",
      challenge,
    });
    const { iat, exp } = await readRoutedStatement(
      readRoutedBase64((routed as unknown as { statement: string }).statement),
    );
    // A router refuses an hour's lease for good, so this SDK must ship before
    // a router that enforces ten minutes.
    expect(exp).toBe(
      challenge.expiresAt - ROUTED_CHALLENGE_SECONDS + MAX_ROUTED_LEASE_SECONDS,
    );
    expect(exp - iat).toBeLessThanOrEqual(MAX_ROUTED_LEASE_SECONDS);
    const direct = await createSignedConnectionAuth(signer, {
      audience: signer.did(),
      challenge,
    });
    const { invocation } = direct as unknown as {
      invocation: { iat: number; exp: number };
    };
    expect(invocation.exp - invocation.iat).toBe(CONNECTION_AUTH_LEASE_SECONDS);
    expect(CONNECTION_AUTH_LEASE_SECONDS).toBe(3600);
  });
});
