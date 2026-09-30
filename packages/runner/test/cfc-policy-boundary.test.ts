import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";

import { CFC_ATOM_TYPE, cfcAtom } from "@commonfabric/api/cfc";
import { internSchema } from "@commonfabric/data-model-schema";
import { Identity } from "@commonfabric/identity";

import type { JSONSchema } from "../src/builder/types.ts";
import { preparedDigestFor } from "../src/cfc/canonical.ts";
import type { IFCLabel } from "../src/cfc/mod.ts";
import type { CfcPolicyRecordInput, ExchangeRule } from "../src/cfc/policy.ts";
import { createFrozenRequestSnapshot } from "../src/cfc/request-snapshot.ts";
import { enqueueSinkRequestPostCommitEffect } from "../src/cfc/sink-request.ts";
import type { PreparedDigestInput } from "../src/cfc/types.ts";
import { Runtime } from "../src/runtime.ts";
import { StorageManager } from "../src/storage/cache.deno.ts";
import {
  ExtendedStorageTransaction,
  TransactionWrapper,
} from "../src/storage/extended-storage-transaction.ts";
import { seedStoredEnvelope } from "./cfc-seed-envelope.ts";

const signer = await Identity.fromPassphrase("runner-cfc-policy-boundary");

// Epic B5 (docs/history/plans/cfc-future-work-implementation.md §3): exchange-rule
// evaluation wired into the boundary gates behind the cfcPolicyEvaluation
// dial. `off` is byte-identical to the pre-dial gates; `observe` evaluates
// and diagnoses but decides on the raw label; `enforce` decides on the
// REWRITTEN label and fails closed on fuel exhaustion.

const SPACE_ATOM = cfcAtom.space("space:x");
const USER_ALICE = cfcAtom.user("did:key:alice");
const USER_MALLORY = cfcAtom.user("did:key:mallory");
const ROLE_ALICE = cfcAtom.hasRole("did:key:alice", "space:x", "reader");

// Space-reader access (spec §4.3.3 worked example), applicable only at
// network-class boundaries.
const spaceReaderAtNetwork: ExchangeRule = {
  id: "space-reader-at-network",
  appliesTo: { type: CFC_ATOM_TYPE.Space, id: { var: "$s" } },
  preCondition: {
    integrity: [{
      type: CFC_ATOM_TYPE.HasRole,
      principal: { var: "$p" },
      space: { var: "$s" },
      role: "reader",
    }],
    boundary: [{
      type: CFC_ATOM_TYPE.BoundaryContext,
      key: "sinkClass",
      value: "network",
    }],
  },
  post: {
    addAlternatives: [{ type: CFC_ATOM_TYPE.User, subject: { var: "$p" } }],
  },
};

const POLICY: CfcPolicyRecordInput[] = [{
  id: "boundary-test-policy",
  rules: [spaceReaderAtNetwork],
}];

// An add/drop ping-pong over the Space atom: never converges, so enforce
// must fail closed on fuel exhaustion (spec §4.4.5 bounded evaluator).
const CYCLING_POLICY: CfcPolicyRecordInput[] = [{
  id: "cycling-policy",
  rules: [
    {
      id: "add-marker",
      appliesTo: { type: CFC_ATOM_TYPE.Space, id: { var: "$s" } },
      post: {
        addAlternatives: [{ type: "https://example.com/atoms/Marker" }],
      },
    },
    {
      id: "drop-marker",
      appliesTo: { type: "https://example.com/atoms/Marker" },
      post: { dropClause: true },
    },
  ],
}];

const SECRET_SCHEMA = internSchema(
  {
    type: "object",
    properties: {
      secret: { type: "string", ifc: { confidentiality: ["never-fits"] } },
    },
    required: ["secret"],
  } satisfies JSONSchema,
  true,
);

