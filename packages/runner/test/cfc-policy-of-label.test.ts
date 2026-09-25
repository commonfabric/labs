import { expect } from "@std/expect";
import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";

import { CFC_ATOM_TYPE, cfcAtom } from "@commonfabric/api/cfc";
import { internSchema } from "@commonfabric/data-model-schema";
import { Identity } from "@commonfabric/identity";
import { isObjectOrArray } from "@commonfabric/utils/types";

import type { JSONSchema } from "../src/builder/types.ts";
import type { CfcConfClause } from "../src/cfc/clause.ts";
import { readStoredCfcMetadata } from "../src/cfc/metadata.ts";
import {
  createTxCfcModulePolicyResolver,
  decideSinkRelease,
  evaluateExchangeRules,
} from "../src/cfc/mod.ts";
import {
  buildCfcPolicyArtifactManifest,
  cfcPolicyManifestDocId,
} from "../src/cfc/policy.ts";
import { createFrozenRequestSnapshot } from "../src/cfc/request-snapshot.ts";
import { enqueueSinkRequestPostCommitEffect } from "../src/cfc/sink-request.ts";
import type { Engine } from "../src/harness/engine.ts";
import { Runtime } from "../src/runtime.ts";
import { StorageManager } from "../src/storage/cache.deno.ts";
import { isCfcEnforcementRejection } from "../src/storage/rejection.ts";

const signer = await Identity.fromPassphrase("cfc PolicyOf label test");
const space = signer.did();
const destinationSpace = (await Identity.fromPassphrase(
  "cfc PolicyOf label destination",
)).did();

