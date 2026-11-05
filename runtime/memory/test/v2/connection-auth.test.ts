import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";

import {
  authorizeLoopbackConnection,
  verifyConnectionAuthorization,
} from "../../v2/connection-auth.ts";
import { alice, bob, mallory } from "../principal.ts";
import {
  type ConnectionAuthFields,
  signConnectionAuth,
} from "../support/connection-auth.ts";

const now = 1_000_000;
const audience = bob.did();
const challenge = { value: "challenge:one", expiresAt: now + 60 };

const fields = (extra: ConnectionAuthFields = {}): ConnectionAuthFields => ({
  aud: audience,
  challenge: challenge.value,
  iat: now,
  exp: now + 300,
  ...extra,
});

const options = (
  extra: Partial<Parameters<typeof verifyConnectionAuthorization>[1]> = {},
) => ({ audience, challenge, nowSeconds: now, ...extra });

/** The error a verification of `fields`, signed by `alice`, is refused with. */
const refusal = async (
  invocation: ConnectionAuthFields,
  verify = options(),
): Promise<{ name: string; message: string; retriable?: boolean }> => {
  const message = await signConnectionAuth(alice, invocation);
  try {
    await verifyConnectionAuthorization(message, verify);
  } catch (error) {
    const { name, message, retriable } = error as Error & {
      retriable?: boolean;
    };
    return { name, message, ...(retriable === undefined ? {} : { retriable }) };
  }
  throw new Error("expected the verification to be refused");
};

describe("connection-auth", () => {
  describe("verifyConnectionAuthorization()", () => {
    it("returns the issuer of a signed invocation", async () => {
      const message = await signConnectionAuth(alice, fields());
      expect(await verifyConnectionAuthorization(message, options())).toBe(
        alice.did(),
      );
    });

    it("throws for an invocation naming an issuer other than its signer", async () => {
      const message = await signConnectionAuth(
        mallory,
        fields({ iss: alice.did() }),
      );
      await expect(verifyConnectionAuthorization(message, options())).rejects
        .toThrow();
    });

    it("throws for an invocation changed after it was signed", async () => {
      const message = await signConnectionAuth(alice, fields());
      message.invocation.exp = now + 10_000;
      await expect(verifyConnectionAuthorization(message, options())).rejects
        .toThrow();
    });

    it("throws an `AuthorizationError` for a message carrying no signature", async () => {
      const { invocation } = await signConnectionAuth(alice, fields());
      await expect(
        verifyConnectionAuthorization({ invocation }, options()),
      ).rejects.toThrow("memory connection.auth requires authorization");
    });

    it("throws for a signed `session.open` invocation", async () => {
      // A signature made to open one session does not authenticate the
      // connection.
      expect(await refusal(fields({ cmd: "session.open" }))).toEqual({
        name: "AuthorizationError",
        message: "memory connection.auth authorization mismatch",
      });
    });

    it("throws for an invocation of another protocol", async () => {
      expect(await refusal(fields({ args: { protocol: "other" } }))).toEqual({
        name: "AuthorizationError",
        message: "memory connection.auth authorization mismatch",
      });
    });

    it("throws a permanent error for another server's audience", async () => {
      expect(await refusal(fields({ aud: mallory.did() }))).toEqual({
        name: "AuthorizationError",
        message: "memory connection.auth audience mismatch",
      });
    });

    it("throws a retriable error for a challenge other than the one issued", async () => {
      expect(await refusal(fields({ challenge: "challenge:other" }))).toEqual({
        name: "AuthorizationError",
        message: "memory connection.auth challenge mismatch",
        retriable: true,
      });
    });

    it("throws a retriable error for a challenge that has expired", async () => {
      expect(
        await refusal(
          fields(),
          options({ challenge: { ...challenge, expiresAt: now } }),
        ),
      ).toEqual({
        name: "AuthorizationError",
        message: "memory connection.auth challenge expired",
        retriable: true,
      });
    });

    it("throws a retriable error for an `exp` further back than the clock-skew grace", async () => {
      expect(
        await refusal(
          fields({ iat: now - 1000, exp: now - 500 }),
          options({ clockSkewSeconds: 120 }),
        ),
      ).toEqual({
        name: "AuthorizationError",
        message: "memory connection.auth authorization expired",
        retriable: true,
      });
    });

    it("returns the issuer for an `exp` within the clock-skew grace", async () => {
      const message = await signConnectionAuth(
        alice,
        fields({ exp: now - 30 }),
      );
      expect(
        await verifyConnectionAuthorization(
          message,
          options({ clockSkewSeconds: 120 }),
        ),
      ).toBe(alice.did());
    });

    it("throws for an invocation with no `iat` or no `exp`", async () => {
      const { iat: _iat, ...withoutIat } = fields();
      const { exp: _exp, ...withoutExp } = fields();
      expect((await refusal(withoutIat)).message).toBe(
        "memory connection.auth requires iat",
      );
      expect((await refusal(withoutExp)).message).toBe(
        "memory connection.auth requires exp",
      );
    });
  });

  describe("authorizeLoopbackConnection()", () => {
    it("returns the issuer of a signed invocation", async () => {
      const message = await signConnectionAuth(alice, fields());
      expect(await authorizeLoopbackConnection(message, options())).toBe(
        alice.did(),
      );
    });

    it("throws for a signed invocation that does not verify", async () => {
      const message = await signConnectionAuth(
        alice,
        fields({ aud: mallory.did() }),
      );
      await expect(
        Promise.resolve().then(() =>
          authorizeLoopbackConnection(message, options())
        ),
      ).rejects.toThrow("audience mismatch");
    });

    it("returns the principal an unsigned message names", async () => {
      expect(
        await authorizeLoopbackConnection(
          { authorization: { principal: alice.did() } },
          options(),
        ),
      ).toBe(alice.did());
    });

    it("returns `undefined` for an unsigned message naming no principal", async () => {
      expect(await authorizeLoopbackConnection({}, options())).toBeUndefined();
    });
  });
});
