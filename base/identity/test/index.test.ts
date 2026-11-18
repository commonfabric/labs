// Flat `Deno.test` cases: this package's tests also run in a browser through
// `deno-web-test`, which does not support `@std/testing/bdd`.

import { expect } from "@std/expect";

import * as identity from "@commonfabric/identity";
import { isDID } from "../src/did.ts";
import { Identity } from "../src/identity.ts";
import { KeyStore } from "../src/key-store.ts";
import { PassKey } from "../src/pass-key.ts";

Deno.test("the package root exports the classes and functions of the modules behind it", () => {
  expect(identity.Identity).toBe(Identity);
  expect(identity.KeyStore).toBe(KeyStore);
  expect(identity.PassKey).toBe(PassKey);
  expect(identity.isDID).toBe(isDID);
});
