import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";

import { CFC_ATOM_TYPE } from "@commonfabric/api/cfc";
import { Identity } from "@commonfabric/identity";

import type { JSONSchema } from "../src/builder/types.ts";
import { preparedDigestFor } from "../src/cfc/mod.ts";
import { deriveFlowJoin } from "../src/cfc/prepare.ts";
import { createFrozenRequestSnapshot } from "../src/cfc/request-snapshot.ts";
import { enqueueSinkRequestPostCommitEffect } from "../src/cfc/sink-request.ts";
import { Runtime } from "../src/runtime.ts";
import { StorageManager } from "../src/storage/cache.deno.ts";
import {
  SEED_ENVELOPE_SCHEMA_HASH,
  seedStoredEnvelope,
  writeSeedEnvelopeDoc,
} from "./cfc-seed-envelope.ts";

const signer = await Identity.fromPassphrase(
  "runner-external-content-observation",
);
const space = signer.did();
const PRODUCER = "test-result-writer";
const SECRET = "https://cfc.test/atom/facet/secret";
const VERIFIED = "https://cfc.test/atom/integrity/verified";

const ROW_SCHEMA = {
  type: "object",
  properties: { title: { type: "string" } },
  required: ["title"],
  ifc: { confidentiality: [SECRET], addIntegrity: [VERIFIED] },
} as const satisfies JSONSchema;

const RESULT_SCHEMA = {
  type: "object",
  properties: { summary: { type: "string" } },
  required: ["summary"],
  ifc: { maxConfidentiality: [SECRET] },
} as const satisfies JSONSchema;

const withRuntime = async (
  fn: (
    runtime: Runtime,
    storageManager: ReturnType<typeof StorageManager.emulate>,
  ) => void | Promise<void>,
  options: { cfcWriteFloor?: "off" | "observe" | "enforce" } = {},
): Promise<void> => {
  const storageManager = StorageManager.emulate({ as: signer });
  const runtime = new Runtime({
    apiUrl: new URL("https://example.com"),
    storageManager,
    cfcEnforcementMode: "enforce-explicit",
    cfcFlowLabels: "persist",
    cfcWriteFloor: options.cfcWriteFloor,
    cfcSinkMaxConfidentiality: { fetchJson: [] },
  });
  try {
    await fn(runtime, storageManager);
  } finally {
    await runtime.scheduler.idle();
    await runtime.dispose();
    await storageManager.close();
  }
};

const identifyProducer = (
  tx: ReturnType<Runtime["edit"]>,
): void => {
  tx.setCfcImplementationIdentity({
    kind: "builtin",
    builtinId: PRODUCER,
  });
};

