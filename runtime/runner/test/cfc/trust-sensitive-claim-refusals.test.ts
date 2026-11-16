import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";

import { Identity } from "@commonfabric/identity";

import type { JSONSchema } from "../../src/builder/types.ts";
import { prepareBoundaryCommit } from "../../src/cfc/prepare.ts";
import type { TrustSnapshot } from "../../src/cfc/types.ts";
import { Runtime } from "../../src/runtime.ts";
import { StorageManager } from "../../src/storage/cache.deno.ts";
import {
  setCfcImplementationIdentity,
  setCfcTrustSnapshot,
} from "../../src/storage/extended-storage-transaction.ts";
import type { FabricValue } from "@commonfabric/data-model";
import {
  SEED_ENVELOPE_SCHEMA_HASH,
  seedStoredEnvelope,
  writeSeedEnvelopeDoc,
} from "../cfc-seed-envelope.ts";

const signer = await Identity.fromPassphrase("cfc-trust-sensitive-refusals");
const other = await Identity.fromPassphrase("cfc-trust-sensitive-other");
const me = signer.did();

const CURRENT_PRINCIPAL = { __ctCurrentPrincipal: true };
const representsPrincipal = (subject: string | typeof CURRENT_PRINCIPAL) => ({
  kind: "represents-principal",
  subject,
});

/** The writer claim the staged writes' identity satisfies. */
const writer = {
  __ctWriterIdentityOf: {
    file: "/main.tsx",
    path: ["write"],
    moduleIdentity: "module",
  },
};

/** A record whose field `v` declares `ifc`. */
const fieldSchema = (ifc: Record<string, unknown>): JSONSchema => ({
  type: "object",
  properties: { v: { type: "string", ifc } },
} as JSONSchema);

/** An owned field: its owner, the claim naming them, and its writer. */
const ownedField = (owner: unknown = CURRENT_PRINCIPAL) =>
  fieldSchema({
    ownerPrincipal: owner,
    addIntegrity: [representsPrincipal(CURRENT_PRINCIPAL)],
    writeAuthorizedBy: writer,
  });

/**
 * The reasons `prepareBoundaryCommit()` returns for a write of `v` under
 * `schema` by the claim's writer, made under `snapshot` (the runtime's own
 * where `"ambient"`), over a document that already stores `stored` if given.
 */
async function refusals(
  schema: JSONSchema,
  snapshot: TrustSnapshot | undefined | "ambient",
  stored?: FabricValue,
): Promise<readonly string[]> {
  const storageManager = StorageManager.emulate({ as: signer });
  const runtime = new Runtime({
    apiUrl: new URL("https://example.com"),
    storageManager,
    cfcEnforcementMode: "enforce-explicit",
  });
  try {
    if (stored !== undefined) {
      const seed = runtime.edit();
      writeSeedEnvelopeDoc(seed, me);
      const address = runtime.getCell(me, "doc", undefined, seed)
        .getAsNormalizedFullLink();
      seedStoredEnvelope(seed, { ...address, path: [] }, stored);
      expect((await seed.commit().settled).error).toBeUndefined();
    }
    const tx = runtime.edit();
    try {
      if (snapshot !== "ambient") setCfcTrustSnapshot(tx, snapshot);
      setCfcImplementationIdentity(tx, {
        kind: "verified",
        moduleIdentity: "module",
        sourceFile: "/main.tsx",
        bindingPath: ["write"],
      });
      runtime.getCell(me, "doc", schema, tx).set({ v: "written" });
      return prepareBoundaryCommit(tx);
    } finally {
      tx.abort();
    }
  } finally {
    await runtime.dispose();
    await storageManager.close();
  }
}

const verdict = (reason: string) => [`cfc-verdict: ${reason}`];

