import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { assert } from "@std/assert";
import { encodeBase64 } from "@std/encoding/base64";

import { saAssertion, type ServiceAccountKey } from "./gcp-auth.ts";

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

function b64urlDecode(text: string): Uint8Array {
  const padded = text.replaceAll("-", "+").replaceAll("_", "/") +
    "=".repeat((4 - text.length % 4) % 4);
  return Uint8Array.from(atob(padded), (c) => c.charCodeAt(0));
}

describe("gcp-auth", () => {
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
