import { afterEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import type { FabricValue } from "@commonfabric/data-model";
import { Identity } from "@commonfabric/identity";
import {
  SEED_ENVELOPE_SCHEMA_HASH,
  seedStoredEnvelope,
  writeSeedEnvelopeDoc,
} from "./cfc-seed-envelope.ts";
import { StorageManager } from "../src/storage/cache.deno.ts";
import { Runtime } from "../src/runtime.ts";
import { createTrustedBuilder } from "./support/trusted-builder.ts";
import { type FactoryInput } from "../src/builder/types.ts";

const signer = await Identity.fromPassphrase("runner-cfc-flow-pointwise");
const space = signer.did();

type StoredEntry = {
  path: string[];
  label: { confidentiality?: string[]; integrity?: unknown[] };
  origin?: string;
  observes?: string;
};

describe("CFC flow labels: pointwise structure (phase B)", () => {
  // S16 phase B: pointwise label precision is a structural fact of the
  // per-element transaction decomposition (design D4), not a trusted claim.
  // These tests pin the split: element results carry only their element's
  // taint; the result container carries only structure-level taint — and for
  // filter, the membership decision's taint (§8.5.6.1) arrives via the
  // predicate outputs the coordinator consumes.

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
    return replica!.getDocument(id)?.cfc?.labelMap?.entries ?? [];
  };

  const derivedConfidentiality = (id: string): string[] =>
    entriesOf(id)
      .filter((e) => e.origin === "derived")
      .flatMap((e) => e.label.confidentiality ?? []);

  // confidentiality of the container's STRUCTURE label (origin structure at the
  // container root) — the membership/order taint (§8.5.6.1).
  const structureConfidentiality = (id: string): string[] =>
    entriesOf(id)
      .filter((e) => e.origin === "structure" && e.path.length === 0)
      .flatMap((e) => e.label.confidentiality ?? []);

  it("map: incrementally added elements get pointwise derived labels", async () => {
    // Element ops run in their own transactions reading only their element,
    // so per-element precision is structural — for elements that arrive in
    // separate reconciles. A batch first-instantiation evaluates all new
    // element ops inline in ONE pattern-run transaction, whose J is then the
    // join of every new element (coarse but sound; it refines as elements
    // are touched individually). This test exercises the incremental path:
    // el0 instantiates first, el1 arrives later, and each element's result
    // carries exactly its own taint.

    storageManager = StorageManager.emulate({ as: signer });
    runtime = new Runtime({
      apiUrl: new URL("https://example.com"),
      storageManager,
      // At this rung the writer-fit check flags a tainted write to a store
      // that declares no ceiling and lets it land. Each `probe` call
      // writes into a fresh document that declares none, and `conf0` and
      // `conf1` read back what those writes persisted.
      cfcEnforcementMode: "enforce-explicit",
      // Persisting the derived join is what puts those entries in the probe
      // documents.
      cfcFlowLabels: "persist",
    });

    await seedLabeledDoc(runtime, "pointwise-el-0", { n: 1 }, "alice-secret");
    await seedLabeledDoc(runtime, "pointwise-el-1", { n: 2 }, "bob-secret");

    const { commonfabric } = createTrustedBuilder(runtime);
    const { pattern, lift } = commonfabric as unknown as {
      pattern: typeof commonfabric.pattern;
      lift: (fn: (value: any) => unknown) => (value: unknown) => unknown;
    };
    const double = lift((value: { n: number }) => ({ doubled: value.n * 2 }));
    let mappedRef: any;

    const setup = runtime.edit();
    const el0 = runtime.getCell(space, "pointwise-el-0", undefined, setup);
    const listCell = runtime.getCell(
      space,
      "pointwise-list",
      {
        type: "array",
        items: { asCell: ["cell"] },
      },
      setup,
    );
    listCell.set([el0]);
    setup.prepareCfc();
    expect((await setup.commit().settled).ok).toBeDefined();

    const collectionPattern = pattern<{ values: unknown[] }>(({ values }) => {
      mappedRef = (values as any).mapWithPattern(
        pattern(({ element }: FactoryInput<any>) => double(element)),
        {},
      );
      return { mapped: mappedRef };
    });

    const tx = runtime.edit();
    const valuesIn = runtime.getCell(space, "pointwise-list", undefined, tx);
    const resultCell = runtime.getCell(
      space,
      "pointwise-map-result",
      undefined,
      tx,
    );
    const result = runtime.run(
      tx,
      collectionPattern,
      { values: valuesIn },
      resultCell,
    );
    tx.prepareCfc();
    expect((await tx.commit().settled).ok).toBeDefined();
    await result.pull();
    await runtime.idle();

    // Second element arrives in its own reconcile: the update transaction
    // only shuffles links (no content reads), and el1's op instantiates in
    // a transaction that never read el0.
    const grow = runtime.edit();
    const el0Again = runtime.getCell(space, "pointwise-el-0", undefined, grow);
    const el1 = runtime.getCell(space, "pointwise-el-1", undefined, grow);
    runtime.getCell(space, "pointwise-list", {
      type: "array",
      items: { asCell: ["cell"] },
    }, grow).set([el0Again, el1]);
    grow.prepareCfc();
    expect((await grow.commit().settled).ok).toBeDefined();
    await result.pull();
    await runtime.idle();

    const mapped = (result.key("mapped") as any).get() as Array<
      { doubled: number }
    >;
    expect(mapped.map((m) => m?.doubled)).toEqual([2, 4]);

    // Reader-visible pointwise check: a consumer of mapped[i] picks up
    // exactly element i's taint. (Asserting on specific internal docs is
    // brittle — content lands in different docs on the inline-first-run vs
    // steady-state paths; what matters is what a reader's derivation
    // joins.) Three parts of the blind-passing split keep the coordinator's
    // scaffolding from smearing one element's taint onto the other:
    // link-covered writes aren't stamped, so the per-slot link labels the
    // link write mints from each source's own label are the pointwise
    // answer; pure-link-structure writes get exact-path `structure` stamps
    // that slot reads below them never join; and the `*`-path membership
    // templates beside those stamps are not consumed by the coordinator's
    // own scaffolding reads, which carry `machineryRead`. This test also
    // pins that the batch first-run's coarse J landing on the container as
    // shape taint does NOT leak back into later per-element results.
    const probe = async (index: number, cause: string): Promise<string[]> => {
      const ptx = runtime!.edit();
      const value = (result.key("mapped") as any).key(index).withTx(ptx)
        .get() as { doubled: number };
      const out = runtime!.getCell(space, cause, undefined, ptx);
      out.set({ copied: value.doubled });
      ptx.prepareCfc();
      expect((await ptx.commit().settled).ok).toBeDefined();
      return derivedConfidentiality(out.getAsNormalizedFullLink().id);
    };

    const conf0 = await probe(0, "pointwise-probe-0");
    const conf1 = await probe(1, "pointwise-probe-1");
    expect(conf0).toContainEqual("alice-secret");
    expect(conf0).not.toContainEqual("bob-secret");
    expect(conf1).toContainEqual("bob-secret");
    expect(conf1).not.toContainEqual("alice-secret");
  });

  //
  // Membership taint (§8.5.6.1)
  //
  // §8.5.6.1 membership taint: which elements survive a filter is decided by
  // the predicate outputs, and those are values the coordinator reads — so the
  // filtered container's derived component must join the predicate taint of
  // every element it considered. (No flow-precision claims needed: the
  // membership channel rides ordinary value reads.)
  //

  it("filter: membership structure carries the predicate outputs' taint", async () => {
    storageManager = StorageManager.emulate({ as: signer });
    runtime = new Runtime({
      apiUrl: new URL("https://example.com"),
      storageManager,
      // At this rung the writer-fit check flags a tainted write to a store
      // that declares no ceiling and lets it land. The probe writes
      // into a document that declares none, and `probeConf` reads back what
      // that write persisted.
      cfcEnforcementMode: "enforce-explicit",
      // Persisting the derived join is what puts that entry in the probe
      // document.
      cfcFlowLabels: "persist",
    });

    await seedLabeledDoc(runtime, "memb-el-0", { n: 1 }, "alice-secret");
    await seedLabeledDoc(runtime, "memb-el-1", { n: 2 }, "bob-secret");

    const { commonfabric } = createTrustedBuilder(runtime);
    const { pattern, lift } = commonfabric as unknown as {
      pattern: typeof commonfabric.pattern;
      lift: (fn: (value: any) => unknown) => (value: unknown) => unknown;
    };
    const isPositive = lift((value: { n: number }) => value.n > 0);
    let filteredRef: any;

    const setup = runtime.edit();
    const el0 = runtime.getCell(space, "memb-el-0", undefined, setup);
    const el1 = runtime.getCell(space, "memb-el-1", undefined, setup);
    const listCell = runtime.getCell(
      space,
      "memb-list",
      {
        type: "array",
        items: { asCell: ["cell"] },
      },
      setup,
    );
    listCell.set([el0, el1]);
    setup.prepareCfc();
    expect((await setup.commit().settled).ok).toBeDefined();

    const collectionPattern = pattern<{ values: unknown[] }>(({ values }) => {
      filteredRef = (values as any).filterWithPattern(
        pattern(({ element }: FactoryInput<any>) => isPositive(element)),
        {},
      );
      return { kept: filteredRef };
    });

    const tx = runtime.edit();
    const valuesIn = runtime.getCell(space, "memb-list", undefined, tx);
    const resultCell = runtime.getCell(
      space,
      "memb-filter-result",
      undefined,
      tx,
    );
    const result = runtime.run(
      tx,
      collectionPattern,
      { values: valuesIn },
      resultCell,
    );
    tx.prepareCfc();
    expect((await tx.commit().settled).ok).toBeDefined();
    await result.pull();
    await runtime.idle();

    const kept = (result.key("kept") as any).get() as Array<{ n: number }>;
    expect(kept.length).toBe(2);

    // A consumer of the membership structure (the array shape itself, not
    // any element's content) picks up the predicate taint of every element
    // the filter considered.
    const ptx = runtime.edit();
    const keptLength = ((result.key("kept") as any).withTx(ptx)
      .get() as Array<unknown>).length;
    const out = runtime.getCell(space, "memb-probe", undefined, ptx);
    out.set({ count: keptLength });
    ptx.prepareCfc();
    expect((await ptx.commit().settled).ok).toBeDefined();
    const probeConf = derivedConfidentiality(
      out.getAsNormalizedFullLink().id,
    );
    expect(probeConf).toContainEqual("alice-secret");
    expect(probeConf).toContainEqual("bob-secret");
  });

  it("filter: shape-only reader (no dereference) picks up membership taint", async () => {
    // The membership channel must not require dereferencing (codex review on
    // #4022): a reader that observes only the container's shape — length via
    // an items-as-cell schema, never reading any element's content — still
    // learns which elements survived the predicate. The container write is
    // pure link structure, but its shape is secret-dependent, so the
    // membership taint has to ride the container itself, not just the
    // element contents.

    storageManager = StorageManager.emulate({ as: signer });
    runtime = new Runtime({
      apiUrl: new URL("https://example.com"),
      storageManager,
      // At this rung the writer-fit check flags a tainted write to a store
      // that declares no ceiling and lets it land. The probe writes
      // into a document that declares none, and `probeConf` reads back what
      // that write persisted.
      cfcEnforcementMode: "enforce-explicit",
      // Persisting the derived join is what puts that entry in the probe
      // document.
      cfcFlowLabels: "persist",
    });

    await seedLabeledDoc(runtime, "shape-el-0", { n: 1 }, "alice-secret");
    await seedLabeledDoc(runtime, "shape-el-1", { n: -2 }, "bob-secret");

    const { commonfabric } = createTrustedBuilder(runtime);
    const { pattern, lift } = commonfabric as unknown as {
      pattern: typeof commonfabric.pattern;
      lift: (fn: (value: any) => unknown) => (value: unknown) => unknown;
    };
    const isPositive = lift((value: { n: number }) => value.n > 0);
    let filteredRef: any;

    const setup = runtime.edit();
    const el0 = runtime.getCell(space, "shape-el-0", undefined, setup);
    const el1 = runtime.getCell(space, "shape-el-1", undefined, setup);
    const listCell = runtime.getCell(
      space,
      "shape-list",
      {
        type: "array",
        items: { asCell: ["cell"] },
      },
      setup,
    );
    listCell.set([el0, el1]);
    setup.prepareCfc();
    expect((await setup.commit().settled).ok).toBeDefined();

    const collectionPattern = pattern<{ values: unknown[] }>(({ values }) => {
      filteredRef = (values as any).filterWithPattern(
        pattern(({ element }: FactoryInput<any>) => isPositive(element)),
        {},
      );
      return { kept: filteredRef };
    });

    const tx = runtime.edit();
    const valuesIn = runtime.getCell(space, "shape-list", undefined, tx);
    const resultCell = runtime.getCell(
      space,
      "shape-filter-result",
      undefined,
      tx,
    );
    const result = runtime.run(
      tx,
      collectionPattern,
      { values: valuesIn },
      resultCell,
    );
    tx.prepareCfc();
    expect((await tx.commit().settled).ok).toBeDefined();
    await result.pull();
    await runtime.idle();

    // Elements stay cells under this schema: the probe reads the array's
    // shape (membership/length) without a single element content read.
    const ptx = runtime.edit();
    const keptCells = (result.key("kept") as any)
      .asSchema({ type: "array", items: { asCell: ["cell"] } })
      .withTx(ptx)
      .get() as unknown[];
    const out = runtime.getCell(space, "shape-probe", undefined, ptx);
    out.set({ count: keptCells.length });
    ptx.prepareCfc();
    expect((await ptx.commit().settled).ok).toBeDefined();
    const probeConf = derivedConfidentiality(
      out.getAsNormalizedFullLink().id,
    );
    expect(probeConf).toContainEqual("alice-secret");
    expect(probeConf).toContainEqual("bob-secret");
  });

  it("filter: empty result still carries membership taint on its shape", async () => {
    // The empty-container limit of the membership channel: when the
    // predicate drops EVERY element the write is `[]` — no slot link
    // entries exist at all, so the structure stamp is the only possible
    // carrier and "nothing survived" must still be as confidential as the
    // values that decided it.

    storageManager = StorageManager.emulate({ as: signer });
    runtime = new Runtime({
      apiUrl: new URL("https://example.com"),
      storageManager,
      // At this rung the writer-fit check flags a tainted write to a store
      // that declares no ceiling and lets it land. The probe writes
      // into a document that declares none, and `probeConf` reads back what
      // that write persisted.
      cfcEnforcementMode: "enforce-explicit",
      // Persisting the derived join is what puts that entry in the probe
      // document.
      cfcFlowLabels: "persist",
    });

    await seedLabeledDoc(runtime, "empty-el-0", { n: -1 }, "alice-secret");
    await seedLabeledDoc(runtime, "empty-el-1", { n: -2 }, "bob-secret");

    const { commonfabric } = createTrustedBuilder(runtime);
    const { pattern, lift } = commonfabric as unknown as {
      pattern: typeof commonfabric.pattern;
      lift: (fn: (value: any) => unknown) => (value: unknown) => unknown;
    };
    const isPositive = lift((value: { n: number }) => value.n > 0);
    let filteredRef: any;

    const setup = runtime.edit();
    const el0 = runtime.getCell(space, "empty-el-0", undefined, setup);
    const el1 = runtime.getCell(space, "empty-el-1", undefined, setup);
    const listCell = runtime.getCell(
      space,
      "empty-list",
      {
        type: "array",
        items: { asCell: ["cell"] },
      },
      setup,
    );
    listCell.set([el0, el1]);
    setup.prepareCfc();
    expect((await setup.commit().settled).ok).toBeDefined();

    const collectionPattern = pattern<{ values: unknown[] }>(({ values }) => {
      filteredRef = (values as any).filterWithPattern(
        pattern(({ element }: FactoryInput<any>) => isPositive(element)),
        {},
      );
      return { kept: filteredRef };
    });

    const tx = runtime.edit();
    const valuesIn = runtime.getCell(space, "empty-list", undefined, tx);
    const resultCell = runtime.getCell(
      space,
      "empty-filter-result",
      undefined,
      tx,
    );
    const result = runtime.run(
      tx,
      collectionPattern,
      { values: valuesIn },
      resultCell,
    );
    tx.prepareCfc();
    expect((await tx.commit().settled).ok).toBeDefined();
    await result.pull();
    await runtime.idle();

    const ptx = runtime.edit();
    const keptCells = (result.key("kept") as any)
      .asSchema({ type: "array", items: { asCell: ["cell"] } })
      .withTx(ptx)
      .get() as unknown[];
    expect(keptCells.length).toBe(0);
    const out = runtime.getCell(space, "empty-probe", undefined, ptx);
    out.set({ count: keptCells.length });
    ptx.prepareCfc();
    expect((await ptx.commit().settled).ok).toBeDefined();
    const probeConf = derivedConfidentiality(
      out.getAsNormalizedFullLink().id,
    );
    expect(probeConf).toContainEqual("alice-secret");
    expect(probeConf).toContainEqual("bob-secret");
  });

  const resolvedContainerId = (keptCell: any): string => {
    const rtx = runtime!.edit();
    const id =
      keptCell.withTx(rtx).resolveAsCell().getAsNormalizedFullLink().id;
    rtx.prepareCfc();
    rtx.commit();
    return id;
  };

  it("filter: index-only predicate keeps member content out of the structure label", async () => {
    // The dual of membership taint: when the predicate decides membership
    // WITHOUT reading element content (here: by index), the result container's
    // structure must carry NO member content. This is the over-taint the
    // input-read identity-only materialization removes — the old asCell
    // `.get()` on the input list dereferenced every element into the
    // coordinator's J (§8.5.6.1 keeps member confidentiality separate from
    // structural).

    storageManager = StorageManager.emulate({ as: signer });
    runtime = new Runtime({
      apiUrl: new URL("https://example.com"),
      storageManager,
      // Persisting the derived join is what puts the container's structure
      // entry in the document, and `sc` reads that entry back.
      cfcFlowLabels: "persist",
    });

    await seedLabeledDoc(runtime, "ix-el-0", { n: 1 }, "alice-secret");
    await seedLabeledDoc(runtime, "ix-el-1", { n: 2 }, "bob-secret");

    const { commonfabric } = createTrustedBuilder(runtime);
    const { pattern, lift } = commonfabric as unknown as {
      pattern: typeof commonfabric.pattern;
      lift: (fn: (value: any) => unknown) => (value: unknown) => unknown;
    };
    const keepFirst = lift((i: number) => i < 1);
    let filteredRef: any;

    const setup = runtime.edit();
    const el0 = runtime.getCell(space, "ix-el-0", undefined, setup);
    const el1 = runtime.getCell(space, "ix-el-1", undefined, setup);
    const listCell = runtime.getCell(
      space,
      "ix-list",
      { type: "array", items: { asCell: ["cell"] } },
      setup,
    );
    listCell.set([el0, el1]);
    setup.prepareCfc();
    expect((await setup.commit().settled).ok).toBeDefined();

    const collectionPattern = pattern<{ values: unknown[] }>(({ values }) => {
      filteredRef = (values as any).filterWithPattern(
        // reads only `index`, never element content
        pattern(({ index }: FactoryInput<any>) => keepFirst(index)),
        {},
      );
      return { kept: filteredRef };
    });

    const tx = runtime.edit();
    const valuesIn = runtime.getCell(space, "ix-list", undefined, tx);
    const resultCell = runtime.getCell(
      space,
      "ix-filter-result",
      undefined,
      tx,
    );
    const result = runtime.run(
      tx,
      collectionPattern,
      { values: valuesIn },
      resultCell,
    );
    tx.prepareCfc();
    expect((await tx.commit().settled).ok).toBeDefined();
    await result.pull();
    await runtime.idle();

    const containerId = resolvedContainerId(result.key("kept"));
    // The kept element's own entry carries alice-secret, so the structure
    // label below is read from a container that holds a label map.
    expect(
      entriesOf(containerId).flatMap((e) => e.label.confidentiality ?? []),
    ).toContainEqual("alice-secret");
    const sc = structureConfidentiality(containerId);
    expect(sc).not.toContainEqual("alice-secret");
    expect(sc).not.toContainEqual("bob-secret");
  });

  it("filter: structure label re-stamps from J when the list grows", async () => {
    // The membership taint must RE-STAMP (replace, not duplicate or go stale)
    // when the list changes across reconciles: the structure label is
    // re-derived from each reconcile's J, even though the container's root
    // value is not rewritten (only a slot is appended). Without the re-stamp
    // the late-arriving member's taint would never reach the container shape.

    storageManager = StorageManager.emulate({ as: signer });
    runtime = new Runtime({
      apiUrl: new URL("https://example.com"),
      storageManager,
      // Persisting the derived join is what puts the container's structure
      // entry in the document. `before`, `after` and `membershipEntries`
      // read that entry back.
      cfcFlowLabels: "persist",
    });

    await seedLabeledDoc(runtime, "grow-el-0", { n: 1 }, "alice-secret");
    await seedLabeledDoc(runtime, "grow-el-1", { n: 2 }, "bob-secret");
    await seedLabeledDoc(runtime, "grow-el-2", { n: 3 }, "carol-secret");

    const { commonfabric } = createTrustedBuilder(runtime);
    const { pattern, lift } = commonfabric as unknown as {
      pattern: typeof commonfabric.pattern;
      lift: (fn: (value: any) => unknown) => (value: unknown) => unknown;
    };
    const isPositive = lift((value: { n: number }) => value.n > 0);
    let filteredRef: any;

    const setup = runtime.edit();
    const el0 = runtime.getCell(space, "grow-el-0", undefined, setup);
    const el1 = runtime.getCell(space, "grow-el-1", undefined, setup);
    const el2 = runtime.getCell(space, "grow-el-2", undefined, setup);
    const listCell = runtime.getCell(
      space,
      "grow-list",
      { type: "array", items: { asCell: ["cell"] } },
      setup,
    );
    listCell.set([el0, el1]);
    setup.prepareCfc();
    expect((await setup.commit().settled).ok).toBeDefined();

    const collectionPattern = pattern<{ values: unknown[] }>(({ values }) => {
      filteredRef = (values as any).filterWithPattern(
        pattern(({ element }: FactoryInput<any>) => isPositive(element)),
        {},
      );
      return { kept: filteredRef };
    });

    const tx = runtime.edit();
    const valuesIn = runtime.getCell(space, "grow-list", undefined, tx);
    const resultCell = runtime.getCell(space, "grow-result", undefined, tx);
    const result = runtime.run(
      tx,
      collectionPattern,
      { values: valuesIn },
      resultCell,
    );
    tx.prepareCfc();
    expect((await tx.commit().settled).ok).toBeDefined();
    await result.pull();
    await runtime.idle();

    const containerId = resolvedContainerId(result.key("kept"));
    const before = structureConfidentiality(containerId);
    expect(before).toContainEqual("alice-secret");
    expect(before).toContainEqual("bob-secret");

    // Grow the list: a re-reconcile re-stamps the container structure from the
    // new J (now including carol), replacing the prior structure entry rather
    // than leaving it stale or duplicating it.
    const gtx = runtime.edit();
    const lc = runtime.getCell(
      space,
      "grow-list",
      { type: "array", items: { asCell: ["cell"] } },
      gtx,
    );
    lc.set([el0, el1, el2]);
    gtx.prepareCfc();
    expect((await gtx.commit().settled).ok).toBeDefined();
    await result.pull();
    await runtime.idle();

    const after = structureConfidentiality(containerId);
    expect(after).toContainEqual("alice-secret");
    expect(after).toContainEqual("bob-secret");
    expect(after).toContainEqual("carol-secret");
    // Re-stamped, not duplicated: exactly one MEMBERSHIP (enumerate) entry
    // at the root. The frozen existence entry (observes:"shape", #4546)
    // coexists beside it and is not touched by the re-stamp.
    const membershipEntries = entriesOf(containerId).filter(
      (e) =>
        e.origin === "structure" && e.path.length === 0 &&
        e.observes === "enumerate",
    );
    expect(membershipEntries.length).toBe(1);
  });

  it("flatMap: result structure carries the op outputs' taint", async () => {
    // flatMap gets the same structural-taint treatment as filter: the result
    // container's structure carries the op outputs' taint
    // (membership/multiplicity depend on every element the op considered), not
    // via the input deref.

    storageManager = StorageManager.emulate({ as: signer });
    runtime = new Runtime({
      apiUrl: new URL("https://example.com"),
      storageManager,
      // Persisting the derived join is what puts the container's structure
      // entry in the document, and `sc` reads that entry back.
      cfcFlowLabels: "persist",
    });

    await seedLabeledDoc(runtime, "fm-el-0", { n: 1 }, "alice-secret");
    await seedLabeledDoc(runtime, "fm-el-1", { n: 2 }, "bob-secret");

    const { commonfabric } = createTrustedBuilder(runtime);
    const { pattern, lift } = commonfabric as unknown as {
      pattern: typeof commonfabric.pattern;
      lift: (fn: (value: any) => unknown) => (value: unknown) => unknown;
    };
    // op reads element content and emits a one-element segment
    const toSegment = lift((value: { n: number }) => [value.n]);
    let flattenedRef: any;

    const setup = runtime.edit();
    const el0 = runtime.getCell(space, "fm-el-0", undefined, setup);
    const el1 = runtime.getCell(space, "fm-el-1", undefined, setup);
    const listCell = runtime.getCell(
      space,
      "fm-list",
      { type: "array", items: { asCell: ["cell"] } },
      setup,
    );
    listCell.set([el0, el1]);
    setup.prepareCfc();
    expect((await setup.commit().settled).ok).toBeDefined();

    const collectionPattern = pattern<{ values: unknown[] }>(({ values }) => {
      flattenedRef = (values as any).flatMapWithPattern(
        pattern(({ element }: FactoryInput<any>) => toSegment(element)),
        {},
      );
      return { flattened: flattenedRef };
    });

    const tx = runtime.edit();
    const valuesIn = runtime.getCell(space, "fm-list", undefined, tx);
    const resultCell = runtime.getCell(space, "fm-result", undefined, tx);
    const result = runtime.run(
      tx,
      collectionPattern,
      { values: valuesIn },
      resultCell,
    );
    tx.prepareCfc();
    expect((await tx.commit().settled).ok).toBeDefined();
    await result.pull();
    await runtime.idle();

    const sc = structureConfidentiality(
      resolvedContainerId(result.key("flattened")),
    );
    expect(sc).toContainEqual("alice-secret");
    expect(sc).toContainEqual("bob-secret");
  });

  it("filter: membership replaces from criteria on a no-write re-stamp; frozen existence keeps the creation join", async () => {
    // Replace-from-criteria, the narrowing direction (§8.12.8-normative per
    // #4546): when the selection criteria change on a reconcile with NO value
    // write (result stays []), the membership (enumerate) entry is re-derived
    // from the new criteria alone — the departed candidate's atom leaves. The
    // frozen existence entry (observes "shape") keeps the creation join,
    // untouched by the re-stamp. This is the coordinator-level pin of the
    // no-write path; #4546's A3 test covers the persist layer.

    storageManager = StorageManager.emulate({ as: signer });
    runtime = new Runtime({
      apiUrl: new URL("https://example.com"),
      storageManager,
      // Persisting the derived join is what puts the container's membership
      // and existence entries in the document. The assertions below read
      // both back.
      cfcFlowLabels: "persist",
    });

    await seedLabeledDoc(runtime, "rp-el-0", { n: 1 }, "dave-secret");
    await seedLabeledDoc(runtime, "rp-el-1", { n: 2 }, "erin-secret");

    const { commonfabric } = createTrustedBuilder(runtime);
    const { pattern, lift } = commonfabric as unknown as {
      pattern: typeof commonfabric.pattern;
      lift: (fn: (value: { n: number }) => unknown) => (
        value: FabricValue,
      ) => unknown;
    };
    // Reads element content, drops everything: the result stays [] across
    // membership changes, so the re-stamp rides the declared-container path
    // (no container value write to piggyback on).
    const dropAll = lift((value: { n: number }) => value.n < 0);

    const setup = runtime.edit();
    const d0 = runtime.getCell(space, "rp-el-0", undefined, setup);
    const d1 = runtime.getCell(space, "rp-el-1", undefined, setup);
    const listCell = runtime.getCell(
      space,
      "rp-list",
      { type: "array", items: { asCell: ["cell"] } },
      setup,
    );
    listCell.set([d0]);
    setup.prepareCfc();
    expect((await setup.commit().settled).ok).toBeDefined();

    const collectionPattern = pattern<{ values: unknown[] }>(({ values }) => {
      const kept = (values as unknown as {
        filterWithPattern: (op: unknown, params: unknown) => unknown;
      }).filterWithPattern(
        pattern(({ element }: FactoryInput<any>) => dropAll(element)),
        {},
      );
      return { kept };
    });

    const tx = runtime.edit();
    const valuesIn = runtime.getCell(space, "rp-list", undefined, tx);
    const resultCell = runtime.getCell(space, "rp-result", undefined, tx);
    const result = runtime.run(
      tx,
      collectionPattern,
      { values: valuesIn },
      resultCell,
    );
    tx.prepareCfc();
    expect((await tx.commit().settled).ok).toBeDefined();
    await result.pull();
    await runtime.idle();

    const containerId = resolvedContainerId(result.key("kept"));
    const rootEntries = () =>
      entriesOf(containerId).filter(
        (e) => e.origin === "structure" && e.path.length === 0,
      );
    const membership = () =>
      rootEntries()
        .filter((e) => e.observes === "enumerate")
        .flatMap((e) => e.label.confidentiality ?? []);
    const frozenShape = () =>
      rootEntries()
        .filter((e) => e.observes === "shape")
        .flatMap((e) => e.label.confidentiality ?? []);

    expect(membership()).toContainEqual("dave-secret");
    expect(frozenShape()).toContainEqual("dave-secret");

    // Swap the sole candidate: the result stays [] (no container value
    // write), the predicate now reads erin only.
    const stx = runtime.edit();
    const lc = runtime.getCell(
      space,
      "rp-list",
      { type: "array", items: { asCell: ["cell"] } },
      stx,
    );
    lc.set([d1]);
    stx.prepareCfc();
    expect((await stx.commit().settled).ok).toBeDefined();
    await result.pull();
    await runtime.idle();

    const after = membership();
    expect(after).toContainEqual("erin-secret");
    expect(after).not.toContainEqual("dave-secret");
    // The frozen existence entry is never touched by the re-stamp.
    expect(frozenShape()).toContainEqual("dave-secret");
    expect(frozenShape()).not.toContainEqual("erin-secret");
  });
});
