import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";

import { CFC_ATOM_TYPE, type CfcAtom, cfcAtom } from "@commonfabric/api/cfc";
import { Identity } from "@commonfabric/identity";

import type { CfcConfClause } from "../src/cfc/clause.ts";
import { readStoredCfcMetadata } from "../src/cfc/metadata.ts";
import type { CfcPolicyRecordInput } from "../src/cfc/policy.ts";
import { decideSinkRelease } from "../src/cfc/prepare.ts";
import { createFrozenRequestSnapshot } from "../src/cfc/request-snapshot.ts";
import { decideSinkFit } from "../src/cfc/sink-decision.ts";
import { enqueueSinkRequestPostCommitEffect } from "../src/cfc/sink-request.ts";
import type { CfcTrustConfigInput } from "../src/cfc/trust.ts";
import { Runtime } from "../src/runtime.ts";
import { StorageManager } from "../src/storage/cache.deno.ts";
import {
  SEED_ENVELOPE_SCHEMA_HASH,
  seedStoredEnvelope,
  writeSeedEnvelopeDoc,
} from "./cfc-seed-envelope.ts";

const signer = await Identity.fromPassphrase("runner-cfc-sink-release");
const space = signer.did();

//
// The release measurement
//
// The commit boundary answers what a ceiling refuses for the sink requests a
// transaction records. A host releasing a value of its own — a tool answering
// a model with what a piece computed — records no request and commits
// nothing, so it reads what it is about to release through a transaction and
// asks the same question of that transaction's consumed join.
//

