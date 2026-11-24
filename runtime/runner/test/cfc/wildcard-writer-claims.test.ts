import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";

import { Identity } from "@commonfabric/identity";

import type { JSONSchema } from "../../src/builder/types.ts";
import { prepareBoundaryCommit } from "../../src/cfc/prepare.ts";
import { Runtime } from "../../src/runtime.ts";
import { StorageManager } from "../../src/storage/cache.deno.ts";

const signer = await Identity.fromPassphrase("cfc-wildcard-writer-claims");

/** A record each of whose entries only the `trusted` builtin may write. */
const schema = {
  type: "object",
  additionalProperties: {
    type: "string",
    ifc: { writeAuthorizedBy: ["trusted"] },
  },
} as const satisfies JSONSchema;

/**
 * The reasons `prepareBoundaryCommit()` returns for a write of `value` at
 * `key` of a stored record governed by `schema`, by a writer the claim does
 * not name.
 */
async function refusals(key: string, value: string) {
  const storageManager = StorageManager.emulate({ as: signer });
  const runtime = new Runtime({
    apiUrl: new URL("https://example.com"),
    storageManager,
    cfcEnforcementMode: "enforce-explicit",
  });
  try {
    const seed = runtime.edit();
    runtime.getCell<Record<string, string>>(
      signer.did(),
      "record",
      undefined,
      seed,
    )
      .set({ [key]: "stored", other: "stored" });
    expect((await seed.commit().settled).error).toBeUndefined();

    const tx = runtime.edit();
    try {
      runtime.getCell(signer.did(), "record", schema, tx).key(key).set(value);
      return prepareBoundaryCommit(tx);
    } finally {
      tx.abort();
    }
  } finally {
    await runtime.dispose();
    await storageManager.close();
  }
}

describe("prepareBoundaryCommit()", () => {
  it("returns a writer refusal for an entry of a claimed record whose key is literally `*`", async () => {
    // A path pattern spells every entry `*`, and a written path that holds
    // the key `*` reads the same; the entry is still one of the record's.
    expect(await refusals("*", "rewritten")).toEqual([
      "cfc-verdict: writeAuthorizedBy requires a trusted builtin identity at /*",
    ]);
    expect(await refusals("a", "rewritten")).toEqual([
      "cfc-verdict: writeAuthorizedBy requires a trusted builtin identity at /a",
    ]);
  });
});