const seedSpaceLabeledCell = async (
  runtime: Runtime,
  id: string,
  label: IFCLabel,
): Promise<void> => {
  const seed = runtime.edit();
  const target = runtime.getCell(signer.did(), id, undefined, seed);
  const targetId = target.getAsNormalizedFullLink().id;
  seedStoredEnvelope(seed, {
    space: signer.did(),
    scope: "space",
    id: targetId,
    path: [],
  }, {
    value: { secret: "rosebud" },
    cfc: {
      version: 1,
      schemaHash: SECRET_SCHEMA.taggedHashString,
      labelMap: { version: 1, entries: [{ path: ["secret"], label }] },
    },
  });
  seed.writeOrThrow({
    space: signer.did(),
    scope: "space",
    id: `cid:${SECRET_SCHEMA.taggedHashString}`,
    path: [],
  }, { value: SECRET_SCHEMA.schema });
  expect((await seed.commit()).ok).toBeDefined();
};

// Read the labeled cell and enqueue a fetchJson sink request; prepare and
// return the recorded prepare reasons + diagnostics.
const readThenSink = (
  runtime: Runtime,
  id: string,
): { reasons: readonly string[]; diagnostics: readonly string[] } => {
  const tx = runtime.edit();
  const cell = runtime.getCell(signer.did(), id, SECRET_SCHEMA.schema, tx);
  expect(cell.key("secret").get()).toBe("rosebud");
  enqueueSinkRequestPostCommitEffect(
    tx,
    "fetchJson",
    "fetchJson:policy-boundary-test",
    createFrozenRequestSnapshot({ url: "https://example.com/exfil" }),
    "fetchJson-start",
    () => {},
  );
  tx.prepareCfc();
  const state = tx.getCfcState();
  const reasons = state.prepare.status === "invalidated"
    ? state.prepare.reasons
    : [];
  const result = {
    reasons: [...reasons],
    diagnostics: [...state.diagnostics],
  };
  tx.abort();
  return result;
};

const withRuntime = async (
  opts: {
    policyEvaluation?: "off" | "observe" | "enforce";
    policyRecords?: CfcPolicyRecordInput[];
  },
  body: (runtime: Runtime) => void | Promise<void>,
): Promise<void> => {
  const storageManager = StorageManager.emulate({ as: signer });
  const runtime = new Runtime({
    apiUrl: new URL("https://example.com"),
    storageManager,
    cfcSinkMaxConfidentiality: { fetchJson: [USER_ALICE] },
    cfcPolicyRecords: opts.policyRecords ?? POLICY,
    // Each case names the policy-evaluation rung it is about, and asserts the
    // decision or the diagnostic that rung produces over one fixture.
    cfcPolicyEvaluation: opts.policyEvaluation ?? "off",
  });
  try {
    await body(runtime);
  } finally {
    await runtime.dispose();
    await storageManager.close();
  }
};

