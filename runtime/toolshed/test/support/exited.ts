/**
 * What a test's stand-in for `Deno.exit` throws, so that, like `Deno.exit`,
 * the call does not return. It carries the status the code exited with.
 */
export class Exited extends Error {
  constructor(readonly code: number) {
    super(`exit ${code}`);
  }
}
