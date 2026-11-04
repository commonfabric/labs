import { Identity } from "@commonfabric/identity";

/** The identity a harness signs as, read from the PKCS#8 keyfile at `path`. */
export const loadHarnessIdentity = async (path: string): Promise<Identity> =>
  await Identity.fromPkcs8(await Deno.readFile(path));
