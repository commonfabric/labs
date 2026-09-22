/**
 * The remedy channel a CFC refusal carries: not only WHAT the gate refused, but
 * WHICH of the transaction's reads carried the offending confidentiality in. A
 * refusal naming only its atoms leaves the refused party with nothing to replan
 * against; a refusal naming its inputs, and stating whether those inputs
 * account for every offending atom, is one an agent can act on by dropping an
 * argument and running again.
 *
 * Three layers, because the channel breaks at any of them:
 *
 * - the pure grouping/classification helpers of `cfc/refusal-detail.ts`;
 * - the detail riding out on a real pattern's refused egress, all the way to
 *   the error the scheduler reports — paired with the unlabelled control that
 *   reaches the network, so the refusal case cannot pass vacuously;
 * - the `cfc.prepare-reject` telemetry marker, which is the only trace a
 *   refusal leaves when the commit boundary decides it is retryable rather
 *   than terminal and so never puts it on the error channel at all.
 */

import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";

import { expect } from "@std/expect";
import { Identity } from "@commonfabric/identity";
import {
  clearMockResponses,
  enableMockMode,
  setMockResponseGate,
} from "@commonfabric/llm/client";
import type { URI } from "@commonfabric/memory/interface";
import { StorageManager } from "../src/storage/cache.deno.ts";
import { Runtime } from "../src/runtime.ts";
import { setPatternEnvironment } from "../src/env.ts";
import { createTrustedBuilder } from "./support/trusted-builder.ts";
import { enqueueSinkRequestPostCommitEffect } from "../src/cfc/sink-request.ts";
import { createFrozenRequestSnapshot } from "../src/cfc/request-snapshot.ts";
import {
  SEED_ENVELOPE_SCHEMA_HASH,
  seedStoredEnvelope,
  writeSeedEnvelopeDoc,
} from "./cfc-seed-envelope.ts";
import {
  type CfcAddress,
  type CfcConfClause,
  type CfcRefusalDetail,
  type ConsumedAtomSource,
  describeRefusalInputs,
  renderCfcAtom,
} from "../src/cfc/mod.ts";
import { RuntimeTelemetryEvent } from "../src/telemetry.ts";
import type { RuntimeTelemetryMarker } from "../src/telemetry.ts";
import type { ErrorWithContext } from "../src/scheduler.ts";
import type { Cell } from "../src/cell.ts";

const signer = await Identity.fromPassphrase("runner-cfc-refusal-detail");
const space = signer.did();

enableMockMode();

/** The one atom every gate in this file refuses, rendered as details name it. */
const MEDICAL = renderCfcAtom("medical");

type PrepareRejectMarker = Extract<
  RuntimeTelemetryMarker,
  { type: "cfc.prepare-reject" }
>;

/** The structured details a surfaced refusal carries, or none. */
const refusalsOf = (error: unknown): readonly CfcRefusalDetail[] =>
  (error as { refusals?: readonly CfcRefusalDetail[] })?.refusals ?? [];

const addressOf = (id: string, path: readonly string[]): CfcAddress =>
  ({ space, id, scope: "space", path }) as CfcAddress;

const sourceOf = (
  atom: CfcConfClause,
  id: string,
  readPath: readonly string[],
  labelPath: readonly string[],
): ConsumedAtomSource => ({ atom, read: addressOf(id, readPath), labelPath });

/**
 * Seed a document holding `{ secret: "rosebud" }`. With `confidentiality`, its
 * `/secret` carries those clauses as persisted store-policy metadata — the
 * form a read actually picks a label up from. Without, the document is plain,
 * which is the control every refusal case here is measured against.
 */
const seedSecret = async (
  runtime: Runtime,
  name: string,
  confidentiality?: readonly string[],
): Promise<URI> => {
  const seed = runtime.edit();
  const cell = runtime.getCell(space, name, undefined, seed);
  const id = cell.getAsNormalizedFullLink().id as URI;
  writeSeedEnvelopeDoc(seed, space);
  seedStoredEnvelope(seed, { space, scope: "space", id, path: [] }, {
    value: { secret: "rosebud" },
    ...(confidentiality === undefined ? {} : {
      cfc: {
        version: 1,
        schemaHash: SEED_ENVELOPE_SCHEMA_HASH,
        labelMap: {
          version: 1,
          entries: [{
            path: ["secret"],
            label: { confidentiality: [...confidentiality] },
          }],
        },
      },
    }),
  });
  expect((await seed.commit()).ok).toBeDefined();
  return id;
};