describe("external content observation", () => {
  it("records canonical flow and egress evidence without persisting the observed value", async () => {
    await withRuntime(async (runtime, storageManager) => {
      const targetTx = runtime.edit();
      identifyProducer(targetTx);
      const cause = "external-content-row";

      const receipt = await runtime.prepareExternalContentObservation({
        targetTx,
        space,
        cause,
        schema: ROW_SCHEMA,
        value: { title: "private row" },
        producer: PRODUCER,
      });
      const replica = storageManager.open(space).replica as unknown as {
        getDocument(id: string): unknown;
      };
      runtime.recordExternalContentObservation(targetTx, receipt, {
        space,
        producer: PRODUCER,
      });
      const [observation] = targetTx.getCfcState()
        .externalContentObservations;
      expect(replica.getDocument(observation.source.id)).toBeUndefined();
      expect(observation.flow.confidentiality).toContainEqual(SECRET);
      expect(observation.flow.integrity).toEqual([]);
      expect(observation.consumed.confidentiality).toContainEqual(SECRET);
      expect(observation.consumed.integrity).toContainEqual(VERIFIED);
      targetTx.abort("test complete");
    });
  });

  it("includes labels reached through the observed value's links", async () => {
    await withRuntime(async (runtime) => {
      const seedTx = runtime.edit();
      const linked = runtime.getCell(
        space,
        "external-content-linked-source",
        ROW_SCHEMA,
        seedTx,
      );
      linked.set({ title: "linked private row" });
      expect((await seedTx.commit()).ok).toBeDefined();

      const targetTx = runtime.edit();
      identifyProducer(targetTx);
      const receipt = await runtime.prepareExternalContentObservation({
        targetTx,
        space,
        cause: "external-content-row-with-link",
        schema: {
          type: "object",
          properties: {
            detail: {
              type: "object",
              properties: { title: { type: "string" } },
              required: ["title"],
            },
          },
          required: ["detail"],
        },
        value: { detail: linked },
        producer: PRODUCER,
      });
      runtime.recordExternalContentObservation(targetTx, receipt, {
        space,
        producer: PRODUCER,
      });

      const [observation] = targetTx.getCfcState()
        .externalContentObservations;
      expect(observation.flow.confidentiality).toContainEqual(SECRET);
      expect(observation.consumed.confidentiality).toContainEqual(SECRET);
      targetTx.abort("test complete");
    });
  });

  it("refuses when traversal introduces content that fails the write gate", async () => {
    await withRuntime(async (runtime) => {
      const seedTx = runtime.edit();
      const linked = runtime.getCell(
        space,
        "external-content-unverified-source",
        {
          type: "object",
          properties: { title: { type: "string" } },
          required: ["title"],
          ifc: { confidentiality: [SECRET] },
        },
        seedTx,
      );
      linked.set({ title: "unverified linked row" });
      expect((await seedTx.commit()).ok).toBeDefined();

      const targetTx = runtime.edit();
      identifyProducer(targetTx);
      try {
        await expect(runtime.prepareExternalContentObservation({
          targetTx,
          space,
          cause: "external-content-gated-link",
          schema: {
            type: "object",
            properties: {
              detail: {
                type: "object",
                properties: { title: { type: "string" } },
                required: ["title"],
              },
            },
            required: ["detail"],
            ifc: { maxConfidentiality: [] },
          },
          value: { detail: linked },
          producer: PRODUCER,
        })).rejects.toThrow(/traversed external content observation/);
      } finally {
        targetTx.abort("test complete");
      }
    });
  });

  it("uses the full consumed integrity label for input requirements", async () => {
    await withRuntime(async (runtime) => {
      const targetTx = runtime.edit();
      identifyProducer(targetTx);
      const receipt = await runtime.prepareExternalContentObservation({
        targetTx,
        space,
        cause: "external-content-endorsed-row",
        schema: ROW_SCHEMA,
        value: { title: "verified row" },
        producer: PRODUCER,
      });
      runtime.recordExternalContentObservation(targetTx, receipt, {
        space,
        producer: PRODUCER,
      });
      runtime.getCell(
        space,
        "external-content-required-integrity-result",
        {
          type: "object",
          properties: { summary: { type: "string" } },
          required: ["summary"],
          ifc: {
            maxConfidentiality: [SECRET],
            requiredIntegrity: [VERIFIED],
          },
        },
        targetTx,
      ).set({ summary: "derived from a verified row" });

      runtime.prepareTxForCommit(targetTx);
      expect(targetTx.getCfcState().prepare.status).toBe("prepared");
      expect((await targetTx.commit()).error).toBeUndefined();
    }, { cfcWriteFloor: "off" });
  });

  it("meets hereditary integrity with an observed empty-integrity row", async () => {
    await withRuntime(async (runtime) => {
      const certified = {
        type: CFC_ATOM_TYPE.PolicyCertified,
        policy: "external-observation-test",
      };
      const seedTx = runtime.edit();
      const certifiedCell = runtime.getCell(
        space,
        "external-content-certified-input",
        undefined,
        seedTx,
      );
      const certifiedLink = certifiedCell.getAsNormalizedFullLink();
      writeSeedEnvelopeDoc(seedTx, space);
      seedStoredEnvelope(seedTx, {
        space,
        scope: certifiedLink.scope,
        id: certifiedLink.id,
        path: [],
      }, {
        value: { title: "certified input" },
        cfc: {
          version: 1,
          schemaHash: SEED_ENVELOPE_SCHEMA_HASH,
          labelMap: {
            version: 1,
            entries: [{ path: [], label: { integrity: [certified] } }],
          },
        },
      });
      expect((await seedTx.commit()).ok).toBeDefined();

      const targetTx = runtime.edit();
      identifyProducer(targetTx);
      certifiedCell.withTx(targetTx).get({ traverseCells: true });
      expect(deriveFlowJoin(targetTx).integrity).toContainEqual(certified);

      const receipt = await runtime.prepareExternalContentObservation({
        targetTx,
        space,
        cause: "external-content-empty-integrity-row",
        schema: {
          type: "object",
          properties: {
            title: { type: "string", ifc: { maxConfidentiality: [] } },
          },
          required: ["title"],
          ifc: { maxConfidentiality: [] },
        },
        value: { title: "uncertified row" },
        producer: PRODUCER,
      });
      runtime.recordExternalContentObservation(targetTx, receipt, {
        space,
        producer: PRODUCER,
      });

      expect(deriveFlowJoin(targetTx).integrity).not.toContainEqual(certified);
      targetTx.abort("test complete");
    });
  });

  it("rejects forged, cross-transaction, and reused receipts", async () => {
    await withRuntime(async (runtime) => {
      const targetTx = runtime.edit();
      const otherTx = runtime.edit();
      identifyProducer(targetTx);
      identifyProducer(otherTx);
      const receipt = await runtime.prepareExternalContentObservation({
        targetTx,
        space,
        cause: "bound-external-content-row",
        schema: ROW_SCHEMA,
        value: { title: "private row" },
        producer: PRODUCER,
      });

      expect(() =>
        runtime.recordExternalContentObservation(otherTx, receipt, {
          space,
          producer: PRODUCER,
        })
      ).toThrow(/target/);
      expect(() =>
        runtime.recordExternalContentObservation(targetTx, {}, {
          space,
          producer: PRODUCER,
        })
      ).toThrow(/missing/);

      runtime.recordExternalContentObservation(targetTx, receipt, {
        space,
        producer: PRODUCER,
      });
      expect(() =>
        runtime.recordExternalContentObservation(targetTx, receipt, {
          space,
          producer: PRODUCER,
        })
      ).toThrow(/consumed/);
      targetTx.abort("test complete");
      otherTx.abort("test complete");
    });
  });

  it("rejects a target transaction owned by another runtime", async () => {
    await withRuntime(async (runtime) => {
      const foreignStorage = StorageManager.emulate({ as: signer });
      const foreignRuntime = new Runtime({
        apiUrl: new URL("https://example.com"),
        storageManager: foreignStorage,
        cfcEnforcementMode: "enforce-explicit",
        cfcFlowLabels: "persist",
      });
      const foreignTx = foreignRuntime.edit();
      identifyProducer(foreignTx);
      try {
        await expect(runtime.prepareExternalContentObservation({
          targetTx: foreignTx,
          space,
          cause: "foreign-runtime-row",
          schema: ROW_SCHEMA,
          value: { title: "private row" },
          producer: PRODUCER,
        })).rejects.toThrow(/runtime and producer/);
      } finally {
        foreignTx.abort("test complete");
        await foreignRuntime.dispose();
        await foreignStorage.close();
      }
    });
  });

  it("rejects evidence when the target trust snapshot changes", async () => {
    await withRuntime(async (runtime) => {
      const targetTx = runtime.edit();
      identifyProducer(targetTx);
      const receipt = await runtime.prepareExternalContentObservation({
        targetTx,
        space,
        cause: "trust-bound-external-content-row",
        schema: ROW_SCHEMA,
        value: { title: "private row" },
        producer: PRODUCER,
      });
      targetTx.setCfcTrustSnapshot({
        id: "changed-trust",
        actingPrincipal: space,
      });

      expect(() =>
        runtime.recordExternalContentObservation(targetTx, receipt, {
          space,
          producer: PRODUCER,
        })
      ).toThrow(/trust/);
      targetTx.abort("test complete");
    });
  });

  it("gates egress assembled from externally observed content", async () => {
    await withRuntime(async (runtime) => {
      const targetTx = runtime.edit();
      identifyProducer(targetTx);
      const receipt = await runtime.prepareExternalContentObservation({
        targetTx,
        space,
        cause: "egress-external-content-row",
        schema: ROW_SCHEMA,
        value: { title: "private row" },
        producer: PRODUCER,
      });
      let released = false;
      enqueueSinkRequestPostCommitEffect(
        targetTx,
        "fetchJson",
        "fetchJson:external-content",
        createFrozenRequestSnapshot({
          url: "https://example.com/exfil",
          options: { body: "private row" },
        }),
        "fetchJson-start",
        () => {
          released = true;
        },
      );
      runtime.recordExternalContentObservation(targetTx, receipt, {
        space,
        producer: PRODUCER,
      });

      runtime.prepareTxForCommit(targetTx);
      const result = await targetTx.commit();
      expect(released).toBe(false);
      expect(result.error?.message).toContain("exceeds ceiling for fetchJson");
    });
  });

  it("invalidates prior preparation and binds the observation in a fresh preparation", async () => {
    await withRuntime(async (runtime) => {
      const targetTx = runtime.edit();
      identifyProducer(targetTx);
      runtime.getCell(
        space,
        "external-content-result",
        RESULT_SCHEMA,
        targetTx,
      ).set({ summary: "derived" });
      runtime.prepareTxForCommit(targetTx);
      expect(targetTx.getCfcState().prepare.status).toBe("prepared");

      const receipt = await runtime.prepareExternalContentObservation({
        targetTx,
        space,
        cause: "digest-external-content-row",
        schema: ROW_SCHEMA,
        value: { title: "private row" },
        producer: PRODUCER,
      });
      runtime.recordExternalContentObservation(targetTx, receipt, {
        space,
        producer: PRODUCER,
      });
      const invalidated = targetTx.getCfcState().prepare;
      expect(invalidated.status).toBe("invalidated");
      if (invalidated.status === "invalidated") {
        expect(invalidated.reasons).toContainEqual(
          "external-content-observation-added",
        );
      }

      targetTx.abort("test complete");

      const freshTx = runtime.edit();
      identifyProducer(freshTx);
      runtime.getCell(
        space,
        "fresh-external-content-result",
        RESULT_SCHEMA,
        freshTx,
      ).set({ summary: "derived" });
      const freshReceipt = await runtime.prepareExternalContentObservation({
        targetTx: freshTx,
        space,
        cause: "fresh-digest-external-content-row",
        schema: ROW_SCHEMA,
        value: { title: "private row" },
        producer: PRODUCER,
      });
      runtime.recordExternalContentObservation(freshTx, freshReceipt, {
        space,
        producer: PRODUCER,
      });
      runtime.prepareTxForCommit(freshTx);
      const prepared = freshTx.getCfcState().prepare;
      expect(prepared.status).toBe("prepared");
      if (prepared.status === "prepared") {
        expect(prepared.input.externalContentObservations).toHaveLength(1);
        expect(preparedDigestFor({
          ...prepared.input,
          externalContentObservations: undefined,
        })).not.toBe(prepared.digest);
      }
      freshTx.abort("test complete");
    });
  });
});
