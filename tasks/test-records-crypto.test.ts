import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";

import {
  fromBase64url,
  toUnpaddedBase64url,
} from "@commonfabric/bytes/base64url";
import {
  generateIdentity,
  isRecipient,
  open,
  recipientFingerprint,
  seal,
} from "./test-records-crypto.ts";

describe("test-records-crypto", () => {
  describe("generateIdentity()", () => {
    it("returns a recipient the validator accepts", async () => {
      const identity = await generateIdentity();
      expect(isRecipient(identity.recipient)).toBe(true);
    });
  });

  describe("isRecipient()", () => {
    it("returns false for other prefixes and wrong lengths", () => {
      expect(isRecipient("age1qqqq")).toBe(false);
      expect(isRecipient("cfr1")).toBe(false);
      expect(isRecipient("cfr1" + toUnpaddedBase64url(new Uint8Array(31))))
        .toBe(
          false,
        );
    });
  });

  describe("recipientFingerprint()", () => {
    it("returns thirty-two hex digits, stable per recipient", async () => {
      const identity = await generateIdentity();
      const first = await recipientFingerprint(identity.recipient);
      expect(first).toMatch(/^[0-9a-f]{32}$/);
      expect(await recipientFingerprint(identity.recipient)).toBe(first);
    });

    it("returns different fingerprints for different recipients", async () => {
      const a = await generateIdentity();
      const b = await generateIdentity();
      expect(await recipientFingerprint(a.recipient)).not.toBe(
        await recipientFingerprint(b.recipient),
      );
    });
  });

  describe("seal()", () => {
    it("round-trips plaintext through open()", async () => {
      const identity = await generateIdentity();
      const plaintext = new TextEncoder().encode(
        '{"client_email":"test-records-gh-octocat@x","cf_username":"octocat"}',
      );
      const box = await seal(identity.recipient, plaintext);
      expect(await open(identity, box)).toEqual(plaintext);
    });

    it("throws for a malformed recipient", async () => {
      await expect(seal("not-a-recipient", new Uint8Array(1))).rejects
        .toThrow();
    });
  });

  describe("open()", () => {
    it("rejects a box sealed to someone else", async () => {
      const alice = await generateIdentity();
      const mallory = await generateIdentity();
      const box = await seal(alice.recipient, new Uint8Array([1, 2, 3]));
      await expect(open(mallory, box)).rejects.toThrow();
    });

    it("rejects a tampered ciphertext", async () => {
      const identity = await generateIdentity();
      const box = await seal(identity.recipient, new Uint8Array([9, 9, 9]));
      const bytes = fromBase64url(box.ct);
      bytes[0]! ^= 0xff;
      const tampered = { ...box, ct: toUnpaddedBase64url(bytes) };
      await expect(open(identity, tampered)).rejects.toThrow();
    });
  });
});
