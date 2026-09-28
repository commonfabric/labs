import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";
import { stub } from "@std/testing/mock";

import { CFC_ATOM_TYPE } from "@commonfabric/api/cfc";
import { Identity } from "@commonfabric/identity";

import type { JSONSchema } from "../src/builder/types.ts";
import { preparedDigestFor } from "../src/cfc/mod.ts";
import { collectConsumedLabel, deriveFlowJoin } from "../src/cfc/prepare.ts";
import { createFrozenRequestSnapshot } from "../src/cfc/request-snapshot.ts";
import { enqueueSinkRequestPostCommitEffect } from "../src/cfc/sink-request.ts";
import {
  type CfcTxState,
  runtimeWritePolicyAuthorization,
} from "../src/cfc/types.ts";
import { Runtime } from "../src/runtime.ts";
import { StorageManager } from "../src/storage/cache.deno.ts";
import {
  setCfcImplementationIdentity,
  setCfcTrustSnapshot,
  TransactionWrapper,
} from "../src/storage/extended-storage-transaction.ts";
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

const PUBLIC_RESULT_SCHEMA = {
  type: "string",
  ifc: { maxConfidentiality: [] },
} as const satisfies JSONSchema;

const withRuntime = async (
  fn: (
    runtime: Runtime,
    storageManager: ReturnType<typeof StorageManager.emulate>,
  ) => void | Promise<void>,
  options: {
    cfcWriteFloor?: "off" | "observe" | "enforce";
    cfcEnforcementMode?: "disabled" | "enforce-explicit";
  } = {},
): Promise<void> => {
  const storageManager = StorageManager.emulate({ as: signer });
  const runtime = new Runtime({
    apiUrl: new URL("https://example.com"),
    storageManager,
    cfcEnforcementMode: options.cfcEnforcementMode ?? "enforce-explicit",
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
  setCfcImplementationIdentity(tx, {
    kind: "builtin",
    builtinId: PRODUCER,
  });
};

type ObservationProbePhase = "initial" | "traversal";

/** Replaces the next observation probe's state view at one preparation phase. */
const interceptObservationProbeState = (
  runtime: Runtime,
  transform: (
    phase: ObservationProbePhase,
    state: Readonly<CfcTxState>,
  ) => Readonly<CfcTxState>,
): void => {
  const edit = runtime.edit.bind(runtime);
  runtime.edit = ((...args: Parameters<Runtime["edit"]>) => {
    runtime.edit = edit as Runtime["edit"];
    const tx = edit(...args);
    let phase: ObservationProbePhase | undefined;
    return new Proxy(tx, {
      get(target, property) {
        if (property === "prepareForCommit") {
          return () => {
            target.prepareForCommit();
            phase = "initial";
          };
        }
        if (property === "prepareCfc") {
          return () => {
            const digest = target.prepareCfc();
            phase = "traversal";
            return digest;
          };
        }
        if (property === "getCfcState") {
          return () => {
            const state = target.getCfcState();
            return phase === undefined ? state : transform(phase, state);
          };
        }
        const value = Reflect.get(target, property, target);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
  }) as Runtime["edit"];
};

describe("external content observation", () => {
  it("forwards only authorized observations through transaction wrappers", async () => {
    await withRuntime(async (runtime) => {
      const tx = runtime.edit();
      const wrapped = new TransactionWrapper(tx);
      const source = {
        space,
        id: "of:external-wrapper-source" as const,
        scope: "space" as const,
        path: [],
      };
      const observation = {
        source,
        flow: { confidentiality: [], integrity: [] },
        consumed: { confidentiality: [], integrity: [] },
        labeledSpaces: [],
        sources: [],
      };

      wrapped.recordCfcExternalContentObservation(observation);
      expect(tx.getCfcState().externalContentObservations).toEqual([]);
      wrapped.recordCfcExternalContentObservation(
        observation,
        runtimeWritePolicyAuthorization,
      );
      expect(tx.getCfcState().externalContentObservations).toEqual([
        observation,
      ]);
      expect(collectConsumedLabel(wrapped).confidentiality).toEqual([]);

      const result = runtime.getCell(space, "external-wrapper-result", {
        type: "object",
        properties: { summary: { type: "string" } },
        required: ["summary"],
        ifc: { maxConfidentiality: [] },
      }, tx);
      await result.sync();
      result.set({ summary: "public result" });
      runtime.prepareTxForCommit(tx);
      expect(tx.getCfcState().prepare.status).toBe("prepared");
      tx.abort("test complete");
    });
  });

  it("admits a receipt when CFC enforcement is disabled", async () => {
    await withRuntime(async (runtime) => {
      const targetTx = runtime.edit();
      identifyProducer(targetTx);

      const receipt = await runtime.prepareExternalContentObservation({
        targetTx,
        space,
        cause: "disabled-external-content-row",
        schema: ROW_SCHEMA,
        value: { title: "row outside CFC enforcement" },
        producer: PRODUCER,
      });

      expect(() =>
        runtime.recordExternalContentObservation(targetTx, receipt, {
          space,
          producer: PRODUCER,
        })
      ).not.toThrow();
      targetTx.abort("test complete");
    }, { cfcEnforcementMode: "disabled" });
  });

  it("awaits link-target loads before deriving the receipt", async () => {
    await withRuntime(async (runtime, storageManager) => {
      let pendingChecks = 0;
      let settled = 0;
      using _pending = stub(
        storageManager,
        "pendingCrossSpacePromiseCount",
        () => pendingChecks++ === 0 ? 1 : 0,
      );
      using _settled = stub(
        storageManager,
        "crossSpaceSettled",
        () => {
          settled++;
          return Promise.resolve();
        },
      );
      const targetTx = runtime.edit();
      identifyProducer(targetTx);

      const receipt = await runtime.prepareExternalContentObservation({
        targetTx,
        space,
        cause: "settled-external-content-row",
        schema: ROW_SCHEMA,
        value: { title: "private row" },
        producer: PRODUCER,
      });

      expect(settled).toBe(1);
      runtime.recordExternalContentObservation(targetTx, receipt, {
        space,
        producer: PRODUCER,
      });
      targetTx.abort("test complete");
    });
  });

  it("traverses afresh after a linked-content load settles", async () => {
    await withRuntime(async (runtime, storageManager) => {
      let afterSettle = false;
      let cacheHitsAfterSettle = 0;
      let cacheSetsAfterSettle = 0;
      const targetTx = runtime.edit();
      identifyProducer(targetTx);
      const edit = runtime.edit.bind(runtime);
      runtime.edit = ((...args: Parameters<Runtime["edit"]>) => {
        runtime.edit = edit as Runtime["edit"];
        const tx = edit(...args);
        return new Proxy(tx, {
          get(target, property) {
            if (property === "getCachedReadResult") {
              return (...cacheArgs: [string, string]) => {
                const cached = target.getCachedReadResult?.(...cacheArgs);
                if (afterSettle && cached !== undefined) cacheHitsAfterSettle++;
                return cached;
              };
            }
            if (property === "setCachedReadResult") {
              return (...cacheArgs: [string, string, unknown]) => {
                if (afterSettle) cacheSetsAfterSettle++;
                return target.setCachedReadResult?.(...cacheArgs);
              };
            }
            const value = Reflect.get(target, property, target);
            return typeof value === "function" ? value.bind(target) : value;
          },
        });
      }) as Runtime["edit"];
      let pendingChecks = 0;
      using _pending = stub(
        storageManager,
        "pendingCrossSpacePromiseCount",
        () => pendingChecks++ === 0 ? 1 : 0,
      );
      using _settled = stub(
        storageManager,
        "crossSpaceSettled",
        () => {
          afterSettle = true;
          return Promise.resolve();
        },
      );
      await runtime.prepareExternalContentObservation({
        targetTx,
        space,
        cause: "fresh-linked-content-traversal",
        schema: ROW_SCHEMA,
        value: { title: "private row" },
        producer: PRODUCER,
      });

      expect(cacheHitsAfterSettle).toBe(0);
      expect(cacheSetsAfterSettle).toBeGreaterThan(0);
      targetTx.abort("test complete");
    }, { cfcEnforcementMode: "disabled" });
  });

  it("refuses when link-target load convergence exhausts its bound", async () => {
    await withRuntime(async (runtime, storageManager) => {
      let pendingChecks = 0;
      let settled = 0;
      using _pending = stub(
        storageManager,
        "pendingCrossSpacePromiseCount",
        () => ++pendingChecks <= 101 ? 1 : 0,
      );
      using _settled = stub(
        storageManager,
        "crossSpaceSettled",
        () => {
          settled++;
          return Promise.resolve();
        },
      );
      const targetTx = runtime.edit();
      identifyProducer(targetTx);

      try {
        await expect(runtime.prepareExternalContentObservation({
          targetTx,
          space,
          cause: "nonconverging-external-content-row",
          schema: ROW_SCHEMA,
          value: { title: "private row" },
          producer: PRODUCER,
        })).rejects.toMatchObject({
          name: "CfcCommitRefusalError",
          message: expect.stringContaining("did not converge"),
        });
        expect(pendingChecks).toBe(100);
        expect(settled).toBe(100);
      } finally {
        targetTx.abort("test complete");
      }
    });
  });

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

  it("accepts matching nonempty module-delegation snapshots", async () => {
    await withRuntime(async (runtime) => {
      runtime.registerModuleDelegations(
        space,
        new Map([["module:successor", new Set(["module:predecessor"])]]),
      );
      const targetTx = runtime.edit();
      identifyProducer(targetTx);

      const receipt = await runtime.prepareExternalContentObservation({
        targetTx,
        space,
        cause: "external-content-matching-delegations",
        schema: PUBLIC_RESULT_SCHEMA,
        value: "public",
        producer: PRODUCER,
      });

      expect(receipt).toEqual({});
      targetTx.abort("test complete");
    });
  });

  it("refuses when module delegations change before admission", async () => {
    await withRuntime(async (runtime) => {
      const targetTx = runtime.edit();
      identifyProducer(targetTx);
      runtime.registerModuleDelegations(
        space,
        new Map([["module:successor", new Set(["module:predecessor"])]]),
      );

      try {
        await expect(runtime.prepareExternalContentObservation({
          targetTx,
          space,
          cause: "external-content-changed-delegations",
          schema: PUBLIC_RESULT_SCHEMA,
          value: "public",
          producer: PRODUCER,
        })).rejects.toThrow(/admission context changed/);
      } finally {
        targetTx.abort("test complete");
      }
    });
  });

  it("refuses module delegations from a different space", async () => {
    await withRuntime(async (runtime) => {
      runtime.registerModuleDelegations(
        space,
        new Map([["module:successor", new Set(["module:predecessor"])]]),
      );
      const targetTx = runtime.edit();
      identifyProducer(targetTx);
      interceptObservationProbeState(
        runtime,
        (phase, state) =>
          phase === "initial"
            ? {
              ...state,
              moduleDelegations: new Map([[
                `${space}:other` as typeof space,
                new Map([
                  ["module:successor", ["module:predecessor"]],
                ]),
              ]]),
            }
            : state,
      );

      try {
        await expect(runtime.prepareExternalContentObservation({
          targetTx,
          space,
          cause: "external-content-different-delegation-space",
          schema: PUBLIC_RESULT_SCHEMA,
          value: "public",
          producer: PRODUCER,
        })).rejects.toThrow(/admission context changed/);
      } finally {
        targetTx.abort("test complete");
      }
    });
  });

  it("refuses changed predecessor authority within a module delegation", async () => {
    await withRuntime(async (runtime) => {
      runtime.registerModuleDelegations(
        space,
        new Map([["module:successor", new Set(["module:predecessor"])]]),
      );
      const targetTx = runtime.edit();
      identifyProducer(targetTx);
      interceptObservationProbeState(
        runtime,
        (phase, state) =>
          phase === "initial"
            ? {
              ...state,
              moduleDelegations: new Map([[
                space,
                new Map([
                  ["module:successor", ["module:other"]],
                ]),
              ]]),
            }
            : state,
      );

      try {
        await expect(runtime.prepareExternalContentObservation({
          targetTx,
          space,
          cause: "external-content-changed-delegation-authority",
          schema: PUBLIC_RESULT_SCHEMA,
          value: "public",
          producer: PRODUCER,
        })).rejects.toThrow(/admission context changed/);
      } finally {
        targetTx.abort("test complete");
      }
    });
  });

  it("refuses a probe that is not prepared after its initial write gate", async () => {
    await withRuntime(async (runtime) => {
      const targetTx = runtime.edit();
      identifyProducer(targetTx);
      interceptObservationProbeState(
        runtime,
        (phase, state) =>
          phase === "initial"
            ? {
              ...state,
              prepare: { status: "invalidated", reasons: ["test"] },
            }
            : state,
      );

      try {
        await expect(runtime.prepareExternalContentObservation({
          targetTx,
          space,
          cause: "external-content-initial-refusal",
          schema: PUBLIC_RESULT_SCHEMA,
          value: "public",
          producer: PRODUCER,
        })).rejects.toThrow(/CFC refused the external content observation/);
      } finally {
        targetTx.abort("test complete");
      }
    });
  });

  it("refuses mutable policy evidence during initial admission", async () => {
    await withRuntime(async (runtime) => {
      const targetTx = runtime.edit();
      identifyProducer(targetTx);
      interceptObservationProbeState(
        runtime,
        (phase, state) =>
          phase === "initial"
            ? {
              ...state,
              consultedGrants: [{ space, id: "grant", digest: "digest" }],
            }
            : state,
      );

      try {
        await expect(runtime.prepareExternalContentObservation({
          targetTx,
          space,
          cause: "external-content-initial-mutable-evidence",
          schema: PUBLIC_RESULT_SCHEMA,
          value: "public",
          producer: PRODUCER,
        })).rejects.toThrow(/admission depends on mutable policy evidence/);
      } finally {
        targetTx.abort("test complete");
      }
    });
  });

  it("refuses mutable policy evidence discovered during traversal", async () => {
    await withRuntime(async (runtime) => {
      const targetTx = runtime.edit();
      identifyProducer(targetTx);
      interceptObservationProbeState(
        runtime,
        (phase, state) =>
          phase === "traversal"
            ? {
              ...state,
              consultedGrants: [{ space, id: "grant", digest: "digest" }],
            }
            : state,
      );

      try {
        await expect(runtime.prepareExternalContentObservation({
          targetTx,
          space,
          cause: "external-content-traversal-mutable-evidence",
          schema: PUBLIC_RESULT_SCHEMA,
          value: "public",
          producer: PRODUCER,
        })).rejects.toThrow(/traversal depends on mutable policy evidence/);
      } finally {
        targetTx.abort("test complete");
      }
    });
  });

  it("refuses a posture change discovered during traversal", async () => {
    await withRuntime(async (runtime) => {
      const targetTx = runtime.edit();
      identifyProducer(targetTx);
      interceptObservationProbeState(
        runtime,
        (phase, state) =>
          phase === "traversal"
            ? { ...state, enforcementMode: "enforce-strict" }
            : state,
      );

      try {
        await expect(runtime.prepareExternalContentObservation({
          targetTx,
          space,
          cause: "external-content-traversal-posture-change",
          schema: PUBLIC_RESULT_SCHEMA,
          value: "public",
          producer: PRODUCER,
        })).rejects.toThrow(/context changed during traversal/);
      } finally {
        targetTx.abort("test complete");
      }
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
      setCfcTrustSnapshot(targetTx, {
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
        expect(preparedDigestFor({
          ...prepared.input,
          externalContentObservations: [],
        })).toBe(preparedDigestFor({
          ...prepared.input,
          externalContentObservations: undefined,
        }));
      }
      freshTx.abort("test complete");
    });
  });
});
