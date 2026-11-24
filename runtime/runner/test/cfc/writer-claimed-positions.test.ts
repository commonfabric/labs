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

const signer = await Identity.fromPassphrase("cfc-writer-claimed-positions");

const writer = {
  __ctWriterIdentityOf: {
    file: "/main.tsx",
    path: ["write"],
    moduleIdentity: "module",
  },
};

/** A branch of the `admin` union that only `writer` may write. */
const claimedBoolean = { type: "boolean", ifc: { writeAuthorizedBy: writer } };

/**
 * The reasons for, and the label entries persisted by, `writer`'s write of
 * `admin` under a union of `claimedBoolean` and `other`, beside a field
 * whose schema is a reference to the unconstrained schema `true`.
 */
async function persist(other: JSONSchema, admin: unknown) {
  const storageManager = StorageManager.emulate({ as: signer });
  const runtime = new Runtime({
    apiUrl: new URL("https://example.com"),
    storageManager,
    cfcEnforcementMode: "enforce-explicit",
  });
  try {
    const tx = runtime.edit();
    try {
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
          admin: { anyOf: [claimedBoolean, other] },
          free: { $ref: "#/$defs/Anything" },
        },
        $defs: { Anything: true },
      } as JSONSchema;
      const cell = runtime.getCell(signer.did(), "flags", schema, tx);
      cell.set({ admin, free: 1 } as never);
      const reasons = prepareBoundaryCommit(tx);
      const stored = tx.readOrThrow({
        ...cell.getAsNormalizedFullLink(),
        path: ["cfc"],
      }) as { labelMap: { entries: unknown[] } } | undefined;
      return { reasons, entries: stored?.labelMap.entries ?? [] };
    } finally {
      tx.abort();
    }
  } finally {
    await runtime.dispose();
    await storageManager.close();
  }
}

describe("prepareBoundaryCommit()", () => {
  // A position every branch of whose union carries a writer claim stays
  // policy-carrying whatever value is written there, so it persists a
  // declared entry even for a value no branch's own claim applies to.

  const adminEntry = { path: ["admin"], label: {}, origin: "declared" };

  it("persists a declared entry at a union every branch of which is claimed", async () => {
    const claimedString = {
      type: "string",
      ifc: { writeAuthorizedBy: writer },
    } as JSONSchema;
    const { reasons, entries } = await persist(claimedString, 5);
    expect(reasons).toEqual([]);
    expect(entries).toEqual([adminEntry]);
  });

  it("persists the claimed branch's entry for a value that takes it", async () => {
    const { reasons, entries } = await persist(true, true);
    expect(reasons).toEqual([]);
    expect(entries).toEqual([adminEntry]);
  });
});
