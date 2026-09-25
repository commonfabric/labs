import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";

import { internSchema } from "@commonfabric/data-model-schema";
import { Identity } from "@commonfabric/identity";
import type { MemorySpace, URI } from "@commonfabric/memory/interface";
import * as MemoryV2Client from "@commonfabric/memory/v2/client";
import * as MemoryV2Server from "@commonfabric/memory/v2/server";

import {
  SEED_ENVELOPE_SCHEMA_HASH,
  seedStoredEnvelope,
  writeSeedEnvelopeDoc,
} from "./cfc-seed-envelope.ts";
import type { JSONSchema, Pattern } from "../src/builder/types.ts";
import { createCell } from "../src/cell.ts";
import {
  readStoredCfcMetadata,
  storedCfcMetadataAppliesToPath,
} from "../src/cfc/metadata.ts";
import type { IFCLabel } from "../src/cfc/mod.ts";
import {
  canonicalizeCfcMetadata,
  canonicalizePreparedDigestInput,
  canonicalizeWritePolicyInput,
  logicalPathToPointer,
  preparedDigestFor,
} from "../src/cfc/mod.ts";
import {
  CFC_STRUCTURAL_PROVENANCE_RUNTIME_OWNED_STORE,
  CFC_STRUCTURAL_PROVENANCE_SETUP_PROJECTION,
  type CfcEnforcementMode,
  runtimeWritePolicyAuthorization,
} from "../src/cfc/types.ts";
import { diffAndUpdate } from "../src/data-updating.ts";
import type { NormalizedFullLink } from "../src/link-types.ts";
import {
  createSigilLinkFromParsedLink,
  getDerivedInternalCellLink,
  getMetaLink,
  parseLink,
  toMemorySpaceAddress,
} from "../src/link-utils.ts";
import { raw } from "../src/module.ts";
import { setResultCell } from "../src/result-utils.ts";
import { Runtime } from "../src/runtime.ts";
import { ignoreReadForScheduling } from "../src/scheduler.ts";
import { LINK_V1_TAG } from "../src/sigil-types.ts";
import { StorageManager } from "../src/storage/cache.deno.ts";
import { internalVerifierRead } from "../src/storage/reactivity-log.ts";
import type { ExtendedStorageTransaction } from "../src/storage/extended-storage-transaction.ts";
import type {
  IExtendedStorageTransaction,
  IMemorySpaceAddress,
} from "../src/storage/interface.ts";
import * as V2Storage from "../src/storage/v2.ts";
import {
  TEST_MEMORY_SERVER_AUTH,
  testSessionOpenAuthFactory,
} from "./memory-v2-test-utils.ts";
import { rawMetaWriteAuthorization } from "../src/meta-seam.ts";
import { isCfcEnforcementRejection } from "../src/storage/rejection.ts";
import { refuseAtCommitBoundary } from "./refused-commit.ts";
import type { FabricValue } from "@commonfabric/data-model";
import {
  setCfcImplementationIdentity,
  setCfcTrustSnapshot,
} from "../src/storage/extended-storage-transaction.ts";

const signer = await Identity.fromPassphrase("runner-cfc-boundary-tests");

// Seed stored CFC metadata with a path-[] full-document write, reading the
// current doc first so the value survives. Every write that reaches a
// document's reserved siblings from outside the runtime's privileged
// persistence scope is recorded as label forgery (audit S18), so the seed
// goes through `seedStoredEnvelope`, which runs inside that scope.
const seedPrivilegedCfc = (
  tx: unknown,
  address: unknown,
  metadata: unknown,
): void => {
  const t = tx as IExtendedStorageTransaction;
  const docAddress = {
    ...(address as Record<string, unknown>),
    path: [],
  } as unknown as IMemorySpaceAddress;
  let current: unknown;
  try {
    current = t.readOrThrow(docAddress);
  } catch {
    current = undefined;
  }
  const base = current && typeof current === "object" ? current : {};
  seedStoredEnvelope(t, docAddress, {
    ...base,
    cfc: metadata,
  } as FabricValue);
};

class SharedV2SessionFactory implements V2Storage.SessionFactory {
  readonly #server: MemoryV2Server.Server;

  constructor(server: MemoryV2Server.Server) {
    this.#server = server;
  }

