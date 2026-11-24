import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { assert } from "@std/assert";
import { encodeBase64 } from "@std/encoding/base64";

import {
  importRsaSigningKey,
  saAssertion,
  type ServiceAccountKey,
} from "./gcp-auth.ts";

async function generateKey(): Promise<
  { key: ServiceAccountKey; publicKey: CryptoKey }
> {
  const pair = await crypto.subtle.generateKey(
    {
      name: "RSASSA-PKCS1-v1_5",
      modulusLength: 2048,
      publicExponent: new Uint8Array([1, 0, 1]),
      hash: "SHA-256",
    },
    true,
    ["sign", "verify"],
  );
  const der = new Uint8Array(
    await crypto.subtle.exportKey("pkcs8", pair.privateKey),
  );
  const pem = `-----BEGIN PRIVATE KEY-----\n${encodeBase64(der)}\n` +
    "-----END PRIVATE KEY-----\n";
  return {
    key: {
      client_email: "signer@example.iam.gserviceaccount.com",
      private_key: pem,
      token_uri: "https://oauth2.example/token",
    },
    publicKey: pair.publicKey,
  };
}

function b64Decode(pem: string): Uint8Array {
  return Uint8Array.from(
    atob(pem.replace(/-----[^-]+-----/g, "").replace(/\s+/g, "")),
    (c) => c.charCodeAt(0),
  );
}

function b64urlDecode(text: string): Uint8Array {
  const padded = text.replaceAll("-", "+").replaceAll("_", "/") +
    "=".repeat((4 - text.length % 4) % 4);
  return Uint8Array.from(atob(padded), (c) => c.charCodeAt(0));
}

describe("gcp-auth", () => {
  describe("importRsaSigningKey()", () => {
    it("imports a PKCS#1 key as one that signs like the same key in PKCS#8", async () => {
      const { key, publicKey } = await generateKey();
      const pkcs8 = b64Decode(key.private_key);
      // A 2048-bit key's PKCS#8 structure carries its PKCS#1 key after a
      // 26-byte header, the last four bytes of which open its octet string.
      expect(Array.from(pkcs8.slice(22, 24))).toEqual([0x04, 0x82]);
      const pkcs1 = `-----BEGIN RSA PRIVATE KEY-----\n${
        encodeBase64(pkcs8.slice(26))
      }\n-----END RSA PRIVATE KEY-----\n`;
      const data = new TextEncoder().encode("signed");
      const signature = await crypto.subtle.sign(
        "RSASSA-PKCS1-v1_5",
        await importRsaSigningKey(pkcs1),
        data,
      );
      expect(
        await crypto.subtle.verify(
          "RSASSA-PKCS1-v1_5",
          publicKey,
          signature,
          data,
        ),
      ).toBe(true);
    });

    it("rejects text that is not a PEM RSA private key", async () => {
      await expect(importRsaSigningKey("not a key")).rejects.toThrow(
        "expected a PEM RSA private key",
      );
    });
  });

  describe("saAssertion()", () => {
    it("returns a JWT whose signature verifies with the public key", async () => {
      const { key, publicKey } = await generateKey();
      const jwt = await saAssertion(key, 1_755_000_000, "scope-under-test");
      const [head, body, signature] = jwt.split(".");
      assert(head && body && signature);
      const verified = await crypto.subtle.verify(
        "RSASSA-PKCS1-v1_5",
        publicKey,
        b64urlDecode(signature) as BufferSource,
        new TextEncoder().encode(`${head}.${body}`),
      );
      expect(verified).toBe(true);
    });

    it("claims the given scope, audience, and hour-long validity", async () => {
      const { key } = await generateKey();
      const jwt = await saAssertion(key, 1_755_000_000, "scope-under-test");
      const body = JSON.parse(
        new TextDecoder().decode(b64urlDecode(jwt.split(".")[1]!)),
      );
      expect(body).toEqual({
        iss: "signer@example.iam.gserviceaccount.com",
        scope: "scope-under-test",
        aud: "https://oauth2.example/token",
        iat: 1_755_000_000,
        exp: 1_755_003_600,
      });
    });
  });
});
