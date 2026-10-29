import { Identity } from "@commonfabric/identity";
import { decode } from "@commonfabric/utils/encoding";
import { dirname } from "@std/path";
import { cliText } from "./cli-name.ts";
import { shellQuote } from "./shell-quote.ts";

export async function pkcs8FromPassphrase(
  passphrase: string,
): Promise<string> {
  const identity = await Identity.fromPassphrase(passphrase, {
    implementation: "noble",
  });
  return decode(identity.toPkcs8());
}

export async function pkcs8FromMnemonic(
  mnemonic: string,
): Promise<string> {
  const identity = await Identity.fromMnemonic(mnemonic.trim(), {
    implementation: "noble",
  });
  return decode(identity.toPkcs8());
}

export async function pkcs8FromEntropy(): Promise<string> {
  return decode(await Identity.generatePkcs8());
}

/**
 * A keyfile `cf` was pointed at yields no identity: the path does not exist,
 * cannot be read, or does not hold a key. The message names the path, what is
 * wrong with it, and what to do — for a path that does not exist, a line that
 * creates the directory as well as the file, since a teammate who has never
 * provisioned a key has neither — and carries nothing from inside the file: the
 * key decoder quotes the bytes it failed on in its own message, and a keyfile
 * that is merely corrupt may still be most of a private key, so that message
 * is not forwarded.
 *
 * Reported as a data error (stderr, exit 1) rather than a Cliffy usage error:
 * the option parsed fine, the path it carries does not yield a key.
 */
export class IdentityKeyfileError extends Error {
  constructor(
    readonly path: string,
    readonly problem: string,
    readonly remedy: string,
  ) {
    super(`Identity keyfile ${path} ${problem}. ${remedy}`);
    this.name = "IdentityKeyfileError";
  }
}

const POINT_AT = "Point --identity or CF_IDENTITY at";

async function identityFromKeyfile(
  path: string,
): Promise<Identity<`did:key:${string}`>> {
  let pkcs8: Uint8Array;
  try {
    pkcs8 = await Deno.readFile(path);
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) {
      throw new IdentityKeyfileError(
        path,
        "does not exist",
        `${POINT_AT} an existing keyfile, or create one there with ` +
          `\`mkdir -p ${shellQuote(dirname(path))} && ${
            cliText("cf id new")
          } > ${shellQuote(path)}\`.`,
      );
    }
    const reason = error instanceof Error ? error.message : String(error);
    throw new IdentityKeyfileError(
      path,
      `cannot be read (${reason})`,
      `${POINT_AT} a readable keyfile.`,
    );
  }
  try {
    return await Identity.fromPkcs8(pkcs8);
  } catch {
    throw new IdentityKeyfileError(
      path,
      "does not hold an Ed25519 PKCS#8 key",
      `${POINT_AT} a keyfile written by \`${cliText("cf id new")}\`, ` +
        `\`${cliText("cf id derive")}\`, or ` +
        `\`${cliText("cf id from-mnemonic")}\`.`,
    );
  }
}

export async function getDidFromFile(
  keypath: string,
): Promise<`did:key:${string}`> {
  return (await identityFromKeyfile(keypath)).did();
}

export function loadIdentity(
  filepath: string,
): Promise<Identity<`did:key:${string}`>> {
  return identityFromKeyfile(filepath);
}
