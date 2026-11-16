import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";

import { Identity } from "@commonfabric/identity";

import type { JSONSchema } from "../../src/builder/types.ts";
import { prepareBoundaryCommit } from "../../src/cfc/prepare.ts";
import { Runtime } from "../../src/runtime.ts";
import { StorageManager } from "../../src/storage/cache.deno.ts";

const signer = await Identity.fromPassphrase("cfc-exact-copy-pointer");

/**
 * What `prepareBoundaryCommit()` returns and stores for a record whose
 * `confirmed.email` claims to copy the field `exactCopyOf` names.
 */
async function copy(
  exactCopyOf: string,
  value: { email: string; confirmed: { email: string } },
) {
  const storageManager = StorageManager.emulate({ as: signer });
  const runtime = new Runtime({
    apiUrl: new URL("https://example.com"),
    storageManager,
    cfcEnforcementMode: "enforce-explicit",
  });
  try {
    const tx = runtime.edit();
    try {
      // The schema type spells the claim as a list of segments; the pointer
      // spelling reaches the runtime in a schema read as data, as this one is.
      const schema: JSONSchema = JSON.parse(JSON.stringify({
        type: "object",
        properties: {
          email: { type: "string", ifc: { confidentiality: ["secret"] } },
          confirmed: {
            type: "object",
            properties: {
              email: { type: "string", ifc: { exactCopyOf } },
            },
          },
        },
      }));
      const cell = runtime.getCell(signer.did(), "copy", schema, tx);
      cell.set(value);
      const reasons = prepareBoundaryCommit(tx);
      const stored = tx.readOrThrow({
        ...cell.getAsNormalizedFullLink(),
        path: ["cfc"],
      }) as { labelMap?: { entries: unknown[] } } | undefined;
      return { reasons, entries: stored?.labelMap?.entries };
    } finally {
      tx.abort();
    }
  } finally {
    await runtime.dispose();
    await storageManager.close();
  }
}

describe("prepareBoundaryCommit()", () => {
  // The specification spells an `exactCopyOf` claim as a JSON Pointer
  // (§8.8).

  const copied = {
    email: "a@example.com",
    confirmed: { email: "a@example.com" },
  };
  const altered = {
    email: "a@example.com",
    confirmed: { email: "b@example.com" },
  };

  for (const spelling of ["/email"]) {
    describe(`an \`exactCopyOf\` claim spelled \`${spelling}\``, () => {
      it("returns no reason, and carries the source's label to the copy, where the copy holds the source's value", async () => {
        const { reasons, entries } = await copy(spelling, copied);
        expect(reasons).toEqual([]);
        expect(entries).toContainEqual(expect.objectContaining({
          path: ["confirmed", "email"],
          label: expect.objectContaining({ confidentiality: ["secret"] }),
        }));
      });

      it("returns a verdict where the copy holds another value", async () => {
        expect((await copy(spelling, altered)).reasons).toEqual([
          "cfc-verdict: exactCopyOf failed at /confirmed/email",
        ]);
      });
    });
  }
});