  async create(space: MemorySpace) {
    const client = await MemoryV2Client.connect({
      transport: MemoryV2Client.loopback(this.#server),
    });
    const session = await client.mount(space, {}, testSessionOpenAuthFactory);
    return { client, session };
  }
}

class SharedV2StorageManager extends V2Storage.StorageManager {
  constructor(options: V2Storage.Options, server: MemoryV2Server.Server) {
    super(options, new SharedV2SessionFactory(server));
  }
}

describe("CFC canonicalization helpers", () => {
  it("strips the value wrapper and sorts metadata entries canonically", () => {
    const metadata = canonicalizeCfcMetadata({
      version: 1,
      schemaHash: "abc",
      labelMap: {
        version: 1,
        entries: [
          { path: ["value", "b"], label: { confidentiality: ["secret"] } },
          {
            path: ["value", "a"],
            label: { confidentiality: ["confidential"] },
          },
        ],
      },
    });

    expect(metadata.labelMap.entries.map((entry) => entry.path)).toEqual([
      ["a"],
      ["b"],
    ]);
    expect(logicalPathToPointer(["value", "a"])).toBe("/a");
  });

  it("canonicalizes write-policy input deterministically", () => {
    const canonical = canonicalizeWritePolicyInput({
      kind: "structural-provenance",
      target: {
        space: signer.did(),
        scope: "space",
        id: "of:target",
        path: ["value", "items"],
      },
      claim: "projection",
      sources: [
        {
          space: signer.did(),
          scope: "space",
          id: "of:b",
          path: ["value", "items", "1"],
        },
        {
          space: signer.did(),
          scope: "space",
          id: "of:a",
          path: ["value", "items", "0"],
        },
      ],
    });

    expect(canonical).toMatchObject({
      target: { path: ["items"] },
      sources: [{ id: "of:a", path: ["items", "0"] }, {
        id: "of:b",
        path: ["items", "1"],
      }],
    });
  });

  it("canonicalizes prepared digest input independently of insertion order", () => {
    const input = canonicalizePreparedDigestInput({
      consumedReads: [{
        space: signer.did(),
        scope: "space",
        id: "of:doc",
        path: ["value", "z"],
      }, {
        space: signer.did(),
        scope: "space",
        id: "of:doc",
        path: ["value", "a"],
      }],
      attemptedWrites: [],
      writes: [],
      // Deliberately out of clock order: the attempt log canonicalizes BY
      // journalIndex (order-preserving), never by address.
      writeAttemptLog: [{
        space: signer.did(),
        scope: "space",
        id: "of:doc",
        path: ["value", "a"],
        journalIndex: 3,
      }, {
        space: signer.did(),
        scope: "space",
        id: "of:doc",
        path: ["value", "z"],
        journalIndex: 1,
      }],
      dereferenceTraces: [],
      triggerReads: [],
      writePolicyInputs: [{
        kind: "custom",
        name: "b",
        value: 2,
      }, {
        kind: "custom",
        name: "a",
        value: 1,
      }],
    });

    expect(input.consumedReads.map((read) => read.path)).toEqual([
      ["a"],
      ["z"],
    ]);
    // Sorted by journalIndex (temporal order), paths verbatim (raw, no
    // leading-"value" strip) — the §6 order binding, not an address sort.
    expect(
      input.writeAttemptLog.map((attempt) => ({
        path: attempt.path,
        journalIndex: attempt.journalIndex,
      })),
    ).toEqual([
      { path: ["value", "z"], journalIndex: 1 },
      { path: ["value", "a"], journalIndex: 3 },
    ]);
    expect(
      input.writePolicyInputs.map((item) =>
        item.kind === "custom" ? item.name : ""
      ),
    ).toEqual(["a", "b"]);
  });

  it("binds delegation space while canonicalizing delegation order", () => {
    const spaceA = signer.did();
    const spaceB = "did:key:z6MkPreparedDigestOtherSpace" as MemorySpace;
    const base = {
      consumedReads: [],
      attemptedWrites: [],
      writes: [],
      writeAttemptLog: [],
      dereferenceTraces: [],
      triggerReads: [],
      writePolicyInputs: [],
    };

    expect(preparedDigestFor({
      ...base,
      moduleDelegations: [{
        space: spaceA,
        moduleIdentity: "successor",
        delegatedModuleIdentities: ["predecessor"],
      }],
    })).not.toBe(preparedDigestFor({
      ...base,
      moduleDelegations: [{
        space: spaceB,
        moduleIdentity: "successor",
        delegatedModuleIdentities: ["predecessor"],
      }],
    }));

    const ordered = preparedDigestFor({
      ...base,
      moduleDelegations: [{
        space: spaceB,
        moduleIdentity: "z-successor",
        delegatedModuleIdentities: ["z-predecessor", "a-predecessor"],
      }, {
        space: spaceA,
        moduleIdentity: "a-successor",
        delegatedModuleIdentities: ["predecessor"],
      }],
    });
    const reversed = preparedDigestFor({
      ...base,
      moduleDelegations: [{
        space: spaceA,
        moduleIdentity: "a-successor",
        delegatedModuleIdentities: ["predecessor"],
      }, {
        space: spaceB,
        moduleIdentity: "z-successor",
        delegatedModuleIdentities: ["a-predecessor", "z-predecessor"],
      }],
    });
    expect(reversed).toBe(ordered);
  });

  it("canonicalizes link-write policy input paths", () => {
    const canonical = canonicalizeWritePolicyInput({
      kind: "link-write",
      target: {
        space: signer.did(),
        scope: "space",
        id: "of:target",
        path: ["value", "bookmark"],
      },
      source: {
        space: signer.did(),
        scope: "space",
        id: "of:source",
        path: ["value", "title"],
      },
    });

    expect(canonical).toMatchObject({
      target: { path: ["bookmark"] },
      source: { path: ["title"] },
    });
  });
});

describe("ExtendedStorageTransaction CFC gate", () => {
  // Characterization posture: the cases below describe what the gate does at
  // the explicit rung with every other dial down, so the suite states that
  // whole row rather than reaching it by inheritance. Every dial in
  // RUNTIME_CFC_DIAL_DEFAULTS appears here; a mode passed by a test overrides
  // the enforcement mode.
  const characterizationCfcPosture = {
    cfcEnforcementMode: "enforce-explicit",
    cfcFlowLabels: "off",
    cfcWriteFloor: "off",
    cfcTriggerReadGating: false,
    cfcDecomposedEnvelopes: false,
    cfcPolicyEvaluation: "off",
    cfcLabelMetadataProtection: "off",
    cfcDeclaredMonotonicity: "off",
  } as const;

  const createRuntime = (cfcEnforcementMode?: CfcEnforcementMode) => {
    const storageManager = StorageManager.emulate({
      as: signer,
    });
    const runtime = new Runtime({
      apiUrl: new URL("https://example.com"),
      storageManager,
      ...characterizationCfcPosture,
      ...(cfcEnforcementMode ? { cfcEnforcementMode } : {}),
    });
    return { runtime, storageManager };
  };

  it("allows setup to install alias-backed CFC result projections", async () => {
    const storageManager = StorageManager.emulate({
      as: signer,
    });
    const runtime = new Runtime({
      apiUrl: new URL("https://example.com"),
      storageManager,
      ...characterizationCfcPosture,
      trustSnapshotProvider: () => ({
        id: "trust-snapshot-setup",
        actingPrincipal: signer.did(),
      }),
    });
    try {
      const resultSchema = {
        type: "object",
        properties: {
          savedTitle: {
            type: "string",
            ifc: {
              writeAuthorizedBy: {
                __ctWriterIdentityOf: {
                  file: "/main.tsx",
                  path: ["commitTrustedSaveTitle"],
                },
              },
            },
          },
        },
        required: ["savedTitle"],
      } as const satisfies JSONSchema;
      const pattern = {
        argumentSchema: { type: "object", properties: {} } as const,
        resultSchema,
        derivedInternalCells: [{
          partialCause: "savedTitle",
          schema: { type: "string", default: "" },
        }],
        result: {
          savedTitle: { $alias: { partialCause: "savedTitle", path: [] } },
        },
        nodes: [],
      } satisfies Pattern;
      const resultCell = runtime.getCell(
        signer.did(),
        "cfc-setup-projection",
        resultSchema,
      );

      await runtime.setup(undefined, pattern, {}, resultCell);

      // A hand-built pattern is KEYLESS: setup stamps no durable pattern
      // pointer for it (the never-durable contract; L3(a), RULED 2026-08-27).
      // The staged argument link is the setup-completed evidence instead.
      expect(resultCell.getMetaRaw("patternIdentity"))
        .toBeUndefined();
      expect(parseLink(resultCell.getMetaRaw("argument"), resultCell))
        .toBeDefined();
      const savedTitleLink = parseLink(resultCell.key("savedTitle").getRaw());
      const savedTitleDerivedLink = getDerivedInternalCellLink(resultCell, {
        partialCause: "savedTitle",
      });
      expect(savedTitleLink?.id).toBe(savedTitleDerivedLink?.id);
      expect(savedTitleLink?.path).toEqual([]);

      const replica = storageManager.open(signer.did()).replica as unknown as {
        getDocument(id: string): {
          cfc?: {
            labelMap?: {
              entries: Array<{
                path: string[];
                label: Record<string, unknown>;
              }>;
            };
          };
        } | undefined;
      };
      const persisted = replica.getDocument(
        parseLink(resultCell.getAsLink()).id!,
      );
      expect(persisted?.cfc?.labelMap?.entries).toContainEqual({
        path: ["savedTitle"],
        label: {},
        origin: "declared",
      });
    } finally {
      await runtime.dispose();
      await storageManager.close();
    }
  });

  it("allows setup to install alias-backed CFC projections when the result cell is initially untyped", async () => {
    const storageManager = StorageManager.emulate({
      as: signer,
    });
    const runtime = new Runtime({
      apiUrl: new URL("https://example.com"),
      storageManager,
      ...characterizationCfcPosture,
      trustSnapshotProvider: () => ({
        id: "trust-snapshot-setup-untyped",
        actingPrincipal: signer.did(),
      }),
    });
    try {
      const resultSchema = {
        type: "object",
        properties: {
          savedTitle: {
            type: "string",
            ifc: {
              writeAuthorizedBy: {
                __ctWriterIdentityOf: {
                  file: "/main.tsx",
                  path: ["commitTrustedSaveTitle"],
                },
              },
            },
          },
        },
        required: ["savedTitle"],
      } as const satisfies JSONSchema;
      const pattern = {
        argumentSchema: { type: "object", properties: {} } as const,
        resultSchema,
        derivedInternalCells: [{
          partialCause: "savedTitle",
          schema: { type: "string", default: "" },
        }],
        result: {
          savedTitle: { $alias: { partialCause: "savedTitle", path: [] } },
        },
        nodes: [],
      } satisfies Pattern;
      const resultCell = runtime.getCell(
        signer.did(),
        "cfc-setup-projection-untyped",
        undefined,
      );

      await runtime.setup(undefined, pattern, {}, resultCell);

      expect(getMetaLink(resultCell, "result")).toBeUndefined();
      // A hand-built pattern is KEYLESS: setup stamps no durable pattern
      // pointer for it (the never-durable contract; L3(a), RULED 2026-08-27).
      // The staged argument link is the setup-completed evidence instead.
      expect(resultCell.getMetaRaw("patternIdentity"))
        .toBeUndefined();
      expect(parseLink(resultCell.getMetaRaw("argument"), resultCell))
        .toBeDefined();
      const savedTitleLink = parseLink(resultCell.key("savedTitle").getRaw());
      const internalManifest = resultCell.getMetaRaw("internal");
      expect(internalManifest).toBeDefined();
      expect(savedTitleLink?.path).toEqual([]);

      const replica = storageManager.open(signer.did()).replica as unknown as {
        getDocument(id: string): {
          cfc?: {
            labelMap?: {
              entries: Array<{
                path: string[];
                label: Record<string, unknown>;
              }>;
            };
          };
        } | undefined;
      };
      const persisted = replica.getDocument(
        parseLink(resultCell.getAsLink()).id!,
      );
      expect(persisted?.cfc?.labelMap?.entries).toContainEqual({
        path: ["savedTitle"],
        label: {},
        origin: "declared",
      });
    } finally {
      await runtime.dispose();
      await storageManager.close();
    }
  });

  it("rejects setup constants for writeAuthorizedBy CFC outputs", async () => {
    const storageManager = StorageManager.emulate({
      as: signer,
    });
    const runtime = new Runtime({
      apiUrl: new URL("https://example.com"),
      storageManager,
      ...characterizationCfcPosture,
      trustSnapshotProvider: () => ({
        id: "trust-snapshot-setup",
        actingPrincipal: signer.did(),
      }),
    });
    try {
      const resultSchema = {
        type: "object",
        properties: {
          savedTitle: {
            type: "string",
            ifc: {
              writeAuthorizedBy: {
                __ctWriterIdentityOf: {
                  file: "/main.tsx",
                  path: ["commitTrustedSaveTitle"],
                },
              },
            },
          },
        },
        required: ["savedTitle"],
      } as const satisfies JSONSchema;
      const pattern = {
        argumentSchema: { type: "object", properties: {} } as const,
        resultSchema,
        result: {
          savedTitle: "not user authorized",
        },
        nodes: [],
      } satisfies Pattern;
      const resultCell = runtime.getCell(
        signer.did(),
        "cfc-setup-constant",
        resultSchema,
      );

      await expect(runtime.setup(undefined, pattern, {}, resultCell)).rejects
        .toThrow("CFC enforcement rejected commit");
      expect(getMetaLink(resultCell, "result")).toBeUndefined();

      // The setup boundary re-wraps the rejection as a plain Error, so the
      // refusal reasons survive only if they are carried onto the cause.
      // The boundary refusal carries every reason as `reasons`; reading the
      // digest-drift `reason` instead would drop them silently.
      const rejection = await runtime.setup(undefined, pattern, {}, resultCell)
        .then(() => undefined, (error: unknown) => error as Error);
      expect(rejection?.cause).toBeDefined();
      expect(Array.isArray(rejection?.cause)).toBe(true);
      expect((rejection?.cause as string[]).join(" ")).toContain(
        "writeAuthorizedBy requires a trusted verified binding identity",
      );
    } finally {
      await runtime.dispose();
      await storageManager.close();
    }
  });

  it("rejects forged setup projection provenance for writeAuthorizedBy constants", async () => {
    const storageManager = StorageManager.emulate({
      as: signer,
    });
    const runtime = new Runtime({
      apiUrl: new URL("https://example.com"),
      storageManager,
      ...characterizationCfcPosture,
      trustSnapshotProvider: () => ({
        id: "trust-snapshot-setup-forged-projection",
        actingPrincipal: signer.did(),
      }),
    });
    try {
      const tx = runtime.edit();
      const schema = {
        type: "object",
        properties: {
          savedTitle: {
            type: "string",
            ifc: {
              writeAuthorizedBy: {
                __ctWriterIdentityOf: {
                  file: "/main.tsx",
                  path: ["commitTrustedSaveTitle"],
                },
              },
            },
          },
        },
        required: ["savedTitle"],
      } as const satisfies JSONSchema;
      const cell = runtime.getCell(
        signer.did(),
        "cfc-setup-forged-projection",
        schema,
        tx,
      );
      cell.set({ savedTitle: "not user authorized" });
      const target = cell.getAsNormalizedFullLink();
      tx.recordCfcWritePolicyInput({
        kind: "structural-provenance",
        claim: CFC_STRUCTURAL_PROVENANCE_SETUP_PROJECTION,
        target: {
          space: target.space,
          scope: "space",
          id: target.id,
          path: ["savedTitle"],
        },
        sources: [{
          space: signer.did(),
          scope: "space",
          id: "of:source",
          path: ["internal", "savedTitle"],
        }],
      });

      tx.prepareCfc();
      const result = await tx.commit();
      expect(result.error?.message).toContain(
        "writeAuthorizedBy requires a trusted verified binding identity",
      );
    } finally {
      await runtime.dispose();
      await storageManager.close();
    }
  });

  it("does not let setup projection provenance bypass uiContract requirements", async () => {
    const storageManager = StorageManager.emulate({
      as: signer,
    });
    const runtime = new Runtime({
      apiUrl: new URL("https://example.com"),
      storageManager,
      ...characterizationCfcPosture,
    });
    try {
      const tx = runtime.edit();
      const schema = {
        type: "string",
        ifc: {
          uiContract: {
            helper: "UiAction",
            action: "TrustedSave",
          },
        },
      } as const satisfies JSONSchema;
      const cell = runtime.getCell(
        signer.did(),
        "cfc-setup-ui-contract-bypass",
        schema,
        tx,
      );
      cell.set("saved");
      const target = cell.getAsNormalizedFullLink();
      tx.recordCfcWritePolicyInput({
        kind: "structural-provenance",
        claim: CFC_STRUCTURAL_PROVENANCE_SETUP_PROJECTION,
        target: {
          space: target.space,
          scope: "space",
          id: target.id,
          path: [],
        },
        sources: [{
          space: signer.did(),
          scope: "space",
          id: "of:source",
          path: ["internal", "saved"],
        }],
      });

      tx.prepareCfc();
      const result = await tx.commit();
      expect(result.error?.message).toContain(
        "missing trusted-event policy input",
      );
    } finally {
      await runtime.dispose();
      await storageManager.close();
    }
  });

  // A setup that runs a second time over its own stored projection — a cold
  // start replaying the pattern a stored piece already names — re-stages the
  // redirect the document holds. Every value it stages is the one already
  // there, so the transaction ends with no write detail for the document,
  // while the whole-document staging still registers an attempted write at
  // the root and brings every uiContract field under it into the gate. The
  // two tests below hold the line the marker draws there: what it exempts is
  // the projection it names, and only where that projection really is.
  describe("uiContract fields under a replayed setup projection", () => {
    const projectedSchema = {
      type: "object",
      properties: {
        savedTitle: {
          type: "string",
          ifc: {
            uiContract: {
              helper: "UiAction",
              action: "TrustedSave",
            },
          },
        },
      },
      required: ["savedTitle"],
    } as const satisfies JSONSchema;

    const sourceId = (runtime: Runtime) =>
      runtime.getCell(signer.did(), "cfc-setup-replay-source", undefined)
        .getAsNormalizedFullLink().id;

    const setupProjectionMarker = (
      projected: NormalizedFullLink,
      source: URI,
    ) => ({
      kind: "structural-provenance" as const,
      claim: CFC_STRUCTURAL_PROVENANCE_SETUP_PROJECTION,
      target: {
        space: projected.space,
        scope: "space" as const,
        id: projected.id,
        path: ["savedTitle"],
      },
      sources: [{
        space: signer.did(),
        scope: "space" as const,
        id: source,
        path: ["savedTitle"],
      }],
    });

    // Instantiate the projection, then hand back what a replay re-stages: the
    // document now holding a write redirect at its uiContract field, and that
    // same redirect.
    const instantiate = async (runtime: Runtime) => {
      const tx = runtime.edit();
      const source = runtime.getCell(
        signer.did(),
        "cfc-setup-replay-source",
        { type: "object", properties: { savedTitle: { type: "string" } } },
        tx,
      );
      source.set({ savedTitle: "" });
      const projected = runtime.getCell(
        signer.did(),
        "cfc-setup-replay",
        projectedSchema,
        tx,
      );
      const projectedLink = projected.getAsNormalizedFullLink();
      const redirect = createSigilLinkFromParsedLink(
        source.key("savedTitle").getAsNormalizedFullLink(),
        { overwrite: "redirect" },
      );
      diffAndUpdate(
        runtime,
        tx,
        projectedLink,
        { savedTitle: redirect },
        projectedLink,
      );
      tx.recordCfcWritePolicyInput(
        setupProjectionMarker(projectedLink, sourceId(runtime)),
      );
      tx.prepareCfc();
      expect((await tx.commit()).error).toBeUndefined();
      return { projectedLink, redirect };
    };

    // Stage the stored projection again the way `Runner`'s reuse path does:
    // the whole argument through the cell, then the per-field diff.
    const replay = (
      runtime: Runtime,
      tx: IExtendedStorageTransaction,
      projectedLink: NormalizedFullLink,
      redirect: unknown,
    ) => {
      runtime.getCellFromLink<unknown>(projectedLink, projectedSchema, tx).set({
        savedTitle: redirect,
      });
      diffAndUpdate(
        runtime,
        tx,
        projectedLink,
        { savedTitle: redirect },
        projectedLink,
      );
    };

    it("admits a replay whose marker names the stored redirect", async () => {
      const { runtime, storageManager } = createRuntime();
      try {
        const { projectedLink, redirect } = await instantiate(runtime);

        const tx = runtime.edit();
        replay(runtime, tx, projectedLink, redirect);
        tx.recordCfcWritePolicyInput(
          setupProjectionMarker(projectedLink, sourceId(runtime)),
        );
        tx.prepareCfc();
        expect((await tx.commit()).error).toBeUndefined();
      } finally {
        await runtime.dispose({ closeStorage: false });
        await storageManager.close();
      }
    });

    it("refuses a marked write that drops the field", async () => {
      const { runtime, storageManager } = createRuntime();
      try {
        const { projectedLink } = await instantiate(runtime);

        // Staging the document without the field REMOVES the projection
        // rather than replaying it, and a removal is a write like any other.
        // It records no write detail at the path, the same as a replay that
        // changed nothing; what separates them is that the gate reads the
        // path THROUGH the transaction, so the removal reads as removed and
        // the marker has no projection left to vouch for.
        const tx = runtime.edit();
        runtime.getCellFromLink<unknown>(projectedLink, undefined, tx).set({});
        diffAndUpdate(runtime, tx, projectedLink, {}, projectedLink);
        tx.recordCfcWritePolicyInput(
          setupProjectionMarker(projectedLink, sourceId(runtime)),
        );
        tx.prepareCfc();
        expect((await tx.commit()).error?.message).toContain(
          "missing trusted-event policy input",
        );
      } finally {
        await runtime.dispose({ closeStorage: false });
        await storageManager.close();
      }
    });

    it("refuses a replay whose marker names another document", async () => {
      const { runtime, storageManager } = createRuntime();
      try {
        const { projectedLink, redirect } = await instantiate(runtime);

        const tx = runtime.edit();
        replay(runtime, tx, projectedLink, redirect);
        tx.recordCfcWritePolicyInput(
          setupProjectionMarker(projectedLink, "of:elsewhere" as URI),
        );
        tx.prepareCfc();
        expect((await tx.commit()).error?.message).toContain(
          "missing trusted-event policy input",
        );
      } finally {
        await runtime.dispose({ closeStorage: false });
        await storageManager.close();
      }
    });
  });

  it("allows setup to install alias-backed CFC pattern arguments", async () => {
    const storageManager = StorageManager.emulate({
      as: signer,
    });
    const runtime = new Runtime({
      apiUrl: new URL("https://example.com"),
      storageManager,
      ...characterizationCfcPosture,
      trustSnapshotProvider: () => ({
        id: "trust-snapshot-argument-setup",
        actingPrincipal: signer.did(),
      }),
    });
    try {
      const sourceCell = runtime.getCell(
        signer.did(),
        "cfc-setup-argument-source",
        {
          type: "object",
          properties: {
            savedTitle: { type: "string", default: "" },
          },
          required: ["savedTitle"],
        } as const satisfies JSONSchema,
      );
      await runtime.editWithRetry((tx) =>
        sourceCell.withTx(tx).set({ savedTitle: "" })
      );

      const trustedTitleSchema = {
        type: "string",
        default: "",
        ifc: {
          uiContract: {
            helper: "UiAction",
            action: "TrustedSave",
            trustedPattern: "TrustedSaveSurface",
          },
        },
      } as const satisfies JSONSchema;
      const argumentSchema = {
        type: "object",
        properties: {
          savedTitle: trustedTitleSchema,
        },
        required: ["savedTitle"],
      } as const satisfies JSONSchema;
      const pattern = {
        argumentSchema,
        resultSchema: {
          type: "object",
          properties: {},
        } as const satisfies JSONSchema,
        result: {},
        nodes: [],
      } satisfies Pattern;
      const resultCell = runtime.getCell(
        signer.did(),
        "cfc-setup-argument-target",
        undefined,
      );

      await runtime.setup(undefined, pattern, {
        savedTitle: sourceCell.key("savedTitle").getAsWriteRedirectLink({
          includeSchema: true,
        }),
      }, resultCell);

      expect(resultCell.getArgumentCell()).toBeDefined();
      expect(
        (resultCell.getArgumentCell()?.getRaw() as any)?.savedTitle?.[
          "/"
        ]?.["link@1"]?.id,
      ).toBe(sourceCell.getAsNormalizedFullLink().id);
    } finally {
      await runtime.dispose();
      await storageManager.close();
    }
  });

  it("allows first-time uiContract fields to install their schema default", async () => {
    const { runtime, storageManager } = createRuntime();
    try {
      const schema = {
        type: "object",
        properties: {
          argument: {
            type: "object",
            properties: {
              savedTitle: {
                type: "string",
                default: "",
                ifc: {
                  uiContract: {
                    helper: "UiAction",
                    action: "TrustedSave",
                    trustedPattern: "TrustedSaveSurface",
                  },
                },
              },
            },
            required: ["savedTitle"],
          },
        },
      } as const satisfies JSONSchema;

      const tx = runtime.edit();
      tx.setCfcEnforcementMode("enforce-explicit");
      const cell = runtime.getCell(
        signer.did(),
        "cfc-ui-contract-default-setup",
        schema,
        tx,
      );
      cell.set({ argument: { savedTitle: "" } });

      tx.prepareCfc();
      const result = await tx.commit();
      expect(result.ok).toBeDefined();
    } finally {
      await runtime.dispose();
      await storageManager.close();
    }
  });

  it("rejects first-time uiContract fields initialized away from their default", async () => {
    const { runtime, storageManager } = createRuntime();
    try {
      const schema = {
        type: "object",
        properties: {
          argument: {
            type: "object",
            properties: {
              savedTitle: {
                type: "string",
                default: "",
                ifc: {
                  uiContract: {
                    helper: "UiAction",
                    action: "TrustedSave",
                    trustedPattern: "TrustedSaveSurface",
                  },
                },
              },
            },
            required: ["savedTitle"],
          },
        },
      } as const satisfies JSONSchema;

      const tx = runtime.edit();
      tx.setCfcEnforcementMode("enforce-explicit");
      const cell = runtime.getCell(
        signer.did(),
        "cfc-ui-contract-non-default-setup",
        schema,
        tx,
      );
      cell.set({ argument: { savedTitle: "not default" } });

      tx.prepareCfc();
      const result = await tx.commit();
      expect(result.error?.message).toContain(
        "missing trusted-event policy input",
      );
    } finally {
      await runtime.dispose();
      await storageManager.close();
    }
  });

  it("rejects a uiContract field whose Fabric write differs from its Fabric default", async () => {
    // The schema default and the written value are distinct `FabricBytes`
    // (interned from the `Uint8Array`s) that differ only in byte content, so
    // the write does NOT install the default -- the write-policy gate's
    // content comparison must reject it exactly like the "not default" string
    // case above.
    const { runtime, storageManager } = createRuntime();
    try {
      // A schema whose `savedBytes` default is a `Uint8Array` cannot be
      // authored as a plain literal (schema interning deep-freezes it and a raw
      // `Uint8Array` cannot be frozen). Instead, round-trip the schema through
      // a cell read as a query result, which interns the JS `Uint8Array`
      // default into a `FabricBytes` -- the realistic way a `FabricValue`
      // reaches `schema.default` (see
      // query-result-proxy-fabric-primitive.test.ts).
      const schemaSource = {
        type: "object",
        properties: {
          argument: {
            type: "object",
            properties: {
              savedBytes: {
                default: new Uint8Array([1, 2, 3]),
                ifc: {
                  uiContract: {
                    helper: "UiAction",
                    action: "TrustedSave",
                    trustedPattern: "TrustedSaveSurface",
                  },
                },
              },
            },
            required: ["savedBytes"],
          },
        },
      };

      const schemaTx = runtime.edit();
      const schemaCell = runtime.getCell(
        signer.did(),
        "cfc-ui-contract-fabric-schema-source",
        undefined,
        schemaTx,
      );
      schemaCell.set(schemaSource);
      const schema = schemaCell.getAsQueryResult() as JSONSchema;

      const tx = runtime.edit();
      tx.setCfcEnforcementMode("enforce-explicit");
      const cell = runtime.getCell(
        signer.did(),
        "cfc-ui-contract-fabric-non-default-setup",
        schema,
        tx,
      );
      // Write bytes that DIFFER from the default's bytes.
      cell.set({ argument: { savedBytes: new Uint8Array([4, 5, 6]) } });

      tx.prepareCfc();
      const result = await tx.commit();
      expect(result.error?.message).toContain(
        "missing trusted-event policy input",
      );
    } finally {
      await runtime.dispose();
      await storageManager.close();
    }
  });

  it("rejects a refused commit in enforce-explicit mode", async () => {
    // A reserved CFC grant document is policy state that only `writeCfcGrant`
    // may write, so prepare records a verdict over this write and the ladder
    // rejects it.

    const { runtime, storageManager } = createRuntime();
    try {
      const tx = runtime.edit();
      tx.setCfcEnforcementMode("enforce-explicit");
      refuseAtCommitBoundary(tx, signer.did(), "the ladder rejects it");

      const result = await tx.commit();
      expect(result.error?.message).toContain(
        "unprivileged write to protected runtime surface",
      );
    } finally {
      await runtime.dispose();
      await storageManager.close();
    }
  });

  it("prepares a relevant commit nothing prepared, in enforce-explicit mode", async () => {
    // Relevance is computed from what the transaction did, so a caller cannot
    // be the thing that decides whether the ladder sees a prepared
    // transaction. `commit()` runs the prepare (see
    // `docs/specs/cfc-commit-preparation.md`).

    const { runtime, storageManager } = createRuntime();
    try {
      const tx = runtime.edit();
      tx.setCfcEnforcementMode("enforce-explicit");
      tx.markCfcRelevant("test");
      tx.writeValueOrThrow({
        space: signer.did(),
        scope: "space",
        id: "of:cfc-enforce",
        path: [],
      }, { ok: true });

      expect((await tx.commit()).error).toBeUndefined();
      expect(tx.getCfcState().prepare.status).toBe("prepared");
    } finally {
      await runtime.dispose();
      await storageManager.close();
    }
  });

  it("does not trigger CFC prepare for read-only inspection transactions", async () => {
    const { runtime, storageManager } = createRuntime();
    try {
      const seed = runtime.edit();
      const cell = runtime.getCell(
        signer.did(),
        "cfc-read-only-inspection",
        {
          type: "object",
          properties: {
            secret: {
              type: "string",
              ifc: { confidentiality: ["secret"] },
            },
          },
          required: ["secret"],
        },
        seed,
      );
      cell.set({ secret: "seed" });
      runtime.prepareTxForCommit(seed);
      expect((await seed.commit()).ok).toBeDefined();

      const tx = runtime.readTx();
      const readCell = runtime.getCell(
        signer.did(),
        "cfc-read-only-inspection",
        {
          type: "object",
          properties: {
            secret: {
              type: "string",
              ifc: { confidentiality: ["secret"] },
            },
          },
          required: ["secret"],
        },
        tx,
      );
      expect(readCell.get()).toEqual({ secret: "seed" });

      const result = await tx.commit();
      expect(result.ok).toBeDefined();
      expect(tx.getCfcState().prepare.status).toBe("unprepared");
    } finally {
      await runtime.dispose();
      await storageManager.close();
    }
  });

  it("allows relevant unprepared commits when enforcement is disabled", async () => {
    const { runtime, storageManager } = createRuntime("disabled");
    try {
      const tx = runtime.edit();
      tx.markCfcRelevant("test");
      tx.writeValueOrThrow({
        space: signer.did(),
        scope: "space",
        id: "of:cfc-disabled",
        path: [],
      }, { ok: true });

      const result = await tx.commit();
      expect(result.ok).toBeDefined();
      expect(tx.getCfcState().prepare.status).toBe("unprepared");
    } finally {
      await runtime.dispose();
      await storageManager.close();
    }
  });

  it("allows observe-mode commits without blocking", async () => {
    const { runtime, storageManager } = createRuntime("observe");
    try {
      const tx = runtime.edit();
      tx.markCfcRelevant("test");
      tx.writeValueOrThrow({
        space: signer.did(),
        scope: "space",
        id: "of:cfc-observe",
        path: [],
      }, { ok: true });

      const result = await tx.commit();
      expect(result.ok).toBeDefined();
      expect(tx.getCfcState().prepare.status).toBe("prepared");
    } finally {
      await runtime.dispose();
      await storageManager.close();
    }
  });

  it("rejects a refused commit in enforce-strict mode", async () => {
    const { runtime, storageManager } = createRuntime();
    try {
      const tx = runtime.edit();
      tx.setCfcEnforcementMode("enforce-strict");
      refuseAtCommitBoundary(tx, signer.did(), "the ladder rejects it");

      const result = await tx.commit();
      expect(result.error?.message).toContain(
        "unprivileged write to protected runtime surface",
      );
    } finally {
      await runtime.dispose();
      await storageManager.close();
    }
  });

  it("invalidates prepared state on post-prepare policy changes", async () => {
    const { runtime, storageManager } = createRuntime();
    try {
      const tx = runtime.edit();
      tx.setCfcEnforcementMode("enforce-explicit");
      tx.markCfcRelevant("test");
      tx.writeValueOrThrow({
        space: signer.did(),
        scope: "space",
        id: "of:cfc-prepare",
        path: [],
      }, { count: 1 });

      tx.prepareCfc();
      tx.recordCfcWritePolicyInput({
        kind: "custom",
        name: "schema",
        value: "x",
      });

      expect(tx.getCfcState().prepare.status).toBe("invalidated");
    } finally {
      await runtime.dispose();
      await storageManager.close();
    }
  });

  it("invalidates prepared state on a dereference the transaction had not performed", async () => {
    const { runtime, storageManager } = createRuntime();
    try {
      const tx = runtime.edit();
      tx.setCfcEnforcementMode("enforce-explicit");
      tx.markCfcRelevant("test");
      tx.writeValueOrThrow({
        space: signer.did(),
        scope: "space",
        id: "of:cfc-new-dereference",
        path: [],
      }, { count: 1 });

      tx.prepareCfc();
      tx.recordCfcDereferenceTrace({
        source: {
          space: signer.did(),
          id: "of:cfc-new-dereference",
          scope: "space",
          path: ["slot"],
        },
        target: {
          space: signer.did(),
          id: "of:cfc-new-target",
          scope: "space",
          path: [],
        },
        kind: "value",
      });

      expect(tx.getCfcState().prepare.status).toBe("invalidated");
    } finally {
      await runtime.dispose();
      await storageManager.close();
    }
  });

  it("holds prepared state when a recorded dereference repeats", async () => {
    // The digest binds the dereference SET, so a repeat leaves it untouched
    // and the commit recheck would accept. Invalidating here would reject a
    // transaction on the strength of a re-read alone.
    const { runtime, storageManager } = createRuntime();
    try {
      const tx = runtime.edit();
      tx.setCfcEnforcementMode("enforce-explicit");
      tx.markCfcRelevant("test");
      tx.writeValueOrThrow({
        space: signer.did(),
        scope: "space",
        id: "of:cfc-repeat-dereference",
        path: [],
      }, { count: 1 });

      const hop = {
        source: {
          space: signer.did(),
          id: "of:cfc-repeat-dereference",
          scope: "space" as const,
          // Recorded raw; the repeat below arrives already canonicalized, and
          // the two are the same dereference.
          path: ["value", "slot"],
        },
        target: {
          space: signer.did(),
          id: "of:cfc-repeat-target",
          scope: "space" as const,
          path: [],
        },
        kind: "value" as const,
      };
      tx.recordCfcDereferenceTrace(hop);
      tx.prepareCfc();
      expect(tx.getCfcState().prepare.status).toBe("prepared");

      tx.recordCfcDereferenceTrace({
        ...hop,
        source: { ...hop.source, path: ["slot"] },
      });

      expect(tx.getCfcState().prepare.status).toBe("prepared");
    } finally {
      await runtime.dispose();
      await storageManager.close();
    }
  });

  it("invalidates prepared state on a dereference under a payload field named `value`", async () => {
    // `["value","value","slot"]` is the payload path `value.slot`, a
    // different dereference from `["value","slot"]`'s payload `slot`. Reading
    // the second must still invalidate, or the guard would mistake it for a
    // repeat of the first and hold a decision the digest no longer covers.
    const { runtime, storageManager } = createRuntime();
    try {
      const tx = runtime.edit();
      tx.setCfcEnforcementMode("enforce-explicit");
      tx.markCfcRelevant("test");
      tx.writeValueOrThrow({
        space: signer.did(),
        scope: "space",
        id: "of:cfc-payload-value-field",
        path: [],
      }, { count: 1 });

      const target = {
        space: signer.did(),
        id: "of:cfc-payload-value-target",
        scope: "space" as const,
        path: [],
      };
      tx.recordCfcDereferenceTrace({
        source: {
          space: signer.did(),
          id: "of:cfc-payload-value-field",
          scope: "space",
          path: ["value", "slot"],
        },
        target,
        kind: "value",
      });
      tx.prepareCfc();
      expect(tx.getCfcState().prepare.status).toBe("prepared");

      tx.recordCfcDereferenceTrace({
        source: {
          space: signer.did(),
          id: "of:cfc-payload-value-field",
          scope: "space",
          path: ["value", "value", "slot"],
        },
        target,
        kind: "value",
      });

      expect(tx.getCfcState().prepare.status).toBe("invalidated");
    } finally {
      await runtime.dispose();
      await storageManager.close();
    }
  });

  it("invalidates prepared state when the trust snapshot changes", async () => {
    const { runtime, storageManager } = createRuntime();
    try {
      const tx = runtime.edit();
      tx.setCfcEnforcementMode("enforce-explicit");
      const cell = runtime.getCell(
        signer.did(),
        "cfc-trust-snapshot",
        {
          type: "object",
          properties: {
            secret: {
              type: "string",
              ifc: { confidentiality: ["secret"] },
            },
          },
          required: ["secret"],
        },
        tx,
      );
      cell.set({ secret: "value" });

      setCfcTrustSnapshot(tx, {
        id: "snapshot-a",
        actingPrincipal: signer.did(),
      });
      tx.prepareCfc();
      setCfcTrustSnapshot(tx, {
        id: "snapshot-b",
        actingPrincipal: signer.did(),
      });

      expect(tx.getCfcState().prepare.status).toBe("invalidated");
      const result = await tx.commit();
      expect(result.error?.message).toContain(
        "relevant transaction was not prepared",
      );
    } finally {
      await runtime.dispose();
      await storageManager.close();
    }
  });

  it("invalidates prepared state when the implementation identity changes", async () => {
    const { runtime, storageManager } = createRuntime();
    try {
      const tx = runtime.edit();
      tx.setCfcEnforcementMode("enforce-explicit");
      const cell = runtime.getCell(
        signer.did(),
        "cfc-implementation-identity",
        {
          type: "object",
          properties: {
            secret: {
              type: "string",
              ifc: { confidentiality: ["secret"] },
            },
          },
          required: ["secret"],
        },
        tx,
      );
      cell.set({ secret: "value" });

      setCfcImplementationIdentity(tx, {
        kind: "builtin",
        builtinId: "builtin:a",
      });
      tx.prepareCfc();
      setCfcImplementationIdentity(tx, {
        kind: "builtin",
        builtinId: "builtin:b",
      });

      expect(tx.getCfcState().prepare.status).toBe("invalidated");
      const result = await tx.commit();
      expect(result.error?.message).toContain(
        "relevant transaction was not prepared",
      );
    } finally {
      await runtime.dispose();
      await storageManager.close();
    }
  });

  it("commits a prepared relevant transaction when the digest is unchanged", async () => {
    const { runtime, storageManager } = createRuntime();
    try {
      const tx = runtime.edit();
      tx.setCfcEnforcementMode("enforce-explicit");
      const cell = runtime.getCell(
        signer.did(),
        "cfc-prepared-success",
        {
          type: "object",
          properties: {
            count: {
              type: "number",
              ifc: { confidentiality: ["secret"] },
            },
          },
          required: ["count"],
        },
        tx,
      );
      cell.set({ count: 1 });

      tx.prepareCfc();
      const result = await tx.commit();
      expect(result.ok).toBeDefined();
    } finally {
      await runtime.dispose();
      await storageManager.close();
    }
  });

  it("invalidates prepared state on post-prepare reads and writes", async () => {
    const { runtime, storageManager } = createRuntime();
    try {
      const readTx = runtime.edit();
      readTx.setCfcEnforcementMode("enforce-explicit");
      readTx.markCfcRelevant("test");
      readTx.writeValueOrThrow({
        space: signer.did(),
        scope: "space",
        id: "of:cfc-read-invalidate",
        path: [],
      }, { count: 1 });
      readTx.prepareCfc();
      readTx.readValueOrThrow({
        space: signer.did(),
        scope: "space",
        id: "of:cfc-read-invalidate",
        path: [],
      });
      expect(readTx.getCfcState().prepare.status).toBe("invalidated");

      const writeTx = runtime.edit();
      writeTx.setCfcEnforcementMode("enforce-explicit");
      writeTx.markCfcRelevant("test");
      writeTx.writeValueOrThrow({
        space: signer.did(),
        scope: "space",
        id: "of:cfc-write-invalidate",
        path: [],
      }, { count: 1 });
      writeTx.prepareCfc();
      writeTx.writeValueOrThrow({
        space: signer.did(),
        scope: "space",
        id: "of:cfc-write-invalidate",
        path: [],
      }, { count: 2 });
      expect(writeTx.getCfcState().prepare.status).toBe("invalidated");
    } finally {
      await runtime.dispose();
      await storageManager.close();
    }
  });

  it("flushes outbox effects only after successful commit", async () => {
    const { runtime, storageManager } = createRuntime();
    try {
      const flushed: string[] = [];
      const tx = runtime.edit();
      tx.enqueuePostCommitEffect({
        id: "effect-1",
        kind: "test",
        flush() {
          flushed.push("effect-1");
        },
      });
      tx.writeValueOrThrow({
        space: signer.did(),
        scope: "space",
        id: "of:cfc-outbox",
        path: [],
      }, { ok: true });

      const result = await tx.commit();
      expect(result.ok).toBeDefined();
      expect(flushed).toEqual(["effect-1"]);

      const rejected = runtime.edit();
      refuseAtCommitBoundary(
        rejected,
        signer.did(),
        "an effect must not flush",
      );
      rejected.enqueuePostCommitEffect({
        id: "effect-2",
        kind: "test",
        flush() {
          flushed.push("effect-2");
        },
      });
      const rejectedResult = await rejected.commit();
      expect(isCfcEnforcementRejection(rejectedResult.error)).toBe(true);
      expect(flushed).toEqual(["effect-1"]);

      const throwing = runtime.edit();
      throwing.enqueuePostCommitEffect({
        id: "effect-throws",
        kind: "test",
        flush() {
          flushed.push("effect-throws");
          throw new Error("post-commit effect failed");
        },
      });
      throwing.writeValueOrThrow({
        space: signer.did(),
        scope: "space",
        id: "of:cfc-outbox-effect-throws",
        path: [],
      }, { ok: "committed" });

      let thrown: unknown;
      let throwingResult:
        | Awaited<ReturnType<typeof throwing.commit>>
        | undefined;
      try {
        throwingResult = await throwing.commit();
      } catch (error) {
        thrown = error;
      }
      expect(thrown).toBeUndefined();
      expect(throwingResult?.ok).toBeDefined();
      expect(flushed).toEqual(["effect-1", "effect-throws"]);

      const verify = runtime.edit();
      expect(verify.readOrThrow({
        space: signer.did(),
        scope: "space",
        id: "of:cfc-outbox-effect-throws",
        path: [],
      })).toMatchObject({ value: { ok: "committed" } });
      verify.abort();
    } finally {
      await runtime.dispose();
      await storageManager.close();
    }
  });

  it("clears outbox state on abort", async () => {
    const { runtime, storageManager } = createRuntime();
    try {
      const tx = runtime.edit();
      tx.enqueuePostCommitEffect({
        id: "effect-abort",
        kind: "test",
        flush() {
          throw new Error("should not flush");
        },
      });
      tx.abort("test");
      expect(tx.getCfcState().outbox).toEqual([]);
    } finally {
      await runtime.dispose();
      await storageManager.close();
    }
  });

  it("marks labeled reads as CFC-relevant and leaves unlabeled reads alone", async () => {
    const { runtime, storageManager } = createRuntime();
    try {
      const labeledTx = runtime.edit();
      const labeledCell = runtime.getCell(
        signer.did(),
        "cfc-read-labeled",
        { type: "string", ifc: { confidentiality: ["secret"] } },
        labeledTx,
      );
      labeledCell.get();
      expect(labeledTx.getCfcState().relevant).toBe(true);

      const plainTx = runtime.edit();
      const plainCell = runtime.getCell(
        signer.did(),
        "cfc-read-plain",
        { type: "string" },
        plainTx,
      );
      plainCell.get();
      expect(plainTx.getCfcState().relevant).toBe(false);
    } finally {
      await runtime.dispose();
      await storageManager.close();
    }
  });

  it("keeps unlabeled writes permissive in phase 1 even after a relevant read", async () => {
    const { runtime, storageManager } = createRuntime();
    try {
      const seed = runtime.edit();
      const sourceId = parseLink(
        runtime.getCell(
          signer.did(),
          "cfc-unlabeled-permissive-source",
          {
            type: "object",
            properties: {
              secret: { type: "string" },
            },
          },
        ).getAsLink(),
      ).id!;
      writeSeedEnvelopeDoc(seed, signer.did());
      seedStoredEnvelope(seed, {
        space: signer.did(),
        scope: "space",
        id: sourceId,
        path: [],
      }, {
        value: { secret: "seed" },
        cfc: {
          version: 1,
          schemaHash: SEED_ENVELOPE_SCHEMA_HASH,
          labelMap: {
            version: 1,
            entries: [{
              path: ["secret"],
              label: { confidentiality: ["secret"] },
            }],
          },
        },
      });
      expect((await seed.commit()).ok).toBeDefined();

      const tx = runtime.edit();
      tx.setCfcEnforcementMode("enforce-explicit");
      const source = runtime.getCell(
        signer.did(),
        "cfc-unlabeled-permissive-source",
        {
          type: "object",
          properties: {
            secret: { type: "string" },
          },
        },
        tx,
      );
      expect(source.get()).toEqual({ secret: "seed" });
      expect(tx.getCfcState().relevant).toBe(true);

      const output = runtime.getCell(
        signer.did(),
        "cfc-unlabeled-permissive-target",
        {
          type: "object",
          properties: {
            value: { type: "string" },
          },
        },
        tx,
      );
      output.set({ value: "result" });

      tx.prepareCfc();
      expect((await tx.commit()).ok).toBeDefined();
    } finally {
      await runtime.dispose();
      await storageManager.close();
    }
  });

  it("marks reads as CFC-relevant when stored metadata labels the consumed path", async () => {
    const { runtime, storageManager } = createRuntime();
    try {
      const seededId = parseLink(
        runtime.getCell(
          signer.did(),
          "cfc-stored-read",
          {
            type: "object",
            properties: {
              secret: { type: "string" },
            },
          },
        ).getAsLink(),
      ).id!;

      const seed = runtime.edit();
      writeSeedEnvelopeDoc(seed, signer.did());
      seedStoredEnvelope(seed, {
        space: signer.did(),
        scope: "space",
        id: seededId,
        path: [],
      }, {
        value: { secret: "seed" },
        cfc: {
          version: 1,
          schemaHash: SEED_ENVELOPE_SCHEMA_HASH,
          labelMap: {
            version: 1,
            entries: [{
              path: ["secret"],
              label: { confidentiality: ["secret"] },
            }],
          },
        },
      });
      const seedResult = await seed.commit();
      expect(seedResult.ok).toBeDefined();

      const tx = runtime.edit();
      const cell = runtime.getCell(
        signer.did(),
        "cfc-stored-read",
        {
          type: "object",
          properties: {
            secret: { type: "string" },
          },
        },
        tx,
      );
      expect(cell.key("secret").get()).toEqual("seed");
      expect(tx.getCfcState().relevant).toBe(true);
    } finally {
      await runtime.dispose();
      await storageManager.close();
    }
  });

  it("keeps source-cell traversal reads internal and out of consumed inputs", async () => {
    const { runtime, storageManager } = createRuntime();
    try {
      const seed = runtime.edit();
      const targetId = "of:cfc-internal-source-traversal-target";
      writeSeedEnvelopeDoc(seed, signer.did());
      seed.writeOrThrow(
        {
          space: signer.did(),
          scope: "space",
          id: targetId,
          path: [],
        },
        {
          value: { source: "seed" },
        },
      );
      seedPrivilegedCfc(
        seed,
        {
          space: signer.did(),
          scope: "space",
          id: targetId,
          path: ["cfc"],
        },
        {
          version: 1,
          schemaHash: SEED_ENVELOPE_SCHEMA_HASH,
          labelMap: {
            version: 1,
            entries: [{
              path: ["source"],
              label: { confidentiality: ["secret"] },
            }],
          },
        },
      );
      const seedResult = await seed.commit();
      expect(seedResult.ok).toBeDefined();

      const metadataTx = runtime.edit();
      const targetLink = {
        space: signer.did(),
        scope: "space",
        id: targetId,
        path: [],
      } as const;
      expect(
        storedCfcMetadataAppliesToPath(metadataTx, targetLink),
      ).toBe(true);
      expect(
        storedCfcMetadataAppliesToPath(metadataTx, {
          ...targetLink,
          path: ["source"],
        }),
      ).toBe(true);

      const readActivities = [...(metadataTx as unknown as {
        getReadActivities(): Iterable<{ meta?: unknown }>;
      }).getReadActivities()];
      expect(readActivities).toContainEqual(
        expect.objectContaining({
          path: ["cfc"],
        }),
      );

      const digestInput = (metadataTx as ExtendedStorageTransaction)
        .accessForTestingOnly.buildPreparedDigestInput();
      expect(digestInput.consumedReads).toEqual([]);
      expect(metadataTx.getCfcState().relevant).toBe(false);

      const result = await metadataTx.commit();
      expect(result.ok).toBeDefined();
    } finally {
      await runtime.dispose();
      await storageManager.close();
    }
  });

  it("treats claim-only persisted entries as covering the path", async () => {
    // Persisted labelMap entries with empty labels (i.e., the schema only
    // carried writeAuthorizedBy / uiContract / exactCopyOf claims, no
    // confidentiality or integrity values) must still be recognized as
    // "policy applies on this path"; filtering on `hasLabelValues` would
    // silently bypass enforcement.
    const { runtime, storageManager } = createRuntime();
    try {
      const seededId = parseLink(
        runtime.getCell(
          signer.did(),
          "cfc-stored-claim-only",
          {
            type: "object",
            properties: {
              auditedField: { type: "string" },
            },
          },
        ).getAsLink(),
      ).id!;

      const seed = runtime.edit();
      const targetId = seededId;
      seed.writeOrThrow(
        {
          space: signer.did(),
          scope: "space",
          id: targetId,
          path: ["value"],
        },
        { auditedField: "seed" },
      );
      writeSeedEnvelopeDoc(seed, signer.did());
      seedPrivilegedCfc(
        seed,
        {
          space: signer.did(),
          scope: "space",
          id: targetId,
          path: ["cfc"],
        },
        {
          version: 1,
          schemaHash: SEED_ENVELOPE_SCHEMA_HASH,
          labelMap: {
            version: 1,
            entries: [{
              path: ["auditedField"],
              // Empty label: no confidentiality / integrity values, just
              // the entry itself signaling the path was claim-tagged at
              // persist time.
              label: {},
            }],
          },
        },
      );
      const seedResult = await seed.commit();
      expect(seedResult.ok).toBeDefined();

      const tx = runtime.edit();
      const targetLink = {
        space: signer.did(),
        scope: "space",
        id: targetId,
        path: ["auditedField"],
      } as const;
      expect(storedCfcMetadataAppliesToPath(tx, targetLink)).toBe(true);
      // Parent / prefix paths also see the entry.
      expect(
        storedCfcMetadataAppliesToPath(tx, { ...targetLink, path: [] }),
      ).toBe(true);
    } finally {
      await runtime.dispose();
      await storageManager.close();
    }
  });

  it("marks labeled writes as CFC-relevant", async () => {
    const { runtime, storageManager } = createRuntime();
    try {
      const tx = runtime.edit();
      const cell = runtime.getCell(
        signer.did(),
        "cfc-write-labeled",
        { type: "string", ifc: { confidentiality: ["secret"] } },
        tx,
      );
      cell.set("value");
      expect(tx.getCfcState().relevant).toBe(true);
    } finally {
      await runtime.dispose();
      await storageManager.close();
    }
  });

  it("marks writes as CFC-relevant when stored metadata labels the target path", async () => {
    const { runtime, storageManager } = createRuntime();
    try {
      const seededId = parseLink(
        runtime.getCell(
          signer.did(),
          "cfc-stored-write",
          {
            type: "object",
            properties: {
              secret: { type: "string" },
            },
          },
        ).getAsLink(),
      ).id!;

      const seed = runtime.edit();
      writeSeedEnvelopeDoc(seed, signer.did());
      seedStoredEnvelope(seed, {
        space: signer.did(),
        scope: "space",
        id: seededId,
        path: [],
      }, {
        value: { secret: "seed" },
        cfc: {
          version: 1,
          schemaHash: SEED_ENVELOPE_SCHEMA_HASH,
          labelMap: {
            version: 1,
            entries: [{
              path: ["secret"],
              label: { confidentiality: ["secret"] },
            }],
          },
        },
      });
      const seedResult = await seed.commit();
      expect(seedResult.ok).toBeDefined();

      const tx = runtime.edit();
      const cell = runtime.getCell(
        signer.did(),
        "cfc-stored-write",
        {
          type: "object",
          properties: {
            secret: { type: "string" },
          },
        },
        tx,
      );
      cell.key("secret").set("updated");
      expect(tx.getCfcState().relevant).toBe(true);
    } finally {
      await runtime.dispose();
      await storageManager.close();
    }
  });

  it("allows unlabeled sibling writes in documents with stored CFC metadata", async () => {
    const { runtime, storageManager } = createRuntime();
    try {
      const seededId = parseLink(
        runtime.getCell(
          signer.did(),
          "cfc-stored-sibling-write",
          {
            type: "object",
            properties: {
              secret: { type: "string" },
              pending: { type: "boolean" },
            },
          },
        ).getAsLink(),
      ).id!;

      const seed = runtime.edit();
      seed.setCfcEnforcementMode("enforce-explicit");
      writeSeedEnvelopeDoc(seed, signer.did());
      seedStoredEnvelope(seed, {
        space: signer.did(),
        scope: "space",
        id: seededId,
        path: [],
      }, {
        value: { secret: "seed", pending: false },
        cfc: {
          version: 1,
          schemaHash: SEED_ENVELOPE_SCHEMA_HASH,
          labelMap: {
            version: 1,
            entries: [{
              path: ["secret"],
              label: { confidentiality: ["secret"] },
            }],
          },
        },
      });
      expect((await seed.commit()).ok).toBeDefined();

      const tx = runtime.edit();
      tx.setCfcEnforcementMode("enforce-explicit");
      const cell = runtime.getCell(
        signer.did(),
        "cfc-stored-sibling-write",
        {
          type: "object",
          properties: {
            secret: { type: "string" },
            pending: { type: "boolean" },
          },
        },
        tx,
      );
      cell.key("pending").set(true);
      tx.markCfcRelevant("stored-sibling-write");

      tx.prepareCfc();
      const result = await tx.commit();
      expect(result.ok).toBeDefined();
    } finally {
      await runtime.dispose();
      await storageManager.close();
    }
  });

  it("keeps no-op attempted targets in attemptedWrites for labeled paths", async () => {
    const { runtime, storageManager } = createRuntime();
    try {
      const seed = runtime.edit();
      seed.setCfcEnforcementMode("enforce-explicit");
      const seededCell = runtime.getCell(
        signer.did(),
        "cfc-noop-attempted-write",
        {
          type: "object",
          properties: {
            secret: {
              type: "string",
              ifc: { confidentiality: ["secret"] },
            },
          },
          required: ["secret"],
        },
        seed,
      );
      seededCell.set({ secret: "same" });
      seed.prepareCfc();
      const seedResult = await seed.commit();
      expect(seedResult.ok).toBeDefined();
      const seededId = parseLink(seededCell.getAsLink()).id!;

      const tx = runtime.edit();
      tx.setCfcEnforcementMode("enforce-explicit");
      const cell = runtime.getCell(
        signer.did(),
        "cfc-noop-attempted-write",
        {
          type: "object",
          properties: {
            secret: {
              type: "string",
              ifc: { confidentiality: ["secret"] },
            },
          },
          required: ["secret"],
        },
        tx,
      );
      cell.key("secret").set("same");
      expect(tx.getCfcState().relevant).toBe(true);

      const digestInput = (tx as ExtendedStorageTransaction)
        .accessForTestingOnly.buildPreparedDigestInput();
      expect(digestInput.attemptedWrites).toContainEqual({
        space: signer.did(),
        scope: "space",
        id: seededId,
        path: ["secret"],
      });
      expect(digestInput.writes).toEqual([]);
    } finally {
      await runtime.dispose();
      await storageManager.close();
    }
  });

  it("evaluates target-side policy for no-op attempted writes", async () => {
    const { runtime, storageManager } = createRuntime();
    try {
      const seed = runtime.edit();
      seed.setCfcEnforcementMode("enforce-explicit");
      const seededCell = runtime.getCell(
        signer.did(),
        "cfc-noop-policy-target",
        {
          type: "object",
          properties: {
            value: {
              type: "string",
              ifc: { confidentiality: ["secret"] },
            },
          },
          required: ["value"],
        },
        seed,
      );
      seededCell.set({ value: "same" });
      seed.prepareCfc();
      expect((await seed.commit()).ok).toBeDefined();

      const tx = runtime.edit();
      tx.setCfcEnforcementMode("enforce-explicit");
      const cell = runtime.getCell(
        signer.did(),
        "cfc-noop-policy-target",
        {
          type: "object",
          properties: {
            value: {
              type: "string",
              ifc: { writeAuthorizedBy: ["trusted-handler"] },
            },
          },
          required: ["value"],
        },
        tx,
      );
      cell.set({ value: "same" });
      tx.prepareCfc();
      const result = await tx.commit();
      expect(result.error?.message).toContain(
        "writeAuthorizedBy requires a trusted builtin identity",
      );
    } finally {
      await runtime.dispose();
      await storageManager.close();
    }
  });

  it("does not persist CFC metadata for IFC claims without labels", async () => {
    const { runtime, storageManager } = createRuntime();
    try {
      const tx = runtime.edit();
      tx.setCfcEnforcementMode("enforce-explicit");
      // `flowPrecisionClaim` is a reserved legacy key: nothing mints it, but
      // already-persisted link schemas may embed it, so an ifc entry that is
      // not a label must stay tolerated and must not persist CFC metadata.
      const schema: JSONSchema = {
        type: "array",
        ifc: {
          flowPrecisionClaim: {
            concept:
              "https://commonfabric.org/cfc/concepts/flow-taint-precision",
            claims: [
              { type: "PointwisePresencePreserved" },
              { type: "PointwiseWriteDependency" },
            ],
          },
        },
      } as JSONSchema;
      const cell = runtime.getCell(
        signer.did(),
        "cfc-empty-label-ifc-noop",
        schema,
        tx,
      );
      cell.set([1, 2, 3]);
      runtime.prepareTxForCommit(tx);
      expect((await tx.commit()).ok).toBeDefined();

      const link = cell.getAsNormalizedFullLink();
      const verify = runtime.edit();
      const stored = verify.readOrThrow(toMemorySpaceAddress(link)) as {
        cfc?: unknown;
      };
      expect(stored.cfc).toBeUndefined();
      expect(storedCfcMetadataAppliesToPath(verify, link)).toBe(false);
      verify.abort();
    } finally {
      await runtime.dispose();
      await storageManager.close();
    }
  });

  it("persists cfc metadata and canonical schema documents for prepared writes", async () => {
    const { runtime, storageManager } = createRuntime();
    try {
      const tx = runtime.edit();
      tx.setCfcEnforcementMode("enforce-explicit");
      const cell = runtime.getCell(
        signer.did(),
        "cfc-persisted-write",
        {
          type: "object",
          properties: {
            secret: {
              type: "string",
              ifc: { confidentiality: ["secret"], integrity: ["trusted"] },
            },
          },
        },
        tx,
      );
      cell.set({ secret: "hello" });
      tx.prepareCfc();
      const result = await tx.commit();
      expect(result.ok).toBeDefined();
      const persistedId = parseLink(cell.getAsLink()).id!;

      const replica = storageManager.open(signer.did()).replica as unknown as {
        getDocument(id: string): {
          value?: unknown;
          cfc?: { schemaHash: string; labelMap?: { entries: unknown[] } };
        } | undefined;
      };
      const persisted = replica.getDocument(persistedId);
      expect(persisted?.value).toEqual({ secret: "hello" });
      expect(persisted?.cfc?.schemaHash).toBeDefined();
      expect(persisted?.cfc?.labelMap?.entries.length).toBeGreaterThan(0);
      expect(persisted?.cfc?.labelMap?.entries).toContainEqual({
        path: ["secret"],
        label: {
          confidentiality: ["secret"],
          integrity: ["trusted"],
        },
        origin: "declared",
      });

      const schemaDoc = replica.getDocument(
        `cid:${persisted!.cfc!.schemaHash}`,
      );
      expect(schemaDoc?.value).toBeDefined();

      const readTx = runtime.edit();
      const readCell = runtime.getCell(
        signer.did(),
        "cfc-persisted-write",
        {
          type: "object",
          properties: {
            secret: {
              type: "string",
              ifc: { confidentiality: ["secret"], integrity: ["trusted"] },
            },
          },
        },
        readTx,
      );
      expect(readCell.get()).toEqual({ secret: "hello" });
    } finally {
      await runtime.dispose();
      await storageManager.close();
    }
  });

  it("persists IFC labels for each path that reuses the same schema ref", async () => {
    const { runtime, storageManager } = createRuntime();
    const guardedRef: JSONSchema = { $ref: "#/$defs/Guarded" };
    try {
      const tx = runtime.edit();
      tx.setCfcEnforcementMode("enforce-explicit");
      const cell = runtime.getCell(
        signer.did(),
        "cfc-persisted-reused-ref-labels",
        {
          type: "object",
          properties: {
            first: guardedRef,
            second: guardedRef,
          },
          $defs: {
            Guarded: {
              type: "string",
              ifc: { integrity: ["shared-ref-integrity"] },
            },
          },
        },
        tx,
      );
      cell.set({ first: "one", second: "two" });
      tx.prepareCfc();
      const result = await tx.commit();
      expect(result.ok).toBeDefined();

      const persistedId = parseLink(cell.getAsLink()).id!;
      const replica = storageManager.open(signer.did()).replica as unknown as {
        getDocument(id: string): {
          cfc?: { labelMap?: { entries: unknown[] } };
        } | undefined;
      };
      const entries = replica.getDocument(persistedId)?.cfc?.labelMap?.entries;
      expect(entries).toContainEqual({
        path: ["first"],
        label: { integrity: ["shared-ref-integrity"] },
        origin: "declared",
      });
      expect(entries).toContainEqual({
        path: ["second"],
        label: { integrity: ["shared-ref-integrity"] },
        origin: "declared",
      });
    } finally {
      await runtime.dispose();
      await storageManager.close();
    }
  });

  it("does not conflict when another transaction already wrote the same schema document", async () => {
    const server = new MemoryV2Server.Server(TEST_MEMORY_SERVER_AUTH);
    const storageManagerA = new SharedV2StorageManager({
      as: signer,
      memoryHost: new URL("memory://"),
    }, server);
    const storageManagerB = new SharedV2StorageManager({
      as: signer,
      memoryHost: new URL("memory://"),
    }, server);
    const runtimeA = new Runtime({
      apiUrl: new URL("https://example.com"),
      storageManager: storageManagerA,
      ...characterizationCfcPosture,
    });
    const runtimeB = new Runtime({
      apiUrl: new URL("https://example.com"),
      storageManager: storageManagerB,
      ...characterizationCfcPosture,
    });
    const schema = {
      type: "object",
      properties: {
        name: {
          type: "string",
          ifc: { integrity: ["trusted-profile"] },
        },
      },
      required: ["name"],
    } as const satisfies JSONSchema;

    try {
      const txA = runtimeA.edit();
      txA.setCfcEnforcementMode("enforce-explicit");
      const cellA = runtimeA.getCell(
        signer.did(),
        "cfc-schema-doc-race-a",
        schema,
        txA,
      );
      cellA.set({ name: "Alice" });
      txA.prepareCfc();

      const txB = runtimeB.edit();
      txB.setCfcEnforcementMode("enforce-explicit");
      const cellB = runtimeB.getCell(
        signer.did(),
        "cfc-schema-doc-race-b",
        schema,
        txB,
      );
      cellB.set({ name: "Bob" });
      txB.prepareCfc();
      expect((await txB.commit()).ok).toBeDefined();

      const resultA = await txA.commit();
      expect(resultA.ok).toBeDefined();
    } finally {
      await runtimeA.dispose();
      await runtimeB.dispose();
      await storageManagerA.close();
      await storageManagerB.close();
      await server.close();
    }
  });

  it("persists CFC metadata on the scoped document instance", async () => {
    const { runtime, storageManager } = createRuntime();
    try {
      const tx = runtime.edit();
      tx.setCfcEnforcementMode("enforce-explicit");
      const baseCell = runtime.getCell(
        signer.did(),
        "cfc-scoped-persisted-write",
        {
          type: "object",
          properties: {
            secret: {
              type: "string",
              ifc: { confidentiality: ["secret"], integrity: ["trusted"] },
            },
          },
        },
        tx,
      );
      const scopedCell = createCell(
        runtime,
        { ...baseCell.getAsNormalizedFullLink(), scope: "user" },
        tx,
      );
      scopedCell.set({ secret: "hello" });
      tx.prepareCfc();
      const result = await tx.commit();
      expect(result.ok).toBeDefined();
      const persistedId = parseLink(scopedCell.getAsLink()).id!;

      const replica = storageManager.open(signer.did()).replica as unknown as {
        getDocument(id: string, scope?: "space" | "user" | "session"): {
          value?: unknown;
          cfc?: { schemaHash: string; labelMap?: { entries: unknown[] } };
        } | undefined;
      };
      const scopedPersisted = replica.getDocument(persistedId, "user");
      const spacePersisted = replica.getDocument(persistedId, "space");

      expect(scopedPersisted?.value).toEqual({ secret: "hello" });
      expect(scopedPersisted?.cfc?.schemaHash).toBeDefined();
      expect(scopedPersisted?.cfc?.labelMap?.entries).toContainEqual({
        path: ["secret"],
        label: {
          confidentiality: ["secret"],
          integrity: ["trusted"],
        },
        origin: "declared",
      });
      expect(spacePersisted?.cfc).toBeUndefined();

      const verify = runtime.edit();
      expect(
        storedCfcMetadataAppliesToPath(verify, {
          ...scopedCell.getAsNormalizedFullLink(),
          path: ["secret"],
        }),
      ).toBe(true);
      verify.abort();
    } finally {
      await runtime.dispose();
      await storageManager.close();
    }
  });

  it("persists CFC metadata for stored link writes without link schema", async () => {
    const { runtime, storageManager } = createRuntime();
    try {
      const seed = runtime.edit();
      seed.setCfcEnforcementMode("enforce-explicit");
      const source = runtime.getCell(
        signer.did(),
        "cfc-link-write-source",
        {
          type: "object",
          ifc: {
            confidentiality: ["shared-space"],
            integrity: ["authored-by-bob"],
          },
          properties: {
            title: { type: "string" },
          },
        },
        seed,
      );
      source.set({ title: "shared notes" });
      seed.prepareCfc();
      expect((await seed.commit()).ok).toBeDefined();

      const tx = runtime.edit();
      tx.setCfcEnforcementMode("enforce-explicit");
      const linkedSource = runtime.getCell(
        signer.did(),
        "cfc-link-write-source",
        undefined,
        tx,
      );
      const target = runtime.getCell(
        signer.did(),
        "cfc-link-write-target",
        undefined,
        tx,
      );
      target.set(linkedSource);
      tx.prepareCfc();
      expect((await tx.commit()).ok).toBeDefined();

      const verify = runtime.edit();
      const stored = verify.readOrThrow({
        space: signer.did(),
        scope: "space",
        id: target.getAsNormalizedFullLink().id,
        path: [],
      }) as { cfc?: { labelMap?: { entries?: unknown[] } } };
      const entries = stored.cfc?.labelMap?.entries as Array<{
        path: string[];
        label: IFCLabel;
      }>;
      expect(entries).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            path: [],
            label: expect.objectContaining({
              confidentiality: ["shared-space"],
              integrity: expect.arrayContaining([
                "authored-by-bob",
                expect.objectContaining({
                  type: "https://commonfabric.org/cfc/atom/LinkReference",
                }),
              ]),
            }),
          }),
        ]),
      );
      verify.abort();
    } finally {
      await runtime.dispose();
      await storageManager.close();
    }
  });

  it("persists link metadata when the source label is new in the same transaction", async () => {
    const { runtime, storageManager } = createRuntime();
    try {
      const tx = runtime.edit();
      tx.setCfcEnforcementMode("enforce-explicit");
      const source = runtime.getCell(
        signer.did(),
        "cfc-link-same-tx-source",
        {
          type: "object",
          ifc: {
            confidentiality: ["same-tx-secret"],
            integrity: ["same-tx-integrity"],
          },
          properties: {
            title: { type: "string" },
          },
        },
        tx,
      );
      source.set({ title: "created and linked" });
      const target = runtime.getCell(
        signer.did(),
        "cfc-link-same-tx-target",
        undefined,
        tx,
      );
      target.set(source);
      tx.prepareCfc();
      expect((await tx.commit()).ok).toBeDefined();

      const verify = runtime.edit();
      const stored = verify.readOrThrow({
        space: signer.did(),
        scope: "space",
        id: target.getAsNormalizedFullLink().id,
        path: [],
      }) as { cfc?: { labelMap?: { entries?: unknown[] } } };
      const entries = stored.cfc?.labelMap?.entries as Array<{
        path: string[];
        label: IFCLabel;
      }>;
      expect(entries).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            path: [],
            label: expect.objectContaining({
              confidentiality: ["same-tx-secret"],
              integrity: expect.arrayContaining([
                "same-tx-integrity",
                expect.objectContaining({
                  type: "https://commonfabric.org/cfc/atom/LinkReference",
                }),
              ]),
            }),
          }),
        ]),
      );
      verify.abort();
    } finally {
      await runtime.dispose();
      await storageManager.close();
    }
  });

  it("persists carried link labels without storing transient label views", async () => {
    const { runtime, storageManager } = createRuntime();
    try {
      const seed = runtime.edit();
      seed.setCfcEnforcementMode("enforce-explicit");
      const source = runtime.getCell(
        signer.did(),
        "cfc-link-carried-only-source",
        undefined,
        seed,
      );
      source.set({ title: "plain source" });
      seed.prepareCfc();
      expect((await seed.commit()).ok).toBeDefined();

      const tx = runtime.edit();
      tx.setCfcEnforcementMode("enforce-explicit");
      const link = source.getAsLink() as any;
      link["/"][LINK_V1_TAG].cfcLabelView = {
        version: 1,
        entries: [{
          path: [],
          label: { integrity: ["selected-by-alice"] },
        }, {
          path: ["title"],
          label: { confidentiality: ["selected-title"] },
        }],
      };
      const target = runtime.getCell(
        signer.did(),
        "cfc-link-carried-only-target",
        undefined,
        tx,
      );
      target.set(link);
      tx.prepareCfc();
      expect((await tx.commit()).ok).toBeDefined();

      const verify = runtime.edit();
      const stored = verify.readOrThrow({
        space: signer.did(),
        scope: "space",
        id: target.getAsNormalizedFullLink().id,
        path: [],
      }) as {
        value?: { "/": { [LINK_V1_TAG]: { cfcLabelView?: unknown } } };
        cfc?: { labelMap?: { entries?: unknown[] } };
      };
      expect(stored.value?.["/"][LINK_V1_TAG]).not.toHaveProperty(
        "cfcLabelView",
      );
      expect(stored.cfc?.labelMap?.entries).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            path: [],
            label: { integrity: ["selected-by-alice"] },
          }),
          expect.objectContaining({
            path: ["title"],
            label: { confidentiality: ["selected-title"] },
          }),
        ]),
      );
      verify.abort();
    } finally {
      await runtime.dispose();
      await storageManager.close();
    }
  });

  it("persists CFC metadata for stored write-redirect links", async () => {
    const { runtime, storageManager } = createRuntime();
    try {
      const seed = runtime.edit();
      seed.setCfcEnforcementMode("enforce-explicit");
      const source = runtime.getCell(
        signer.did(),
        "cfc-write-redirect-source",
        {
          type: "object",
          ifc: {
            confidentiality: ["redirect-source-secret"],
            integrity: ["redirect-source-integrity"],
          },
          properties: {
            title: { type: "string" },
          },
        },
        seed,
      );
      source.set({ title: "redirect source" });
      seed.prepareCfc();
      expect((await seed.commit()).ok).toBeDefined();

      const tx = runtime.edit();
      tx.setCfcEnforcementMode("enforce-explicit");
      const linkedSource = runtime.getCell(
        signer.did(),
        "cfc-write-redirect-source",
        undefined,
        tx,
      );
      const target = runtime.getCell(
        signer.did(),
        "cfc-write-redirect-target",
        undefined,
        tx,
      );
      target.set(linkedSource.getAsWriteRedirectLink() as never);
      tx.prepareCfc();
      expect((await tx.commit()).ok).toBeDefined();

      const verify = runtime.edit();
      const stored = verify.readOrThrow({
        space: signer.did(),
        scope: "space",
        id: target.getAsNormalizedFullLink().id,
        path: [],
      }) as { cfc?: { labelMap?: { entries?: unknown[] } } };
      const entries = stored.cfc?.labelMap?.entries as Array<{
        path: string[];
        label: IFCLabel;
      }>;
      expect(entries).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            path: [],
            label: expect.objectContaining({
              confidentiality: ["redirect-source-secret"],
              integrity: expect.arrayContaining([
                "redirect-source-integrity",
                expect.objectContaining({
                  type: "https://commonfabric.org/cfc/atom/LinkReference",
                }),
              ]),
            }),
          }),
        ]),
      );
      verify.abort();
    } finally {
      await runtime.dispose();
      await storageManager.close();
    }
  });

  it("does not let link-write provenance cover unrelated stored writes", async () => {
    const { runtime, storageManager } = createRuntime();
    try {
      const sourceSeed = runtime.edit();
      sourceSeed.setCfcEnforcementMode("enforce-explicit");
      const source = runtime.getCell(
        signer.did(),
        "cfc-link-unrelated-source",
        {
          type: "object",
          ifc: { confidentiality: ["unrelated-link-source"] },
          properties: {
            title: { type: "string" },
          },
        },
        sourceSeed,
      );
      source.set({ title: "source" });
      sourceSeed.prepareCfc();
      expect((await sourceSeed.commit()).ok).toBeDefined();

      const targetSeed = runtime.edit();
      targetSeed.setCfcEnforcementMode("enforce-explicit");
      const target = runtime.getCell(
        signer.did(),
        "cfc-link-unrelated-target",
        {
          type: "object",
          properties: {
            guarded: {
              type: "string",
              ifc: { confidentiality: ["guarded-field"] },
            },
          },
        },
        targetSeed,
      );
      target.set({ guarded: "old" });
      targetSeed.prepareCfc();
      expect((await targetSeed.commit()).ok).toBeDefined();

      const tx = runtime.edit();
      tx.setCfcEnforcementMode("enforce-explicit");
      const targetLink = target.getAsNormalizedFullLink();
      tx.writeValueOrThrow({
        ...targetLink,
        path: ["guarded"],
      }, "new");
      const linkedSource = runtime.getCell(
        signer.did(),
        "cfc-link-unrelated-source",
        undefined,
        tx,
      );
      const linkedTarget = runtime.getCell(
        signer.did(),
        "cfc-link-unrelated-target",
        undefined,
        tx,
      );
      linkedTarget.key("linked").set(linkedSource as never);

      tx.prepareCfc();
      const result = await tx.commit();
      expect(result.error?.message).toContain(
        "missing schema write-policy input",
      );
    } finally {
      await runtime.dispose();
      await storageManager.close();
    }
  });

  it("rejects link writes when a PRE-EXISTING source has no metadata", async () => {
    const { runtime, storageManager } = createRuntime();
    try {
      const seed = runtime.edit();
      seed.setCfcEnforcementMode("enforce-explicit");
      const target = runtime.getCell(
        signer.did(),
        "cfc-link-missing-source-target",
        {
          type: "object",
          ifc: { confidentiality: ["personal-space"] },
        },
        seed,
      );
      target.set({ existing: true });
      // The unlabeled source pre-exists: written and committed WITHOUT any
      // schema, in a transaction that never links it anywhere.
      const unlabeledSeed = runtime.getCell(
        signer.did(),
        "cfc-link-missing-source",
        undefined,
        seed,
      );
      unlabeledSeed.set({ title: "unlabeled" });
      seed.prepareCfc();
      expect((await seed.commit()).ok).toBeDefined();

      const tx = runtime.edit();
      tx.setCfcEnforcementMode("enforce-explicit");
      const unlabeledSource = runtime.getCell(
        signer.did(),
        "cfc-link-missing-source",
        undefined,
        tx,
      );
      const linkedTarget = runtime.getCell(
        signer.did(),
        "cfc-link-missing-source-target",
        undefined,
        tx,
      );
      linkedTarget.set(unlabeledSource);
      tx.prepareCfc();
      const result = await tx.commit();
      expect(result.error?.message).toContain(
        "missing link source metadata",
      );
    } finally {
      await runtime.dispose();
      await storageManager.close();
    }
  });

  it("labels a SAME-TRANSACTION link source from the target's own schema", async () => {
    // A doc this transaction itself wrote and then linked into a labeled
    // location (the data layer does exactly this when an array/object entry
    // is split into a child doc) is treated like the inline value it holds:
    // the link label derives from the target's schema at the target path —
    // here the location's own confidentiality — instead of failing closed
    // (the profile element write shape).
    const { runtime, storageManager } = createRuntime();
    try {
      const seed = runtime.edit();
      const target = runtime.getCell(
        signer.did(),
        "cfc-link-same-tx-source-target",
        {
          type: "object",
          ifc: { confidentiality: ["personal-space"] },
        },
        seed,
      );
      target.set({ existing: true });
      seed.prepareCfc();
      expect((await seed.commit()).ok).toBeDefined();

      const tx = runtime.edit();
      const sameTxSource = runtime.getCell(
        signer.did(),
        "cfc-link-same-tx-source",
        undefined,
        tx,
      );
      sameTxSource.set({ title: "fresh" });
      const linkedTarget = runtime.getCell(
        signer.did(),
        "cfc-link-same-tx-source-target",
        undefined,
        tx,
      );
      linkedTarget.set(sameTxSource);
      // The marker `data-updating` records for the child document it splits an
      // entry into: the child is the runtime's store, filled out of what this
      // transaction read.
      const sourceLink = sameTxSource.getAsNormalizedFullLink();
      const targetLink = linkedTarget.getAsNormalizedFullLink();
      tx.recordCfcWritePolicyInput({
        kind: "structural-provenance",
        target: {
          space: sourceLink.space,
          id: sourceLink.id,
          scope: sourceLink.scope,
          path: [],
        },
        claim: CFC_STRUCTURAL_PROVENANCE_RUNTIME_OWNED_STORE,
        sources: [{
          space: targetLink.space,
          id: targetLink.id,
          scope: targetLink.scope,
          path: [],
        }],
      }, runtimeWritePolicyAuthorization);
      tx.prepareCfc();
      const result = await tx.commit();
      expect(result.error).toBeUndefined();

      // The persisted link label carries the location's confidentiality.
      const verify = runtime.edit();
      const metadata = readStoredCfcMetadata(verify, {
        space: signer.did(),
        id: linkedTarget.getAsNormalizedFullLink().id,
        scope: "space",
      });
      const rootEntry = metadata?.labelMap.entries.find((entry) =>
        entry.path.length === 0 && entry.origin === "link"
      );
      expect(rootEntry?.label.confidentiality).toEqual(["personal-space"]);
      verify.abort?.();
    } finally {
      await runtime.dispose();
      await storageManager.close();
    }
  });

  it("labels a SAME-TRANSACTION link source from its setup-written schema meta", async () => {
    // A piece instantiated by this transaction gets its result schema written
    // at the doc's ["schema"] meta during setup (updateResultSchemaMeta). A
    // handler that materializes such a piece and links it into a protected
    // list in ONE commit (profile-home's addElement) leaves the
    // source with no stored CFC metadata and no pending schema input — the
    // setup-written schema, read back read-your-writes, is what keeps the
    // link write from failing closed. The persisted link label must derive
    // from the SOURCE's own schema: the target-schema child-doc fallback
    // (previous test) could only produce ["personal-space"] here, so
    // ["card-space"] proves the setup-schema hatch supplied the label.
    const { runtime, storageManager } = createRuntime();
    try {
      const seed = runtime.edit();
      seed.setCfcEnforcementMode("enforce-explicit");
      const target = runtime.getCell(
        signer.did(),
        "cfc-link-setup-schema-target",
        {
          type: "object",
          ifc: { confidentiality: ["personal-space"] },
        },
        seed,
      );
      target.set({ existing: true });
      seed.prepareCfc();
      expect((await seed.commit()).ok).toBeDefined();

      const tx = runtime.edit();
      tx.setCfcEnforcementMode("enforce-explicit");
      const piece = runtime.getCell(
        signer.did(),
        "cfc-link-setup-schema-source",
        undefined,
        tx,
      );
      piece.set({ title: "fresh card" });
      // What piece setup writes for a fresh instance (updateResultSchemaMeta).
      piece.setMetaRaw("schema", {
        type: "object",
        ifc: { confidentiality: ["card-space"] },
        properties: { title: { type: "string" } },
      }, rawMetaWriteAuthorization);
      const linkedTarget = runtime.getCell(
        signer.did(),
        "cfc-link-setup-schema-target",
        undefined,
        tx,
      );
      linkedTarget.set(piece);
      tx.prepareCfc();
      const result = await tx.commit();
      expect(result.error).toBeUndefined();

      const verify = runtime.edit();
      const metadata = readStoredCfcMetadata(verify, {
        space: signer.did(),
        id: linkedTarget.getAsNormalizedFullLink().id,
        scope: "space",
      });
      const rootEntry = metadata?.labelMap.entries.find((entry) =>
        entry.path.length === 0 && entry.origin === "link"
      );
      expect(rootEntry?.label.confidentiality).toEqual(["card-space"]);
      verify.abort?.();
    } finally {
      await runtime.dispose();
      await storageManager.close();
    }
  });

  it("allows link writes that strengthen a stored confidentiality declaration", async () => {
    const { runtime, storageManager } = createRuntime("enforce-explicit");
    const targetSchema = (confidentiality: string[]): JSONSchema => ({
      type: "object",
      properties: {
        linked: { type: "string", ifc: { confidentiality } },
      },
      required: ["linked"],
    });
    try {
      const seed = runtime.edit();
      const source = runtime.getCell(signer.did(), "strengthening source", {
        type: "string",
        ifc: { confidentiality: ["source-reader"] },
      }, seed);
      source.set("linked content");
      const target = runtime.getCell(
        signer.did(),
        "strengthening target",
        targetSchema(["source-reader"]),
        seed,
      );
      target.set({ linked: "initial content" });
      expect((await seed.commit()).error).toBeUndefined();

      const tx = runtime.edit();
      const strengthened = target.withTx(tx).asSchema(
        targetSchema(["source-reader", "additional-reader"]),
      );
      strengthened.set({ linked: source.withTx(tx) } as never);
      expect((await tx.commit()).error).toBeUndefined();

      const verify = runtime.edit();
      try {
        expect(target.withTx(verify).key("linked").get()).toBe(
          "linked content",
        );
        const metadata = readStoredCfcMetadata(
          verify,
          toMemorySpaceAddress(target.getAsNormalizedFullLink()),
        );
        const declared = metadata?.labelMap.entries.find((entry) =>
          entry.path.join("/") === "linked" && entry.origin === "declared"
        );
        expect(declared?.label.confidentiality).toEqual([
          "source-reader",
          "additional-reader",
        ]);
      } finally {
        verify.abort();
      }
    } finally {
      await runtime.dispose();
      await storageManager.close();
    }
  });

  it("validates link writes against affected stored schema claims", async () => {
    const { runtime, storageManager } = createRuntime();
    try {
      const sourceSeed = runtime.edit();
      sourceSeed.setCfcEnforcementMode("enforce-explicit");
      const source = runtime.getCell(
        signer.did(),
        "cfc-link-write-guard-source",
        {
          type: "object",
          ifc: {
            confidentiality: ["guarded-source"],
            integrity: ["source-integrity"],
          },
          properties: {
            title: { type: "string" },
          },
        },
        sourceSeed,
      );
      source.set({ title: "guarded" });
      sourceSeed.prepareCfc();
      expect((await sourceSeed.commit()).ok).toBeDefined();

      const targetSeed = runtime.edit();
      const target = runtime.getCell(
        signer.did(),
        "cfc-link-write-guard-target",
        undefined,
        targetSeed,
      );
      const targetLink = target.getAsNormalizedFullLink();
      const guardedSchema = internSchema(
        {
          type: "object",
          properties: {
            linked: {
              type: "object",
              ifc: { writeAuthorizedBy: ["trusted-handler"] },
            },
          },
        } satisfies JSONSchema,
        true,
      );
      seedStoredEnvelope(targetSeed, {
        space: signer.did(),
        scope: "space",
        id: targetLink.id,
        path: [],
      }, {
        value: { linked: null },
        cfc: {
          version: 1,
          schemaHash: guardedSchema.taggedHashString,
          labelMap: {
            version: 1,
            entries: [{ path: ["linked"], label: {} }],
          },
        },
      });
      targetSeed.writeOrThrow({
        space: signer.did(),
        scope: "space",
        id: `cid:${guardedSchema.taggedHashString}`,
        path: [],
      }, {
        value: guardedSchema.schema,
      });
      expect((await targetSeed.commit()).ok).toBeDefined();

      for (
        const schema of [
          undefined,
          {
            type: "object",
            properties: { linked: { type: "object" } },
          } as const,
        ]
      ) {
        const tx = runtime.edit();
        tx.setCfcEnforcementMode("enforce-explicit");
        const linkedSource = runtime.getCell(
          signer.did(),
          "cfc-link-write-guard-source",
          undefined,
          tx,
        );
        const guardedTarget = runtime.getCell(
          signer.did(),
          "cfc-link-write-guard-target",
          schema,
          tx,
        );
        guardedTarget.key("linked").set(linkedSource as never);

        tx.prepareCfc();
        const result = await tx.commit();
        expect(result.error?.message).toContain(
          "writeAuthorizedBy requires a trusted builtin identity at /linked",
        );
      }
    } finally {
      await runtime.dispose();
      await storageManager.close();
    }
  });

  it("validates link writes against wildcard array item stored schema claims", async () => {
    const { runtime, storageManager } = createRuntime();
    try {
      const sourceSeed = runtime.edit();
      sourceSeed.setCfcEnforcementMode("enforce-explicit");
      const source = runtime.getCell(
        signer.did(),
        "cfc-link-write-array-source",
        {
          type: "object",
          ifc: {
            confidentiality: ["array-source"],
            integrity: ["array-source-integrity"],
          },
          properties: {
            title: { type: "string" },
          },
        },
        sourceSeed,
      );
      source.set({ title: "array guarded" });
      sourceSeed.prepareCfc();
      expect((await sourceSeed.commit()).ok).toBeDefined();

      const targetSeed = runtime.edit();
      const target = runtime.getCell(
        signer.did(),
        "cfc-link-write-array-target",
        undefined,
        targetSeed,
      );
      const targetLink = target.getAsNormalizedFullLink();
      const guardedSchema = internSchema(
        {
          type: "object",
          properties: {
            items: {
              type: "array",
              items: {
                type: "object",
                ifc: { writeAuthorizedBy: ["trusted-handler"] },
              },
            },
          },
        } satisfies JSONSchema,
        true,
      );
      seedStoredEnvelope(targetSeed, {
        space: signer.did(),
        scope: "space",
        id: targetLink.id,
        path: [],
      }, {
        value: { items: [null] },
        cfc: {
          version: 1,
          schemaHash: guardedSchema.taggedHashString,
          labelMap: {
            version: 1,
            entries: [{ path: ["items", "*"], label: {} }],
          },
        },
      });
      targetSeed.writeOrThrow({
        space: signer.did(),
        scope: "space",
        id: `cid:${guardedSchema.taggedHashString}`,
        path: [],
      }, {
        value: guardedSchema.schema,
      });
      expect((await targetSeed.commit()).ok).toBeDefined();

      const tx = runtime.edit();
      tx.setCfcEnforcementMode("enforce-explicit");
      const linkedSource = runtime.getCell(
        signer.did(),
        "cfc-link-write-array-source",
        undefined,
        tx,
      );
      const guardedTarget = runtime.getCell(
        signer.did(),
        "cfc-link-write-array-target",
        undefined,
        tx,
      );
      guardedTarget.key("items").key("0").set(linkedSource as never);

      tx.prepareCfc();
      const result = await tx.commit();
      expect(result.error?.message).toContain(
        "writeAuthorizedBy requires a trusted builtin identity at /items/*",
      );
    } finally {
      await runtime.dispose();
      await storageManager.close();
    }
  });

  it("does not apply wildcard policy entries with unresolved refs", async () => {
    const { runtime, storageManager } = createRuntime();
    try {
      const tx = runtime.edit();
      tx.setCfcEnforcementMode("enforce-explicit");
      const cell = runtime.getCell(
        signer.did(),
        "cfc-unresolved-ref-policy-match",
        {
          type: "object",
          properties: {
            items: {
              type: "array",
              items: {
                $ref: "#/$defs/Missing",
                ifc: { writeAuthorizedBy: ["trusted-handler"] },
              },
            },
          },
        },
        tx,
      );
      cell.set({ items: [{ title: "unresolved" }] });
      tx.prepareCfc();

      expect((await tx.commit()).ok).toBeDefined();
    } finally {
      await runtime.dispose();
      await storageManager.close();
    }
  });

  it("applies wildcard policy entries with refs resolved from parent defs", async () => {
    const { runtime, storageManager } = createRuntime();
    try {
      const tx = runtime.edit();
      tx.setCfcEnforcementMode("enforce-explicit");
      const cell = runtime.getCell(
        signer.did(),
        "cfc-resolved-ref-policy-match",
        {
          type: "object",
          properties: {
            items: {
              type: "array",
              items: {
                $ref: "#/$defs/GuardedItem",
              },
            },
          },
          $defs: {
            GuardedItem: {
              $ref: "#/$defs/GuardedItemShape",
              ifc: { writeAuthorizedBy: ["trusted-handler"] },
            },
            GuardedItemShape: {
              type: "object",
              properties: {
                title: { type: "string" },
              },
            },
          },
        },
        tx,
      );
      cell.set({ items: [{ title: "resolved" }] });

      tx.prepareCfc();
      const result = await tx.commit();
      expect(result.error?.message).toContain(
        "writeAuthorizedBy requires a trusted builtin identity at /items/*",
      );
    } finally {
      await runtime.dispose();
      await storageManager.close();
    }
  });

  it("does not apply wildcard policy entries when item value shape mismatches", async () => {
    const { runtime, storageManager } = createRuntime();
    try {
      const tx = runtime.edit();
      tx.setCfcEnforcementMode("enforce-explicit");
      const cell = runtime.getCell(
        signer.did(),
        "cfc-wildcard-policy-shape-mismatch",
        {
          type: "object",
          properties: {
            items: {
              type: "array",
              items: {
                type: "object",
                properties: {
                  title: { type: "string" },
                },
                ifc: { writeAuthorizedBy: ["trusted-handler"] },
              },
            },
          },
        },
        tx,
      );
      cell.set({ items: ["not an object"] });

      tx.prepareCfc();
      expect((await tx.commit()).ok).toBeDefined();
    } finally {
      await runtime.dispose();
      await storageManager.close();
    }
  });

  it("does not persist wildcard policy metadata for empty list writes", async () => {
    const { runtime, storageManager } = createRuntime();
    try {
      const tx = runtime.edit();
      tx.setCfcEnforcementMode("enforce-explicit");
      const cell = runtime.getCell(
        signer.did(),
        "cfc-wildcard-policy-empty-list",
        {
          type: "object",
          properties: {
            items: {
              type: "array",
              items: {
                type: "object",
                ifc: { writeAuthorizedBy: ["trusted-handler"] },
              },
            },
          },
        },
        tx,
      );
      cell.set({ items: [] });

      tx.prepareCfc();
      expect((await tx.commit()).ok).toBeDefined();

      const verify = runtime.edit();
      const stored = verify.readOrThrow({
        space: signer.did(),
        scope: "space",
        id: cell.getAsNormalizedFullLink().id,
        path: [],
      }) as { value?: unknown; cfc?: { labelMap?: { entries?: unknown[] } } };
      // The stored value pins the document the label map is read from, so
      // the empty map below is that document's own.
      expect(stored.value).toEqual({ items: [] });
      expect(stored.cfc?.labelMap?.entries ?? []).not.toContainEqual({
        path: ["items", "*"],
        label: {},
      });
      verify.abort();
    } finally {
      await runtime.dispose();
      await storageManager.close();
    }
  });

  it("preserves untouched wildcard policy entries during unrelated rewrites", async () => {
    const { runtime, storageManager } = createRuntime();
    try {
      const seed = runtime.edit();
      const target = runtime.getCell(
        signer.did(),
        "cfc-wildcard-policy-preserve-target",
        undefined,
        seed,
      );
      const targetLink = target.getAsNormalizedFullLink();
      const guardedSchema = internSchema(
        {
          type: "object",
          properties: {
            title: { type: "string" },
            items: {
              type: "array",
              items: {
                type: "object",
                ifc: { writeAuthorizedBy: ["trusted-handler"] },
              },
            },
          },
        } satisfies JSONSchema,
        true,
      );
      seedStoredEnvelope(seed, {
        space: signer.did(),
        scope: "space",
        id: targetLink.id,
        path: [],
      }, {
        value: { title: "draft", items: [{ title: "existing" }] },
        cfc: {
          version: 1,
          schemaHash: guardedSchema.taggedHashString,
          labelMap: {
            version: 1,
            entries: [{ path: ["items", "*"], label: {} }],
          },
        },
      });
      seed.writeOrThrow({
        space: signer.did(),
        scope: "space",
        id: `cid:${guardedSchema.taggedHashString}`,
        path: [],
      }, {
        value: guardedSchema.schema,
      });
      expect((await seed.commit()).ok).toBeDefined();

      const update = runtime.edit();
      update.setCfcEnforcementMode("enforce-explicit");
      const targetWithSchema = runtime.getCell(
        signer.did(),
        "cfc-wildcard-policy-preserve-target",
        guardedSchema.schema,
        update,
      );
      targetWithSchema.key("title").set("updated");
      update.prepareCfc();
      expect((await update.commit()).ok).toBeDefined();

      const verify = runtime.edit();
      const stored = verify.readOrThrow({
        space: signer.did(),
        scope: "space",
        id: targetLink.id,
        path: [],
      }) as { cfc?: { labelMap?: { entries?: unknown[] } } };
      expect(stored.cfc?.labelMap?.entries).toContainEqual({
        path: ["items", "*"],
        label: {},
      });
      verify.abort();
    } finally {
      await runtime.dispose();
      await storageManager.close();
    }
  });

  it("preserves prior stored link-field labels across unrelated metadata rewrites", async () => {
    const { runtime, storageManager } = createRuntime();
    try {
      const sourceSeed = runtime.edit();
      sourceSeed.setCfcEnforcementMode("enforce-explicit");
      const source = runtime.getCell(
        signer.did(),
        "cfc-link-label-preserve-source",
        {
          type: "object",
          ifc: {
            confidentiality: ["linked-secret"],
            integrity: ["linked-integrity"],
          },
          properties: {
            title: { type: "string" },
          },
        },
        sourceSeed,
      );
      source.set({ title: "linked" });
      sourceSeed.prepareCfc();
      expect((await sourceSeed.commit()).ok).toBeDefined();

      const linkTx = runtime.edit();
      linkTx.setCfcEnforcementMode("enforce-explicit");
      const linkedSource = runtime.getCell(
        signer.did(),
        "cfc-link-label-preserve-source",
        undefined,
        linkTx,
      );
      const target = runtime.getCell(
        signer.did(),
        "cfc-link-label-preserve-target",
        undefined,
        linkTx,
      );
      target.set({ title: "draft" });
      target.key("linked").set(linkedSource as never);
      linkTx.prepareCfc();
      expect((await linkTx.commit()).ok).toBeDefined();

      const update = runtime.edit();
      update.setCfcEnforcementMode("enforce-explicit");
      const targetWithSchema = runtime.getCell(
        signer.did(),
        "cfc-link-label-preserve-target",
        {
          type: "object",
          properties: {
            title: {
              type: "string",
              ifc: { confidentiality: ["title-public"] },
            },
          },
        },
        update,
      );
      targetWithSchema.key("title").set("updated");
      update.prepareCfc();
      expect((await update.commit()).ok).toBeDefined();

      const verify = runtime.edit();
      const stored = verify.readOrThrow({
        space: signer.did(),
        scope: "space",
        id: target.getAsNormalizedFullLink().id,
        path: [],
      }) as { cfc?: { labelMap?: { entries?: unknown[] } } };
      const entries = stored.cfc?.labelMap?.entries as Array<{
        path: string[];
        label: IFCLabel;
      }>;
      expect(entries).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            path: ["linked"],
            label: expect.objectContaining({
              confidentiality: ["linked-secret"],
              integrity: expect.arrayContaining([
                "linked-integrity",
                expect.objectContaining({
                  type: "https://commonfabric.org/cfc/atom/LinkReference",
                }),
              ]),
            }),
          }),
          expect.objectContaining({
            path: ["title"],
            label: expect.objectContaining({
              confidentiality: ["title-public"],
            }),
          }),
        ]),
      );
      verify.abort();
    } finally {
      await runtime.dispose();
      await storageManager.close();
    }
  });

  it("does not record link-write provenance when a link is collapsed to a snapshot", async () => {
    const { runtime, storageManager } = createRuntime("observe");
    try {
      const tx = runtime.edit();
      const cell = runtime.getCell(
        signer.did(),
        "cfc-collapsed-link-provenance",
        undefined,
        tx,
      );
      const link = cell.getAsNormalizedFullLink();
      seedStoredEnvelope(tx, {
        space: signer.did(),
        scope: "space",
        id: link.id,
        path: [],
      }, {
        value: { title: "parent" },
        cfc: {
          version: 1,
          schemaHash: "source-schema",
          labelMap: {
            version: 1,
            entries: [{
              path: [],
              label: { confidentiality: ["source-root"] },
            }],
          },
        },
      });

      cell.key("child").set(cell.getAsLink() as never);
      expect(tx.getCfcState().writePolicyInputs).not.toContainEqual(
        expect.objectContaining({ kind: "link-write" }),
      );
      tx.abort();
    } finally {
      await runtime.dispose();
      await storageManager.close();
    }
  });

  it("persists cfc metadata for nested entity documents created from labeled collection items", async () => {
    const { runtime, storageManager } = createRuntime();
    try {
      const tx = runtime.edit();
      tx.setCfcEnforcementMode("enforce-explicit");
      const cell = runtime.getCell(
        signer.did(),
        "cfc-nested-entity-metadata",
        {
          type: "object",
          properties: {
            messages: {
              type: "array",
              items: {
                type: "object",
                properties: {
                  piece: {
                    type: "object",
                    properties: {
                      body: { type: "string" },
                    },
                    required: ["body"],
                    ifc: {
                      integrity: [{
                        kind: "authored-by",
                        subject: "alice",
                      }],
                    },
                  },
                },
                required: ["piece"],
              },
            },
          },
          required: ["messages"],
        },
        tx,
      );
      cell.set({
        messages: [{
          piece: { body: "hello" },
        }],
      });
      tx.prepareCfc();
      const result = await tx.commit();
      expect(result.ok).toBeDefined();

      const rootId = parseLink(cell.getAsLink()).id!;
      const replica = storageManager.open(signer.did()).replica as unknown as {
        getDocument(id: string): {
          value?: unknown;
          cfc?: {
            schemaHash: string;
            labelMap?: {
              entries: Array<{
                path: string[];
                label: {
                  confidentiality?: unknown[];
                  integrity?: unknown[];
                };
              }>;
            };
          };
        } | undefined;
      };
      const rootDoc = replica.getDocument(rootId);
      const nestedLink = parseLink(
        (rootDoc?.value as { messages?: unknown[] } | undefined)?.messages?.[0],
      );
      expect(nestedLink?.id).toBeDefined();

      const nestedDoc = replica.getDocument(nestedLink!.id!);
      expect(nestedDoc?.cfc?.labelMap?.entries).toContainEqual({
        path: ["piece"],
        label: {
          integrity: [{
            kind: "authored-by",
            subject: "alice",
          }],
        },
        origin: "declared",
      });
    } finally {
      await runtime.dispose();
      await storageManager.close();
    }
  });

  it("uses generated-output provenance when migrating extracted collection entities", async () => {
    const { runtime, storageManager } = createRuntime();
    try {
      const entitySchema = (withGeneratedField: boolean): JSONSchema => ({
        type: "object",
        properties: {
          messages: {
            type: "array",
            items: {
              type: "object",
              properties: {
                body: {
                  type: "string",
                  ifc: { confidentiality: ["secret"] },
                },
                ...(withGeneratedField
                  ? { generated: { type: "string" } }
                  : {}),
              },
              required: [
                "body",
                ...(withGeneratedField ? ["generated"] : []),
              ],
            },
          },
        },
        required: ["messages"],
      });
      const write = (
        rootId: string,
        withGeneratedField: boolean,
        schemaRole?: "output",
      ) => {
        const tx = runtime.edit();
        tx.setCfcEnforcementMode("enforce-explicit");
        const cell = runtime.getCell(
          signer.did(),
          rootId,
          entitySchema(withGeneratedField),
          tx,
        );
        diffAndUpdate(
          runtime,
          tx,
          cell.getAsNormalizedFullLink(),
          {
            messages: [{
              // Once the array container exists, reusing this anchor id
              // targets the same extracted document during migration.
              body: "hello",
              ...(withGeneratedField ? { generated: "new" } : {}),
            }],
          },
          undefined,
          schemaRole === undefined ? undefined : { schemaRole },
          () => "message-1",
        );
        return tx;
      };

      // The first write establishes the array container; the second targets
      // the stable entity id derived once that container is present. The
      // migration then revisits that same long-lived entity document.
      for (let round = 0; round < 2; round++) {
        for (const rootId of ["generated-output-control", "generated-output"]) {
          const seed = write(rootId, false);
          seed.prepareCfc();
          expect((await seed.commit()).ok).toBeDefined();
        }
      }

      const strictUpdate = write("generated-output-control", true);
      strictUpdate.prepareCfc();
      const strictResult = await strictUpdate.commit();
      expect(strictResult.error?.message).toContain(
        "required field generated needs a default",
      );

      const outputUpdate = write("generated-output", true, "output");
      outputUpdate.prepareCfc();
      expect((await outputUpdate.commit()).ok).toBeDefined();
    } finally {
      await runtime.dispose();
      await storageManager.close();
    }
  });

  it("persists matched anyOf branch cfc metadata for nested entity documents", async () => {
    const { runtime, storageManager } = createRuntime();
    try {
      const tx = runtime.edit();
      tx.setCfcEnforcementMode("enforce-explicit");
      const cell = runtime.getCell(
        signer.did(),
        "cfc-nested-anyof-entity-metadata",
        {
          type: "object",
          properties: {
            messages: {
              type: "array",
              items: {
                type: "object",
                properties: {
                  piece: {
                    anyOf: [
                      {
                        type: "object",
                        properties: {
                          id: {
                            type: "string",
                            enum: ["alice"],
                          },
                          body: { type: "string" },
                        },
                        required: ["id", "body"],
                        ifc: {
                          integrity: [{
                            kind: "authored-by",
                            subject: "alice",
                          }],
                        },
                      },
                      {
                        type: "object",
                        properties: {
                          id: {
                            type: "string",
                            enum: ["bob"],
                          },
                          body: { type: "string" },
                        },
                        required: ["id", "body"],
                        ifc: {
                          integrity: [{
                            kind: "authored-by",
                            subject: "bob",
                          }],
                        },
                      },
                    ],
                  },
                },
                required: ["piece"],
              },
            },
          },
          required: ["messages"],
        },
        tx,
      );
      cell.set({
        messages: [{
          piece: { id: "alice", body: "hello" },
        }],
      });
      tx.prepareCfc();
      const result = await tx.commit();
      expect(result.ok).toBeDefined();

      const rootId = parseLink(cell.getAsLink()).id!;
      const replica = storageManager.open(signer.did()).replica as unknown as {
        getDocument(id: string): {
          value?: unknown;
          cfc?: {
            schemaHash: string;
            labelMap?: {
              entries: Array<{
                path: string[];
                label: {
                  confidentiality?: unknown[];
                  integrity?: unknown[];
                };
              }>;
            };
          };
        } | undefined;
      };
      const rootDoc = replica.getDocument(rootId);
      const nestedLink = parseLink(
        (rootDoc?.value as { messages?: unknown[] } | undefined)?.messages?.[0],
      );
      expect(nestedLink?.id).toBeDefined();

      const nestedDoc = replica.getDocument(nestedLink!.id!);
      expect(nestedDoc?.cfc?.labelMap?.entries).toContainEqual({
        path: ["piece"],
        label: {
          integrity: [{
            kind: "authored-by",
            subject: "alice",
          }],
        },
        origin: "declared",
      });
    } finally {
      await runtime.dispose();
      await storageManager.close();
    }
  });

  it("persists nested item labels when child refs rely on parent defs during push", async () => {
    const { runtime, storageManager } = createRuntime();
    try {
      const cell = runtime.getCell(
        signer.did(),
        "cfc-parent-defs-push-metadata",
        {
          type: "object",
          properties: {
            messages: {
              type: "array",
              items: {
                $ref: "#/$defs/SharedMessageEntry",
              },
            },
          },
          required: ["messages"],
          $defs: {
            SharedMessageEntry: {
              type: "object",
              properties: {
                piece: {
                  $ref: "#/$defs/TrustedMessage",
                },
              },
              required: ["piece"],
            },
            TrustedMessage: {
              anyOf: [
                { $ref: "#/$defs/TrustedMessageAlice" },
                { $ref: "#/$defs/TrustedMessageBob" },
              ],
            },
            TrustedMessageAlice: {
              type: "object",
              properties: {
                id: {
                  type: "string",
                  enum: ["alice-message"],
                },
                author: {
                  type: "object",
                  properties: {
                    id: {
                      type: "string",
                      enum: ["alice"],
                    },
                  },
                  required: ["id"],
                },
                body: { type: "string" },
              },
              required: ["id", "author", "body"],
              ifc: {
                integrity: [{
                  kind: "authored-by",
                  subject: "alice",
                }],
              },
            },
            TrustedMessageBob: {
              type: "object",
              properties: {
                id: {
                  type: "string",
                  enum: ["bob-message"],
                },
                author: {
                  type: "object",
                  properties: {
                    id: {
                      type: "string",
                      enum: ["bob"],
                    },
                  },
                  required: ["id"],
                },
                body: { type: "string" },
              },
              required: ["id", "author", "body"],
              ifc: {
                integrity: [{
                  kind: "authored-by",
                  subject: "bob",
                }],
              },
            },
          },
        },
      );

      const seed = runtime.edit();
      seed.setCfcEnforcementMode("enforce-explicit");
      cell.withTx(seed).set({ messages: [] });
      seed.prepareCfc();
      expect((await seed.commit()).ok).toBeDefined();

      const tx = runtime.edit();
      tx.setCfcEnforcementMode("enforce-explicit");
      cell.withTx(tx).key("messages").push({
        piece: {
          id: "alice-message",
          author: { id: "alice" },
          body: "hello",
        },
      });
      tx.prepareCfc();
      const result = await tx.commit();
      expect(result.ok).toBeDefined();

      const rootId = parseLink(cell.getAsLink()).id!;
      const replica = storageManager.open(signer.did()).replica as unknown as {
        getDocument(id: string): {
          value?: { messages?: unknown[] };
          cfc?: {
            schemaHash: string;
            labelMap?: {
              entries: Array<{
                path: string[];
                label: {
                  confidentiality?: unknown[];
                  integrity?: unknown[];
                };
              }>;
            };
          };
        } | undefined;
      };
      const rootDoc = replica.getDocument(rootId);
      const nestedLink = parseLink(
        (rootDoc?.value as { messages?: unknown[] } | undefined)?.messages?.[0],
      );
      expect(nestedLink?.id).toBeDefined();

      const nestedDoc = replica.getDocument(nestedLink!.id!);
      expect(nestedDoc?.cfc?.labelMap?.entries).toContainEqual({
        path: ["piece"],
        label: {
          integrity: [{
            kind: "authored-by",
            subject: "alice",
          }],
        },
        origin: "declared",
      });
    } finally {
      await runtime.dispose();
      await storageManager.close();
    }
  });

  it("keeps derived read labels out of persisted label metadata", async () => {
    const { runtime, storageManager } = createRuntime();
    try {
      const seed = runtime.edit();
      writeSeedEnvelopeDoc(seed, signer.did());
      seedStoredEnvelope(seed, {
        space: signer.did(),
        scope: "space",
        id: "of:cfc-derived-label-source",
        path: [],
      }, {
        value: { secret: "seed" },
        cfc: {
          version: 1,
          schemaHash: SEED_ENVELOPE_SCHEMA_HASH,
          labelMap: {
            version: 1,
            entries: [{
              path: ["secret"],
              label: { confidentiality: ["secret"] },
            }],
          },
        },
      });
      const seedResult = await seed.commit();
      expect(seedResult.ok).toBeDefined();

      const tx = runtime.edit();
      tx.setCfcEnforcementMode("enforce-explicit");

      const source = runtime.getCell(
        signer.did(),
        "cfc-derived-label-source",
        {
          type: "object",
          properties: {
            secret: {
              type: "string",
              ifc: { confidentiality: ["secret"] },
            },
          },
          required: ["secret"],
        },
        tx,
      );
      source.get();

      const output = runtime.getCell(
        signer.did(),
        "cfc-derived-label-output",
        {
          type: "string",
          ifc: { confidentiality: ["public"] },
        },
        tx,
      );
      output.set("visible");

      tx.prepareCfc();
      const result = await tx.commit();
      expect(result.ok).toBeDefined();

      const persistedId = parseLink(output.getAsLink()).id!;
      const replica = storageManager.open(signer.did()).replica as unknown as {
        getDocument(id: string): {
          cfc?: {
            labelMap?: {
              entries: Array<{
                path: string[];
                label: {
                  confidentiality?: string[];
                  integrity?: string[];
                };
              }>;
            };
          };
        } | undefined;
      };
      const persisted = replica.getDocument(persistedId);
      expect(persisted?.cfc?.labelMap?.entries).toContainEqual({
        path: [],
        label: {
          confidentiality: ["public"],
        },
        origin: "declared",
      });
      expect(persisted?.cfc?.labelMap?.entries).not.toContainEqual({
        path: [],
        label: {
          confidentiality: ["public", "secret"],
        },
        origin: "declared",
      });
    } finally {
      await runtime.dispose();
      await storageManager.close();
    }
  });

  it("merges canonical schema envelopes monotonically across writes", async () => {
    const { runtime, storageManager } = createRuntime();
    try {
      const firstTx = runtime.edit();
      firstTx.setCfcEnforcementMode("enforce-explicit");
      const firstCell = runtime.getCell(
        signer.did(),
        "cfc-schema-merge",
        {
          type: "object",
          properties: {
            secret: {
              type: "string",
              ifc: { confidentiality: ["secret"] },
            },
          },
          required: ["secret"],
        },
        firstTx,
      );
      firstCell.set({ secret: "hello" });
      firstTx.prepareCfc();
      const firstResult = await firstTx.commit();
      expect(firstResult.ok).toBeDefined();

      const replica = storageManager.open(signer.did()).replica as unknown as {
        getDocument(id: string): {
          value?: unknown;
          cfc?: { schemaHash: string };
        } | undefined;
      };
      const persistedId = parseLink(firstCell.getAsLink()).id!;
      const before = replica.getDocument(persistedId);
      expect(before?.cfc?.schemaHash).toBeDefined();

      const secondTx = runtime.edit();
      secondTx.setCfcEnforcementMode("enforce-explicit");
      const secondCell = runtime.getCell(
        signer.did(),
        "cfc-schema-merge",
        {
          type: "object",
          properties: {
            secret: {
              type: "string",
              ifc: { confidentiality: ["secret"] },
            },
            title: {
              type: "string",
              default: "",
            },
          },
          required: ["secret", "title"],
        },
        secondTx,
      );
      secondCell.set({ secret: "hello", title: "updated" });
      secondTx.prepareCfc();
      const secondResult = await secondTx.commit();
      expect(secondResult.ok).toBeDefined();

      const after = replica.getDocument(persistedId);
      expect(after?.cfc?.schemaHash).toBeDefined();
      expect(after?.cfc?.schemaHash).not.toEqual(before?.cfc?.schemaHash);

      const schemaDoc = replica.getDocument(`cid:${after!.cfc!.schemaHash}`);
      expect(schemaDoc?.value).toMatchObject({
        type: "object",
        required: ["secret", "title"],
      });
      expect(
        (schemaDoc?.value as { properties?: { title?: unknown } }).properties
          ?.title,
      )
        .toMatchObject({
          type: "string",
          default: "",
        });
    } finally {
      await runtime.dispose();
      await storageManager.close();
    }
  });

  it("does not re-check existing trusted-event claims for unrelated schema candidates", async () => {
    const { runtime, storageManager } = createRuntime();
    try {
      const documentId = "of:cfc-existing-trusted-event-unrelated-write";
      const type = "application/json";
      const existingSchemaAndHash = internSchema(
        {
          type: "object",
          properties: {
            argument: {
              type: "object",
              properties: {
                savedTitle: {
                  type: "string",
                  ifc: {
                    uiContract: {
                      helper: "UiAction",
                      action: "TrustedSaveDraft",
                      trustedPattern: "TrustedSaveDraftSurface",
                    },
                  },
                },
                savedBody: {
                  type: "string",
                  ifc: {
                    uiContract: {
                      helper: "UiAction",
                      action: "TrustedSaveDraft",
                      trustedPattern: "TrustedSaveDraftSurface",
                    },
                  },
                },
              },
            },
          },
        } satisfies JSONSchema,
        true,
      );

      const seed = runtime.edit();
      seedStoredEnvelope(seed, {
        space: signer.did(),
        scope: "space",
        id: documentId,
        type,
        path: [],
      }, {
        value: {
          argument: {
            savedTitle: "Launch checklist",
            savedBody: "Ship it",
          },
          internal: {
            stage: "drafting",
          },
        },
        cfc: {
          version: 1,
          schemaHash: existingSchemaAndHash.taggedHashString,
          labelMap: {
            version: 1,
            entries: [
              { path: ["argument", "savedTitle"], label: {} },
              { path: ["argument", "savedBody"], label: {} },
            ],
          },
        },
      });
      seed.writeOrThrow({
        space: signer.did(),
        scope: "space",
        id: `cid:${existingSchemaAndHash.taggedHashString}`,
        type,
        path: [],
      }, {
        value: existingSchemaAndHash.schema,
      });
      expect((await seed.commit()).ok).toBeDefined();

      const stageSchemaAndHash = internSchema(
        {
          enum: ["drafting", "saved", "reviewed", "published"],
        } satisfies JSONSchema,
        true,
      );
      const update = runtime.edit();
      update.setCfcEnforcementMode("enforce-explicit");
      update.markCfcRelevant("stage-derived-from-cfc-input");
      update.writeValueOrThrow({
        space: signer.did(),
        scope: "space",
        id: documentId,
        path: ["internal", "stage"],
      }, "saved");
      update.recordCfcWritePolicyInput({
        kind: "schema",
        target: {
          space: signer.did(),
          scope: "space",
          id: documentId,
          path: ["internal", "stage"],
        },
        schemaHash: stageSchemaAndHash.taggedHashString,
        schema: stageSchemaAndHash.schema,
      });

      update.prepareCfc();
      expect(update.getCfcState().diagnostics).not.toContain(
        `missing trusted-event policy input for ${documentId} at /argument/savedTitle`,
      );
      const result = await update.commit();
      expect(result.ok).toBeDefined();

      const replica = storageManager.open(signer.did()).replica as unknown as {
        getDocument(id: string): {
          value?: {
            internal?: { stage?: string };
          };
          cfc?: { schemaHash: string };
        } | undefined;
      };
      const persisted = replica.getDocument(documentId);
      expect(persisted?.value?.internal?.stage).toBe("saved");
      const schemaDoc = replica.getDocument(
        `cid:${persisted!.cfc!.schemaHash}`,
      );
      expect(schemaDoc?.value).toMatchObject({
        properties: {
          argument: {
            properties: {
              savedTitle: {
                ifc: {
                  uiContract: {
                    action: "TrustedSaveDraft",
                  },
                },
              },
            },
          },
          internal: {
            properties: {
              stage: {
                enum: ["drafting", "saved", "reviewed", "published"],
              },
            },
          },
        },
      });
    } finally {
      await runtime.dispose();
      await storageManager.close();
    }
  });

  it("reloads stored schema envelopes after a fresh runtime restart", async () => {
    const storageManager = StorageManager.emulate({
      as: signer,
    });
    const runtime1 = new Runtime({
      apiUrl: new URL("https://example.com"),
      storageManager,
      ...characterizationCfcPosture,
    });
    try {
      const firstTx = runtime1.edit();
      firstTx.setCfcEnforcementMode("enforce-explicit");
      const firstCell = runtime1.getCell(
        signer.did(),
        "cfc-schema-restart",
        {
          type: "object",
          properties: {
            secret: {
              type: "string",
              ifc: { confidentiality: ["secret"] },
            },
          },
          required: ["secret"],
        },
        firstTx,
      );
      firstCell.set({ secret: "hello" });
      firstTx.prepareCfc();
      const firstResult = await firstTx.commit();
      expect(firstResult.ok).toBeDefined();

      const persistedId = parseLink(firstCell.getAsLink()).id!;
      await runtime1.dispose();

      const runtime2 = new Runtime({
        apiUrl: new URL("https://example.com"),
        storageManager,
        ...characterizationCfcPosture,
      });
      try {
        const secondTx = runtime2.edit();
        secondTx.setCfcEnforcementMode("enforce-explicit");
        const secondCell = runtime2.getCell(
          signer.did(),
          "cfc-schema-restart",
          {
            type: "object",
            properties: {
              secret: {
                type: "string",
                ifc: { confidentiality: ["secret"] },
              },
              title: {
                type: "string",
                default: "",
              },
            },
            required: ["secret", "title"],
          },
          secondTx,
        );
        secondCell.set({ secret: "hello", title: "restarted" });
        secondTx.prepareCfc();
        const secondResult = await secondTx.commit();
        expect(secondResult.ok).toBeDefined();

        const replica = storageManager.open(signer.did())
          .replica as unknown as {
            getDocument(id: string): {
              value?: unknown;
              cfc?: { schemaHash: string };
            } | undefined;
          };
        const persisted = replica.getDocument(persistedId);
        const schemaDoc = replica.getDocument(
          `cid:${persisted!.cfc!.schemaHash}`,
        );
        expect(schemaDoc?.value).toMatchObject({
          type: "object",
          required: ["secret", "title"],
        });
      } finally {
        await runtime2.dispose();
      }
    } finally {
      await storageManager.close();
    }
  });

  it("syncs cfc schema documents into separate v2 runtime caches", async () => {
    const server = new MemoryV2Server.Server(TEST_MEMORY_SERVER_AUTH);
    const createStorageManager = () =>
      new SharedV2StorageManager({
        as: signer,
        memoryHost: new URL("memory://"),
      }, server);
    const storageManager1 = createStorageManager();
    const runtime1 = new Runtime({
      apiUrl: new URL("https://example.com"),
      storageManager: storageManager1,
      ...characterizationCfcPosture,
    });
    const cellSchema = {
      type: "object",
      properties: {
        secret: {
          type: "string",
          ifc: { confidentiality: ["secret"] },
        },
      },
      required: ["secret"],
    } as const satisfies JSONSchema;
    try {
      const firstTx = runtime1.edit();
      firstTx.setCfcEnforcementMode("enforce-explicit");
      const firstCell = runtime1.getCell(
        signer.did(),
        "cfc-schema-remote-sync",
        cellSchema,
        firstTx,
      );
      firstCell.set({ secret: "hello" });
      firstTx.prepareCfc();
      const firstResult = await firstTx.commit();
      expect(firstResult.ok).toBeDefined();
      await storageManager1.synced();
    } finally {
      await runtime1.dispose();
      await storageManager1.close();
    }

    const storageManager2 = createStorageManager();
    const runtime2 = new Runtime({
      apiUrl: new URL("https://example.com"),
      storageManager: storageManager2,
      ...characterizationCfcPosture,
    });
    try {
      const secondSchema = {
        type: "object",
        properties: {
          secret: {
            type: "string",
            ifc: { confidentiality: ["secret"] },
          },
          title: { type: "string", default: "" },
        },
        required: ["secret", "title"],
      } as const satisfies JSONSchema;
      const secondCell = runtime2.getCell(
        signer.did(),
        "cfc-schema-remote-sync",
        secondSchema,
      );
      await secondCell.sync();

      const secondTx = runtime2.edit();
      secondTx.setCfcEnforcementMode("enforce-explicit");
      secondCell.withTx(secondTx).set({ secret: "hello", title: "synced" });
      secondTx.prepareCfc();
      const secondResult = await secondTx.commit();
      expect(secondResult.error).toBeUndefined();
      expect(secondResult.ok).toBeDefined();
    } finally {
      await runtime2.dispose();
      await storageManager2.close();
      await server.close();
    }
  });

  it("syncs cfc schema documents for scoped v2 documents", async () => {
    const server = new MemoryV2Server.Server({
      ...TEST_MEMORY_SERVER_AUTH,
      authorizeSessionOpen: () => signer.did(),
    });
    const createStorageManager = () =>
      new SharedV2StorageManager({
        as: signer,
        memoryHost: new URL("memory://"),
      }, server);
    const storageManager1 = createStorageManager();
    const runtime1 = new Runtime({
      apiUrl: new URL("https://example.com"),
      storageManager: storageManager1,
      ...characterizationCfcPosture,
    });
    const cellSchema = {
      type: "object",
      properties: {
        secret: {
          type: "string",
          ifc: { confidentiality: ["secret"] },
        },
      },
      required: ["secret"],
    } as const satisfies JSONSchema;
    try {
      const firstTx = runtime1.edit();
      firstTx.setCfcEnforcementMode("enforce-explicit");
      const firstBaseCell = runtime1.getCell(
        signer.did(),
        "cfc-scoped-schema-remote-sync",
        cellSchema,
        firstTx,
      );
      const firstCell = createCell(
        runtime1,
        { ...firstBaseCell.getAsNormalizedFullLink(), scope: "user" },
        firstTx,
      );
      firstCell.set({ secret: "hello" });
      firstTx.prepareCfc();
      const firstResult = await firstTx.commit();
      expect(firstResult.error).toBeUndefined();
      expect(firstResult.ok).toBeDefined();
      await storageManager1.synced();
    } finally {
      await runtime1.dispose();
      await storageManager1.close();
    }

    const storageManager2 = createStorageManager();
    const runtime2 = new Runtime({
      apiUrl: new URL("https://example.com"),
      storageManager: storageManager2,
      ...characterizationCfcPosture,
    });
    try {
      const secondSchema = {
        type: "object",
        properties: {
          secret: {
            type: "string",
            ifc: { confidentiality: ["secret"] },
          },
          title: { type: "string", default: "" },
        },
        required: ["secret", "title"],
      } as const satisfies JSONSchema;
      const secondBaseCell = runtime2.getCell(
        signer.did(),
        "cfc-scoped-schema-remote-sync",
        secondSchema,
      );
      const secondCell = createCell(
        runtime2,
        { ...secondBaseCell.getAsNormalizedFullLink(), scope: "user" },
      );
      await secondCell.sync();

      const secondTx = runtime2.edit();
      secondTx.setCfcEnforcementMode("enforce-explicit");
      secondCell.withTx(secondTx).set({
        secret: "hello",
        title: "synced",
      });
      secondTx.prepareCfc();
      const secondResult = await secondTx.commit();
      expect(secondResult.error).toBeUndefined();
      expect(secondResult.ok).toBeDefined();
    } finally {
      await runtime2.dispose();
      await storageManager2.close();
      await server.close();
    }
  });

  it("refuses the seeding commit when its schemaHash names no backing document", async () => {
    const { runtime, storageManager } = createRuntime();
    try {
      const seed = runtime.edit();
      const seededId = parseLink(
        runtime.getCell(
          signer.did(),
          "cfc-missing-schema-doc",
          {
            type: "object",
            properties: {
              secret: { type: "string" },
            },
          },
        ).getAsLink(),
      ).id!;
      seedStoredEnvelope(seed, {
        space: signer.did(),
        scope: "space",
        id: seededId,
        path: [],
      }, {
        value: { secret: "seed" },
        cfc: {
          version: 1,
          schemaHash: "missing-hash",
          labelMap: {
            version: 1,
            entries: [{
              path: ["secret"],
              label: { confidentiality: ["secret"] },
            }],
          },
        },
      });
      // The commit boundary polices backing: metadata naming a schema
      // document that is neither in the commit nor stored refuses at seed
      // time, so the bad state a later write would trip over cannot land.
      // (The runner-side load guard keeps its own coverage in
      // cfc-cid-schema-verify.test.ts.)
      const seedResult = await seed.commit();
      expect(seedResult.error?.message).toContain(
        "neither included in the commit nor stored in the space",
      );
    } finally {
      await runtime.dispose();
      await storageManager.close();
    }
  });

  it("rejects writes when requiredIntegrity is not satisfied by consumed input labels", async () => {
    const { runtime, storageManager } = createRuntime();
    try {
      const seed = runtime.edit();
      const sourceId = parseLink(
        runtime.getCell(
          signer.did(),
          "cfc-input",
          {
            type: "object",
            properties: {
              secret: { type: "string" },
            },
          },
        ).getAsLink(),
      ).id!;
      writeSeedEnvelopeDoc(seed, signer.did());
      seedStoredEnvelope(seed, {
        space: signer.did(),
        scope: "space",
        id: sourceId,
        path: [],
      }, {
        value: { secret: "seed" },
        cfc: {
          version: 1,
          schemaHash: SEED_ENVELOPE_SCHEMA_HASH,
          labelMap: {
            version: 1,
            entries: [{
              path: ["secret"],
              label: { integrity: ["untrusted"] },
            }],
          },
        },
      });
      const seedResult = await seed.commit();
      expect(seedResult.ok).toBeDefined();

      const tx = runtime.edit();
      tx.setCfcEnforcementMode("enforce-explicit");
      const source = runtime.getCell(
        signer.did(),
        "cfc-input",
        {
          type: "object",
          properties: {
            secret: { type: "string" },
          },
        },
        tx,
      );
      expect(source.get()).toEqual({ secret: "seed" });
      tx.markCfcRelevant("stored-input-metadata");

      const output = runtime.getCell(
        signer.did(),
        "cfc-output",
        {
          type: "object",
          properties: {
            value: {
              type: "string",
              ifc: { requiredIntegrity: ["trusted"] },
            },
          },
        },
        tx,
      );
      output.set({ value: "result" });

      tx.prepareCfc();
      const result = await tx.commit();
      expect(result.error?.message).toContain("requiredIntegrity");
    } finally {
      await runtime.dispose();
      await storageManager.close();
    }
  });

  it("does not apply exact-path policies for omitted optional fields", async () => {
    const { runtime, storageManager } = createRuntime();
    try {
      const tx = runtime.edit();
      tx.setCfcEnforcementMode("enforce-explicit");
      const output = runtime.getCell(
        signer.did(),
        "cfc-optional-exact-path-policy",
        {
          type: "object",
          properties: {
            public: { type: "string" },
            guarded: {
              type: "string",
              ifc: { requiredIntegrity: ["trusted"] },
            },
          },
        },
        tx,
      );
      output.set({ public: "ok" });

      tx.prepareCfc();
      const result = await tx.commit();
      expect(result.ok).toBeDefined();
    } finally {
      await runtime.dispose();
      await storageManager.close();
    }
  });

  it("rejects removing an existing protected optional field without required integrity", async () => {
    const { runtime, storageManager } = createRuntime();
    try {
      const schema = {
        type: "object",
        properties: {
          public: { type: "string" },
          guarded: {
            type: "string",
            ifc: { requiredIntegrity: ["trusted"] },
          },
        },
      } as const satisfies JSONSchema;

      const seed = runtime.edit();
      const sourceId = parseLink(
        runtime.getCell(
          signer.did(),
          "cfc-optional-removal-source",
          {
            type: "object",
            properties: {
              secret: { type: "string" },
            },
          },
        ).getAsLink(),
      ).id!;
      writeSeedEnvelopeDoc(seed, signer.did());
      seedStoredEnvelope(seed, {
        space: signer.did(),
        scope: "space",
        id: sourceId,
        path: [],
      }, {
        value: { secret: "untrusted" },
        cfc: {
          version: 1,
          schemaHash: SEED_ENVELOPE_SCHEMA_HASH,
          labelMap: {
            version: 1,
            entries: [{
              path: ["secret"],
              label: { integrity: ["untrusted"] },
            }],
          },
        },
      });
      const targetId = parseLink(
        runtime.getCell(
          signer.did(),
          "cfc-optional-removal-target",
          schema,
        ).getAsLink(),
      ).id!;
      seed.writeOrThrow({
        space: signer.did(),
        scope: "space",
        id: targetId,
        path: [],
      }, {
        value: { public: "before", guarded: "old" },
      });
      expect((await seed.commit()).ok).toBeDefined();

      const tx = runtime.edit();
      tx.setCfcEnforcementMode("enforce-explicit");
      const source = runtime.getCell(
        signer.did(),
        "cfc-optional-removal-source",
        {
          type: "object",
          properties: {
            secret: { type: "string" },
          },
        },
        tx,
      );
      expect(source.get()).toEqual({ secret: "untrusted" });
      tx.markCfcRelevant("stored-input-metadata");

      const output = runtime.getCell(
        signer.did(),
        "cfc-optional-removal-target",
        schema,
        tx,
      );
      output.set({ public: "after" });

      tx.prepareCfc();
      const result = await tx.commit();
      expect(result.error?.message).toContain("requiredIntegrity");
    } finally {
      await runtime.dispose();
      await storageManager.close();
    }
  });

  it("evaluates exact-path policies against explicit null writes", async () => {
    const { runtime, storageManager } = createRuntime();
    try {
      const schema = {
        type: "object",
        properties: {
          guarded: {
            type: "null",
            ifc: { requiredIntegrity: ["trusted"] },
          },
        },
      } as const satisfies JSONSchema;

      const seed = runtime.edit();
      const sourceId = parseLink(
        runtime.getCell(
          signer.did(),
          "cfc-null-write-source",
          {
            type: "object",
            properties: {
              secret: { type: "string" },
            },
          },
        ).getAsLink(),
      ).id!;
      writeSeedEnvelopeDoc(seed, signer.did());
      seedStoredEnvelope(seed, {
        space: signer.did(),
        scope: "space",
        id: sourceId,
        path: [],
      }, {
        value: { secret: "untrusted" },
        cfc: {
          version: 1,
          schemaHash: SEED_ENVELOPE_SCHEMA_HASH,
          labelMap: {
            version: 1,
            entries: [{
              path: ["secret"],
              label: { integrity: ["untrusted"] },
            }],
          },
        },
      });
      const targetId = parseLink(
        runtime.getCell(
          signer.did(),
          "cfc-null-write-target",
          schema,
        ).getAsLink(),
      ).id!;
      seed.writeOrThrow({
        space: signer.did(),
        scope: "space",
        id: targetId,
        path: [],
      }, {
        value: { guarded: "stale" },
      });
      expect((await seed.commit()).ok).toBeDefined();

      const tx = runtime.edit();
      tx.setCfcEnforcementMode("enforce-explicit");
      const source = runtime.getCell(
        signer.did(),
        "cfc-null-write-source",
        {
          type: "object",
          properties: {
            secret: { type: "string" },
          },
        },
        tx,
      );
      expect(source.get()).toEqual({ secret: "untrusted" });
      tx.markCfcRelevant("stored-input-metadata");

      const output = runtime.getCell(
        signer.did(),
        "cfc-null-write-target",
        schema,
        tx,
      );
      output.set({ guarded: null });

      tx.prepareCfc();
      const result = await tx.commit();
      expect(result.error?.message).toContain("requiredIntegrity");
    } finally {
      await runtime.dispose();
      await storageManager.close();
    }
  });

  it("treats unrelated consumed reads as influencing every target path in phase 1", async () => {
    const { runtime, storageManager } = createRuntime();
    try {
      const seed = runtime.edit();
      const trustedSourceId = parseLink(
        runtime.getCell(
          signer.did(),
          "cfc-phase1-trusted-source",
          {
            type: "object",
            properties: {
              secret: { type: "string" },
            },
          },
        ).getAsLink(),
      ).id!;
      writeSeedEnvelopeDoc(seed, signer.did());
      seedStoredEnvelope(seed, {
        space: signer.did(),
        scope: "space",
        id: trustedSourceId,
        path: [],
      }, {
        value: { secret: "trusted" },
        cfc: {
          version: 1,
          schemaHash: SEED_ENVELOPE_SCHEMA_HASH,
          labelMap: {
            version: 1,
            entries: [{
              path: ["secret"],
              label: { integrity: ["trusted"] },
            }],
          },
        },
      });
      const untrustedSourceId = parseLink(
        runtime.getCell(
          signer.did(),
          "cfc-phase1-unrelated-source",
          {
            type: "object",
            properties: {
              secret: { type: "string" },
            },
          },
        ).getAsLink(),
      ).id!;
      writeSeedEnvelopeDoc(seed, signer.did());
      seedStoredEnvelope(seed, {
        space: signer.did(),
        scope: "space",
        id: untrustedSourceId,
        path: [],
      }, {
        value: { secret: "untrusted" },
        cfc: {
          version: 1,
          schemaHash: SEED_ENVELOPE_SCHEMA_HASH,
          labelMap: {
            version: 1,
            entries: [{
              path: ["secret"],
              label: { integrity: ["untrusted"] },
            }],
          },
        },
      });
      expect((await seed.commit()).ok).toBeDefined();

      const tx = runtime.edit();
      tx.setCfcEnforcementMode("enforce-explicit");
      const trustedSource = runtime.getCell(
        signer.did(),
        "cfc-phase1-trusted-source",
        {
          type: "object",
          properties: {
            secret: { type: "string" },
          },
        },
        tx,
      );
      const unrelatedSource = runtime.getCell(
        signer.did(),
        "cfc-phase1-unrelated-source",
        {
          type: "object",
          properties: {
            secret: { type: "string" },
          },
        },
        tx,
      );
      expect(trustedSource.get()).toEqual({ secret: "trusted" });
      expect(unrelatedSource.get()).toEqual({ secret: "untrusted" });
      tx.markCfcRelevant("stored-input-metadata");

      const output = runtime.getCell(
        signer.did(),
        "cfc-phase1-target",
        {
          type: "object",
          properties: {
            value: {
              type: "string",
              ifc: { requiredIntegrity: ["trusted"] },
            },
          },
        },
        tx,
      );
      output.set({ value: "result" });

      tx.prepareCfc();
      const result = await tx.commit();
      expect(result.error?.message).toContain("requiredIntegrity");
    } finally {
      await runtime.dispose();
      await storageManager.close();
    }
  });

  it("rejects writes when maxConfidentiality is not satisfied by consumed input labels", async () => {
    const { runtime, storageManager } = createRuntime();
    try {
      const seed = runtime.edit();
      const sourceId = parseLink(
        runtime.getCell(
          signer.did(),
          "cfc-max-conf-input",
          {
            type: "object",
            properties: {
              secret: { type: "string" },
            },
          },
        ).getAsLink(),
      ).id!;
      writeSeedEnvelopeDoc(seed, signer.did());
      seedStoredEnvelope(seed, {
        space: signer.did(),
        scope: "space",
        id: sourceId,
        path: [],
      }, {
        value: { secret: "seed" },
        cfc: {
          version: 1,
          schemaHash: SEED_ENVELOPE_SCHEMA_HASH,
          labelMap: {
            version: 1,
            entries: [{
              path: ["secret"],
              label: { confidentiality: ["secret"] },
            }],
          },
        },
      });
      expect((await seed.commit()).ok).toBeDefined();

      const tx = runtime.edit();
      tx.setCfcEnforcementMode("enforce-explicit");
      const source = runtime.getCell(
        signer.did(),
        "cfc-max-conf-input",
        {
          type: "object",
          properties: {
            secret: { type: "string" },
          },
        },
        tx,
      );
      expect(source.get()).toEqual({ secret: "seed" });
      tx.markCfcRelevant("stored-input-metadata");

      const output = runtime.getCell(
        signer.did(),
        "cfc-max-conf-output",
        {
          type: "object",
          properties: {
            value: {
              type: "string",
              ifc: { maxConfidentiality: ["internal"] },
            },
          },
          required: ["value"],
        },
        tx,
      );
      output.set({ value: "result" });

      tx.prepareCfc();
      const result = await tx.commit();
      expect(result.error?.message).toContain("maxConfidentiality");
    } finally {
      await runtime.dispose();
      await storageManager.close();
    }
  });

  it("rejects maxConfidentiality when a labeled child is consumed via a schema-less parent read", async () => {
    const { runtime, storageManager } = createRuntime();
    try {
      const seed = runtime.edit();
      const sourceId = parseLink(
        runtime.getCell(
          signer.did(),
          "cfc-max-conf-parent-read-input",
          {
            type: "object",
            properties: {
              secret: { type: "string" },
            },
          },
        ).getAsLink(),
      ).id!;
      writeSeedEnvelopeDoc(seed, signer.did());
      seedStoredEnvelope(seed, {
        space: signer.did(),
        scope: "space",
        id: sourceId,
        path: [],
      }, {
        value: { secret: "seed" },
        cfc: {
          version: 1,
          schemaHash: SEED_ENVELOPE_SCHEMA_HASH,
          labelMap: {
            version: 1,
            entries: [{
              path: ["secret"],
              label: { confidentiality: ["secret"] },
            }],
          },
        },
      });
      expect((await seed.commit()).ok).toBeDefined();

      const tx = runtime.edit();
      tx.setCfcEnforcementMode("enforce-explicit");
      // Raw parent read: the journal records one recursive read at the value
      // root — no per-leaf reads — yet the raw value hands the labeled child
      // to the handler. The child's label must enter the consumed set via
      // subtree join, not vanish behind the ancestor-only lookup.
      const source = runtime.getCell(
        signer.did(),
        "cfc-max-conf-parent-read-input",
        undefined,
        tx,
      );
      const raw = source.getRaw() as { secret?: string };
      expect(raw.secret).toBe("seed");
      tx.markCfcRelevant("stored-input-metadata");

      const output = runtime.getCell(
        signer.did(),
        "cfc-max-conf-parent-read-output",
        {
          type: "object",
          properties: {
            value: {
              type: "string",
              ifc: { maxConfidentiality: ["internal"] },
            },
          },
          required: ["value"],
        },
        tx,
      );
      output.set({ value: "result" });

      tx.prepareCfc();
      const result = await tx.commit();
      expect(result.error?.message).toContain("maxConfidentiality");
    } finally {
      await runtime.dispose();
      await storageManager.close();
    }
  });

  it("does not let helper source-cell reads affect the prepared digest", async () => {
    const { runtime, storageManager } = createRuntime();
    try {
      const setupTx = runtime.edit();
      setupTx.setCfcEnforcementMode("enforce-explicit");
      const sourceCell = runtime.getCell(
        signer.did(),
        "internal-verifier-source",
        {
          type: "object",
          properties: {
            foo: { type: "number" },
          },
        },
        setupTx,
      );
      sourceCell.set({ foo: 1 });

      const targetCell = runtime.getCell(
        signer.did(),
        "internal-verifier-target",
        {
          type: "object",
          properties: {
            bar: {
              type: "string",
              ifc: { confidentiality: ["secret"] },
            },
          },
          required: ["bar"],
        },
        setupTx,
      );
      targetCell.set({ bar: "seed" });
      setResultCell(targetCell, sourceCell);
      setupTx.prepareCfc();
      expect((await setupTx.commit()).ok).toBeDefined();

      const tx1 = runtime.edit();
      tx1.setCfcEnforcementMode("enforce-explicit");
      const plainTarget1 = runtime.getCell(
        signer.did(),
        "internal-verifier-target",
        {
          type: "object",
          properties: {
            bar: {
              type: "string",
              ifc: { confidentiality: ["secret"] },
            },
          },
          required: ["bar"],
        },
        tx1,
      );
      plainTarget1.set({ bar: "updated" });
      tx1.prepareCfc();
      const prepared1 = tx1.getCfcState().prepare;
      const digest1 = prepared1.status === "prepared"
        ? prepared1.digest
        : undefined;

      const tx2 = runtime.edit();
      tx2.setCfcEnforcementMode("enforce-explicit");
      const plainTarget2 = runtime.getCell(
        signer.did(),
        "internal-verifier-target",
        {
          type: "object",
          properties: {
            bar: {
              type: "string",
              ifc: { confidentiality: ["secret"] },
            },
          },
          required: ["bar"],
        },
        tx2,
      );
      expect(getMetaLink(plainTarget2, "result", {
        meta: { ...ignoreReadForScheduling, ...internalVerifierRead },
      })).toBeDefined();
      plainTarget2.set({ bar: "updated" });
      tx2.prepareCfc();
      const prepared2 = tx2.getCfcState().prepare;
      const digest2 = prepared2.status === "prepared"
        ? prepared2.digest
        : undefined;

      expect(digest1).toBeDefined();
      expect(digest2).toBeDefined();
      expect(digest2).toBe(digest1);
    } finally {
      await runtime.dispose();
      await storageManager.close();
    }
  });

  it("persists only concrete evidence and addIntegrity in output metadata", async () => {
    const { runtime, storageManager } = createRuntime();
    try {
      const seed = runtime.edit();
      const sourceId = parseLink(
        runtime.getCell(
          signer.did(),
          "cfc-propagation-input",
          {
            type: "object",
            properties: {
              secret: { type: "string" },
            },
          },
        ).getAsLink(),
      ).id!;
      writeSeedEnvelopeDoc(seed, signer.did());
      seedStoredEnvelope(seed, {
        space: signer.did(),
        scope: "space",
        id: sourceId,
        path: [],
      }, {
        value: { secret: "seed" },
        cfc: {
          version: 1,
          schemaHash: SEED_ENVELOPE_SCHEMA_HASH,
          labelMap: {
            version: 1,
            entries: [{
              path: ["secret"],
              label: {
                confidentiality: ["secret"],
                integrity: ["source-integrity"],
              },
            }],
          },
        },
      });
      expect((await seed.commit()).ok).toBeDefined();

      const tx = runtime.edit();
      tx.setCfcEnforcementMode("enforce-explicit");
      const source = runtime.getCell(
        signer.did(),
        "cfc-propagation-input",
        {
          type: "object",
          properties: {
            secret: { type: "string" },
          },
        },
        tx,
      );
      expect(source.get()).toEqual({ secret: "seed" });
      tx.markCfcRelevant("stored-input-metadata");

      const output = runtime.getCell(
        signer.did(),
        "cfc-propagation-output",
        {
          type: "object",
          properties: {
            value: {
              type: "string",
              ifc: {
                integrity: ["target-integrity"],
                addIntegrity: ["derived-integrity"],
              },
            },
          },
          required: ["value"],
        },
        tx,
      );
      output.set({ value: "result" });

      tx.prepareCfc();
      const result = await tx.commit();
      expect(result.ok).toBeDefined();

      const replica = storageManager.open(signer.did()).replica as unknown as {
        getDocument(id: string): {
          cfc?: {
            labelMap?: {
              entries: Array<{
                path: string[];
                label: {
                  confidentiality?: string[];
                  integrity?: string[];
                };
              }>;
            };
          };
        } | undefined;
      };
      const persisted = replica.getDocument(parseLink(output.getAsLink()).id!);
      expect(persisted?.cfc?.labelMap?.entries).toContainEqual({
        path: ["value"],
        label: {
          integrity: [
            "target-integrity",
            "derived-integrity",
          ],
        },
        origin: "declared",
      });
    } finally {
      await runtime.dispose();
      await storageManager.close();
    }
  });

  it("keeps unrelated direct writes without schema policy inputs out of CFC prepare", async () => {
    const { runtime, storageManager } = createRuntime();
    try {
      const tx = runtime.edit();
      tx.setCfcEnforcementMode("enforce-explicit");
      tx.markCfcRelevant("direct-write-without-schema-input");
      tx.writeValueOrThrow({
        space: signer.did(),
        scope: "space",
        id: "of:cfc-missing-schema-input",
        path: [],
      }, { secret: "value" });

      tx.prepareCfc();
      const result = await tx.commit();
      expect(result.ok).toBeDefined();
    } finally {
      await runtime.dispose();
      await storageManager.close();
    }
  });

  it("keeps untyped pattern result writes without CFC labels permissive", async () => {
    const { runtime, storageManager } = createRuntime();
    try {
      const pattern = {
        argumentSchema: { type: "object", properties: {} } as const,
        resultSchema: undefined,
        result: { title: "Untyped" },
        nodes: [],
      } as unknown as Pattern;
      const tx = runtime.edit();
      tx.setCfcEnforcementMode("enforce-explicit");
      tx.markCfcRelevant("untyped-pattern-result");

      const resultCell = runtime.getCell(
        signer.did(),
        "cfc-untyped-pattern-result",
        undefined,
        tx,
      );
      runtime.run(tx, pattern, {}, resultCell);

      runtime.prepareTxForCommit(tx);
      const result = await tx.commit();
      expect(result.ok).toBeDefined();
    } finally {
      await runtime.dispose();
      await storageManager.close();
    }
  });

  it("fails closed on writeAuthorizedBy without a trusted implementation identity", async () => {
    const { runtime, storageManager } = createRuntime();
    try {
      const tx = runtime.edit();
      tx.setCfcEnforcementMode("enforce-explicit");

      const cell = runtime.getCell(
        signer.did(),
        "cfc-unsupported-trust-claim",
        {
          type: "object",
          properties: {
            value: {
              type: "string",
              ifc: { writeAuthorizedBy: ["trusted-handler"] },
            },
          },
          required: ["value"],
        },
        tx,
      );
      cell.set({ value: "secret" });

      tx.prepareCfc();
      const result = await tx.commit();
      expect(result.error?.message).toContain(
        "writeAuthorizedBy requires a trusted builtin identity",
      );
    } finally {
      await runtime.dispose();
      await storageManager.close();
    }
  });

  it("allows writeAuthorizedBy when the builtin identity matches", async () => {
    const { runtime, storageManager } = createRuntime();
    try {
      runtime.moduleRegistry.addModuleByRef(
        "trusted-handler",
        raw((inputsCell) => {
          const tx = inputsCell.tx;
          if (!tx) {
            throw new Error("missing tx");
          }
          const cell = runtime.getCell(
            signer.did(),
            "cfc-authorized-write",
            {
              type: "object",
              properties: {
                value: {
                  type: "string",
                  ifc: { writeAuthorizedBy: ["trusted-handler"] },
                },
              },
              required: ["value"],
            },
            tx,
          );
          cell.set({ value: "authorized" });
          return () => undefined;
        }),
      );

      const tx = runtime.edit();
      const resultCell = runtime.getCell(
        signer.did(),
        "cfc-authorized-write-result",
        undefined,
        tx,
      );
      runtime.runner.run(
        tx,
        runtime.moduleRegistry.getModule("trusted-handler"),
        {},
        resultCell,
      );

      runtime.prepareTxForCommit(tx);
      const result = await tx.commit();
      expect(result.ok).toBeDefined();
    } finally {
      await runtime.dispose();
      await storageManager.close();
    }
  });

  it("allows writeAuthorizedBy when a verified binding identity matches", async () => {
    const { runtime, storageManager } = createRuntime();
    try {
      const tx = runtime.edit();
      tx.setCfcEnforcementMode("enforce-explicit");
      setCfcTrustSnapshot(tx, {
        id: "trust-snapshot-1",
        actingPrincipal: signer.did(),
      });
      setCfcImplementationIdentity(tx, {
        kind: "verified",
        moduleIdentity: "module-hash-1",
        sourceFile: "/main.tsx",
        bindingPath: ["localFunction"],
      });

      const cell = runtime.getCell(
        signer.did(),
        "cfc-authorized-verified-write",
        {
          type: "object",
          properties: {
            value: {
              type: "string",
              ifc: {
                writeAuthorizedBy: {
                  __ctWriterIdentityOf: {
                    file: "/main.tsx",
                    path: ["localFunction"],
                  },
                },
              },
            },
          },
          required: ["value"],
        },
        tx,
      );
      cell.set({ value: "authorized" });

      tx.prepareCfc();
      const result = await tx.commit();
      expect(result.ok).toBeDefined();
    } finally {
      await runtime.dispose();
      await storageManager.close();
    }
  });

  it("resolves represents-principal(current user) from the trust snapshot", async () => {
    const { runtime, storageManager } = createRuntime();
    try {
      const tx = runtime.edit();
      tx.setCfcEnforcementMode("enforce-explicit");
      setCfcTrustSnapshot(tx, {
        id: "trust-snapshot-current-profile",
        actingPrincipal: signer.did(),
      });
      setCfcImplementationIdentity(tx, {
        kind: "verified",
        moduleIdentity: "module-hash-1",
        sourceFile: "/trusted.tsx",
        bindingPath: ["commitTrustedProfileSave"],
      });

      const cell = runtime.getCell(
        signer.did(),
        "cfc-current-principal-profile",
        {
          type: "object",
          properties: {
            profile: {
              type: "object",
              properties: { name: { type: "string" } },
              required: ["name"],
              ifc: {
                addIntegrity: [{
                  kind: "represents-principal",
                  subject: { __ctCurrentPrincipal: true },
                }],
                writeAuthorizedBy: {
                  __ctWriterIdentityOf: {
                    file: "/trusted.tsx",
                    path: ["commitTrustedProfileSave"],
                  },
                },
                uiContract: {
                  helper: "UiAction",
                  action: "SaveProfile",
                  trustedPattern: "ProfileSurface",
                  requiredEventIntegrity: ["ProfileSurface"],
                },
              },
            },
          },
          required: ["profile"],
        },
        tx,
      );
      cell.set({ profile: { name: "Ada" } });
      const target = cell.getAsNormalizedFullLink();
      tx.recordCfcWritePolicyInput({
        kind: "trusted-event",
        target: {
          space: target.space,
          scope: target.scope,
          id: target.id,
          path: ["profile"],
        },
        eventId: "trusted-save-profile",
        provenance: {
          origin: "dom",
          trusted: true,
          ui: {
            pattern: "ProfileSurface",
            eventIntegrity: ["ProfileSurface"],
            uiContractDataset: { uiAction: "SaveProfile" },
          },
        },
      });

      tx.prepareCfc();
      const result = await tx.commit();
      expect(result.ok).toBeDefined();

      const verify = runtime.edit();
      const stored = verify.readOrThrow({
        space: signer.did(),
        scope: "space",
        id: target.id,
        path: [],
      }) as { cfc?: { labelMap?: { entries?: unknown[] } } };
      expect(stored.cfc?.labelMap?.entries).toContainEqual({
        path: ["profile"],
        label: {
          integrity: [{
            kind: "represents-principal",
            subject: signer.did(),
          }],
        },
        origin: "declared",
      });
      verify.abort();
    } finally {
      await runtime.dispose();
      await storageManager.close();
    }
  });

  it("resolves authored-by(current user) from the trust snapshot", async () => {
    const { runtime, storageManager } = createRuntime();
    try {
      const tx = runtime.edit();
      tx.setCfcEnforcementMode("enforce-explicit");
      setCfcTrustSnapshot(tx, {
        id: "trust-snapshot-current-message",
        actingPrincipal: signer.did(),
      });
      setCfcImplementationIdentity(tx, {
        kind: "verified",
        moduleIdentity: "module-hash-1",
        sourceFile: "/trusted.tsx",
        bindingPath: ["commitTrustedMessageSend"],
      });

      const cell = runtime.getCell(
        signer.did(),
        "cfc-current-principal-message",
        {
          type: "object",
          properties: {
            message: {
              type: "object",
              properties: { body: { type: "string" } },
              required: ["body"],
              ifc: {
                addIntegrity: [{
                  kind: "authored-by",
                  subject: { __ctCurrentPrincipal: true },
                }],
                writeAuthorizedBy: {
                  __ctWriterIdentityOf: {
                    file: "/trusted.tsx",
                    path: ["commitTrustedMessageSend"],
                  },
                },
                uiContract: {
                  helper: "UiAction",
                  action: "SendMessage",
                  trustedPattern: "SendSurface",
                  requiredEventIntegrity: ["SendSurface"],
                },
              },
            },
          },
          required: ["message"],
        },
        tx,
      );
      cell.set({ message: { body: "hello" } });
      const target = cell.getAsNormalizedFullLink();
      tx.recordCfcWritePolicyInput({
        kind: "trusted-event",
        target: {
          space: target.space,
          scope: target.scope,
          id: target.id,
          path: ["message"],
        },
        eventId: "trusted-send-message",
        provenance: {
          origin: "dom",
          trusted: true,
          ui: {
            pattern: "SendSurface",
            eventIntegrity: ["SendSurface"],
            uiContractDataset: { uiAction: "SendMessage" },
          },
        },
      });

      tx.prepareCfc();
      const result = await tx.commit();
      expect(result.ok).toBeDefined();

      const verify = runtime.edit();
      const stored = verify.readOrThrow({
        space: signer.did(),
        scope: "space",
        id: target.id,
        path: [],
      }) as { cfc?: { labelMap?: { entries?: unknown[] } } };
      expect(stored.cfc?.labelMap?.entries).toContainEqual({
        path: ["message"],
        label: {
          integrity: [{
            kind: "authored-by",
            subject: signer.did(),
          }],
        },
        origin: "declared",
      });
      verify.abort();
    } finally {
      await runtime.dispose();
      await storageManager.close();
    }
  });

  it("rejects current-principal integrity without trusted write provenance", async () => {
    const { runtime, storageManager } = createRuntime();
    try {
      const tx = runtime.edit();
      tx.setCfcEnforcementMode("enforce-explicit");
      setCfcTrustSnapshot(tx, {
        id: "trust-snapshot-current-missing-write",
        actingPrincipal: signer.did(),
      });

      const cell = runtime.getCell(
        signer.did(),
        "cfc-current-principal-missing-write",
        {
          type: "object",
          properties: {
            value: {
              type: "string",
              ifc: {
                addIntegrity: [{
                  kind: "authored-by",
                  subject: { __ctCurrentPrincipal: true },
                }],
                uiContract: {
                  helper: "UiAction",
                  action: "SendMessage",
                },
              },
            },
          },
          required: ["value"],
        },
        tx,
      );
      cell.set({ value: "hello" });

      tx.prepareCfc();
      const result = await tx.commit();
      expect(result.error?.message).toContain(
        "current-principal integrity requires writeAuthorizedBy",
      );
    } finally {
      await runtime.dispose();
      await storageManager.close();
    }
  });

  it("explains when current-principal integrity is missing a trust snapshot id", async () => {
    const { runtime, storageManager } = createRuntime();
    try {
      const tx = runtime.edit();
      tx.setCfcEnforcementMode("enforce-explicit");
      setCfcTrustSnapshot(
        tx,
        {
          actingPrincipal: signer.did(),
        } as unknown as Parameters<typeof setCfcTrustSnapshot>[1],
      );

      const cell = runtime.getCell(
        signer.did(),
        "cfc-current-principal-missing-trust-snapshot-id",
        {
          type: "object",
          properties: {
            value: {
              type: "string",
              ifc: {
                addIntegrity: [{
                  kind: "authored-by",
                  subject: { __ctCurrentPrincipal: true },
                }],
                writeAuthorizedBy: {
                  __ctWriterIdentityOf: {
                    file: "/trusted.tsx",
                    path: ["commitTrustedMessageSend"],
                  },
                },
                uiContract: {
                  helper: "UiAction",
                  action: "SendMessage",
                },
              },
            },
          },
          required: ["value"],
        },
        tx,
      );
      cell.set({ value: "hello" });

      tx.prepareCfc();
      const result = await tx.commit();
      expect(result.error?.message).toContain(
        "current-principal integrity requires a trust snapshot id",
      );
    } finally {
      await runtime.dispose();
      await storageManager.close();
    }
  });

  it("explains when current-principal integrity is missing an acting principal", async () => {
    const { runtime, storageManager } = createRuntime();
    try {
      const tx = runtime.edit();
      tx.setCfcEnforcementMode("enforce-explicit");
      setCfcTrustSnapshot(tx, {
        id: "trust-snapshot-current-missing-acting-principal",
      });

      const cell = runtime.getCell(
        signer.did(),
        "cfc-current-principal-missing-acting-principal",
        {
          type: "object",
          properties: {
            value: {
              type: "string",
              ifc: {
                addIntegrity: [{
                  kind: "authored-by",
                  subject: { __ctCurrentPrincipal: true },
                }],
                writeAuthorizedBy: {
                  __ctWriterIdentityOf: {
                    file: "/trusted.tsx",
                    path: ["commitTrustedMessageSend"],
                  },
                },
                uiContract: {
                  helper: "UiAction",
                  action: "SendMessage",
                },
              },
            },
          },
          required: ["value"],
        },
        tx,
      );
      cell.set({ value: "hello" });

      tx.prepareCfc();
      const result = await tx.commit();
      expect(result.error?.message).toContain(
        "current-principal integrity requires an acting principal",
      );
    } finally {
      await runtime.dispose();
      await storageManager.close();
    }
  });

  it("rejects current-principal integrity without trusted UI provenance", async () => {
    const { runtime, storageManager } = createRuntime();
    try {
      const tx = runtime.edit();
      tx.setCfcEnforcementMode("enforce-explicit");
      setCfcTrustSnapshot(tx, {
        id: "trust-snapshot-current-missing-ui",
        actingPrincipal: signer.did(),
      });
      setCfcImplementationIdentity(tx, {
        kind: "verified",
        moduleIdentity: "module-hash-1",
        sourceFile: "/trusted.tsx",
        bindingPath: ["commitTrustedMessageSend"],
      });

      const cell = runtime.getCell(
        signer.did(),
        "cfc-current-principal-missing-ui",
        {
          type: "object",
          properties: {
            value: {
              type: "string",
              ifc: {
                addIntegrity: [{
                  kind: "authored-by",
                  subject: { __ctCurrentPrincipal: true },
                }],
                writeAuthorizedBy: {
                  __ctWriterIdentityOf: {
                    file: "/trusted.tsx",
                    path: ["commitTrustedMessageSend"],
                  },
                },
              },
            },
          },
          required: ["value"],
        },
        tx,
      );
      cell.set({ value: "hello" });

      tx.prepareCfc();
      const result = await tx.commit();
      expect(result.error?.message).toContain(
        "current-principal integrity requires uiContract",
      );
    } finally {
      await runtime.dispose();
      await storageManager.close();
    }
  });

  it("rejects pattern-authored literal DID subjects for current-user claims", async () => {
    const { runtime, storageManager } = createRuntime();
    try {
      const tx = runtime.edit();
      tx.setCfcEnforcementMode("enforce-explicit");
      setCfcTrustSnapshot(tx, {
        id: "trust-snapshot-current-literal-did",
        actingPrincipal: signer.did(),
      });
      setCfcImplementationIdentity(tx, {
        kind: "verified",
        moduleIdentity: "module-hash-1",
        sourceFile: "/trusted.tsx",
        bindingPath: ["commitTrustedMessageSend"],
      });

      const cell = runtime.getCell(
        signer.did(),
        "cfc-current-principal-literal-did",
        {
          type: "object",
          properties: {
            value: {
              type: "string",
              ifc: {
                addIntegrity: [{
                  kind: "authored-by",
                  subject: "did:example:mallory",
                }],
                writeAuthorizedBy: {
                  __ctWriterIdentityOf: {
                    file: "/trusted.tsx",
                    path: ["commitTrustedMessageSend"],
                  },
                },
                uiContract: {
                  helper: "UiAction",
                  action: "SendMessage",
                  trustedPattern: "SendSurface",
                  requiredEventIntegrity: ["SendSurface"],
                },
              },
            },
          },
          required: ["value"],
        },
        tx,
      );
      cell.set({ value: "hello" });
      const target = cell.getAsNormalizedFullLink();
      tx.recordCfcWritePolicyInput({
        kind: "trusted-event",
        target: {
          space: target.space,
          scope: target.scope,
          id: target.id,
          path: ["value"],
        },
        eventId: "trusted-send-literal-did",
        provenance: {
          origin: "dom",
          trusted: true,
          ui: {
            pattern: "SendSurface",
            eventIntegrity: ["SendSurface"],
            uiContractDataset: { uiAction: "SendMessage" },
          },
        },
      });

      tx.prepareCfc();
      const result = await tx.commit();
      expect(result.error?.message).toContain(
        "current-principal integrity subject must be runtime resolved",
      );
    } finally {
      await runtime.dispose();
      await storageManager.close();
    }
  });

  it("rejects a legacy bundleId-only writeAuthorizedBy claim (arm retired, identity E5)", async () => {
    const { runtime, storageManager } = createRuntime();
    try {
      const tx = runtime.edit();
      tx.setCfcEnforcementMode("enforce-explicit");
      setCfcTrustSnapshot(tx, {
        id: "trust-snapshot-1",
        actingPrincipal: signer.did(),
      });
      setCfcImplementationIdentity(tx, {
        kind: "verified",
        moduleIdentity: "module-hash-1",
        sourceFile: "/main.tsx",
        bindingPath: ["localFunction"],
      });

      const cell = runtime.getCell(
        signer.did(),
        "cfc-rejected-verified-bundle-write",
        {
          type: "object",
          properties: {
            value: {
              type: "string",
              ifc: {
                writeAuthorizedBy: {
                  __ctWriterIdentityOf: {
                    bundleId: "bundle-hash-2",
                    file: "/main.tsx",
                    path: ["localFunction"],
                  },
                },
              },
            },
          },
          required: ["value"],
        },
        tx,
      );
      cell.set({ value: "rejected" });

      tx.prepareCfc();
      const result = await tx.commit();
      expect(result.error?.message).toContain("writeAuthorizedBy failed");
    } finally {
      await runtime.dispose();
      await storageManager.close();
    }
  });

  it("records diagnostics for unsupported trust-sensitive claims in observe mode", async () => {
    const { runtime, storageManager } = createRuntime("observe");
    try {
      const tx = runtime.edit();

      const cell = runtime.getCell(
        signer.did(),
        "cfc-observe-unsupported-trust-claim",
        {
          type: "object",
          properties: {
            value: {
              type: "string",
              ifc: { opaque: true } as any,
            },
          },
          required: ["value"],
        },
        tx,
      );
      cell.set({ value: "observed" });

      const result = await tx.commit();
      expect(result.ok).toBeDefined();
      expect(tx.getCfcState().diagnostics).toContain(
        "unsupported trust-sensitive claim opaque at /value",
      );
    } finally {
      await runtime.dispose();
      await storageManager.close();
    }
  });

  it("records diagnostics for malformed projection claims in observe mode", async () => {
    const { runtime, storageManager } = createRuntime("observe");
    try {
      const tx = runtime.edit();

      const cell = runtime.getCell(
        signer.did(),
        "cfc-observe-malformed-projection-claim",
        {
          type: "object",
          properties: {
            value: {
              type: "string",
              // Array-form pointers are not the lowered CanonicalPointer
              // dialect — the claim is malformed, and observe mode must
              // diagnose it rather than silently skip verification.
              ifc: {
                projection: {
                  from: ["input", "value"],
                  path: ["value"],
                },
              } as any,
            },
          },
          required: ["value"],
        },
        tx,
      );
      cell.set({ value: "observed" });

      const result = await tx.commit();
      expect(result.ok).toBeDefined();
      expect(tx.getCfcState().diagnostics).toContain(
        "malformed projection claim at /value",
      );
    } finally {
      await runtime.dispose();
      await storageManager.close();
    }
  });

  it("fails closed on object-shaped collection claims in enforcing modes", async () => {
    const { runtime, storageManager } = createRuntime();
    try {
      const tx = runtime.edit();
      tx.setCfcEnforcementMode("enforce-explicit");

      const cell = runtime.getCell(
        signer.did(),
        "cfc-unsupported-collection-claim",
        {
          type: "object",
          properties: {
            value: {
              type: "array",
              items: { type: "string" },
              ifc: {
                collection: {
                  subsetOf: ["input", "items"],
                  memberIntegrity: "preserved",
                },
              } as any,
            },
          },
          required: ["value"],
        },
        tx,
      );
      cell.set({ value: ["observed"] });

      tx.prepareCfc();
      const result = await tx.commit();
      expect(result.error?.message).toContain(
        "unsupported trust-sensitive claim collection",
      );
    } finally {
      await runtime.dispose();
      await storageManager.close();
    }
  });
});