describe("CFC policy evaluation at boundaries (B5)", () => {
  describe("sink-request egress gate", () => {
    it("off: decides on the raw label even when a rule would admit", async () => {
      await withRuntime({ policyEvaluation: "off" }, async (runtime) => {
        await seedSpaceLabeledCell(runtime, "policy-off", {
          confidentiality: [SPACE_ATOM],
          integrity: [ROLE_ALICE],
        });
        const { reasons } = readThenSink(runtime, "policy-off");
        expect(
          reasons.some((reason) =>
            reason.includes("sink-request confidentiality exceeds ceiling")
          ),
        ).toBe(true);
      });
    });

    it("enforce: admits via the rewritten label (guarded add-alternative)", async () => {
      await withRuntime({ policyEvaluation: "enforce" }, async (runtime) => {
        await seedSpaceLabeledCell(runtime, "policy-enforce", {
          confidentiality: [SPACE_ATOM],
          integrity: [ROLE_ALICE],
        });
        const { reasons } = readThenSink(runtime, "policy-enforce");
        expect(reasons).toEqual([]);
      });
    });

    it("enforce: an unsatisfied integrity guard never fires (inv-3)", async () => {
      await withRuntime({ policyEvaluation: "enforce" }, async (runtime) => {
        // Same clause, NO HasRole evidence.
        await seedSpaceLabeledCell(runtime, "policy-no-evidence", {
          confidentiality: [SPACE_ATOM],
        });
        const { reasons } = readThenSink(runtime, "policy-no-evidence");
        expect(
          reasons.some((reason) =>
            reason.includes("sink-request confidentiality exceeds ceiling")
          ),
        ).toBe(true);
      });
    });

    it("enforce: a boundary guard for another sink class never fires", async () => {
      const displayOnly: CfcPolicyRecordInput[] = [{
        id: "display-only-policy",
        rules: [{
          ...spaceReaderAtNetwork,
          id: "space-reader-at-display",
          preCondition: {
            ...spaceReaderAtNetwork.preCondition,
            boundary: [{
              type: CFC_ATOM_TYPE.BoundaryContext,
              key: "sinkClass",
              value: "display",
            }],
          },
        }],
      }];
      await withRuntime(
        { policyEvaluation: "enforce", policyRecords: displayOnly },
        async (runtime) => {
          await seedSpaceLabeledCell(runtime, "policy-display-guard", {
            confidentiality: [SPACE_ATOM],
            integrity: [ROLE_ALICE],
          });
          const { reasons } = readThenSink(runtime, "policy-display-guard");
          expect(
            reasons.some((reason) =>
              reason.includes("sink-request confidentiality exceeds ceiling")
            ),
          ).toBe(true);
        },
      );
    });

    it("enforce: releasing one clause never releases a sibling (inv-11)", async () => {
      await withRuntime({ policyEvaluation: "enforce" }, async (runtime) => {
        await seedSpaceLabeledCell(runtime, "policy-sibling", {
          confidentiality: [SPACE_ATOM, USER_MALLORY],
          integrity: [ROLE_ALICE],
        });
        const { reasons } = readThenSink(runtime, "policy-sibling");
        // The Space clause is admitted through the rewrite, but Mallory's
        // clause stays outside the ceiling and still rejects.
        const offending = reasons.find((reason) =>
          reason.includes("sink-request confidentiality exceeds ceiling")
        );
        expect(offending).toBeDefined();
        expect(offending).toContain("did:key:mallory");
        expect(offending).not.toContain("space:x");
      });
    });

    it("observe: decides as off, and diagnoses the would-be admission", async () => {
      await withRuntime({ policyEvaluation: "observe" }, async (runtime) => {
        await seedSpaceLabeledCell(runtime, "policy-observe", {
          confidentiality: [SPACE_ATOM],
          integrity: [ROLE_ALICE],
        });
        const { reasons, diagnostics } = readThenSink(
          runtime,
          "policy-observe",
        );
        expect(
          reasons.some((reason) =>
            reason.includes("sink-request confidentiality exceeds ceiling")
          ),
        ).toBe(true);
        expect(
          diagnostics.some((note) =>
            note.includes("policy-evaluation(observe)") &&
            note.includes("from reject to fit")
          ),
        ).toBe(true);
      });
    });

    it("observe: diagnoses an unresolved module policy by digest", async () => {
      await withRuntime(
        { policyEvaluation: "observe", policyRecords: [] },
        async (runtime) => {
          const unresolved = cfcAtom.modulePolicyRef(
            "sha256:missing-module",
            "rules",
            "sha256:missing-manifest",
            signer.did(),
          );
          await seedSpaceLabeledCell(runtime, "policy-observe-missing", {
            confidentiality: [unresolved],
          });
          const { diagnostics } = readThenSink(
            runtime,
            "policy-observe-missing",
          );
          expect(
            diagnostics.some((note) =>
              note.includes("module policy missing-manifest") &&
              note.includes("sha256:missing-manifest")
            ),
          ).toBe(true);
        },
      );
    });

    it("enforce: fuel exhaustion fails closed", async () => {
      await withRuntime(
        { policyEvaluation: "enforce", policyRecords: CYCLING_POLICY },
        async (runtime) => {
          await seedSpaceLabeledCell(runtime, "policy-exhausted", {
            confidentiality: [SPACE_ATOM],
          });
          const { reasons } = readThenSink(runtime, "policy-exhausted");
          expect(
            reasons.some((reason) =>
              reason.includes("policy evaluation exhausted fuel")
            ),
          ).toBe(true);
        },
      );
    });

    it("observe: fuel exhaustion is diagnosed, decision unchanged", async () => {
      await withRuntime(
        { policyEvaluation: "observe", policyRecords: CYCLING_POLICY },
        async (runtime) => {
          await seedSpaceLabeledCell(runtime, "policy-exhausted-observe", {
            confidentiality: [SPACE_ATOM],
          });
          const { reasons, diagnostics } = readThenSink(
            runtime,
            "policy-exhausted-observe",
          );
          expect(
            reasons.some((reason) =>
              reason.includes("sink-request confidentiality exceeds ceiling")
            ),
          ).toBe(true);
          expect(diagnostics.some((note) => note.includes("fuel exhausted")))
            .toBe(true);
        },
      );
    });
  });

  describe("input-requirement maxConfidentiality gate", () => {
    const sinkSchema = {
      type: "object",
      // The write target holds values derived from the Space-labeled cell,
      // so its root declares that clause as the audience it keeps.
      ifc: { confidentiality: [SPACE_ATOM] },
      properties: {
        out: {
          type: "string",
          ifc: { maxConfidentiality: [USER_ALICE] },
        },
      },
      required: ["out"],
    } as const satisfies JSONSchema;

    // No boundary guard: the input-requirement gate is a write-target gate,
    // not a sink — it mints no BoundaryContext atoms.
    const unguardedPolicy: CfcPolicyRecordInput[] = [{
      id: "input-gate-policy",
      rules: [{
        ...spaceReaderAtNetwork,
        id: "space-reader-anywhere",
        preCondition: {
          integrity: spaceReaderAtNetwork.preCondition!.integrity,
        },
      }],
    }];

    const readThenWrite = (
      runtime: Runtime,
      id: string,
    ): { reasons: readonly string[]; diagnostics: readonly string[] } => {
      const tx = runtime.edit();
      const cell = runtime.getCell(signer.did(), id, SECRET_SCHEMA.schema, tx);
      expect(cell.key("secret").get()).toBe("rosebud");
      runtime.getCell(signer.did(), `${id}-sink`, sinkSchema, tx)
        .set({ out: "derived" });
      tx.prepareCfc();
      const state = tx.getCfcState();
      const reasons = state.prepare.status === "invalidated"
        ? [...state.prepare.reasons]
        : [];
      const result = { reasons, diagnostics: [...state.diagnostics] };
      tx.abort();
      return result;
    };

    // The B5×D4 seam: identical to readThenWrite but with the ORDER inverted —
    // write the ceiling-protected path FIRST, then read the confidential cell.
    // The read's activity-clock position is now at/after the write's D4 bound
    // (the last write attempt overlapping /out), so it is excluded from the
    // write's read prefix. `maxConfidentiality` quantifies over that prefix
    // (`gating`), which is empty, so the ceiling check is SKIPPED — a read that
    // cannot have fed the committed value is not a consumed input here. With
    // the pre-D4 transaction-global quantification this same read would sit in
    // the gate and reject.
    const writeThenRead = (
      runtime: Runtime,
      id: string,
    ): { reasons: readonly string[]; diagnostics: readonly string[] } => {
      const tx = runtime.edit();
      runtime.getCell(signer.did(), `${id}-sink`, sinkSchema, tx)
        .set({ out: "derived" });
      const cell = runtime.getCell(signer.did(), id, SECRET_SCHEMA.schema, tx);
      expect(cell.key("secret").get()).toBe("rosebud");
      tx.prepareCfc();
      const state = tx.getCfcState();
      const reasons = state.prepare.status === "invalidated"
        ? [...state.prepare.reasons]
        : [];
      const result = { reasons, diagnostics: [...state.diagnostics] };
      tx.abort();
      return result;
    };

    it("off: rejects on the raw label", async () => {
      await withRuntime(
        { policyEvaluation: "off", policyRecords: unguardedPolicy },
        async (runtime) => {
          await seedSpaceLabeledCell(runtime, "input-off", {
            confidentiality: [SPACE_ATOM],
            integrity: [ROLE_ALICE],
          });
          const { reasons } = readThenWrite(runtime, "input-off");
          expect(
            reasons.some((reason) =>
              reason.includes("maxConfidentiality failed")
            ),
          ).toBe(true);
        },
      );
    });

    it("enforce: subsumption-fits the rewritten consumed label", async () => {
      await withRuntime(
        { policyEvaluation: "enforce", policyRecords: unguardedPolicy },
        async (runtime) => {
          await seedSpaceLabeledCell(runtime, "input-enforce", {
            confidentiality: [SPACE_ATOM],
            integrity: [ROLE_ALICE],
          });
          const { reasons } = readThenWrite(runtime, "input-enforce");
          expect(reasons).toEqual([]);
        },
      );
    });

    it("enforce: rules gated on boundary context cannot fire at a write gate", async () => {
      await withRuntime(
        { policyEvaluation: "enforce" }, // POLICY requires sinkClass network
        async (runtime) => {
          await seedSpaceLabeledCell(runtime, "input-boundary-guarded", {
            confidentiality: [SPACE_ATOM],
            integrity: [ROLE_ALICE],
          });
          const { reasons } = readThenWrite(runtime, "input-boundary-guarded");
          expect(
            reasons.some((reason) =>
              reason.includes("maxConfidentiality failed")
            ),
          ).toBe(true);
        },
      );
    });

    it("enforce: an empty gating prefix skips the ceiling (write-first read excluded by bound)", async () => {
      // The D4 seam guard, dual to input-boundary-guarded above: SAME runtime
      // (enforce, network-guarded POLICY that cannot rewrite [Space] at a
      // write gate) and SAME confidential input, but the read now lands AFTER
      // the protected write. It is therefore past the write's D4 bound and
      // drops out of `gating`; with an empty gating set the `maxConfidentiality`
      // check is skipped entirely and the write commits — even though [Space]
      // is outside the [User(alice)] ceiling. This is intended delegation, not
      // a hole: a read that could not have fed the value is not a consumed
      // input. Flipping the gate's quantification back to the transaction-
      // global consumed set re-admits this read and re-rejects (verified in
      // the PR); the admission here is the regression guard for the skip.
      await withRuntime(
        { policyEvaluation: "enforce" }, // POLICY requires sinkClass network
        async (runtime) => {
          await seedSpaceLabeledCell(runtime, "input-empty-gating", {
            confidentiality: [SPACE_ATOM],
            integrity: [ROLE_ALICE],
          });
          const { reasons } = writeThenRead(runtime, "input-empty-gating");
          expect(reasons).toEqual([]);
        },
      );
    });

    it("observe: decides as off (rejects), and diagnoses the would-be admission", async () => {
      // The rewrite (space-reader-anywhere) WOULD add User(alice), which fits
      // the [User(alice)] ceiling — but observe decides on the raw label
      // ([Space] does not fit) and only diagnoses the divergence.
      await withRuntime(
        { policyEvaluation: "observe", policyRecords: unguardedPolicy },
        async (runtime) => {
          await seedSpaceLabeledCell(runtime, "input-observe", {
            confidentiality: [SPACE_ATOM],
            integrity: [ROLE_ALICE],
          });
          const { reasons, diagnostics } = readThenWrite(
            runtime,
            "input-observe",
          );
          // Decided as off: still rejected.
          expect(
            reasons.some((reason) =>
              reason.includes("maxConfidentiality failed")
            ),
          ).toBe(true);
          // …and the divergence (reject → fit) is diagnosed.
          expect(
            diagnostics.some((d) =>
              d.includes("policy-evaluation(observe): rewrite would change") &&
              d.includes("maxConfidentiality") &&
              d.includes("from reject to fit")
            ),
          ).toBe(true);
        },
      );
    });

    it("observe: fuel exhaustion at the input gate is diagnosed, decision unchanged", async () => {
      // A cycling policy exhausts fuel; observe still decides on the raw label
      // (reject) and diagnoses the exhaustion at the input requirement.
      await withRuntime(
        { policyEvaluation: "observe", policyRecords: CYCLING_POLICY },
        async (runtime) => {
          await seedSpaceLabeledCell(runtime, "input-observe-exhaust", {
            confidentiality: [SPACE_ATOM],
            integrity: [ROLE_ALICE],
          });
          const { reasons, diagnostics } = readThenWrite(
            runtime,
            "input-observe-exhaust",
          );
          expect(
            reasons.some((reason) =>
              reason.includes("maxConfidentiality failed")
            ),
          ).toBe(true);
          expect(
            diagnostics.some((d) =>
              d.includes("policy-evaluation(observe): fuel exhausted") &&
              d.includes("input requirement")
            ),
          ).toBe(true);
        },
      );
    });
  });

  describe("dial + digest plumbing", () => {
    it("pins enforce against mid-tx weakening", async () => {
      await withRuntime({ policyEvaluation: "enforce" }, (runtime) => {
        const tx = runtime.edit();
        expect(tx.getCfcState().policyEvaluationMode).toBe("enforce");
        expect(() => tx.setCfcPolicyEvaluationMode("off")).toThrow(
          /cannot be weakened/,
        );
        expect(() => tx.setCfcPolicyEvaluationMode("observe")).toThrow(
          /cannot be weakened/,
        );
        // Re-asserting enforce is fine.
        tx.setCfcPolicyEvaluationMode("enforce");
        tx.abort();
      });
    });

    it("invalidates a prepared tx when the evaluation mode is strengthened", async () => {
      // Prepare under observe, then strengthen to enforce: the mode is not in
      // PreparedDigestInput, so a decision computed under observe must be
      // invalidated rather than surviving the commit-time recheck while the tx
      // now reports enforce (codex P2 on #4566).
      await withRuntime({ policyEvaluation: "observe" }, (runtime) => {
        const tx = runtime.edit();
        const cell = runtime.getCell(
          signer.did(),
          "mode-change-probe",
          {
            type: "object",
            // The second prepare below reads back the label the first one
            // persisted, so the root declares the clause `value` carries.
            ifc: { confidentiality: ["x"] },
            properties: {
              value: { type: "string", ifc: { confidentiality: ["x"] } },
            },
          } as const satisfies JSONSchema,
          tx,
        );
        cell.set({ value: "v" });
        tx.prepareCfc();
        expect(tx.getCfcState().prepare.status).toBe("prepared");
        tx.setCfcPolicyEvaluationMode("enforce");
        expect(tx.getCfcState().prepare.status).toBe("invalidated");
        // A no-op re-set of the SAME mode does not invalidate a fresh prepare.
        tx.prepareCfc();
        expect(tx.getCfcState().prepare.status).toBe("prepared");
        tx.setCfcPolicyEvaluationMode("enforce");
        expect(tx.getCfcState().prepare.status).toBe("prepared");
        tx.abort();
      });
    });

    it("folds the policy snapshot digest into the prepared digest", () => {
      const base: PreparedDigestInput = {
        consumedReads: [],
        attemptedWrites: [],
        writes: [],
        writeAttemptLog: [],
        dereferenceTraces: [],
        triggerReads: [],
        writePolicyInputs: [],
      };
      const withA = preparedDigestFor({
        ...base,
        policySnapshot: { digest: "sha256:policy-a" },
      });
      const withB = preparedDigestFor({
        ...base,
        policySnapshot: { digest: "sha256:policy-b" },
      });
      const without = preparedDigestFor(base);
      expect(withA).not.toBe(withB);
      expect(withA).not.toBe(without);
      // Stable for identical inputs.
      expect(preparedDigestFor({
        ...base,
        policySnapshot: { digest: "sha256:policy-a" },
      })).toBe(withA);
    });

    it("records the snapshot digest in the prepared input of a live tx", async () => {
      await withRuntime({ policyEvaluation: "enforce" }, (runtime) => {
        const tx = runtime.edit();
        const cell = runtime.getCell(
          signer.did(),
          "digest-probe",
          {
            type: "object",
            properties: {
              value: { type: "string", ifc: { confidentiality: ["x"] } },
            },
          } as const satisfies JSONSchema,
          tx,
        );
        cell.set({ value: "v" });
        tx.prepareCfc();
        const state = tx.getCfcState();
        expect(state.prepare.status).toBe("prepared");
        if (state.prepare.status === "prepared") {
          expect(state.prepare.input.policySnapshot?.digest)
            .toBe(runtime.cfcPolicySnapshot!.digest);
        }
        tx.abort();
      });
    });

    it("the TransactionWrapper delegates setCfcPolicyEvaluationMode to the wrapped tx", async () => {
      // The child-tx wrapper forwards the dial setter; a nested/child pattern
      // tx must carry the deployment mode into the wrapped tx's CFC state.
      await withRuntime({ policyEvaluation: "off" }, (runtime) => {
        const tx = runtime.edit() as ExtendedStorageTransaction;
        const wrapper = new TransactionWrapper(tx, {});
        wrapper.setCfcPolicyEvaluationMode("enforce");
        expect(tx.getCfcState().policyEvaluationMode).toBe("enforce");
        tx.abort();
      });
    });
  });
});
