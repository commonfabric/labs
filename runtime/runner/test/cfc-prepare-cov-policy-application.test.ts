import { afterEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { Identity } from "@commonfabric/identity";

import type { URI } from "@commonfabric/memory/interface";

import type { JSONSchema } from "../src/builder/types.ts";
import { applyCfcPolicyToExistingValue } from "../src/cfc/policy-application.ts";
import { Runtime } from "../src/runtime.ts";
import { StorageManager } from "../src/storage/cache.deno.ts";
import type { IExtendedStorageTransaction } from "../src/storage/interface.ts";
import { markReadAsAttemptedWrite } from "../src/storage/reactivity-log.ts";
import { isCfcEnforcementRejection } from "../src/storage/rejection.ts";
import {
  setCfcImplementationIdentity,
  setCfcTrustSnapshot,
} from "../src/storage/extended-storage-transaction.ts";

const signer = await Identity.fromPassphrase(
  "runner-cfc-prepare-cov-policy-application",
);
const space = signer.did();

// The writer the stored claim names, and the builtin that applies a label to
// a document it does not write.
const CLAIM_OWNER = "claim-owner";
const APPLIER = "policy-applier";

const STORED = {
  type: "object",
  properties: {
    queue: {
      type: "array",
      items: { type: "string" },
      ifc: { writeAuthorizedBy: [CLAIM_OWNER] },
    },
  },
} as const satisfies JSONSchema;

const OWNER_LABEL = {
  type: "object",
  ifc: { confidentiality: ["owner-clause"] },
} as const satisfies JSONSchema;

describe("prepare", () => {
  let storageManager: ReturnType<typeof StorageManager.emulate> | undefined;
  let runtime: Runtime | undefined;

  afterEach(async () => {
    await runtime?.dispose();
    await storageManager?.close();
    runtime = undefined;
    storageManager = undefined;
  });

  const trust = (tx: IExtendedStorageTransaction, builtinId: string) => {
    setCfcTrustSnapshot(tx, { id: `trust-${space}`, actingPrincipal: space });
    setCfcImplementationIdentity(tx, { kind: "builtin", builtinId });
  };

  // Seeds `id` under the stored claim, as the writer it names, then applies
  // the owner label to it as a builtin, with `beside` run on the same
  // transaction, and commits.
  const applyPolicy = async (
    id: string,
    beside: (tx: IExtendedStorageTransaction, document: URI) => void,
  ) => {
    storageManager = StorageManager.emulate({ as: signer });
    runtime = new Runtime({ apiUrl: new URL(import.meta.url), storageManager });
    const seed = runtime.edit();
    trust(seed, CLAIM_OWNER);
    runtime.getCell(space, id, STORED, seed).set({ queue: ["a"] });
    expect((await seed.commit().settled).error).toBeUndefined();
    const tx = runtime.edit();
    trust(tx, APPLIER);
    const cell = runtime.getCell(space, id, OWNER_LABEL, tx);
    applyCfcPolicyToExistingValue(cell);
    beside(tx, cell.getAsNormalizedFullLink().id);
    return await tx.commit().settled;
  };

  describe("a policy application", () => {
    // A policy application writes nothing, so the document's writer claims
    // have no write to govern, but only while nothing else was attempted on
    // the document.

    it("leaves a writer claim it does not satisfy unenforced", async () => {
      const result = await applyPolicy("applies", () => {});
      expect(result.error).toBeUndefined();
    });

    it("enforces the writer claim when an attempt is marked on one of the document's own members", async () => {
      const result = await applyPolicy("beside-member", (tx, document) => {
        tx.readOrThrow({ space, id: document, scope: "space", path: ["cfc"] }, {
          meta: markReadAsAttemptedWrite,
        });
      });
      expect(isCfcEnforcementRejection(result.error)).toBe(true);
      expect(String(result.error?.message)).toContain("writeAuthorizedBy");
    });
  });
});
