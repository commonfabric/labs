// Flat `test()` cases: this package's tests also run in a browser through
// `deno-web-test`, where `describe()` is not available.

import { expect } from "@std/expect";

import { Identity } from "../src/identity.ts";
import { createSession } from "../src/session.ts";
import { test } from "@commonfabric/test-support/test";

test("createSession() returns a session acting as the identity in the space", async () => {
  const identity = await Identity.fromRaw(new Uint8Array(32).fill(1));
  const space = (await Identity.fromRaw(new Uint8Array(32).fill(2))).did();

  const session = createSession({ identity, spaceDid: space });

  expect(session.as).toBe(identity);
  expect(session.space).toBe(space);
});
