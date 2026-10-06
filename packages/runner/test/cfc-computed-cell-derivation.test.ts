import { afterEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import type { FabricValue } from "@commonfabric/data-model";
import { Identity } from "@commonfabric/identity";
import {
  SEED_ENVELOPE_SCHEMA_HASH,
  seedStoredEnvelope,
  writeSeedEnvelopeDoc,
} from "./cfc-seed-envelope.ts";
import { isLinkRef, linkRefPayload } from "@commonfabric/data-model/cell-rep";
import { StorageManager } from "../src/storage/cache.deno.ts";
import { Runtime } from "../src/runtime.ts";
import { createTrustedBuilder } from "./support/trusted-builder.ts";

const signer = await Identity.fromPassphrase("runner-cfc-computed-derivation");
const space = signer.did();

type StoredEntry = {
  path: string[];
  label: { confidentiality?: string[]; integrity?: unknown[] };
  origin?: string;
};

//
// Reactive derivation over labeled data at the strict posture
//
// A derivation's result lands in a computed cell: a document the runtime
// materializes under `computed:fid1:<hash>`, which no author declares a store
// policy on. The §8.12.4 writer-fit quantifies over the surfaces a schema
// could have declared a policy at, and that id class is not one of them, so
// the measurement skips it and a derivation over labeled data commits at
// every rung.
//
// What follows the value is the label. The cases below are what a derivation
// has to satisfy together: it runs, it runs again when its input changes, and
// the value it produced carries the taint it came from. A derived value that
// landed unlabeled would have escaped its label, which is worse than a
// refusal, so the last case reads the stamp off the computed document the
// result links to rather than reading the value back. The second is where a
// recompute is covered: it writes a computed document the first write left
// CFC metadata on, which is a different question from the first write's.
//
// `cfc-writer-fit.test.ts` holds the measurement's own cases, including the
// control that an ordinary document takes the same join and still misfits.
// The egress this exemption leaves to another gate is the host's: a tool
// answering a model measures what it is about to release, in
// `packages/cf-harness/src/tools/run-pattern.ts`.
//

describe("CFC derivation into a computed cell", () => {
  let storageManager: ReturnType<typeof StorageManager.emulate> | undefined;
  let runtime: Runtime | undefined;

  afterEach(async () => {
    await runtime?.dispose();
    await storageManager?.close();
    runtime = undefined;
    storageManager = undefined;
  });

  const seedLabeledDoc = async (
    rt: Runtime,
    cause: string,
    value: FabricValue,
    atom: string,
  ): Promise<string> => {
    const seed = rt.edit();
    const cell = rt.getCell(space, cause, undefined, seed);
    const id = cell.getAsNormalizedFullLink().id;
    writeSeedEnvelopeDoc(seed, space);
    seedStoredEnvelope(seed, {
      space,
      scope: "space",
      id,
      path: [],
    }, {
      value,
      cfc: {
        version: 1,
        schemaHash: SEED_ENVELOPE_SCHEMA_HASH,
        labelMap: {
          version: 1,
          entries: [{ path: [], label: { confidentiality: [atom] } }],
        },
      },
    });
    expect((await seed.commit().settled).ok).toBeDefined();
    return id;
  };

  const entriesOf = (id: string): StoredEntry[] => {
    const replica = storageManager!.open(space).replica as unknown as {
      getDocument(id: string): {
        cfc?: { labelMap?: { entries: StoredEntry[] } };
      } | undefined;
    };
    return replica.getDocument(id)?.cfc?.labelMap?.entries ?? [];
  };

  /**
   * The document id a result field's link points at, read through the
   * link-sigil accessors so the case does not depend on which cell
   * representation is in force.
   */
  const linkTargetId = (result: unknown, field: string): string => {
    const raw = (result as { getRaw(): Record<string, unknown> }).getRaw();
    const link = raw[field];
    if (!isLinkRef(link)) {
      throw new Error(`result field ${field} does not hold a link`);
    }
    return (linkRefPayload(link) as { id: string }).id;
  };

  const derivedConfidentiality = (id: string): string[] =>
    entriesOf(id)
      .filter((e) => e.origin === "derived")
      .flatMap((e) => e.label.confidentiality ?? []);

  const strictRuntime = () => {
    storageManager = StorageManager.emulate({ as: signer });
    runtime = new Runtime({
      apiUrl: new URL("https://example.com"),
      storageManager,
      cfcEnforcementMode: "enforce-strict",
      cfcFlowLabels: "persist",
    });
    return runtime;
  };

  /** Every CFC refusal the scheduler reports while a derivation runs. */
  const collectRefusals = (rt: Runtime): string[] => {
    const refusals: string[] = [];
    rt.scheduler.onError((error: Error) => {
      if (error.message.includes("CFC enforcement rejected commit")) {
        refusals.push(error.message);
      }
    });
    return refusals;
  };

  it("commits a lift that reads a labeled document", async () => {
    // The smallest reactive derivation there is: one lift, one labeled input,
    // one derived output. Nothing here is unusual — no cross-space link, no
    // policy record, no declassification — so a posture that refused this
    // would refuse ordinary reactive computation over labeled data.
    const rt = strictRuntime();
    await seedLabeledDoc(rt, "derivation-input", { n: 21 }, "alice-secret");
    const refusals = collectRefusals(rt);

    const { commonfabric } = createTrustedBuilder(rt);
    const { pattern, lift } = commonfabric as unknown as {
      pattern: typeof commonfabric.pattern;
      lift: (fn: (value: any) => unknown) => (value: unknown) => unknown;
    };
    const double = lift((value: { n: number }) => ({ doubled: value.n * 2 }));

    const tx = rt.edit();
    const input = rt.getCell(space, "derivation-input", undefined, tx);
    const resultCell = rt.getCell(space, "derivation-result", undefined, tx);
    const doubling = pattern<{ value: unknown }>(({ value }) => ({
      out: double(value),
    }));
    const result = rt.run(tx, doubling, { value: input }, resultCell);

    rt.prepareTxForCommit(tx);
    expect((await tx.commit().settled).error).toBeUndefined();
    await result.pull();
    await rt.idle();

    // A computed cell is not a surface a schema could declare a policy at,
    // so the derivation's own transaction has nothing measured against it.
    expect(refusals).toEqual([]);
    expect(
      (result.get() as { out?: { doubled?: number } }).out?.doubled,
    ).toBe(42);
  });

  it("commits the same lift again when its input changes", async () => {
    // The first derivation leaves a stamp on the computed document, so the
    // second one writes a document that already carries CFC metadata. That is
    // a different gate's question from the first write's, and a derivation
    // that ran once has to keep running.
    const rt = strictRuntime();
    await seedLabeledDoc(rt, "recompute-input", { n: 21 }, "alice-secret");
    const refusals = collectRefusals(rt);

    const { commonfabric } = createTrustedBuilder(rt);
    const { pattern, lift } = commonfabric as unknown as {
      pattern: typeof commonfabric.pattern;
      lift: (fn: (value: any) => unknown) => (value: unknown) => unknown;
    };
    const double = lift((value: { n: number }) => ({ doubled: value.n * 2 }));

    const tx = rt.edit();
    const input = rt.getCell(space, "recompute-input", undefined, tx);
    const resultCell = rt.getCell(space, "recompute-result", undefined, tx);
    const doubling = pattern<{ value: unknown }>(({ value }) => ({
      out: double(value),
    }));
    const result = rt.run(tx, doubling, { value: input }, resultCell);

    rt.prepareTxForCommit(tx);
    expect((await tx.commit().settled).error).toBeUndefined();
    await result.pull();
    await rt.idle();
    expect((result.get() as { out?: { doubled?: number } }).out?.doubled)
      .toBe(42);

    const update = rt.edit();
    input.withTx(update).set({ n: 50 });
    rt.prepareTxForCommit(update);
    expect((await update.commit().settled).error).toBeUndefined();
    await result.pull();
    await rt.idle();

    expect(refusals).toEqual([]);
    expect((result.get() as { out?: { doubled?: number } }).out?.doubled)
      .toBe(100);
    expect(derivedConfidentiality(linkTargetId(result, "out")))
      .toContain("alice-secret");
  });

  it("carries the input's taint onto the value it derived", async () => {
    // The exemption is only sound while the taint survives it, so this is
    // checked by what the derived document ends up carrying rather than by
    // the derivation running. A derived value that lands unlabeled has
    // escaped the label.
    const rt = strictRuntime();
    await seedLabeledDoc(rt, "taint-input", { n: 3 }, "bob-secret");
    const refusals = collectRefusals(rt);

    const { commonfabric } = createTrustedBuilder(rt);
    const { pattern, lift } = commonfabric as unknown as {
      pattern: typeof commonfabric.pattern;
      lift: (fn: (value: any) => unknown) => (value: unknown) => unknown;
    };
    const describeIt = lift((value: { n: number }) => ({
      text: `n is ${value.n}`,
    }));

    const tx = rt.edit();
    const input = rt.getCell(space, "taint-input", undefined, tx);
    const resultCell = rt.getCell(space, "taint-result", undefined, tx);
    const describing = pattern<{ value: unknown }>(({ value }) => ({
      out: describeIt(value),
    }));
    const result = rt.run(tx, describing, { value: input }, resultCell);

    rt.prepareTxForCommit(tx);
    expect((await tx.commit().settled).error).toBeUndefined();
    await result.pull();
    await rt.idle();

    expect(refusals).toEqual([]);
    expect((result.get() as { out?: { text?: string } }).out?.text)
      .toBe("n is 3");

    // The result document holds a link; the derived value itself lives in the
    // computed document that link names.
    const computedId = linkTargetId(result, "out");
    expect(computedId.startsWith("computed:")).toBe(true);
    expect(derivedConfidentiality(computedId)).toContain("bob-secret");
  });
});
