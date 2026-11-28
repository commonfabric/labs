import { expect } from "@std/expect";

import { Identity } from "@commonfabric/identity";
import { decode, encode } from "@commonfabric/text/utf8";
import { describe, it } from "@commonfabric/test-support/test";
import { join } from "@std/path/join";

import { argv, cf, checkStderr, exists } from "./utils.ts";

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
    const { code, stdout, stderr } = await cf(argv`id new`);
    const keyBuffer = encode(stdout.join("\n"));
    await Identity.fromPkcs8(keyBuffer);
    expect(code).toBe(0);
    checkStderr(stderr);
  });

  it("Reads DID from key", async () => {
    const temp = await Deno.makeTempFile();
    await Deno.writeFile(temp, encode(PKCS8_KEY));
    const { code, stdout, stderr } = await cf(argv`id did ${temp}`);
    const did = stdout.join("\n");
    expect(did).toBe(PKCS8_KEY_DID);
    expect(code).toBe(0);
    checkStderr(stderr);
  });

  it("Derives a key from a passphrase", async () => {
    const { code, stdout, stderr } = await cf(
      argv`id derive ${"example passphrase"}`,
    );
    const keyBuffer = encode(stdout.join("\n"));
    const identity = await Identity.fromPkcs8(keyBuffer);
    expect(identity.did()).toBe(EXAMPLE_PASSPHRASE_DID);
    expect(code).toBe(0);
    checkStderr(stderr);
  });

  it("Derives a key from a mnemonic matching browser login", async () => {
    const { code, stdout, stderr } = await cf(
      argv`id from-mnemonic ${TEST_MNEMONIC}`,
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
    const { code, stdout, stderr } = await cf(argv`id derive -`, {
      stdin: "example passphrase\n",
    });
    const keyBuffer = encode(stdout.join("\n"));
    const identity = await Identity.fromPkcs8(keyBuffer);
    expect(identity.did()).toBe(EXAMPLE_PASSPHRASE_DID);
    expect(code).toBe(0);
    checkStderr(stderr);
  });

  it("Derives a passphrase key from stdin when the argument is omitted", async () => {
    const { code, stdout, stderr } = await cf(argv`id derive`, {
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
      argv`id from-mnemonic -`,
      { stdin: `${TEST_MNEMONIC}\n` },
    );
    const keyBuffer = encode(stdout.join("\n"));
    const identity = await Identity.fromPkcs8(keyBuffer);
    expect(identity.did()).toBe(TEST_MNEMONIC_DID);
    expect(code).toBe(0);
    checkStderr(stderr);
  });

  it("Errors when no secret is provided on stdin", async () => {
    const { code, stdout } = await cf(argv`id from-mnemonic -`, { stdin: "" });
    expect(code).not.toBe(0);
    expect(stdout.length).toBe(0);
  });

  it("Derives a passphrase key from a file via '-- <file>'", async () => {
    const file = await Deno.makeTempFile();
    // Trailing newline (as editors/`echo` produce) must be stripped.
    await Deno.writeTextFile(file, "example passphrase\n");
    const { code, stdout, stderr } = await cf(argv`id derive -- ${file}`);
    const identity = await Identity.fromPkcs8(encode(stdout.join("\n")));
    expect(identity.did()).toBe(EXAMPLE_PASSPHRASE_DID);
    expect(code).toBe(0);
    checkStderr(stderr);
  });

  it("Derives a mnemonic key from a file via '-- <file>'", async () => {
    const file = await Deno.makeTempFile();
    await Deno.writeTextFile(file, `${TEST_MNEMONIC}\n`);
    const { code, stdout, stderr } = await cf(
      argv`id from-mnemonic -- ${file}`,
    );
    const identity = await Identity.fromPkcs8(encode(stdout.join("\n")));
    expect(identity.did()).toBe(TEST_MNEMONIC_DID);
    expect(code).toBe(0);
    checkStderr(stderr);
  });

  it("Errors when both an inline value and a -- <file> are given", async () => {
    const file = await Deno.makeTempFile();
    await Deno.writeTextFile(file, "example passphrase");
    const { code, stdout } = await cf(argv`id derive inline -- ${file}`);
    expect(code).not.toBe(0);
    expect(stdout.length).toBe(0);
  });

  describe("pair", () => {
    // A pairing code as Weaver shows it, and the canonical form the service
    // is sent.
    const SHOWN_CODE = "abcde-fghjk";
    const CANONICAL_CODE = "ABCDEFGHJK";

    /**
     * Runs `body` against a stand-in service on this machine that trades
     * `CANONICAL_CODE` for a fresh key and refuses any other code, recording
     * the request bodies it receives.
     */
    async function withService(
      body: (
        service: string,
        did: string,
        received: unknown[],
      ) => Promise<void>,
    ): Promise<void> {
      const pkcs8 = await Identity.generatePkcs8();
      const did = (await Identity.fromPkcs8(pkcs8)).did();
      const received: unknown[] = [];
      const server = Deno.serve(
        { hostname: "127.0.0.1", port: 0, onListen: () => {} },
        async (request) => {
          const { pathname } = new URL(request.url);
          if (
            request.method !== "POST" || pathname !== "/identity-pairing/redeem"
          ) {
            return new Response(null, { status: 404 });
          }
          const sent = await request.json();
          received.push(sent);
          if (sent.code !== CANONICAL_CODE) {
            return Response.json({}, { status: 403 });
          }
          // The PKCS8 key is PEM text, so `btoa` takes it as it is.
          return Response.json({ pkcs8Base64: btoa(decode(pkcs8)), did });
        },
      );
      try {
        await body(`http://127.0.0.1:${server.addr.port}`, did, received);
      } finally {
        await server.shutdown();
      }
    }

    it("keeps the key the code read from stdin buys, and leaves a keyfile holding it alone", async () => {
      const dir = await Deno.makeTempDir();
      try {
        await withService(async (service, did, received) => {
          const keyfile = join(dir, "nested", "identity.key");

          const first = await cf(argv`id pair ${service} ${keyfile}`, {
            stdin: `${SHOWN_CODE}\n`,
          });
          expect(first.code).toBe(0);
          expect(first.stdout).toEqual([`Paired: ${keyfile} now holds ${did}`]);
          checkStderr(first.stderr);
          expect(received).toEqual([
            {
              code: CANONICAL_CODE,
              device: { name: "cf", platform: Deno.build.os },
            },
          ]);
          const kept = await Identity.fromPkcs8(await Deno.readFile(keyfile));
          expect(kept.did()).toBe(did);
          // A regular file, readable and writable by its owner only.
          expect((await Deno.stat(keyfile)).mode).toBe(0o100600);

          const again = await cf(argv`id pair ${service} ${keyfile}`, {
            stdin: SHOWN_CODE,
          });
          expect(again.code).toBe(0);
          expect(again.stdout).toEqual([
            `${keyfile} already holds ${did}; nothing changed`,
          ]);
          checkStderr(again.stderr);
        });
      } finally {
        await Deno.remove(dir, { recursive: true });
      }
    });

    it("writes nothing and fails for a code the service refuses", async () => {
      const dir = await Deno.makeTempDir();
      try {
        await withService(async (service, _did, received) => {
          const keyfile = join(dir, "identity.key");

          const { code, stdout, stderr } = await cf(
            argv`id pair ${service} ${keyfile}`,
            { stdin: "zzzzz-zzzzz\n" },
          );
          expect(code).not.toBe(0);
          expect(stdout).toEqual([]);
          expect(stderr.join("\n")).toContain(
            "The service did not accept that code",
          );
          expect(received).toEqual([
            {
              code: "ZZZZZZZZZZ",
              device: { name: "cf", platform: Deno.build.os },
            },
          ]);
          expect(await exists(keyfile)).toBe(false);
        });
      } finally {
        await Deno.remove(dir, { recursive: true });
      }
    });
  });
});
