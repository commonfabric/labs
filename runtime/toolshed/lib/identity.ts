import { Identity } from "@commonfabric/identity";
import env from "@/env.ts";

const ROOT = "implicit trust";

/**
 * The identity a toolshed signs as, chosen by `environment`: the PKCS#8 key
 * at `IDENTITY`, read through `readFile`; otherwise one derived from
 * `IDENTITY_PASSPHRASE`; otherwise, in development only, one derived from a
 * fixed passphrase.
 *
 * @throws If the key at `IDENTITY` cannot be read or parsed, or if no
 * identity is configured outside development.
 */
export async function loadIdentity(
  environment: Pick<typeof env, "IDENTITY" | "IDENTITY_PASSPHRASE" | "ENV">,
  readFile: (path: string) => Promise<Uint8Array> = Deno.readFile,
): Promise<Identity> {
  const identityPath = environment.IDENTITY;
  if (identityPath) {
    console.log(`Using identity at ${identityPath}`);
    try {
      const pkcs8Key = await readFile(identityPath);
      return await Identity.fromPkcs8(pkcs8Key);
    } catch (_) {
      throw new Error(`Could not read key at ${identityPath}.`);
    }
  } else if (environment.IDENTITY_PASSPHRASE) {
    console.warn("Using insecure passphrase identity.");
    return await Identity.fromPassphrase(environment.IDENTITY_PASSPHRASE);
  } else if (environment.ENV === "development") {
    return await Identity.fromPassphrase(ROOT);
  }
  throw new Error("No IDENTITY set.");
}

export const identity: Identity = await loadIdentity(env);
