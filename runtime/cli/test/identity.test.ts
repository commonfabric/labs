import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { Identity } from "@commonfabric/identity";
import {
  getDidFromFile,
  IdentityKeyfileError,
  loadIdentity,
  pkcs8FromEntropy,
} from "../lib/identity.ts";

describe("identity", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await Deno.makeTempDir({ prefix: "cf-identity-" });
  });

  afterEach(async () => {
    await Deno.remove(dir, { recursive: true });
  });

  /** A keyfile as `cf id new > path` writes one, and the DID it holds. */
  async function writeKeyfile(path: string): Promise<string> {
    const pkcs8 = await pkcs8FromEntropy();
    await Deno.writeTextFile(path, pkcs8);
    const identity = await Identity.fromPkcs8(new TextEncoder().encode(pkcs8));
    return identity.did();
  }

  async function failureOf(work: Promise<unknown>): Promise<Error> {
    const outcome = await work.then(() => undefined, (error: unknown) => error);
    expect(outcome).toBeInstanceOf(IdentityKeyfileError);
    return outcome as Error;
  }

  describe("loadIdentity()", () => {
    it("loads the identity a keyfile holds", async () => {
      const path = `${dir}/identity.key`;
      const did = await writeKeyfile(path);
      expect((await loadIdentity(path)).did()).toBe(did);
    });

    it("names a missing keyfile by path, with how to create one there", async () => {
      const path = `${dir}/missing.key`;
      const error = await failureOf(loadIdentity(path));
      expect(error.message).toContain(
        `Identity keyfile ${path} does not exist. Point --identity or ` +
          "CF_IDENTITY at an existing keyfile, or create one there with " +
          `\`mkdir -p '${dir}' && `,
      );
      expect(error.message).toContain(`id new > '${path}'\`.`);
    });

    it("names a keyfile whose directory does not exist, with a remedy that creates it", async () => {
      // The default keyfile lives under a directory a teammate who has never
      // provisioned a key does not have; a remedy that only writes the file
      // fails on the very machine it is written for.

      const below = `${dir}/never/made`;
      const path = `${below}/identity.key`;
      const error = await failureOf(loadIdentity(path));
      expect(error.message).toContain(
        `Identity keyfile ${path} does not exist.`,
      );
      expect(error.message).toContain(`\`mkdir -p '${below}' && `);
      expect(error.message).toContain(`id new > '${path}'\`.`);
    });

    it("quotes the remedy's paths as shell words, an apostrophe included", async () => {
      // The remedy is a line a person pastes. A path holding a quote character
      // must still reach `mkdir` and the redirect as one argument each.

      const below = `${dir}/o'brien`;
      const path = `${below}/identity.key`;
      const error = await failureOf(loadIdentity(path));
      expect(error.message).toContain(
        `\`mkdir -p '${dir}/o'\\''brien' && `,
      );
      expect(error.message).toContain(
        `id new > '${dir}/o'\\''brien/identity.key'\`.`,
      );
    });

    it("names a path that cannot be read, with the system's reason", async () => {
      // A directory is the deterministic case: it exists, and reading it as
      // a file fails everywhere, unlike a permission bit that root ignores.

      const error = await failureOf(loadIdentity(dir));
      expect(error.message).toContain(
        `Identity keyfile ${dir} cannot be read (`,
      );
      expect(error.message).toContain(
        "Point --identity or CF_IDENTITY at a readable keyfile.",
      );
    });

    it("names a file that holds no key, and forwards nothing from inside it", async () => {
      const path = `${dir}/garbage.key`;
      await Deno.writeTextFile(path, "\u0001\u0002not-a-key");
      const error = await failureOf(loadIdentity(path));
      expect(error.message).toContain(
        `Identity keyfile ${path} does not hold an Ed25519 PKCS#8 key. ` +
          "Point --identity or CF_IDENTITY at a keyfile written by `",
      );
      expect(error.message).toContain("id from-mnemonic`.");
      expect(error.message).not.toContain("not-a-key");
    });
  });

  describe("getDidFromFile()", () => {
    it("returns the DID of the key a file holds", async () => {
      const path = `${dir}/identity.key`;
      const did = await writeKeyfile(path);
      expect(await getDidFromFile(path)).toBe(did);
    });

    it("reports a missing keyfile as loadIdentity does", async () => {
      const path = `${dir}/missing.key`;
      const error = await failureOf(getDidFromFile(path));
      expect(error.message).toContain(
        `Identity keyfile ${path} does not exist.`,
      );
    });
  });
});
