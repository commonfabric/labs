import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";

import { Identity } from "@commonfabric/identity";
import { encode } from "@commonfabric/utils/encoding";

import { cf, checkStderr } from "./utils.ts";

const PKCS8_KEY = `-----BEGIN PRIVATE KEY-----
MMC4CAQAwBQYDK2VwBCIEICWSvx4QOW+mogjWSsjInQaPpmjErsDBqf2ZOoK+Y4IO
-----END PRIVATE KEY-----`;
const PKCS8_KEY_DID =
  "did:key:z6MkspRA3aXp7T1GmTo92Q33EV33oJSNDzaoKkFUV5WkW9NC";

// DID from an identity derived from the passphrase "example passphrase"
const EXAMPLE_PASSPHRASE_DID =
  "did:key:z6MkkB8nsWvJhu3d4CBhhcEuHvDEYmtAWJTgBVmDPaR8iJXj";

// Canonical BIP-39 all-zero-entropy 24-word test vector, and the DID that
// `Identity.fromMnemonic` (the browser's mnemonic login path) produces from it.
const TEST_MNEMONIC =
  "abandon abandon abandon abandon abandon abandon abandon abandon abandon " +
  "abandon abandon abandon abandon abandon abandon abandon abandon abandon " +
  "abandon abandon abandon abandon abandon art";
const TEST_MNEMONIC_DID =
  "did:key:z6MkiTBz1ymuepAQ4HEHYSF1H8quG5GLVVQR3djdX3mDooWp";

describe("cli id", () => {
  it("Creates a new key", async () => {
    const { code, stdout, stderr } = await cf("id new");
    const keyBuffer = encode(stdout.join("\n"));
    await Identity.fromPkcs8(keyBuffer);
    expect(code).toBe(0);
    checkStderr(stderr);
  });

  it("Reads DID from key", async () => {
    const temp = await Deno.makeTempFile();
    await Deno.writeFile(temp, encode(PKCS8_KEY));
    const { code, stdout, stderr } = await cf(`id did ${temp}`);
    const did = stdout.join("\n");
    expect(did).toBe(PKCS8_KEY_DID);
    expect(code).toBe(0);
    checkStderr(stderr);
  });

  it("Reads DID from key", async () => {
    const { code, stdout, stderr } = await cf(`id derive "example passphrase"`);
    const keyBuffer = encode(stdout.join("\n"));
    const identity = await Identity.fromPkcs8(keyBuffer);
    expect(identity.did()).toBe(EXAMPLE_PASSPHRASE_DID);
    expect(code).toBe(0);
    checkStderr(stderr);
  });

  it("Derives a key from a mnemonic matching browser login", async () => {
    const { code, stdout, stderr } = await cf(
      `id from-mnemonic "${TEST_MNEMONIC}"`,
    );
    const keyBuffer = encode(stdout.join("\n"));
    const identity = await Identity.fromPkcs8(keyBuffer);
    expect(identity.did()).toBe(TEST_MNEMONIC_DID);
    // Must match the browser's mnemonic-login derivation...
    const browser = await Identity.fromMnemonic(TEST_MNEMONIC, {
      implementation: "noble",
    });
    expect(identity.did()).toBe(browser.did());
    // ...and must NOT collide with `id derive` (fromPassphrase) of the same
    // text, which is the footgun this command exists to avoid.
    const passphrase = await Identity.fromPassphrase(TEST_MNEMONIC, {
      implementation: "noble",
    });
    expect(identity.did()).not.toBe(passphrase.did());
    expect(code).toBe(0);
    checkStderr(stderr);
  });

  it("Derives a passphrase key from stdin via '-'", async () => {
    // Trailing newline (as `echo`/files produce) must be stripped so the
    // result matches the equivalent argv invocation.
    const { code, stdout, stderr } = await cf("id derive -", {
      stdin: "example passphrase\n",
    });
    const keyBuffer = encode(stdout.join("\n"));
    const identity = await Identity.fromPkcs8(keyBuffer);
    expect(identity.did()).toBe(EXAMPLE_PASSPHRASE_DID);
    expect(code).toBe(0);
    checkStderr(stderr);
  });

  it("Derives a passphrase key from stdin when the argument is omitted", async () => {
    const { code, stdout, stderr } = await cf("id derive", {
      stdin: "example passphrase",
    });
    const keyBuffer = encode(stdout.join("\n"));
    const identity = await Identity.fromPkcs8(keyBuffer);
    expect(identity.did()).toBe(EXAMPLE_PASSPHRASE_DID);
    expect(code).toBe(0);
    checkStderr(stderr);
  });

  it("Derives a mnemonic key from stdin via '-'", async () => {
    const { code, stdout, stderr } = await cf(
      "id from-mnemonic -",
      { stdin: `${TEST_MNEMONIC}\n` },
    );
    const keyBuffer = encode(stdout.join("\n"));
    const identity = await Identity.fromPkcs8(keyBuffer);
    expect(identity.did()).toBe(TEST_MNEMONIC_DID);
    expect(code).toBe(0);
    checkStderr(stderr);
  });

  it("Errors when no secret is provided on stdin", async () => {
    const { code, stdout } = await cf("id from-mnemonic -", { stdin: "" });
    expect(code).not.toBe(0);
    expect(stdout.length).toBe(0);
  });

  it("Derives a passphrase key from a file via '-- <file>'", async () => {
    const file = await Deno.makeTempFile();
    // Trailing newline (as editors/`echo` produce) must be stripped.
    await Deno.writeTextFile(file, "example passphrase\n");
    const { code, stdout, stderr } = await cf(`id derive -- ${file}`);
    const identity = await Identity.fromPkcs8(encode(stdout.join("\n")));
    expect(identity.did()).toBe(EXAMPLE_PASSPHRASE_DID);
    expect(code).toBe(0);
    checkStderr(stderr);
  });

  it("Derives a mnemonic key from a file via '-- <file>'", async () => {
    const file = await Deno.makeTempFile();
    await Deno.writeTextFile(file, `${TEST_MNEMONIC}\n`);
    const { code, stdout, stderr } = await cf(`id from-mnemonic -- ${file}`);
    const identity = await Identity.fromPkcs8(encode(stdout.join("\n")));
    expect(identity.did()).toBe(TEST_MNEMONIC_DID);
    expect(code).toBe(0);
    checkStderr(stderr);
  });

  it("Errors when both an inline value and a -- <file> are given", async () => {
    const file = await Deno.makeTempFile();
    await Deno.writeTextFile(file, "example passphrase");
    const { code, stdout } = await cf(`id derive inline -- ${file}`);
    expect(code).not.toBe(0);
    expect(stdout.length).toBe(0);
  });
});