describe("PolicyOf label-time binding", () => {
  let storageManager: ReturnType<typeof StorageManager.emulate>;
  let runtime: Runtime;

  beforeEach(() => {
    storageManager = StorageManager.emulate({ as: signer });
    runtime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager,
    });
  });

  afterEach(async () => {
    await runtime?.dispose();
    await storageManager?.close();
  });

  const artifact = buildCfcPolicyArtifactManifest({
    formatVersion: 1,
    moduleIdentity: "sha256:policy-module",
    symbol: "rules",
    template: {
      templateVersion: 1,
      exchangeRules: [{
        name: "release",
        preCondition: {
          confidentiality: [{ thisPolicy: true }],
          integrity: [{ type: "IntegrityEvidence" }],
        },
        postCondition: { confidentiality: [], integrity: [] },
      }],
      dependencies: { authorityOnly: [], dataBearing: [] },
      integrityRequirements: {},
    },
  });

  const schema = {
    type: "string",
    ifc: {
      confidentiality: [{
        type: CFC_ATOM_TYPE.Policy,
        policyRefKind: "module",
        moduleIdentity: artifact.manifest.moduleIdentity,
        symbol: artifact.manifest.symbol,
        policyDigest: artifact.policyDigest,
        subject: { __ctOwningSpace: true },
      }],
    },
  } as const;

  it("binds the owning space and records the exact installed manifest", async () => {
    runtime.registerCfcPolicyManifests(space, [artifact]);
    const tx = runtime.edit();
    const cell = runtime.getCell(space, "policy-of-value", schema, tx);
    cell.set("secret");
    tx.prepareCfc();
    expect(tx.getCfcState().consultedPolicyManifests).toHaveLength(1);
    await tx.commit();

    const readTx = runtime.edit();
    const link = cell.getAsNormalizedFullLink();
    const metadata = readStoredCfcMetadata(readTx, link);
    readTx.abort?.();
    expect(metadata?.labelMap.entries[0]?.label.confidentiality).toEqual([{
      type: CFC_ATOM_TYPE.Policy,
      policyRefKind: "module",
      moduleIdentity: artifact.manifest.moduleIdentity,
      symbol: artifact.manifest.symbol,
      policyDigest: artifact.policyDigest,
      subject: space,
    }]);
  });

  it("fails closed when the destination lacks the manifest", async () => {
    const tx = runtime.edit();
    runtime.getCell(space, "missing-policy", schema, tx).set("secret");
    // OW50 (verification-coverage.md): a commit-prep crash no longer escapes
    // `prepareCfc` as a throw (which killed the scheduler's action without
    // settling its transaction); it is recorded as an invalidation reason and
    // the commit rejects with the diagnostic — same fail-closed, observable
    // failure.
    expect(tx.prepareCfc()).toBe("");
    const result = await tx.commit();
    expect(String(result.error?.message)).toContain("is not installed");
  });

  it("rejects a malformed owning-space PolicyOf marker", async () => {
    const malformedSchema = {
      type: "string",
      ifc: {
        confidentiality: [{
          type: CFC_ATOM_TYPE.Policy,
          policyRefKind: "module",
          symbol: artifact.manifest.symbol,
          policyDigest: artifact.policyDigest,
          subject: { __ctOwningSpace: true },
        }],
      },
    } as const;
    const tx = runtime.edit();
    runtime.getCell(space, "malformed-policy", malformedSchema, tx).set(
      "secret",
    );
    // OW50: crash -> recorded reason -> rejected commit (see above).
    expect(tx.prepareCfc()).toBe("");
    const result = await tx.commit();
    expect(String(result.error?.message)).toContain(
      "malformed PolicyOf schema marker",
    );
  });

  it("rejects unprivileged overwrite and deletion of a durable manifest", async () => {
    runtime.registerCfcPolicyManifests(space, [artifact]);
    const installTx = runtime.edit();
    runtime.getCell(space, "immutable-policy", schema, installTx).set("secret");
    installTx.prepareCfc();
    expect((await installTx.commit()).ok).toBeDefined();

    const manifestId = cfcPolicyManifestDocId(artifact.policyDigest);
    const overwrite = runtime.edit();
    expect(() =>
      overwrite.writeOrThrow({
        space,
        id: manifestId,
        type: "application/json",
        path: ["value"],
      }, { forged: true })
    ).toThrow("immutable reserved policy state");
    overwrite.abort();

    const deletion = runtime.edit();
    expect(() =>
      deletion.writeOrThrow(
        {
          space,
          id: manifestId,
          type: "application/json",
          path: ["value"],
        },
        undefined,
        { delete: true },
      )
    ).toThrow("immutable reserved policy state");
    deletion.abort();
  });

  it("rejects a zero-write prepared decision after manifest tampering", async () => {
    runtime.registerCfcPolicyManifests(space, [artifact]);
    const installTx = runtime.edit();
    runtime.getCell(space, "tamper-policy", schema, installTx).set("secret");
    installTx.prepareCfc();
    expect((await installTx.commit()).ok).toBeDefined();

    const reference = {
      type: CFC_ATOM_TYPE.Policy,
      policyRefKind: "module",
      moduleIdentity: artifact.manifest.moduleIdentity,
      symbol: artifact.manifest.symbol,
      policyDigest: artifact.policyDigest,
      subject: space,
    } as const;
    const decision = runtime.edit();
    const resolver = createTxCfcModulePolicyResolver(
      decision,
      (candidate) => decision.resolveCfcPolicyManifest(candidate, space),
    );
    expect(resolver(reference)).toBeDefined();
    decision.markCfcRelevant("manifest-decision");
    decision.prepareCfc();

    const tamper = storageManager.edit();
    const tamperResult = tamper.write({
      space,
      id: cfcPolicyManifestDocId(artifact.policyDigest),
      type: "application/json",
      path: ["value"],
    }, { forged: true });
    expect(tamperResult.ok).toBeDefined();
    expect((await tamper.commit()).ok).toBeDefined();

    expect((await decision.commit()).error).toBeDefined();
  });

  it("rejects a zero-write prepared miss when the manifest appears", async () => {
    const missingReference = {
      type: CFC_ATOM_TYPE.Policy,
      policyRefKind: "module",
      moduleIdentity: "sha256:missing-module",
      symbol: "rules",
      policyDigest: "sha256:missing-policy",
      subject: space,
    } as const;
    const decision = runtime.edit();
    const resolver = createTxCfcModulePolicyResolver(
      decision,
      (candidate) => decision.resolveCfcPolicyManifest(candidate, space),
    );
    expect(resolver(missingReference)).toBeUndefined();
    decision.markCfcRelevant("manifest-miss");
    decision.prepareCfc();

    const writer = storageManager.edit();
    const writeResult = writer.write({
      space,
      id: cfcPolicyManifestDocId(missingReference.policyDigest),
      type: "application/json",
      path: ["value"],
    }, { appeared: true });
    expect(writeResult.ok).toBeDefined();
    expect((await writer.commit()).ok).toBeDefined();

    expect((await decision.commit()).error).toBeDefined();
  });

  it("rejects a raw module-policy object in authored schema metadata", async () => {
    runtime.registerCfcPolicyManifests(space, [artifact]);
    const forgedSchema = {
      ...schema,
      ifc: {
        confidentiality: [{
          type: CFC_ATOM_TYPE.Policy,
          policyRefKind: "module",
          moduleIdentity: artifact.manifest.moduleIdentity,
          symbol: artifact.manifest.symbol,
          policyDigest: artifact.policyDigest,
          subject: space,
        }],
      },
    } as const;
    const tx = runtime.edit();
    runtime.getCell(space, "forged-policy", forgedSchema, tx).set("secret");
    // OW50: crash -> recorded reason -> rejected commit (see above).
    expect(tx.prepareCfc()).toBe("");
    const result = await tx.commit();
    expect(String(result.error?.message)).toContain(
      "compiler-lowered PolicyOf",
    );
  });

  it("compiles, installs, persists, and reloads a direct authored policy", async () => {
    const program = {
      main: "/main.tsx",
      files: [{
        name: "/main.tsx",
        contents: `/// <cts-enable />
          import { Confidential, toSchema } from "commonfabric";
          import type { PolicyOf } from "commonfabric/cfc";
          import {
            cfcPattern, exchangeRule, exchangeRules, THIS_POLICY, v,
          } from "commonfabric/cfc";
          export const release = exchangeRule({
            appliesTo: THIS_POLICY,
            pre: { integrity: [cfcPattern.hasRole(v("user"), THIS_POLICY.subject, "reader")] },
            post: { addAlternatives: [cfcPattern.user(v("user"))] },
          });
          export const rules = exchangeRules([release]);
          export const schema = toSchema<
            Confidential<string, [PolicyOf<typeof rules>]>
          >();
        `,
      }],
    };
    const engine = runtime.harness as Engine;
    const compiled = await engine.compileToRecordGraph(program);
    for (const module of compiled.modules) {
      runtime.registerCfcPolicyManifests(
        space,
        module.policyManifests ?? [],
      );
    }
    const evaluated = engine.evaluateRecordGraph(
      compiled.id,
      compiled.graph,
      compiled.mainSpecifier,
      program,
    );
    const emittedSchema = evaluated.main?.schema as JSONSchema;

    const tx = runtime.edit();
    const cell = runtime.getCell(
      space,
      "compiled-policy-of",
      emittedSchema,
      tx,
    );
    cell.set("secret");
    tx.prepareCfc();
    await tx.commit();

    const readTx = runtime.edit();
    const metadata = readStoredCfcMetadata(
      readTx,
      cell.getAsNormalizedFullLink(),
    );
    readTx.abort?.();
    const reference = metadata?.labelMap.entries[0]?.label
      .confidentiality?.[0] as Record<string, unknown>;
    expect(reference.moduleIdentity).toBe(compiled.entryIdentity);
    expect(reference.symbol).toBe("rules");
    expect(reference.subject).toBe(space);
    expect(typeof reference.policyDigest).toBe("string");
  });

  it("cold-loads the destination manifest without the producer module", async () => {
    const program = {
      main: "/main.tsx",
      files: [{
        name: "/main.tsx",
        contents: `/// <cts-enable />
          import { Confidential, toSchema } from "commonfabric";
          import type { PolicyOf } from "commonfabric/cfc";
          import {
            cfcPattern, exchangeRule, exchangeRules, THIS_POLICY, v,
          } from "commonfabric/cfc";
          export const release = exchangeRule({
            appliesTo: THIS_POLICY,
            pre: { integrity: [cfcPattern.hasRole(v("user"), THIS_POLICY.subject, "reader")] },
            post: { addAlternatives: [cfcPattern.user(v("user"))] },
          });
          export const rules = exchangeRules([release]);
          export const schema = toSchema<
            Confidential<string, [PolicyOf<typeof rules>]>
          >();
        `,
      }],
    };
    const engine = runtime.harness as Engine;
    const compiled = await engine.compileToRecordGraph(program);
    const evaluated = engine.evaluateRecordGraph(
      compiled.id,
      compiled.graph,
      compiled.mainSpecifier,
      program,
    );
    const emittedSchema = evaluated.main?.schema as JSONSchema;

    const installTx = runtime.edit();
    runtime.getCell(space, "durable-policy", emittedSchema, installTx).set(
      "secret",
    );
    installTx.prepareCfc();
    expect((await installTx.commit()).ok).toBeDefined();

    const coldRuntime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager,
    });
    try {
      const coldTx = coldRuntime.edit();
      const coldCell = coldRuntime.getCell(
        space,
        "cold-policy",
        emittedSchema,
        coldTx,
      );
      coldCell.set("secret after restart");
      coldTx.prepareCfc();
      expect((await coldTx.commit()).error).toBeUndefined();

      const evaluationTx = coldRuntime.edit();
      const metadata = readStoredCfcMetadata(
        evaluationTx,
        coldCell.getAsNormalizedFullLink(),
      );
      const reference = metadata?.labelMap.entries[0]?.label
        .confidentiality?.[0];
      expect(reference).toBeDefined();
      const reader = "did:key:cold-compiled-reader";
      const evaluated = evaluateExchangeRules(
        { confidentiality: [reference as CfcConfClause] },
        undefined,
        {
          integrity: [cfcAtom.hasRole(reader, space, "reader")],
          modulePolicyResolver: (candidate) =>
            evaluationTx.resolveCfcPolicyManifest(candidate, space) as never,
        },
      );
      expect(evaluated.resolutionFailures).toEqual([]);
      expect(evaluated.firings).toHaveLength(1);
      evaluationTx.abort();
    } finally {
      await coldRuntime.dispose();
    }
  });

  it("retains old immutable policy versions after a producer upgrade", async () => {
    const upgraded = buildCfcPolicyArtifactManifest({
      ...artifact.manifest,
      template: {
        ...artifact.manifest.template,
        exchangeRules: [{
          ...artifact.manifest.template.exchangeRules[0]!,
          name: "release-v2",
        }],
      },
    });
    runtime.registerCfcPolicyManifests(space, [artifact, upgraded]);
    const schemaFor = (policyDigest: string) => ({
      ...schema,
      ifc: {
        confidentiality: [{
          ...schema.ifc.confidentiality[0],
          policyDigest,
        }],
      },
    } as const);

    for (
      const [name, policy] of [
        ["old-policy-label", artifact],
        ["new-policy-label", upgraded],
      ] as const
    ) {
      const tx = runtime.edit();
      runtime.getCell(space, name, schemaFor(policy.policyDigest), tx).set(
        "secret",
      );
      tx.prepareCfc();
      expect((await tx.commit()).ok).toBeDefined();
    }

    const coldRuntime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager,
    });
    try {
      const tx = coldRuntime.edit();
      for (
        const [name, policy] of [
          ["old-policy-label", artifact],
          ["new-policy-label", upgraded],
        ] as const
      ) {
        const cell = coldRuntime.getCell(
          space,
          name,
          schemaFor(policy.policyDigest),
          tx,
        );
        const metadata = readStoredCfcMetadata(
          tx,
          cell.getAsNormalizedFullLink(),
        );
        const reference = metadata?.labelMap.entries[0]?.label
          .confidentiality?.[0];
        expect(reference).toBeDefined();
        expect(tx.resolveCfcPolicyManifest(reference, space)).toBeDefined();
      }
      tx.abort();
    } finally {
      await coldRuntime.dispose();
    }
  });

  it("copies a carried policy manifest into a cross-space destination", async () => {
    runtime.registerCfcPolicyManifests(space, [artifact]);
    const sourceTx = runtime.edit();
    const source = runtime.getCell(space, "policy-source", schema, sourceTx);
    source.set("secret");
    sourceTx.prepareCfc();
    expect((await sourceTx.commit()).ok).toBeDefined();

    const boundReference = {
      type: CFC_ATOM_TYPE.Policy,
      policyRefKind: "module",
      moduleIdentity: artifact.manifest.moduleIdentity,
      symbol: artifact.manifest.symbol,
      policyDigest: artifact.policyDigest,
      subject: space,
    };
    const scopedProbe = runtime.edit();
    source.withTx(scopedProbe).get();
    runtime.getCell(
      destinationSpace,
      "missing-destination-policy",
      undefined,
      scopedProbe,
    ).get();
    expect(
      scopedProbe.resolveCfcPolicyManifest(
        boundReference,
        destinationSpace,
      ),
    ).toBeUndefined();
    scopedProbe.abort();

    const copyTx = runtime.edit();
    const target = runtime.getCell(
      destinationSpace,
      "policy-destination",
      undefined,
      copyTx,
    );
    const sourceLink = source.getAsNormalizedFullLink();
    const targetLink = target.getAsNormalizedFullLink();
    copyTx.writeValueOrThrow({
      ...targetLink,
      path: ["value"],
    }, "copied secret");
    copyTx.recordCfcWritePolicyInput({
      kind: "link-write",
      target: { ...targetLink, path: ["value"] },
      source: { ...sourceLink, path: [] },
    });
    copyTx.prepareCfc();
    expect((await copyTx.commit()).ok).toBeDefined();

    const coldRuntime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager,
    });
    try {
      const coldTx = coldRuntime.edit();
      target.withTx(coldTx).get();
      const metadata = readStoredCfcMetadata(coldTx, targetLink);
      const reference = metadata?.labelMap.entries
        .flatMap((entry) => entry.label.confidentiality ?? [])
        .find((value) =>
          isObjectOrArray(value) &&
          (value as Record<string, unknown>).policyRefKind === "module"
        );
      expect(reference).toBeDefined();
      const evaluated = evaluateExchangeRules(
        { confidentiality: [reference as CfcConfClause] },
        undefined,
        {
          integrity: [{ type: "IntegrityEvidence" }],
          modulePolicyResolver: (candidate) =>
            coldTx.resolveCfcPolicyManifest(
              candidate,
              destinationSpace,
            ) as never,
        },
      );
      expect(evaluated.resolutionFailures).toEqual([]);
      expect(evaluated.label.confidentiality).toEqual([]);
      expect(
        coldTx.resolveCfcPolicyManifest(reference, destinationSpace),
      ).toBeDefined();
      expect(
        coldRuntime.hasCfcPolicyManifest(
          destinationSpace,
          reference,
          coldTx,
        ),
      ).toBe(true);
      coldTx.abort();
    } finally {
      await coldRuntime.dispose();
    }
  });

  it("does not let a sink mask a missing destination manifest with another space", async () => {
    runtime.registerCfcPolicyManifests(space, [artifact]);
    const installTx = runtime.edit();
    runtime.getCell(space, "sink-policy-source", schema, installTx).set(
      "secret",
    );
    installTx.prepareCfc();
    expect((await installTx.commit()).ok).toBeDefined();

    const destinationSchema = internSchema(
      {
        type: "object",
        properties: { secret: { type: "string" } },
        required: ["secret"],
      } satisfies JSONSchema,
      true,
    );
    const target = runtime.getCell(
      destinationSpace,
      "sink-missing-local-manifest",
      destinationSchema.schema,
    );
    const targetLink = target.getAsNormalizedFullLink();
    const reference = {
      type: CFC_ATOM_TYPE.Policy,
      policyRefKind: "module",
      moduleIdentity: artifact.manifest.moduleIdentity,
      symbol: artifact.manifest.symbol,
      policyDigest: artifact.policyDigest,
      subject: space,
    } as const;
    const seed = storageManager.edit();
    expect(
      seed.write({
        space: destinationSpace,
        id: targetLink.id,
        scope: targetLink.scope,
        type: "application/json",
        path: [],
      }, {
        value: { secret: "rosebud" },
        cfc: {
          version: 1,
          schemaHash: destinationSchema.taggedHashString,
          labelMap: {
            version: 1,
            entries: [{
              path: ["secret"],
              label: {
                confidentiality: [reference],
                integrity: [{ type: "IntegrityEvidence" }],
              },
            }],
          },
        },
      }).ok,
    ).toBeDefined();
    expect(
      seed.write({
        space: destinationSpace,
        id: `cid:${destinationSchema.taggedHashString}`,
        type: "application/json",
        path: [],
      }, { value: destinationSchema.schema }).ok,
    ).toBeDefined();
    expect((await seed.commit()).ok).toBeDefined();

    const sinkRuntime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager,
      // The sink gate resolves module policy manifests against the
      // destination space in this mode, which is the lookup the rejection
      // below turns on.
      cfcPolicyEvaluation: "enforce",
      cfcSinkMaxConfidentiality: { fetchJson: [] },
    });
    try {
      const hostDecision = sinkRuntime.edit();
      expect(
        sinkRuntime.getCell(
          space,
          "sink-policy-source",
          schema,
          hostDecision,
        ).get(),
      ).toBe("secret");
      expect(target.withTx(hostDecision).key("secret").get()).toBe("rosebud");
      expect(
        decideSinkRelease(hostDecision, hostDecision, "fetchJson", []).status,
      ).toBe("resolution-unavailable");
      hostDecision.abort();

      const tx = sinkRuntime.edit();
      // The same policy artifact labels consumed values in both spaces. The
      // valid source-space copy must not mask the destination's missing local
      // artifact.
      expect(
        sinkRuntime.getCell(
          space,
          "sink-policy-source",
          schema,
          tx,
        ).get(),
      ).toBe("secret");
      expect(target.withTx(tx).key("secret").get()).toBe("rosebud");
      let flushed = false;
      enqueueSinkRequestPostCommitEffect(
        tx,
        "fetchJson",
        "fetchJson:destination-manifest-mask",
        createFrozenRequestSnapshot({ url: "https://example.com/exfil" }),
        "fetchJson-start",
        () => {
          flushed = true;
        },
      );
      tx.prepareCfc();
      const result = await tx.commit();
      expect(isCfcEnforcementRejection(result.error)).toBe(true);
      expect(flushed).toBe(false);
    } finally {
      await sinkRuntime.dispose();
    }
  });

  it("rejects a prepared sink when any consumed manifest origin changes", async () => {
    runtime.registerCfcPolicyManifests(undefined, [artifact]);
    for (
      const [origin, id] of [
        [space, "sink-origin-a"],
        [destinationSpace, "sink-origin-b"],
      ] as const
    ) {
      const installTx = runtime.edit();
      runtime.getCell(origin, id, schema, installTx).set("secret");
      installTx.prepareCfc();
      expect((await installTx.commit()).ok).toBeDefined();
    }

    const sinkRuntime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager,
      // The sink gate binds every consumed manifest origin into the commit in
      // this mode, which is what the tampering below has to disturb for the
      // commit to reject.
      cfcPolicyEvaluation: "enforce",
      cfcSinkMaxConfidentiality: { fetchJson: [] },
    });
    try {
      const hostDecision = sinkRuntime.edit();
      expect(
        sinkRuntime.getCell(space, "sink-origin-a", schema, hostDecision).get(),
      ).toBe("secret");
      expect(
        sinkRuntime.getCell(
          destinationSpace,
          "sink-origin-b",
          schema,
          hostDecision,
        ).get(),
      ).toBe("secret");
      const host = decideSinkRelease(
        hostDecision,
        hostDecision,
        "fetchJson",
        [],
      );
      expect(host.status).toBe("refused");
      expect(host.failure).toBeUndefined();
      hostDecision.abort();

      const decision = sinkRuntime.edit();
      expect(
        sinkRuntime.getCell(space, "sink-origin-a", schema, decision).get(),
      ).toBe("secret");
      expect(
        sinkRuntime.getCell(
          destinationSpace,
          "sink-origin-b",
          schema,
          decision,
        ).get(),
      ).toBe("secret");
      let flushed = false;
      enqueueSinkRequestPostCommitEffect(
        decision,
        "fetchJson",
        "fetchJson:multi-origin-manifest",
        createFrozenRequestSnapshot({ url: "https://example.com/exfil" }),
        "fetchJson-start",
        () => {
          flushed = true;
        },
      );
      decision.prepareCfc();

      const tamper = storageManager.edit();
      expect(
        tamper.write({
          space: destinationSpace,
          id: cfcPolicyManifestDocId(artifact.policyDigest),
          type: "application/json",
          path: ["value"],
        }, { forged: true }).ok,
      ).toBeDefined();
      expect((await tamper.commit()).ok).toBeDefined();

      expect((await decision.commit()).error).toBeDefined();
      expect(flushed).toBe(false);
    } finally {
      await sinkRuntime.dispose();
    }
  });
});
