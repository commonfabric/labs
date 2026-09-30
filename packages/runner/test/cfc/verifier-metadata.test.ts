import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";

import { internSchema } from "@commonfabric/data-model-schema";
import { Identity } from "@commonfabric/identity";

import type { JSONSchema } from "../../src/builder/types.ts";
import { isKnownCfcMetadataVersion } from "../../src/cfc/metadata.ts";
import { Runtime } from "../../src/runtime.ts";
import { StorageManager } from "../../src/storage/cache.deno.ts";
import {
  SEED_ENVELOPE_SCHEMA_HASH,
  seedStoredEnvelope,
  writeSeedEnvelopeDoc,
} from "../cfc-seed-envelope.ts";

const signer = await Identity.fromPassphrase("cfc-verifier-metadata");
const secret = "verifier-metadata-secret";

const closedSinkSchema = {
  type: "object",
  ifc: { maxConfidentiality: [] },
  properties: {
    value: { type: "string" },
  },
  required: ["value"],
} as const satisfies JSONSchema;

const intermediateSchema = {
  type: "object",
  properties: { value: { type: "string" } },
  required: ["value"],
} as const satisfies JSONSchema;

const labeledIntermediateSchema = {
  ...intermediateSchema,
  ifc: { confidentiality: [secret] },
} as const satisfies JSONSchema;

/** Creates an enforcing runtime with the requested flow-label mode. */
const makeRuntime = (flowLabels: "off" | "persist" = "persist") => {
  const storageManager = StorageManager.emulate({ as: signer });
  const runtime = new Runtime({
    apiUrl: new URL("https://example.com"),
    storageManager,
    cfcEnforcementMode: "enforce-explicit",
    cfcFlowLabels: flowLabels,
  });
  return { runtime, storageManager };
};

