import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";

import { Identity } from "@commonfabric/identity";
import type { MemorySpace } from "@commonfabric/memory/interface";

import type { JSONSchema } from "../src/builder/types.ts";
import { rawMetaWriteAuthorization } from "../src/meta-seam.ts";
import { Runtime } from "../src/runtime.ts";
import type { Action } from "../src/scheduler.ts";
import { StorageManager } from "../src/storage/cache.deno.ts";
import { isAuthorizationRead } from "../src/storage/reactivity-log.ts";

const signer = await Identity.fromPassphrase("runner-cfc-missing-source");
const space: MemorySpace = signer.did();

const LABEL = "personal-space";

const labeledSchema: JSONSchema = {
  type: "object",
  properties: { title: { type: "string" } },
  ifc: { confidentiality: [LABEL] },
};

const createRuntime = () => {
  const storageManager = StorageManager.emulate({ as: signer });
  const runtime = new Runtime({
    apiUrl: new URL("https://example.com"),
    storageManager,
    cfcEnforcementMode: "enforce-explicit",
    cfcFlowLabels: "off",
    cfcWriteFloor: "off",
    cfcTriggerReadGating: false,
    cfcDecomposedEnvelopes: false,
    cfcPolicyEvaluation: "off",
    cfcLabelMetadataProtection: "off",
    cfcDeclaredMonotonicity: "off",
  });
  return { runtime, storageManager };
};

const idFor = (runtime: Runtime, name: string): string =>
  runtime.getCell(space, name).getAsNormalizedFullLink().id;

/** Commits a labeled target and, when named, an unlabeled source beside it. */
const seedTarget = async (
  runtime: Runtime,
  targetName: string,
  sourceName?: string,
) => {
  const tx = runtime.edit();
  tx.setCfcEnforcementMode("enforce-explicit");
  runtime.getCell(space, targetName, {
    type: "object",
    ifc: { confidentiality: [LABEL] },
  }, tx).set({ existing: true });
  if (sourceName !== undefined) {
    // Written with no schema, so the commit stores no `cfc` member on this
    // document and nothing later in the test writes one unasked.
    runtime.getCell(space, sourceName, undefined, tx).set({ title: "plain" });
  }
  tx.prepareCfc();
  expect((await tx.commit()).ok).toBeDefined();
};

/** Commits one write to `name`, under `schema` when one is given. */
const commitWrite = async (
  runtime: Runtime,
  name: string,
  value: unknown,
  schema?: JSONSchema,
) => {
  const tx = runtime.edit();
  tx.setCfcEnforcementMode("enforce-explicit");
  runtime.getCell(space, name, schema, tx).set(value);
  tx.prepareCfc();
  expect((await tx.commit()).ok).toBeDefined();
};

/**
 * Subscribes an action that links `sourceName` into a labeled target, counting
 * its runs and collecting every commit rejection they earn.
 */
const subscribeLink = (
  runtime: Runtime,
  sourceName: string,
  targetName: string,
) => {
  const state = {
    runs: 0,
    errors: [] as { name?: string; message?: string }[],
  };
  const link: Action = (tx) => {
    state.runs++;
    tx.setCfcEnforcementMode("enforce-explicit");
    tx.addVerdictCallback((_tx, result) => {
      if (result.error) state.errors.push(result.error);
    });
    runtime.getCell(space, targetName, undefined, tx).set(
      runtime.getCell(space, sourceName, undefined, tx),
    );
  };
  runtime.scheduler.subscribe(link, { isEffect: true });
  return state;
};