describe("decideSinkRelease", () => {
  const newRuntime = (
    storageManager: ReturnType<typeof StorageManager.emulate>,
  ) =>
    new Runtime({
      apiUrl: new URL("https://example.com"),
      storageManager,
      cfcEnforcementMode: "enforce-strict",
      cfcFlowLabels: "persist",
    });

  /** A document carrying `atom` on its `secret` field. */
  const seedLabeled = async (
    runtime: Runtime,
    cause: string,
    atom: CfcConfClause,
    integrity: readonly CfcAtom[] = [],
  ) => {
    const seed = runtime.edit();
    const cell = runtime.getCell(
      space,
      cause,
      { type: "object", properties: { secret: { type: "string" } } },
      seed,
    );
    const id = cell.getAsNormalizedFullLink().id;
    writeSeedEnvelopeDoc(seed, space);
    seedStoredEnvelope(seed, { space, scope: "space", id, path: [] }, {
      value: { secret: "s3cr3t" },
      cfc: {
        version: 1,
        schemaHash: SEED_ENVELOPE_SCHEMA_HASH,
        labelMap: {
          version: 1,
          entries: [{
            path: ["secret"],
            label: { confidentiality: [atom], integrity: [...integrity] },
          }],
        },
      },
    });
    expect((await seed.commit()).ok).toBeDefined();
    return { id, path: [] as string[], space, scope: "space" as const };
  };

  it("refuses nothing for a transaction that read no labeled document", async () => {
    const storageManager = StorageManager.emulate({ as: signer });
    const runtime = newRuntime(storageManager);
    try {
      const seed = runtime.edit();
      const plain = runtime.getCell(space, "release-plain", undefined, seed);
      plain.set({ note: "public" });
      expect((await seed.commit()).error).toBeUndefined();

      const tx = runtime.edit();
      const cell = runtime.getCellFromLink(
        plain.getAsNormalizedFullLink(),
      ).withTx(tx);
      await cell.pull();
      JSON.stringify(cell.get());
      expect(decideSinkRelease(tx, tx, "answer", []).status).toBe("fit");
      tx.abort();
    } finally {
      await runtime.dispose();
      await storageManager.close();
    }
  });

  it("names the clause a walked read carried, and the read that carried it", async () => {
    const storageManager = StorageManager.emulate({ as: signer });
    const runtime = newRuntime(storageManager);
    try {
      const link = await seedLabeled(runtime, "release-walked", "alice-secret");
      const tx = runtime.edit();
      const cell = runtime.getCellFromLink(link).withTx(tx);
      await cell.pull();
      JSON.stringify(cell.get());

      const refusal = decideSinkRelease(tx, tx, "answer", []).refusal;
      expect(refusal?.gate).toBe("sink-ceiling");
      expect(refusal?.sink).toBe("answer");
      expect(refusal?.offendingAtoms).toEqual(['"alice-secret"']);
      expect(refusal?.attribution).toBe("complete");
      expect(refusal?.inputs.map((input) => input.read.id)).toContain(link.id);
      tx.abort();
    } finally {
      await runtime.dispose();
      await storageManager.close();
    }
  });

  it("refuses nothing for a read that stopped above the labeled field", async () => {
    // A label on a field is consumed where that field is read: a read of the
    // document root is recorded as non-recursive, and counts entries at or
    // above it only. A caller measuring a release therefore has to walk the
    // value it is about to hand over, not merely resolve it.
    const storageManager = StorageManager.emulate({ as: signer });
    const runtime = newRuntime(storageManager);
    try {
      const link = await seedLabeled(runtime, "release-unwalked", "bob-secret");
      const tx = runtime.edit();
      const cell = runtime.getCellFromLink(link).withTx(tx);
      await cell.pull();
      cell.get();
      expect(decideSinkRelease(tx, tx, "answer", []).status).toBe("fit");
      tx.abort();
    } finally {
      await runtime.dispose();
      await storageManager.close();
    }
  });

  it("reports a clause no attribution read carried as unattributed", async () => {
    const storageManager = StorageManager.emulate({ as: signer });
    const runtime = newRuntime(storageManager);
    try {
      const released = await seedLabeled(
        runtime,
        "release-released",
        "carol-secret",
      );
      const attributed = await seedLabeled(
        runtime,
        "release-attributed",
        "dave-secret",
      );
      const releasedTx = runtime.edit();
      const releasedCell = runtime.getCellFromLink(released).withTx(releasedTx);
      await releasedCell.pull();
      JSON.stringify(releasedCell.get());

      const attributedTx = runtime.edit();
      const attributedCell = runtime.getCellFromLink(attributed)
        .withTx(attributedTx);
      await attributedCell.pull();
      JSON.stringify(attributedCell.get());

      const refusal = decideSinkRelease(
        releasedTx,
        attributedTx,
        "answer",
        [],
      ).refusal;
      expect(refusal?.offendingAtoms).toEqual(['"carol-secret"']);
      expect(refusal?.inputs).toEqual([]);
      expect(refusal?.attribution).toBe("none");
      releasedTx.abort();
      attributedTx.abort();
    } finally {
      await runtime.dispose();
      await storageManager.close();
    }
  });

  it("admits a clause the ceiling names", async () => {
    const storageManager = StorageManager.emulate({ as: signer });
    const runtime = newRuntime(storageManager);
    try {
      const link = await seedLabeled(runtime, "release-admitted", "erin-ok");
      const tx = runtime.edit();
      const cell = runtime.getCellFromLink(link).withTx(tx);
      await cell.pull();
      JSON.stringify(cell.get());
      expect(decideSinkRelease(tx, tx, "answer", ["erin-ok"]).status)
        .toBe("fit");
      tx.abort();
    } finally {
      await runtime.dispose();
      await storageManager.close();
    }
  });

  describe("exchange-aware sink decision", () => {
    const source = { type: "https://example.com/cfc/Source" };
    const admitted = { type: "https://example.com/cfc/Admitted" };
    const evidence = { type: "https://example.com/cfc/Evidence" };
    const releasePolicy: CfcPolicyRecordInput[] = [{
      id: "sink-release-policy",
      rules: [{
        id: "admit-source",
        appliesTo: source,
        preCondition: { integrity: [evidence] },
        post: { addAlternatives: [admitted] },
      }],
    }];

    const pairedRuntime = (
      storageManager: ReturnType<typeof StorageManager.emulate>,
      mode: "off" | "observe" | "enforce",
      policyRecords = releasePolicy,
      trustConfig?: CfcTrustConfigInput,
    ) =>
      new Runtime({
        apiUrl: new URL("https://example.com"),
        storageManager,
        cfcEnforcementMode: "enforce-strict",
        cfcFlowLabels: "persist",
        cfcPolicyEvaluation: mode,
        cfcPolicyRecords: policyRecords,
        cfcTrustConfig: trustConfig,
        cfcSinkMaxConfidentiality: {
          answer: [admitted],
          agent: [admitted],
        },
      });

    const readDecision = async (
      runtime: Runtime,
      link: Awaited<ReturnType<typeof seedLabeled>>,
      sink = "answer",
    ) => {
      const tx = runtime.edit();
      const cell = runtime.getCellFromLink(link).withTx(tx);
      await cell.pull();
      JSON.stringify(cell.get());
      const decision = decideSinkRelease(tx, tx, sink, [admitted]);
      tx.abort();
      return decision;
    };

    const commitDecision = async (
      runtime: Runtime,
      link: Awaited<ReturnType<typeof seedLabeled>>,
      sink = "answer",
    ) => {
      const tx = runtime.edit();
      const cell = runtime.getCellFromLink(link).withTx(tx);
      await cell.pull();
      JSON.stringify(cell.get());
      enqueueSinkRequestPostCommitEffect(
        tx,
        sink,
        `${sink}:paired-release`,
        createFrozenRequestSnapshot({ value: "released" }),
        "answer-start",
        () => {},
      );
      tx.prepareCfc();
      return tx.commit();
    };

    it("fails closed when a consumed module policy has no recorded origin", async () => {
      const storageManager = StorageManager.emulate({ as: signer });
      const runtime = pairedRuntime(storageManager, "enforce");
      try {
        const tx = runtime.edit();
        const unresolvedPolicy = {
          type: CFC_ATOM_TYPE.Policy,
          policyRefKind: "module",
          moduleIdentity: "sha256:module",
          symbol: "default",
          policyDigest: "sha256:policy",
          subject: space,
        } as const;
        const decision = decideSinkFit(
          tx,
          {
            confidentiality: [unresolvedPolicy],
            integrity: [],
            modulePolicySpaces: new Map(),
            sources: [],
          },
          [],
          "answer",
          [],
          "observing",
        );
        expect(decision.status).toBe("resolution-unavailable");
        expect(decision.failure?.resolutionFailures).toEqual([{
          reference: unresolvedPolicy,
          reason: "missing-manifest",
        }]);
        tx.abort();
      } finally {
        await runtime.dispose();
        await storageManager.close();
      }
    });

    for (const mode of ["off", "observe", "enforce"] as const) {
      it(`${mode}: the host and committed paths decide on the same label`, async () => {
        const storageManager = StorageManager.emulate({ as: signer });
        const runtime = pairedRuntime(storageManager, mode);
        try {
          const link = await seedLabeled(
            runtime,
            `release-policy-${mode}`,
            source,
            [evidence],
          );
          const beforeTx = runtime.edit();
          const before = readStoredCfcMetadata(beforeTx, link);
          beforeTx.abort();

          const host = await readDecision(runtime, link);
          expect(host.rawLabel).toEqual({
            confidentiality: [source],
            integrity: [evidence],
          });
          if (mode === "off") {
            expect(host.evaluatedLabel).toEqual(host.rawLabel);
          } else {
            expect(host.evaluatedLabel).not.toEqual(host.rawLabel);
            expect(host.evaluatedLabel.integrity).toEqual([evidence]);
          }
          expect(host.effectiveLabel).toEqual(
            mode === "enforce" ? host.evaluatedLabel : host.rawLabel,
          );
          expect(host.status).toBe(mode === "enforce" ? "fit" : "refused");
          expect(host.firings.map(({ ruleId }) => ruleId)).toEqual(
            mode === "off" ? [] : ["admit-source"],
          );
          const committed = await commitDecision(runtime, link);
          expect(committed.ok !== undefined).toBe(mode === "enforce");

          const afterTx = runtime.edit();
          const after = readStoredCfcMetadata(afterTx, link);
          afterTx.abort();
          expect(after).toEqual(before);
        } finally {
          await runtime.dispose();
          await storageManager.close();
        }
      });
    }

    it("uses the same trust closure in the host and committed paths", async () => {
      const concept = "https://example.com/cfc/concepts/verified-source";
      const verifier = "did:key:release-verifier";
      const trustedEvidence = {
        type: "https://example.com/cfc/TrustedEvidence",
      };
      const trustPolicy: CfcPolicyRecordInput[] = [{
        id: "trust-scoped-policy",
        rules: [{
          id: "trust-scoped-release",
          appliesTo: source,
          preCondition: { integrity: [cfcAtom.concept(concept)] },
          post: { addAlternatives: [admitted] },
        }],
      }];
      const trustConfig: CfcTrustConfigInput = {
        statements: [{
          concrete: trustedEvidence,
          implements: concept,
          verifier,
        }],
        delegations: [{
          delegator: signer.did(),
          verifier,
          concepts: "*",
        }],
      };
      const storageManager = StorageManager.emulate({ as: signer });
      const runtime = pairedRuntime(
        storageManager,
        "enforce",
        trustPolicy,
        trustConfig,
      );
      try {
        const link = await seedLabeled(
          runtime,
          "release-trust-closure",
          source,
          [trustedEvidence],
        );
        const host = await readDecision(runtime, link);
        expect(host.status).toBe("fit");
        expect(host.firings.map(({ ruleId }) => ruleId)).toEqual([
          "trust-scoped-release",
        ]);
        expect((await commitDecision(runtime, link)).ok).toBeDefined();
      } finally {
        await runtime.dispose();
        await storageManager.close();
      }
    });

    for (
      const testCase of [
        {
          name: "sink-name mismatch",
          boundary: cfcAtom.boundaryContext("sink", "fetchJson"),
          sink: "answer",
        },
        {
          name: "sink-class mismatch",
          boundary: cfcAtom.boundaryContext("sinkClass", "network"),
          sink: "agent",
        },
      ] as const
    ) {
      it(`refuses a ${testCase.name} in both paths`, async () => {
        const scoped: CfcPolicyRecordInput[] = [{
          id: "boundary-scoped-policy",
          rules: [{
            id: "boundary-scoped-release",
            appliesTo: source,
            preCondition: { boundary: [testCase.boundary] },
            post: { addAlternatives: [admitted] },
          }],
        }];
        const storageManager = StorageManager.emulate({ as: signer });
        const runtime = pairedRuntime(storageManager, "enforce", scoped);
        try {
          const link = await seedLabeled(
            runtime,
            `release-${testCase.name}`,
            source,
          );
          const host = await readDecision(runtime, link, testCase.sink);
          expect(host.status).toBe("refused");
          expect(host.firings).toEqual([]);
          expect((await commitDecision(runtime, link, testCase.sink)).error)
            .toBeDefined();
        } finally {
          await runtime.dispose();
          await storageManager.close();
        }
      });
    }

    it("fails closed on exhaustion in both paths", async () => {
      const cycling: CfcPolicyRecordInput[] = [{
        id: "cycling-policy",
        rules: [{
          id: "add-marker",
          appliesTo: source,
          post: { addAlternatives: [admitted] },
        }, {
          id: "drop-marker",
          appliesTo: admitted,
          post: { dropClause: true },
        }],
      }];
      const storageManager = StorageManager.emulate({ as: signer });
      const runtime = pairedRuntime(storageManager, "enforce", cycling);
      try {
        const link = await seedLabeled(
          runtime,
          "release-policy-exhaustion",
          source,
        );
        expect((await readDecision(runtime, link)).status).toBe("exhausted");
        expect((await commitDecision(runtime, link)).error).toBeDefined();
      } finally {
        await runtime.dispose();
        await storageManager.close();
      }
    });
  });
});
