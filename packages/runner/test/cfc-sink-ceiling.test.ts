import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";

import { internSchema } from "@commonfabric/data-model-schema";
import { Identity } from "@commonfabric/identity";

import type { JSONSchema } from "../src/builder/types.ts";
import type { CfcConfClause } from "../src/cfc/clause.ts";
import type { SinkMaxConfidentiality } from "../src/cfc/mod.ts";
import { CFC_LABEL_READ_FAILED_ATOM } from "../src/cfc/observation.ts";
import { createFrozenRequestSnapshot } from "../src/cfc/request-snapshot.ts";
import { enqueueSinkRequestPostCommitEffect } from "../src/cfc/sink-request.ts";
import { Runtime } from "../src/runtime.ts";
import { StorageManager } from "../src/storage/cache.deno.ts";
import { isCfcEnforcementRejection } from "../src/storage/rejection.ts";
import { seedStoredEnvelope } from "./cfc-seed-envelope.ts";

const signer = await Identity.fromPassphrase("runner-cfc-sink-ceiling");

// §5.2.1 / §7.3-7.5 egress gate (audit item 21): a sink request must not carry
// confidentiality outside the sink's declared ceiling. Each case seeds a
// confidential cell, reads it through its schema (marking the tx CFC-relevant
// and producing a confidential consumed read), enqueues a fetchJson sink
// request, then prepares + commits under a configured ceiling.
const CONFIDENTIAL_SCHEMA = internSchema(
  {
    type: "object",
    properties: {
      secret: { type: "string", ifc: { confidentiality: ["medical"] } },
    },
    required: ["secret"],
  } satisfies JSONSchema,
  true,
);

// The fail-closed read-error marker (audit item 22) stored as a real label, as
// taint propagation would persist it. Used to prove the egress gate treats it
// as UNGRANTABLE even when a deployment ceiling explicitly lists it.
const MARKER_LABELLED_SCHEMA = internSchema(
  {
    type: "object",
    properties: {
      secret: {
        type: "string",
        ifc: { confidentiality: [CFC_LABEL_READ_FAILED_ATOM] },
      },
    },
    required: ["secret"],
  } satisfies JSONSchema,
  true,
);

const seedConfidentialCell = async (
  runtime: Runtime,
  id: string,
  schema = CONFIDENTIAL_SCHEMA,
  atoms: readonly CfcConfClause[] = ["medical"],
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
      schemaHash: schema.taggedHashString,
      labelMap: {
        version: 1,
        entries: [{
          path: ["secret"],
          label: { confidentiality: [...atoms] },
        }],
      },
    },
  });
  seed.writeOrThrow({
    space: signer.did(),
    scope: "space",
    id: `cid:${schema.taggedHashString}`,
    path: [],
  }, { value: schema.schema });
  expect((await seed.commit()).ok).toBeDefined();
};

// Read the confidential cell through its schema and enqueue a fetchJson sink
// request in the same transaction, then prepare. Returns the prepare reasons.
const readConfidentialThenSink = (
  runtime: Runtime,
  id: string,
  sink = "fetchJson",
  schema = CONFIDENTIAL_SCHEMA,
) => {
  const tx = runtime.edit();
  const cell = runtime.getCell(
    signer.did(),
    id,
    schema.schema,
    tx,
  );
  // Reading the labeled field marks the tx CFC-relevant and records the
  // confidential consumed read.
  expect(cell.key("secret").get()).toBe("rosebud");
  enqueueSinkRequestPostCommitEffect(
    tx,
    sink,
    `${sink}:ceiling-test`,
    createFrozenRequestSnapshot({ url: "https://example.com/exfil" }),
    `${sink}-start`,
    () => {},
  );
  tx.prepareCfc();
  return { commit: () => tx.commit() };
};

const withRuntime = async (
  opts: {
    mode?: "observe" | "enforce-explicit";
    ceilings?: SinkMaxConfidentiality;
  },
  body: (runtime: Runtime) => Promise<void>,
): Promise<void> => {
  const storageManager = StorageManager.emulate({ as: signer });
  const runtime = new Runtime({
    apiUrl: new URL("https://example.com"),
    storageManager,
    cfcEnforcementMode: opts.mode ?? "enforce-explicit",
    cfcSinkMaxConfidentiality: opts.ceilings,
  });
  try {
    await body(runtime);
  } finally {
    await runtime.dispose();
    await storageManager.close();
  }
};

