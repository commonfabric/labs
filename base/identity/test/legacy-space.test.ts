import { assertEquals, assertNotEquals, assertRejects } from "@std/assert";

import { Identity } from "../src/identity.ts";
import { legacySpaceDid } from "../src/legacy-space.ts";

Deno.test("legacySpaceDid returns the DID the published derivation gives the name", async () => {
  const derived = await (await Identity.fromPassphrase("common user"))
    .derive("team-lunch");
  assertEquals(await legacySpaceDid("team-lunch"), derived.did());
});

Deno.test("legacySpaceDid returns one DID per name, whoever asks", async () => {
  assertEquals(
    await legacySpaceDid("team-lunch"),
    await legacySpaceDid("team-lunch"),
  );
  assertNotEquals(
    await legacySpaceDid("team-lunch"),
    await legacySpaceDid("team-dinner"),
  );
});

Deno.test("legacySpaceDid returns a string and no key", async () => {
  assertEquals(typeof await legacySpaceDid("team-lunch"), "string");
});

Deno.test("legacySpaceDid refuses a name that is a DID", async () => {
  await assertRejects(
    () => legacySpaceDid("did:key:z6MkName"),
    Error,
    "A space name must not be a DID",
  );
});