describe("prepareBoundaryCommit()", () => {
  it("a later gate observes a schema-closure root write that removed cached metadata", async () => {
    const storageManager = StorageManager.emulate({ as: signer });
    const runtime = new Runtime({
      apiUrl: new URL("https://example.com"),
      storageManager,
      cfcEnforcementMode: "enforce-explicit",
      cfcFlowLabels: "off",
    });
    try {
      // Register the exact schema document target A will stage. Keep its CID
      // unconfirmed by writing it only in this transaction: schema closure
      // staging must then perform its full-root `{ value }` write.
      const guardedSchema = internSchema({
        ...intermediateSchema,
        ifc: { integrity: ["schema-closure-stage"] },
      }, true);
      const schemaId = `cid:${guardedSchema.taggedHashString}` as const;
      const tx = runtime.edit();
      writeSeedEnvelopeDoc(tx, signer.did());
      seedStoredEnvelope(tx, {
        space: signer.did(),
        scope: "space",
        id: schemaId,
        path: [],
      }, {
        value: guardedSchema.schema,
        cfc: {
          version: 1,
          schemaHash: SEED_ENVELOPE_SCHEMA_HASH,
          labelMap: {
            version: 1,
            entries: [{
              path: [],
              label: { confidentiality: [secret] },
            }],
          },
        },
      });
      // This is the early application read whose confidential envelope the
      // verifier resolves and caches. Target A's later schema staging replaces
      // the CID root with `{ value: schema }`, removing that envelope.
      expect(tx.readOrThrow({
        space: signer.did(),
        scope: "space",
        id: schemaId,
        path: [],
      })).toMatchObject({ cfc: { version: 1 } });

      runtime.getCell(
        signer.did(),
        "closure-a-target",
        guardedSchema.schema,
        tx,
      ).set({ value: "stages closure" });
      runtime.getCell(
        signer.did(),
        "closure-b-sink",
        closedSinkSchema,
        tx,
      ).set({ value: "must remain public" });

      tx.prepareCfc();
      // The staged root has no confidentiality envelope, so the later gate's
      // empty confidentiality ceiling permits the commit.
      expect((await tx.commit()).error).toBeUndefined();
      const verify = runtime.edit();
      try {
        expect(verify.readOrThrow({
          space: signer.did(),
          scope: "space",
          id: schemaId,
          path: [],
        })).toEqual({ value: guardedSchema.schema });
        expect(
          runtime.getCell(signer.did(), "closure-b-sink", undefined, verify)
            .getRaw(),
        ).toEqual({ value: "must remain public" });
      } finally {
        verify.abort();
      }
    } finally {
      await runtime.dispose({ closeStorage: false });
      await storageManager.close();
    }
  });

  it("a later target observes metadata created for an earlier target in the same prepare", async () => {
    const { runtime, storageManager } = makeRuntime();
    try {
      const tx = runtime.edit();
      const intermediate = runtime.getCell(
        signer.did(),
        "a-intermediate",
        labeledIntermediateSchema,
        tx,
      );
      intermediate.set({ value: "derived" });
      const sink = runtime.getCell(
        signer.did(),
        "b-sink",
        closedSinkSchema,
        tx,
      );
      sink.set(intermediate);

      tx.prepareCfc();
      const intermediateWrites = [...(tx.getWriteDetails?.(signer.did()) ?? [])]
        .filter(
          (write) =>
            write.address.id === intermediate.getAsNormalizedFullLink().id &&
            write.address.path[0] === "cfc",
        );
      expect(intermediateWrites.length).toBe(1);
      const result = await tx.commit();
      expect(result.error?.message).toContain(
        "linked content evidence is unavailable",
      );
    } finally {
      await runtime.dispose({ closeStorage: false });
      await storageManager.close();
    }
  });

  it("a later target observes an earlier target rewriting a cached present envelope", async () => {
    const { runtime, storageManager } = makeRuntime();
    try {
      const seed = runtime.edit();
      runtime.getCell(signer.did(), "present-intermediate", {
        ...intermediateSchema,
        ifc: { integrity: ["existing-entry"] },
      }, seed).set({ value: "formerly public" });
      seed.prepareCfc();
      expect((await seed.commit()).error).toBeUndefined();

      const tx = runtime.edit();
      const intermediate = runtime.getCell(
        signer.did(),
        "present-intermediate",
        labeledIntermediateSchema,
        tx,
      );
      intermediate.set({ value: "now classified" });
      const sink = runtime.getCell(
        signer.did(),
        "present-sink",
        closedSinkSchema,
        tx,
      );
      sink.set(intermediate);

      tx.prepareCfc();
      expect(
        [...(tx.getWriteDetails?.(signer.did()) ?? [])].some((write) =>
          write.address.id === intermediate.getAsNormalizedFullLink().id &&
          write.address.path[0] === "cfc"
        ),
      ).toBe(true);
      expect((await tx.commit()).error?.message).toContain(
        "linked content evidence is unavailable",
      );
    } finally {
      await runtime.dispose({ closeStorage: false });
      await storageManager.close();
    }
  });

  it("a canonically-equal skipped write leaves the earlier target visible to a later gate", async () => {
    const { runtime, storageManager } = makeRuntime();
    try {
      /** Commits the envelope the next preparation will derive unchanged. */
      const deriveIntermediate = async () => {
        const tx = runtime.edit();
        const intermediate = runtime.getCell(
          signer.did(),
          "equal-intermediate",
          labeledIntermediateSchema,
          tx,
        );
        intermediate.set({ value: "derived" });
        tx.prepareCfc();
        expect((await tx.commit()).error).toBeUndefined();
      };
      await deriveIntermediate();

      const tx = runtime.edit();
      const intermediate = runtime.getCell(
        signer.did(),
        "equal-intermediate",
        labeledIntermediateSchema,
        tx,
      );
      intermediate.set({ value: "derived-again" });
      const sink = runtime.getCell(
        signer.did(),
        "equal-sink",
        closedSinkSchema,
        tx,
      );
      sink.set(intermediate);

      tx.prepareCfc();
      expect(
        [...(tx.getWriteDetails?.(signer.did()) ?? [])].filter((write) =>
          write.address.id === intermediate.getAsNormalizedFullLink().id &&
          write.address.path[0] === "cfc"
        ),
      ).toEqual([]);
      expect((await tx.commit()).error?.message).toContain(
        "linked content evidence is unavailable",
      );
    } finally {
      await runtime.dispose({ closeStorage: false });
      await storageManager.close();
    }
  });

  for (
    const [name, cfc, message] of [
      [
        "unknown-version",
        { version: 999, payload: { labels: [] } },
        "not one this build interprets",
      ],
      [
        "malformed",
        {
          version: 1,
          schemaHash: SEED_ENVELOPE_SCHEMA_HASH,
          labelMap: { entries: {} },
        },
        "carries no label map this build can read",
      ],
    ] as const
  ) {
    it(`fails closed on a consumed ${name} envelope even when the target declares no gate`, async () => {
      if (name === "unknown-version") {
        expect(isKnownCfcMetadataVersion(cfc.version)).toBe(false);
      }
      const { runtime, storageManager } = makeRuntime("off");
      try {
        const seed = runtime.edit();
        writeSeedEnvelopeDoc(seed, signer.did());
        const source = runtime.getCell(
          signer.did(),
          `${name}-source`,
          undefined,
          seed,
        );
        seedStoredEnvelope(seed, {
          ...source.getAsNormalizedFullLink(),
          path: [],
        }, {
          value: "opaque",
          cfc,
        });
        expect((await seed.commit()).error).toBeUndefined();

        const tx = runtime.edit();
        expect(
          runtime.getCell(signer.did(), `${name}-source`, undefined, tx)
            .getRaw(),
        ).toBe("opaque");
        runtime.getCell(signer.did(), `${name}-sink`, {
          type: "string",
          ifc: { integrity: ["independent-output"] },
        }, tx).set(
          "ordinary output",
        );
        tx.markCfcRelevant("test");

        tx.prepareCfc();
        expect((await tx.commit()).error?.message).toContain(message);
      } finally {
        await runtime.dispose({ closeStorage: false });
        await storageManager.close();
      }
    });
  }
});