/**
 * Seed a document whose stored metadata labels its ROOT, so every path on it
 * is one the schema write-policy requirement quantifies over. A raw write to
 * such a document records `missing schema write-policy input` — an UNTAGGED
 * reason, and so the retryable half of a mixed-reason refusal.
 */
const seedRootLabeledDoc = async (
  runtime: Runtime,
  name: string,
): Promise<URI> => {
  const seed = runtime.edit();
  const id = runtime.getCell(space, name, undefined, seed)
    .getAsNormalizedFullLink().id as URI;
  writeSeedEnvelopeDoc(seed, space);
  seedStoredEnvelope(seed, { space, scope: "space", id, path: [] }, {
    value: { note: "labeled" },
    cfc: {
      version: 1,
      schemaHash: SEED_ENVELOPE_SCHEMA_HASH,
      labelMap: {
        version: 1,
        entries: [{ path: [], label: { confidentiality: ["medical"] } }],
      },
    },
  });
  expect((await seed.commit()).ok).toBeDefined();
  return id;
};

describe("refusal-detail", () => {
  describe("describeRefusalInputs()", () => {
    it("returns one input per contributing read, carrying that read's atoms", () => {
      const { inputs } = describeRefusalInputs(["medical", "payroll"], [
        sourceOf("medical", "of:chart", ["value"], ["secret"]),
        sourceOf("payroll", "of:ledger", [], ["amount"]),
      ]);
      expect(inputs).toEqual([
        {
          read: addressOf("of:chart", ["value"]),
          labelPath: ["secret"],
          atoms: [MEDICAL],
        },
        {
          read: addressOf("of:ledger", []),
          labelPath: ["amount"],
          atoms: [renderCfcAtom("payroll")],
        },
      ]);
    });

    it("groups two offending atoms carried by one read into a single input", () => {
      const { inputs } = describeRefusalInputs(["medical", "payroll"], [
        sourceOf("medical", "of:chart", ["value"], ["secret"]),
        sourceOf("payroll", "of:chart", ["value"], ["secret"]),
      ]);
      expect(inputs.length).toBe(1);
      expect(inputs[0].atoms).toEqual([MEDICAL, renderCfcAtom("payroll")]);
    });

    it("returns separate inputs for two label paths inside one document", () => {
      const { inputs } = describeRefusalInputs(["medical"], [
        sourceOf("medical", "of:chart", [], ["secret"]),
        sourceOf("medical", "of:chart", [], ["notes"]),
      ]);
      expect(inputs.map((input) => input.labelPath)).toEqual([
        ["secret"],
        ["notes"],
      ]);
    });

    it("returns no input for an offending atom no source claims", () => {
      const { inputs } = describeRefusalInputs(["medical"], [
        sourceOf("payroll", "of:ledger", [], ["amount"]),
      ]);
      expect(inputs).toEqual([]);
    });

    it("names both reads of a clause whose properties two sources ordered differently", () => {
      // The identity is `deepEqual`, which is what `uniqueCfcAtoms` dedups the
      // consumed union by — so these are ONE clause, carried by two reads, and
      // the remedy is to drop both. Keyed on a rendering they would be two
      // clauses, only the first named, and `complete` would be a lie: dropping
      // the named read leaves the other read's identical clause behind.
      const { inputs, attribution } = describeRefusalInputs([{
        a: 1,
        b: 2,
      }], [
        sourceOf({ a: 1, b: 2 }, "of:chart", [], ["secret"]),
        sourceOf({ b: 2, a: 1 }, "of:ledger", [], ["amount"]),
      ]);
      expect(inputs.map((input) => input.read.id)).toEqual([
        "of:chart",
        "of:ledger",
      ]);
      expect(attribution).toBe("complete");
    });

    it("attributes no read to a signed-zero clause a source carries unsigned", () => {
      // CFC distinguishes `-0` from `0`; `JSON.stringify` renders both `0`. A
      // rendered key would name the innocent read as the one to drop.
      const { inputs, attribution } = describeRefusalInputs([-0], [
        sourceOf(0, "of:ledger", [], ["amount"]),
      ]);
      expect(inputs).toEqual([]);
      expect(attribution).toBe("none");
    });

    it("retains clause-first source order across many distinct clauses", () => {
      const sources = Array.from(
        { length: 80 },
        (_, index) =>
          sourceOf(
            { kind: "secret", number: index % 20 },
            `of:read-${index}`,
            [],
            ["field"],
          ),
      );
      const offending = [19, 0, 7, 100].map((number) => ({
        number,
        kind: "secret",
      }));
      const { inputs, attribution } = describeRefusalInputs(offending, sources);
      expect(inputs.map((input) => input.read.id)).toEqual(
        [19, 0, 7].flatMap((number) =>
          [0, 20, 40, 60].map((offset) => `of:read-${number + offset}`)
        ),
      );
      expect(inputs.map((input) => input.atoms)).toEqual(
        offending.slice(0, 3).flatMap((atom) =>
          Array.from({ length: 4 }, () => [renderCfcAtom(atom)])
        ),
      );
      expect(attribution).toBe("partial");
    });

    it("retains the first rendered clause order for one read with repeated offenders", () => {
      const clauses = Array.from(
        { length: 40 },
        (_, index) => `secret-${index}`,
      );
      const sources = clauses.map((atom) =>
        sourceOf(atom, "of:one-read", [], ["field"])
      );
      const first = [...clauses].reverse();
      const result = describeRefusalInputs([...first, ...clauses], sources);
      expect(result.inputs).toHaveLength(1);
      expect(result.inputs[0].atoms).toEqual(first.map(renderCfcAtom));
      expect(result.attribution).toBe("complete");
    });

    it("returns `none` when no source claims any offending clause", () => {
      expect(describeRefusalInputs(["medical"], []).attribution).toBe("none");
    });

    it("returns `complete` when a source claims every offending clause", () => {
      expect(
        describeRefusalInputs(["medical", "payroll"], [
          sourceOf("medical", "of:chart", [], ["secret"]),
          sourceOf("payroll", "of:ledger", [], ["amount"]),
        ]).attribution,
      ).toBe("complete");
    });

    it("returns `partial` when an offending clause is claimed by no source", () => {
      expect(
        describeRefusalInputs(["medical", "rewritten"], [
          sourceOf("medical", "of:chart", [], ["secret"]),
        ]).attribution,
      ).toBe("partial");
    });
  });

  describe("a pattern's refused egress", () => {
    let storageManager: ReturnType<typeof StorageManager.emulate>;
    let runtime: Runtime;
    let reported: ErrorWithContext[];
    let originalFetch: typeof globalThis.fetch;
    let fetchCalls: Array<{ url: string; init?: RequestInit }>;
    let llmRequests: number;

    beforeEach(() => {
      clearMockResponses();
      llmRequests = 0;
      setMockResponseGate(() => {
        llmRequests += 1;
        return Promise.resolve();
      });
      storageManager = StorageManager.emulate({ as: signer });
      reported = [];
      runtime = new Runtime({
        apiUrl: new URL(import.meta.url),
        storageManager,
        cfcFlowLabels: "persist",
        cfcSinkMaxConfidentiality: { fetchText: [], llm: [] },
        errorHandlers: [(error) => reported.push(error)],
      });
      setPatternEnvironment({
        apiUrl: new URL("http://mock-test-server.local"),
      });
      fetchCalls = [];
      originalFetch = globalThis.fetch;
      globalThis.fetch = ((
        input: string | URL | Request,
        init?: RequestInit,
      ) => {
        const url = typeof input === "string"
          ? input
          : input instanceof URL
          ? input.toString()
          : input.url;
        fetchCalls.push({ url, init });
        return Promise.resolve(
          new Response("hello", {
            status: 200,
            headers: { "Content-Type": "text/plain; charset=utf-8" },
          }),
        );
      }) as typeof globalThis.fetch;
    });

    afterEach(async () => {
      globalThis.fetch = originalFetch;
      setMockResponseGate(undefined);
      await runtime?.dispose();
      await storageManager?.close();
    });

    /** Run `fetchText` over the `secret` field of the named seeded document. */
    const runFetchTextOver = async (name: string): Promise<void> => {
      const { commonfabric } = createTrustedBuilder(runtime);
      const { pattern, byRef } = commonfabric;
      const fetchText = byRef("fetchText");
      const testPattern = pattern<{ url: string; token: string }>(
        ({ url, token }) =>
          fetchText({ url, options: { headers: { "x-token": token } } }),
      );
      const tx = runtime.edit();
      const secret = runtime.getCell(space, name, undefined, tx);
      const resultCell = runtime.getCell(space, `${name}-out`, undefined, tx);
      const result = runtime.run(
        tx,
        testPattern,
        {
          url: "http://mock-test-server.local/text",
          token: secret.key("secret"),
        } as unknown as { url: string; token: string },
        resultCell,
      );
      runtime.prepareTxForCommit(tx);
      await tx.commit();
      await runtime.idle();
      // The request (if any) fires from a post-commit effect and writes back
      // through its own transactions. `idle()` deliberately does not span that
      // async builtin work; `settled()` is the barrier that does.
      await result.pull();
      await runtime.settled();
    };

    /** Run `llm` over the `secret` field of the named seeded document. */
    const runLlmOver = async (name: string): Promise<void> => {
      const { commonfabric } = createTrustedBuilder(runtime);
      const { pattern, llm } = commonfabric;
      const testPattern = pattern<{ token: string }>(({ token }) =>
        llm({ messages: [{ role: "user", content: token }] })
      );
      const tx = runtime.edit();
      const secret = runtime.getCell(space, name, undefined, tx);
      const resultCell = runtime.getCell(space, `${name}-out`, undefined, tx);
      const result = runtime.run(
        tx,
        testPattern,
        { token: secret.key("secret") } as unknown as { token: string },
        resultCell,
      ) as Cell<unknown>;
      runtime.prepareTxForCommit(tx);
      await tx.commit();
      await runtime.idle();
      await result.pull();
      await runtime.settled();
    };

    const reportedRefusalDetail = (): CfcRefusalDetail => {
      const refusal = reported.find((error) =>
        error.name === "CfcCommitRefusalError"
      );
      expect(refusal).toBeDefined();
      expect(refusal!.name).toBe("CfcCommitRefusalError");
      const details = refusalsOf(refusal);
      expect(details.length).toBeGreaterThan(0);
      return details[0];
    };

    it("names the seeded document as the input behind a refused `fetchText` egress", async () => {
      const secretId = await seedSecret(runtime, "refusal-fetch-secret", [
        "medical",
      ]);
      await runFetchTextOver("refusal-fetch-secret");

      const detail = reportedRefusalDetail();
      expect(detail.gate).toBe("sink-ceiling");
      expect(detail.sink).toBe("fetchText");
      expect(detail.offendingAtoms).toContain(MEDICAL);
      // The assertion the whole channel exists for: the refusal names the
      // INPUT, so dropping that argument is a remedy rather than a guess.
      const input = detail.inputs.find((entry) => entry.read.id === secretId);
      expect(input).toBeDefined();
      expect(input!.atoms).toContain(MEDICAL);
      expect(detail.attribution).toBe("complete");
      // Nothing reached the network: the ceiling refused the staging commit,
      // so the post-commit effect never flushed.
      expect(fetchCalls).toEqual([]);
    });

    it("names the seeded document as the input behind a refused `llm` egress", async () => {
      const secretId = await seedSecret(runtime, "refusal-llm-secret", [
        "medical",
      ]);
      await runLlmOver("refusal-llm-secret");

      const detail = reportedRefusalDetail();
      expect(detail.gate).toBe("sink-ceiling");
      expect(detail.sink).toBe("llm");
      expect(detail.offendingAtoms).toContain(MEDICAL);
      const input = detail.inputs.find((entry) => entry.read.id === secretId);
      expect(input).toBeDefined();
      expect(input!.atoms).toContain(MEDICAL);
      expect(detail.attribution).toBe("complete");
      expect(llmRequests).toBe(0);
    });

    it("settles with no reported error and reaches the network over an unlabelled input", async () => {
      // The control that makes the two refusals above non-vacuous, and the
      // property a replan relies on: the same pattern over an input carrying
      // no confidentiality is not refused, and its request is sent.
      await seedSecret(runtime, "refusal-clean-secret");
      await runFetchTextOver("refusal-clean-secret");

      expect(reported.map((error) => error.name)).toEqual([]);
      expect(fetchCalls.map((call) => call.url)).toEqual([
        "http://mock-test-server.local/text",
      ]);
    });
  });

  describe("a refused writer-fit misfit", () => {
    for (
      const mode of [
        "disabled",
        "observe",
        "enforce-explicit",
        "enforce-strict",
      ] as const
    ) {
      it(`builds attribution only for rejected writes in \`${mode}\``, async () => {
        const storageManager = StorageManager.emulate({ as: signer });
        const runtime = new Runtime({
          apiUrl: new URL("https://example.com"),
          storageManager,
          cfcEnforcementMode: "disabled",
          cfcFlowLabels: "persist",
        });
        try {
          await seedSecret(runtime, "refusal-many-source", ["medical"]);
          runtime.resetCfcStats();
          const tx = runtime.edit();
          tx.setCfcEnforcementMode(mode);
          const secret = runtime.getCell(
            space,
            "refusal-many-source",
            undefined,
            tx,
          ).key("secret").get();
          for (let i = 0; i < 4; i++) {
            runtime.getCell(space, `refusal-many-target-${i}`, undefined, tx)
              .set({ copied: secret });
          }
          tx.prepareCfc();
          const result = await tx.commit();
          const stats = runtime.getCfcStats();
          if (mode === "enforce-strict") {
            expect(result.error?.name).toBe("CfcCommitRefusalError");
            expect(refusalsOf(result.error)).toHaveLength(4);
            for (const detail of refusalsOf(result.error)) {
              expect(detail.gate).toBe("writer-fit");
              expect(detail.attribution).toBe("complete");
              expect(detail.inputs.length).toBeGreaterThan(0);
            }
            expect(stats.refusalDetailsRecorded).toBe(4);
            expect(stats.consumedLabelWalks).toBe(1);
          } else {
            expect(result.error).toBeUndefined();
            expect(tx.getCfcState().refusalDetails).toEqual([]);
            const flags = tx.getCfcState().diagnostics.filter((diagnostic) =>
              diagnostic.includes("writer-fit(persist-and-flag)")
            );
            expect(flags).toHaveLength(4);
            expect(stats.refusalDetailsRecorded).toBe(0);
            expect(stats.consumedLabelWalks).toBe(0);
          }
        } finally {
          await runtime.dispose();
          await storageManager.close();
        }
      });
    }

    it("names the write target the derived label did not fit", async () => {
      const storageManager = StorageManager.emulate({ as: signer });
      const runtime = new Runtime({
        apiUrl: new URL("https://example.com"),
        storageManager,
        cfcFlowLabels: "persist",
      });
      try {
        const sourceId = await seedSecret(
          runtime,
          "refusal-writer-fit-source",
          ["medical"],
        );
        runtime.resetCfcStats();

        const tx = runtime.edit();
        // Strict is where the misfit REJECTS rather than persists-and-flags,
        // and a detail only rides out on a refusal.
        tx.setCfcEnforcementMode("enforce-strict");
        const source = runtime.getCell(
          space,
          "refusal-writer-fit-source",
          undefined,
          tx,
        );
        const secret = source.key("secret").get();
        expect(secret).toBe("rosebud");
        // The target declares no store policy, so its ceiling is residency
        // alone: a `medical`-tainted derived value cannot fit.
        const derived = runtime.getCell(
          space,
          "refusal-writer-fit-derived",
          undefined,
          tx,
        );
        derived.set({ copied: `${secret}!` });
        const derivedId = derived.getAsNormalizedFullLink().id;
        tx.prepareCfc();
        const result = await tx.commit();

        expect(result.error?.name).toBe("CfcCommitRefusalError");
        const detail = refusalsOf(result.error).find((entry) =>
          entry.gate === "writer-fit"
        );
        expect(detail).toBeDefined();
        expect(detail!.target?.id).toBe(derivedId);
        expect(detail!.offendingAtoms.length).toBeGreaterThan(0);
        expect(detail!.offendingAtoms).toContain(MEDICAL);
        expect(detail!.reason).toBe(
          `writer-fit confidentiality misfit for ${derivedId} at / ` +
            `(canWrite, §8.12.4): ${MEDICAL}`,
        );
        expect(result.error?.message).toContain(detail!.reason);
        expect(detail!.attribution).toBe("complete");
        expect(detail!.inputs).toContainEqual({
          read: { space, id: sourceId, scope: "space", path: ["secret"] },
          labelPath: ["secret"],
          atoms: [MEDICAL],
        });
        expect(runtime.getCfcStats().refusalDetailsRecorded).toBe(
          tx.getCfcState().refusalDetails.length,
        );
        expect(runtime.getCfcStats().refusalDetailsRecorded).toBeGreaterThan(0);
        expect(runtime.getCfcStats().consumedLabelWalks).toBe(1);
      } finally {
        await runtime.dispose();
        await storageManager.close();
      }
    });
  });

  describe("the `cfc.prepare-reject` marker", () => {
    let storageManager: ReturnType<typeof StorageManager.emulate>;
    let runtime: Runtime;
    let markers: PrepareRejectMarker[];

    beforeEach(() => {
      storageManager = StorageManager.emulate({ as: signer });
      runtime = new Runtime({
        apiUrl: new URL("https://example.com"),
        storageManager,
        cfcFlowLabels: "persist",
        cfcSinkMaxConfidentiality: { fetchText: [] },
      });
      markers = [];
      runtime.telemetry.addEventListener("telemetry", (event) => {
        const marker = (event as RuntimeTelemetryEvent).marker;
        if (marker.type === "cfc.prepare-reject") markers.push(marker);
      });
    });

    afterEach(async () => {
      await runtime?.dispose();
      await storageManager?.close();
    });

    /**
     * Read the seeded secret and stage a `fetchText` request from it, which
     * the empty ceiling refuses. `alsoWrite` adds a raw write to a second
     * labeled document, whose missing schema write-policy input is an
     * UNTAGGED reason — the refusal then mixes a verdict with a reason a
     * fresh attempt could resolve.
     */
    const refuseWithSink = async (
      name: string,
      alsoWrite?: URI,
    ): Promise<void> => {
      await seedSecret(runtime, name, ["medical"]);
      const tx = runtime.edit();
      const secret = runtime.getCell(space, name, undefined, tx);
      expect(secret.key("secret").getRaw() as string).toBe("rosebud");
      if (alsoWrite !== undefined) {
        tx.writeOrThrow(
          { space, scope: "space", id: alsoWrite, path: ["value", "slug"] },
          "late-slug",
        );
      }
      enqueueSinkRequestPostCommitEffect(
        tx,
        "fetchText",
        `fetchText:${name}`,
        createFrozenRequestSnapshot({ url: "https://example.com/exfil" }),
        "fetchText-start",
        () => {},
      );
      tx.prepareCfc();
      tx.abort();
    };

    it("submits a terminal marker carrying the refusal detail for a plain ceiling refusal", async () => {
      await refuseWithSink("marker-terminal-secret");

      expect(markers.length).toBe(1);
      expect(markers[0].terminal).toBe(true);
      expect(markers[0].reasons.join("\n")).toContain(
        "exceeds ceiling for fetchText",
      );
      const detail = markers[0].refusals.find((entry) =>
        entry.gate === "sink-ceiling"
      );
      expect(detail).toBeDefined();
      expect(detail!.sink).toBe("fetchText");
      expect(detail!.offendingAtoms).toContain(MEDICAL);
      expect(detail!.attribution).toBe("complete");
    });

    it("describes only the pass it ran, when one transaction prepares twice", async () => {
      // Diagnostics are append-only history on purpose; a detail is paired to
      // a reason THIS pass recorded. Without the per-pass clear, a second
      // prepare's refusal would carry the first pass's detail as well as its
      // own — the same refusal rendered twice, and, once a reason clears, one
      // the current verdict no longer holds.
      await seedSecret(runtime, "marker-repeated-secret", ["medical"]);
      const tx = runtime.edit();
      const secret = runtime.getCell(
        space,
        "marker-repeated-secret",
        undefined,
        tx,
      );
      expect(secret.key("secret").getRaw() as string).toBe("rosebud");
      enqueueSinkRequestPostCommitEffect(
        tx,
        "fetchText",
        "fetchText:marker-repeated",
        createFrozenRequestSnapshot({ url: "https://example.com/exfil" }),
        "fetchText-start",
        () => {},
      );
      tx.prepareCfc();
      tx.prepareCfc();
      tx.abort();

      expect(markers.length).toBe(2);
      for (const marker of markers) {
        expect(
          marker.refusals.filter((entry) => entry.gate === "sink-ceiling")
            .length,
        ).toBe(1);
      }
    });

    it("submits a non-terminal marker carrying the same detail when an untagged reason joins the verdict", async () => {
      // The gap the marker closes: this refusal never reaches the error
      // channel — the commit boundary downgrades a mixed-reason refusal to a
      // retryable abort — so the marker is its only trace.
      const otherId = await seedRootLabeledDoc(runtime, "marker-mixed-other");
      await refuseWithSink("marker-mixed-secret", otherId);

      expect(markers.length).toBe(1);
      expect(markers[0].terminal).toBe(false);
      expect(markers[0].reasons.join("\n")).toContain(
        "missing schema write-policy input",
      );
      const detail = markers[0].refusals.find((entry) =>
        entry.gate === "sink-ceiling"
      );
      expect(detail).toBeDefined();
      expect(detail!.offendingAtoms).toContain(MEDICAL);
    });
  });
});
