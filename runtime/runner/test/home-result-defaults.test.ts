import { afterAll, beforeAll, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { fromFileUrl } from "@std/path";

import { Identity } from "@commonfabric/identity";
import { resolveLocalProgram } from "@commonfabric/runner/local-program.deno";
import type { JSONSchema } from "../src/builder/types.ts";
import { Runtime } from "../src/runtime.ts";
import { StorageManager } from "../src/storage/cache.deno.ts";

describe("home result-default contract stability", () => {
  // Home's published result contract gives these fields defaults. Newly
  // required generated outputs do not need migration defaults, but removing an
  // existing default is still a contract change: an older Home root that lacks
  // the field takes its value from the default when it merges. The generic
  // compatibility gate does not reject default removal, so these assertions on
  // the result schema Home compiles to are the protection against silently
  // changing Home's established result contract. Generic generated-output
  // behavior is covered by the piece compatibility, CFC schema-merge, and
  // vintage replay suites.

  let runtime: Runtime;
  let storageManager: ReturnType<typeof StorageManager.emulate>;
  let schema: JSONSchema;

  beforeAll(async () => {
    storageManager = StorageManager.emulate({
      as: await Identity.fromPassphrase("home result-default contract"),
    });
    runtime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager,
    });
    const program = await resolveLocalProgram(
      (resolver) => runtime.harness.resolve(resolver),
      {
        main: fromFileUrl(
          new URL("../../../patterns/system/home/home.tsx", import.meta.url),
        ),
        root: fromFileUrl(new URL("../../..", import.meta.url)),
      },
    );
    const pattern = await runtime.patternManager.compilePattern(program);
    if (pattern.resultSchema === undefined) {
      throw new Error("Home compiled to no result schema.");
    }
    schema = pattern.resultSchema;
  });

  afterAll(async () => {
    await runtime.dispose();
    await storageManager.close();
  });

  for (const field of ["favorites", "journal", "spaces", "profiles", "mru"]) {
    it(`defaults \`${field}\` to an empty list`, () => {
      expect(schema).toMatchObject({
        properties: { [field]: { default: [] } },
      });
    });
  }

  it("defaults `defaultAppUrl` to the empty string", () => {
    expect(schema).toMatchObject({
      properties: { defaultAppUrl: { default: "" } },
    });
  });

  it("leaves `defaultProfile` out of the required fields", () => {
    // A field the schema requires and gives no default is one an older Home
    // root cannot merge without. `defaultProfile` has no default, so it must
    // not be required.

    if (typeof schema !== "object") throw new Error("The schema is a boolean.");
    expect(schema.properties).toHaveProperty("defaultProfile");
    expect(schema.required).not.toContain("defaultProfile");
  });
});