describe("cfc-missing-link-source-metadata", () => {
  it("retains an authorization dependency when an unlabeled source is forwarded", async () => {
    const { runtime, storageManager } = createRuntime();
    try {
      await commitWrite(runtime, "plain-source", "public");
      const tx = runtime.edit();
      const source = runtime.getCell(space, "plain-source", undefined, tx);
      runtime.getCell(space, "plain-destination", undefined, tx).set(source);
      expect(
        [...tx.getReadActivities!()].some((read) =>
          read.id === source.getAsNormalizedFullLink().id &&
          read.path[0] === "cfc" && isAuthorizationRead(read.meta)
        ),
      ).toBe(true);
      tx.abort();
    } finally {
      await runtime.dispose({ closeStorage: false });
      await storageManager.close();
    }
  });

  // The cases here are a pair, and each is worth as much as the other. A
  // refusal the state in hand settles has to stop retrying, and one that
  // reading the source would settle has to keep retrying, since mislabelling
  // in the second direction strands a write that would have landed. Two
  // members of the source document decide the refusal — its `["cfc"]`
  // envelope and its `["schema"]` meta — and the run depends on both, so a
  // case covers each one arriving.

  it("stops retrying when the source is here and stores no metadata", async () => {
    const { runtime, storageManager } = createRuntime();
    try {
      await seedTarget(runtime, "held-target", "held-source");
      const state = subscribeLink(runtime, "held-source", "held-target");
      await runtime.scheduler.idleWithPendingCommits();

      expect(state.runs).toBe(1);
      expect(state.errors.length).toBe(1);
      expect(state.errors[0].name).toBe("CfcCommitRefusalError");
      expect(state.errors[0].message).toContain("missing link source metadata");

      // Idling again finds no queued retry.
      await runtime.scheduler.idleWithPendingCommits();
      expect(state.runs).toBe(1);
    } finally {
      await runtime.dispose();
      await storageManager.close();
    }
  });

  it("names the source document and the target the link was written to", async () => {
    const { runtime, storageManager } = createRuntime();
    try {
      await seedTarget(runtime, "named-target", "named-source");
      const sourceId = idFor(runtime, "named-source");
      const targetId = idFor(runtime, "named-target");
      expect(sourceId).not.toBe(targetId);

      const state = subscribeLink(runtime, "named-source", "named-target");
      await runtime.scheduler.idleWithPendingCommits();

      const message = state.errors[0]?.message ?? "";
      expect(message).toContain(`missing link source metadata for ${sourceId}`);
      expect(message).toContain(`linked into ${targetId}`);
    } finally {
      await runtime.dispose();
      await storageManager.close();
    }
  });

  it("re-runs the refused action, and lands it, when the source gains metadata", async () => {
    const { runtime, storageManager } = createRuntime();
    try {
      await seedTarget(runtime, "healed-target", "healed-source");
      const state = subscribeLink(runtime, "healed-source", "healed-target");
      await runtime.scheduler.idleWithPendingCommits();
      expect(state.runs).toBe(1);

      // A change to the source's VALUE does not re-trigger the run: the
      // refusal read the source's metadata, not its value.
      await commitWrite(runtime, "healed-source", { title: "bumped" });
      await runtime.scheduler.idleWithPendingCommits();
      expect(state.runs).toBe(1);

      // Declaring the source's label stores the metadata the refusal went
      // looking for, at the path it read.
      await commitWrite(runtime, "healed-source", { title: "labeled" }, {
        ...labeledSchema,
      });
      await runtime.scheduler.idleWithPendingCommits();

      expect(state.runs).toBeGreaterThan(1);
      // No second rejection: the re-run derived the source's label and the
      // link landed.
      expect(state.errors.length).toBe(1);
      expect(
        runtime.getCell(space, "healed-target").getAsQueryResult(),
      ).toMatchObject({ title: "labeled" });
    } finally {
      await runtime.dispose();
      await storageManager.close();
    }
  });

  it("re-runs the refused action, and lands it, when the source gains a schema", async () => {
    // The stored `["cfc"]` envelope is not the only member the derivation
    // consults: `setupResultSchemaFor` reads the source's `["schema"]` meta,
    // which a piece's setup writes and which can land after the link write
    // was refused. The refusal is terminal over the revision in hand, so the
    // arrival has to re-trigger the run the same way metadata does.
    const { runtime, storageManager } = createRuntime();
    try {
      await seedTarget(runtime, "schema-target", "schema-source");
      const state = subscribeLink(runtime, "schema-source", "schema-target");
      await runtime.scheduler.idleWithPendingCommits();
      expect(state.runs).toBe(1);
      expect(state.errors[0].name).toBe("CfcCommitRefusalError");

      const tx = runtime.edit();
      tx.setCfcEnforcementMode("enforce-explicit");
      runtime.getCell(space, "schema-source", undefined, tx).setMetaRaw(
        "schema",
        labeledSchema,
        rawMetaWriteAuthorization,
      );
      tx.prepareCfc();
      expect((await tx.commit()).ok).toBeDefined();
      await runtime.scheduler.idleWithPendingCommits();

      expect(state.runs).toBeGreaterThan(1);
      expect(state.errors.length).toBe(1);
      expect(
        runtime.getCell(space, "schema-target").getAsQueryResult(),
      ).toMatchObject({ title: "plain" });
    } finally {
      await runtime.dispose();
      await storageManager.close();
    }
  });

  it("keeps retrying when this replica does not hold the source", async () => {
    const { runtime, storageManager } = createRuntime();
    try {
      await seedTarget(runtime, "unheld-target");
      const state = subscribeLink(runtime, "unheld-source", "unheld-target");
      await runtime.scheduler.idleWithPendingCommits();

      // Every attempt is refused, for the same reason, and the reason keeps
      // the retryable name.
      expect(state.runs).toBeGreaterThan(1);
      expect(state.errors.length).toBe(state.runs);
      expect(new Set(state.errors.map((error) => error.name)))
        .toEqual(new Set(["StorageTransactionAborted"]));
      expect(new Set(state.errors.map((error) => error.message))).toEqual(
        new Set([state.errors[0].message]),
      );
      expect(state.errors[0].message).toContain("missing link source metadata");
    } finally {
      await runtime.dispose();
      await storageManager.close();
    }
  });
});