describe("prepareBoundaryCommit()", () => {
  describe("a `writeAuthorizedBy` claim", () => {
    it("is refused without a trust snapshot", async () => {
      expect(
        await refusals(fieldSchema({ writeAuthorizedBy: writer }), undefined),
      )
        .toEqual(verdict("writeAuthorizedBy requires a trust snapshot at /v"));
      expect(
        await refusals(fieldSchema({ writeAuthorizedBy: writer }), "ambient"),
      )
        .toEqual([]);
    });

    it("is refused as unsupported when it is neither a builtin list nor a writer binding", async () => {
      expect(
        await refusals(
          fieldSchema({ writeAuthorizedBy: { by: "x" } }),
          "ambient",
        ),
      )
        .toEqual(
          verdict("unsupported trust-sensitive claim writeAuthorizedBy at /v"),
        );
    });

    it("is refused as unsupported when its writer binding names a path that is not all strings", async () => {
      const claim = {
        __ctWriterIdentityOf: { file: "/main.tsx", path: ["write", 1] },
      };
      expect(
        await refusals(fieldSchema({ writeAuthorizedBy: claim }), "ambient"),
      )
        .toEqual(
          verdict("unsupported trust-sensitive claim writeAuthorizedBy at /v"),
        );
    });
  });

  describe("an `ownerPrincipal` claim", () => {
    const trust = { id: "trust", actingPrincipal: me };

    it("is admitted from its owner, written by its writer", async () => {
      expect(await refusals(ownedField(), trust)).toEqual([]);
      expect(await refusals(ownedField(me), trust)).toEqual([]);
    });

    it("is refused under a trust snapshot with no id", async () => {
      expect(await refusals(ownedField(), { ...trust, id: "" }))
        .toEqual(verdict("ownerPrincipal requires a trust snapshot id at /v"));
    });

    it("is refused under a trust snapshot with no acting principal", async () => {
      expect(await refusals(ownedField(), { ...trust, actingPrincipal: "" }))
        .toEqual(
          verdict("ownerPrincipal requires an acting principal at /v"),
        );
    });

    it("is refused when the owner it names is not a DID", async () => {
      expect(await refusals(ownedField("not-a-did"), trust))
        .toEqual(verdict("ownerPrincipal must be a DID at /v"));
    });

    it("is refused without a `writeAuthorizedBy` claim beside it", async () => {
      const schema = fieldSchema({
        ownerPrincipal: CURRENT_PRINCIPAL,
        addIntegrity: [representsPrincipal(CURRENT_PRINCIPAL)],
      });
      expect(await refusals(schema, trust))
        .toEqual(verdict("ownerPrincipal requires writeAuthorizedBy at /v"));
    });

    it("is refused at a placeholder owner where the store records two owners", async () => {
      const storedOwners = (owners: readonly string[]) => ({
        value: { v: "stored" },
        cfc: {
          version: 1,
          schemaHash: SEED_ENVELOPE_SCHEMA_HASH,
          labelMap: {
            version: 1,
            entries: [{
              path: ["v"],
              label: { integrity: owners.map(representsPrincipal) },
              origin: "declared",
            }],
          },
        },
      });
      expect(
        await refusals(ownedField(), trust, storedOwners([me, other.did()])),
      ).toEqual(
        verdict("ownerPrincipal requires a single stored owner at /v"),
      );
      expect(await refusals(ownedField(), trust, storedOwners([me])))
        .toEqual([]);
    });
  });

  describe("a current-principal integrity claim", () => {
    const claim = fieldSchema({
      addIntegrity: [representsPrincipal(CURRENT_PRINCIPAL)],
    });

    it("is refused without a trust snapshot", async () => {
      expect(await refusals(claim, undefined)).toEqual(
        verdict(
          "current-principal integrity requires a trust snapshot at /v",
        ),
      );
    });

    it("is refused under a trust snapshot with no id", async () => {
      expect(await refusals(claim, { id: "", actingPrincipal: me })).toEqual(
        verdict(
          "current-principal integrity requires a trust snapshot id at /v",
        ),
      );
    });

    it("is refused under a trust snapshot with no acting principal", async () => {
      expect(await refusals(claim, { id: "trust", actingPrincipal: "" }))
        .toEqual(
          verdict(
            "current-principal integrity requires an acting principal at /v",
          ),
        );
    });
  });
});
