import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";

import {
  AUTH_METHOD_KEYFILE,
  AUTH_METHOD_PASSKEY,
  AUTH_METHOD_PASSPHRASE,
} from "../src/lib/credentials.ts";
import {
  availableAuthMethods,
  LOOM_PAIRING,
  methodsForFlow,
  storedCredentialLabel,
} from "../src/lib/login-methods.ts";

describe("login-methods", () => {
  describe("availableAuthMethods()", () => {
    it("returns passkeys first where WebAuthn is present away from `localhost`", () => {
      expect(availableAuthMethods("shell.test", true)).toEqual([
        AUTH_METHOD_PASSKEY,
        AUTH_METHOD_PASSPHRASE,
        AUTH_METHOD_KEYFILE,
      ]);
    });

    it("returns no passkeys on `localhost`, or without WebAuthn", () => {
      for (
        const [hostname, hasWebAuthn] of [
          ["localhost", true],
          ["shell.test", false],
        ] as const
      ) {
        expect(availableAuthMethods(hostname, hasWebAuthn)).toEqual([
          AUTH_METHOD_PASSPHRASE,
          AUTH_METHOD_KEYFILE,
        ]);
      }
    });
  });

  describe("methodsForFlow()", () => {
    const available = [AUTH_METHOD_PASSPHRASE, AUTH_METHOD_KEYFILE];

    it("returns Loom pairing after the available methods for login", () => {
      expect(methodsForFlow("login", available)).toEqual([
        AUTH_METHOD_PASSPHRASE,
        AUTH_METHOD_KEYFILE,
        LOOM_PAIRING,
      ]);
    });

    it("returns only the available methods for registration", () => {
      expect(methodsForFlow("register", available)).toEqual(available);
    });
  });

  describe("storedCredentialLabel()", () => {
    it("returns a passphrase's kind alone", () => {
      expect(
        storedCredentialLabel({
          id: "0f6b1a52-55d6-4f53-9d3b-8a7c1e2d3f40",
          method: AUTH_METHOD_PASSPHRASE,
        }),
      ).toBe("Passphrase");
    });

    it("returns the last eight characters of a key file's DID", () => {
      expect(
        storedCredentialLabel({
          id: "did:key:z6MkABCDEFGH",
          method: AUTH_METHOD_KEYFILE,
        }),
      ).toBe("Imported Key (ABCDEFGH)");
    });

    it("returns the last four characters of a passkey's id", () => {
      expect(
        storedCredentialLabel({ id: "AQIDBA", method: AUTH_METHOD_PASSKEY }),
      ).toBe("Passkey (IDBA)");
    });
  });
});
