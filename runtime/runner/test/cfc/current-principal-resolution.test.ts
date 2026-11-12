import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";

import { Identity } from "@commonfabric/identity";

import type { JSONSchema } from "../../src/builder/types.ts";
import { prepareBoundaryCommit } from "../../src/cfc/prepare.ts";
import { Runtime } from "../../src/runtime.ts";
import { StorageManager } from "../../src/storage/cache.deno.ts";
import {
  setCfcImplementationIdentity,
  setCfcTrustSnapshot,
} from "../../src/storage/extended-storage-transaction.ts";

const signer = await Identity.fromPassphrase(
  "cfc-current-principal-resolution",
);
const CURRENT_PRINCIPAL = { __ctCurrentPrincipal: true };

describe("prepareBoundaryCommit()", () => {
  it("stores the acting principal wherever an integrity atom holds the current-principal placeholder, in a list among them", async () => {
    const storageManager = StorageManager.emulate({ as: signer });
    const runtime = new Runtime({
      apiUrl: new URL("https://example.com"),
      storageManager,
      cfcEnforcementMode: "enforce-explicit",
    });
    try {
      const tx = runtime.edit();
      setCfcTrustSnapshot(tx, { id: "trust", actingPrincipal: signer.did() });
      setCfcImplementationIdentity(tx, {
        kind: "verified",
        moduleIdentity: "module",
        sourceFile: "/main.tsx",
        bindingPath: ["write"],
      });
      const schema = {
        type: "object",
        properties: {
          v: {
            type: "string",
            ifc: {
              integrity: [{ kind: "co-signed", signers: [CURRENT_PRINCIPAL] }],
              addIntegrity: [{
                kind: "witnessed",
                by: { witnesses: [CURRENT_PRINCIPAL, "notary"] },
              }],
              writeAuthorizedBy: {
                __ctWriterIdentityOf: {
                  file: "/main.tsx",
                  path: ["write"],
                  moduleIdentity: "module",
                },
              },
            },
          },
        },
      } as const satisfies JSONSchema;
      const cell = runtime.getCell(signer.did(), "doc", schema, tx);
      cell.set({ v: "signed" });
      expect(prepareBoundaryCommit(tx)).toEqual([]);
      const stored = tx.readOrThrow({
        ...cell.getAsNormalizedFullLink(),
        path: ["cfc"],
      });
      expect(stored).toMatchObject({
        labelMap: {
          entries: [{
            path: ["v"],
            label: {
              integrity: [{ kind: "co-signed", signers: [signer.did()] }],
            },
          }, {
            path: ["v"],
            label: {
              integrity: [{
                kind: "witnessed",
                by: { witnesses: [signer.did(), "notary"] },
              }],
            },
          }],
        },
      });
      tx.abort();
    } finally {
      await runtime.dispose();
      await storageManager.close();
    }
  });
});
