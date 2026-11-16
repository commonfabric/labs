import { expect } from "@std/expect";
import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";

import { Identity } from "@commonfabric/identity";

import type { JSONSchema } from "../../src/builder/types.ts";
import { wildcardPolicyMatchesValue } from "../../src/cfc/prepare.ts";
import { Runtime } from "../../src/runtime.ts";
import { StorageManager } from "../../src/storage/cache.deno.ts";
import type { IExtendedStorageTransaction } from "../../src/storage/interface.ts";

const signer = await Identity.fromPassphrase("cfc-wildcard-policy-match");

describe("wildcardPolicyMatchesValue()", () => {
  const target = {
    space: signer.did(),
    id: "of:policy-target" as const,
    scope: "space" as const,
  };
  let storageManager: ReturnType<typeof StorageManager.emulate>;
  let runtime: Runtime;
  let tx: IExtendedStorageTransaction;

  beforeEach(() => {
    storageManager = StorageManager.emulate({ as: signer });
    runtime = new Runtime({
      apiUrl: new URL("https://example.com"),
      storageManager,
    });
    tx = runtime.edit();
  });

  afterEach(async () => {
    tx.abort();
    await runtime.dispose();
    await storageManager.close();
  });

  it("returns `true` for an entry with no schema, whatever the value", () => {
    expect(wildcardPolicyMatchesValue(tx, target, undefined, 1)).toBe(true);
    expect(wildcardPolicyMatchesValue(tx, target, undefined, "x")).toBe(true);
  });

  it("returns whether the value satisfies every `allOf` part", () => {
    const schema = {
      allOf: [
        { type: "object" },
        { properties: { kind: { const: "admin" } } },
      ],
    } as const satisfies JSONSchema;
    expect(wildcardPolicyMatchesValue(tx, target, schema, { kind: "admin" }))
      .toBe(true);
    expect(wildcardPolicyMatchesValue(tx, target, schema, { kind: "guest" }))
      .toBe(false);
    expect(wildcardPolicyMatchesValue(tx, target, schema, "admin"))
      .toBe(false);
  });

  it("propagates an error other than an unevaluable reference", () => {
    // Only a condition the matcher cannot evaluate makes the entry apply. A
    // failure reading the value is not that, and is not swallowed into an
    // answer either way.
    const schema = {
      type: "object",
      properties: { kind: { const: "admin" } },
    } as const satisfies JSONSchema;
    const value = {
      get kind(): string {
        throw new Error("unreadable field");
      },
    };
    expect(() => wildcardPolicyMatchesValue(tx, target, schema, value))
      .toThrow("unreadable field");
  });
});
