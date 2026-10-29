import { Identity, type IdentityCreateConfig } from "@commonfabric/identity";

/**
 * The prefix every temporary identity keyfile's name carries. A file left
 * behind by a process that was killed has nothing but its name to say what
 * wrote it.
 */
export const IDENTITY_KEYFILE_PREFIX = "cf-test-identity-";

/**
 * A generated identity together with the temporary PKCS8 keyfile holding it.
 *
 * The keyfile stays on disk until {@linkcode TempIdentity.remove} runs, so a
 * caller holds this for as long as it wants the keyfile. `await using` calls
 * that when the binding leaves scope; a holder outliving one scope — a
 * `beforeAll` storing it for an `afterAll` — calls it directly.
 */
export interface TempIdentity extends AsyncDisposable {
  /** The identity, for in-process use. */
  readonly identity: Identity;

  /** Path to the PKCS8 keyfile, for a spawned CLI's `--identity` flag. */
  readonly path: string;

  /**
   * Removes the keyfile. A keyfile already gone is the goal state, so a
   * repeat call succeeds and removes nothing. A removal failing for any
   * other reason is reported on the console.
   */
  remove(): Promise<void>;
}

/**
 * Generates a fresh identity and writes its PKCS8 keyfile to a temporary
 * file, giving a test both the in-process identity and a keyfile path that a
 * spawned CLI can load. The keyfile parses through the same
 * `Identity.fromPkcs8` path the CLI's `--identity` loading uses. Callers that
 * serialize the identity (for example shell login) need
 * `{ implementation: "noble" }`.
 *
 * The result owns the keyfile:
 *
 * ```ts
 * await using temp = await writeTempIdentity();
 * ```
 */
export async function writeTempIdentity(
  config: IdentityCreateConfig = {},
): Promise<TempIdentity> {
  const pkcs8 = await Identity.generatePkcs8();
  const identity = await Identity.fromPkcs8(pkcs8, config);
  const path = await Deno.makeTempFile({ prefix: IDENTITY_KEYFILE_PREFIX });
  const remove = async (): Promise<void> => {
    try {
      await Deno.remove(path);
    } catch (error) {
      // Disposal runs while a test is failing, and a throw from it reaches
      // the reporter as a `SuppressedError` carrying neither message, so a
      // removal failure is reported here instead.
      if (!(error instanceof Deno.errors.NotFound)) {
        console.warn(`Could not remove the keyfile ${path}: ${error}`);
      }
    }
  };
  try {
    await Deno.writeFile(path, pkcs8);
  } catch (error) {
    await remove();
    throw error;
  }
  return { identity, path, remove, [Symbol.asyncDispose]: remove };
}
