// Flat `Deno.test` cases: this package's tests also run in a browser through
// `deno-web-test`, which does not support `@std/testing/bdd`.

import { expect } from "@std/expect";

import { Identity } from "../src/identity.ts";
import { createSession } from "../src/session.ts";

Deno.test("createSession() returns a session acting as the identity in the space", async () => {
  const identity = await Identity.fromRaw(new Uint8Array(32).fill(1));
  const space = (await Identity.fromRaw(new Uint8Array(32).fill(2))).did();

  const session = createSession({ identity, spaceDid: space });

  expect(session.as).toBe(identity);
  expect(session.space).toBe(space);
});