describe("CFC sink-request confidentiality ceiling", () => {
  it("rejects a confidential request to a public-only sink (enforce)", async () => {
    await withRuntime(
      { mode: "enforce-explicit", ceilings: { fetchJson: [] } },
      async (runtime) => {
        await seedConfidentialCell(runtime, "sink-ceiling-reject");
        const { commit } = readConfidentialThenSink(
          runtime,
          "sink-ceiling-reject",
        );
        const result = await commit();
        expect(isCfcEnforcementRejection(result.error)).toBe(true);
        expect(String((result.error as Error).message)).toContain(
          "exceeds ceiling for fetchJson",
        );
      },
    );
  });

  it("rejects when the confidential field is a descendant of the read path", async () => {
    // Reading the WHOLE object (path []) and building a request from it must
    // still see the confidentiality on a child field (/secret) — labelAtPath
    // alone only matches ancestor-or-equal entries and would miss it, letting
    // `cell.get()` then sending `value.secret` slip a public-only ceiling
    // (review on #3993).
    await withRuntime(
      { mode: "enforce-explicit", ceilings: { fetchJson: [] } },
      async (runtime) => {
        await seedConfidentialCell(runtime, "sink-ceiling-descendant");
        const tx = runtime.edit();
        const cell = runtime.getCell(
          signer.did(),
          "sink-ceiling-descendant",
          CONFIDENTIAL_SCHEMA.schema,
          tx,
        );
        // Read the whole object, not cell.key("secret").
        expect(cell.get()).toEqual({ secret: "rosebud" });
        enqueueSinkRequestPostCommitEffect(
          tx,
          "fetchJson",
          "fetchJson:descendant",
          createFrozenRequestSnapshot({ url: "https://example.com/exfil" }),
          "fetchJson-start",
          () => {},
        );
        tx.prepareCfc();
        const result = await tx.commit();
        expect(isCfcEnforcementRejection(result.error)).toBe(true);
        expect(String((result.error as Error).message)).toContain(
          "exceeds ceiling for fetchJson",
        );
      },
    );
  });

  it("allows the same flow in observe mode but records the diagnostic", async () => {
    await withRuntime(
      { mode: "observe", ceilings: { fetchJson: [] } },
      async (runtime) => {
        await seedConfidentialCell(runtime, "sink-ceiling-observe");
        const tx = runtime.edit();
        const cell = runtime.getCell(
          signer.did(),
          "sink-ceiling-observe",
          CONFIDENTIAL_SCHEMA.schema,
          tx,
        );
        expect(cell.key("secret").get()).toBe("rosebud");
        enqueueSinkRequestPostCommitEffect(
          tx,
          "fetchJson",
          "fetchJson:observe",
          createFrozenRequestSnapshot({ url: "https://example.com/exfil" }),
          "fetchJson-start",
          () => {},
        );
        tx.prepareCfc();
        const result = await tx.commit();
        expect(result.ok).toBeDefined();
        expect(
          tx.getCfcState().diagnostics.some((d) =>
            // The diagnostic must name the offending atom so a deployment can
            // identify which (sink, atom) pair needs a ceiling entry (#3993).
            d.includes("exceeds ceiling for fetchJson") && d.includes("medical")
          ),
        ).toBe(true);
      },
    );
  });

  it("allows a confidential request when the atom is within the ceiling", async () => {
    await withRuntime(
      { mode: "enforce-explicit", ceilings: { fetchJson: ["medical"] } },
      async (runtime) => {
        await seedConfidentialCell(runtime, "sink-ceiling-within");
        const { commit } = readConfidentialThenSink(
          runtime,
          "sink-ceiling-within",
        );
        expect((await commit()).ok).toBeDefined();
      },
    );
  });

  it("does not gate a sink with no declared ceiling", async () => {
    await withRuntime(
      // A ceiling on a DIFFERENT sink must not gate fetchJson.
      { mode: "enforce-explicit", ceilings: { llm: [] } },
      async (runtime) => {
        await seedConfidentialCell(runtime, "sink-ceiling-ungated");
        const { commit } = readConfidentialThenSink(
          runtime,
          "sink-ceiling-ungated",
        );
        expect((await commit()).ok).toBeDefined();
      },
    );
  });

  it("does not gate when no ceilings are configured at all (default)", async () => {
    await withRuntime(
      { mode: "enforce-explicit" },
      async (runtime) => {
        await seedConfidentialCell(runtime, "sink-ceiling-default");
        const { commit } = readConfidentialThenSink(
          runtime,
          "sink-ceiling-default",
        );
        expect((await commit()).ok).toBeDefined();
      },
    );
  });

  it("allows a public (unlabeled) request to a public-only sink", async () => {
    await withRuntime(
      { mode: "enforce-explicit", ceilings: { fetchJson: [] } },
      async (runtime) => {
        // No confidential read this time — just enqueue a sink request.
        const tx = runtime.edit();
        // Touch a labeled cell's schema so the tx is CFC-relevant, but read a
        // non-confidential path... simplest: mark relevant via a public write.
        enqueueSinkRequestPostCommitEffect(
          tx,
          "fetchJson",
          "fetchJson:public",
          createFrozenRequestSnapshot({ url: "https://example.com/ok" }),
          "fetchJson-start",
          () => {},
        );
        tx.prepareCfc();
        // With no CFC-relevant activity the boundary check is skipped entirely;
        // either way the public request must commit.
        expect((await tx.commit()).ok).toBeDefined();
      },
    );
  });

  it("rejects the read-failed marker even when the ceiling lists it (ungrantable)", async () => {
    // CFC_LABEL_READ_FAILED_ATOM is the fail-closed taint for label-read
    // errors (audit item 22). It is an exported string a deployment config
    // could name in a sink ceiling — but granting it would re-open the
    // fail-closed hole, so the egress gate must reject it even when the
    // ceiling explicitly lists it, exactly like cfcObservationFitsCeiling.
    await withRuntime(
      {
        mode: "enforce-explicit",
        ceilings: { fetchJson: [CFC_LABEL_READ_FAILED_ATOM, "medical"] },
      },
      async (runtime) => {
        await seedConfidentialCell(
          runtime,
          "sink-ceiling-ungrantable",
          MARKER_LABELLED_SCHEMA,
          [CFC_LABEL_READ_FAILED_ATOM],
        );
        const { commit } = readConfidentialThenSink(
          runtime,
          "sink-ceiling-ungrantable",
          "fetchJson",
          MARKER_LABELLED_SCHEMA,
        );
        const result = await commit();
        expect(isCfcEnforcementRejection(result.error)).toBe(true);
        expect(String((result.error as Error).message)).toContain(
          "exceeds ceiling for fetchJson",
        );
      },
    );
  });
});
