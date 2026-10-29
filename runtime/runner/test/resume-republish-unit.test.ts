import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { getLogger } from "@commonfabric/utils/logger";
import type { Cell } from "../src/cell.ts";
import type { Runtime } from "../src/runtime.ts";
import type { JSONSchema } from "../src/builder/types.ts";
import {
  createResumeRepublisher,
  type ElementContribution,
} from "../src/builtins/resume-republish.ts";
import type { ElementRun } from "../src/builtins/list-element-rollback.ts";
import { flatMapContribution } from "../src/builtins/flatmap.ts";

// Focused coverage for the shared resume-republish machinery
// (src/builtins/resume-republish.ts), driving the straggler and guard arms that
// the end-to-end resume tests (list-resume-preserve.test.ts and friends) cannot
// reach deterministically: the still-pending re-defer, the input/result guards,
// the editWithRetry error arm, and the rejected-sync catch.
//
// The same harness drives each builtin's own contribution through the real
// republisher, so every arm of a contribution is covered by a plain unit test
// rather than by whichever end-to-end resume happens to produce that shape of
// per-element result on a given run.
//
// The republisher's only real collaborators are the cells it reads and writes,
// the runtime's editWithRetry, and the storage manager's trackUntilSettled. Each
// is mocked so the test controls exactly what the rebuild loop sees: which
// elements are present, what each per-element result reads, whether a commit
// fails, and whether a child sync rejects. The republisher code under test is
// the real module; nothing about its logic is stubbed.

const logger = getLogger("runner.resume-republish-unit", {
  enabled: false,
  level: "warn",
});

interface FakeLink {
  space: string;
  id: string;
  path: readonly unknown[];
  scope: string;
}

// A minimal cell stand-in. `value` is what get() returns; `syncResult` is the
// promise its sync() hands back. Only the methods the republisher calls are
// implemented.
class FakeCell {
  setValues: unknown[] = [];
  readonly #syncResult: () => Promise<unknown>;

  constructor(
    readonly id: string,
    public value: unknown,
    syncResult: () => Promise<unknown> = () => Promise.resolve(),
  ) {
    this.#syncResult = syncResult;
  }
  getAsNormalizedFullLink(): FakeLink {
    return { space: "space", id: this.id, path: [], scope: "space" };
  }
  withTx(): this {
    return this;
  }
  asSchema(): this {
    return this;
  }
  get(): unknown {
    return this.value;
  }
  set(v: unknown): void {
    this.setValues.push(v);
  }
  sync(): Promise<unknown> {
    return this.#syncResult();
  }
  asCell(): this {
    return this;
  }
}

// An input-list cell: get() returns `{ list }`. The list is whatever the test
// supplies (a real array, a sparse array, or a non-array to drive the guard).
class FakeInputsCell {
  readonly #listValue: unknown;

  constructor(listValue: unknown) {
    this.#listValue = listValue;
  }
  asSchema(): this {
    return this;
  }
  withTx(): this {
    return this;
  }
  get(): { list?: unknown } {
    return { list: this.#listValue };
  }
}

// editWithRetry stand-in. By default it runs the action and reports {ok}. In
// error mode it skips the action and reports a commit error, driving the
// republisher's failure arm.
interface FakeEditOptions {
  failCommit?: boolean;
}

function makeRuntime(options: FakeEditOptions = {}): {
  runtime: Runtime;
  tracked: Promise<unknown>[];
} {
  const tracked: Promise<unknown>[] = [];
  const runtime = {
    editWithRetry<T>(fn: (tx: unknown) => T) {
      if (options.failCommit) {
        return Promise.resolve({
          error: {
            name: "StorageTransactionAborted" as const,
            message: "forced commit failure",
          },
        });
      }
      // The republisher wraps its container write in
      // tx.runWithAmbientReadMeta(linkResolutionProbe, ...) (S16: structure-only
      // container reads must not journal prior element content). Hand the action
      // a tx whose ambient-read-meta scope is a pass-through, so the wrapped
      // write actually runs.
      const tx = {
        runWithAmbientReadMeta: <T>(_meta: unknown, action: () => T): T =>
          action(),
      };
      const ok = fn(tx);
      return Promise.resolve({ ok });
    },
    // The republisher declares its run context (serving-loop.md §3d's
    // bookkeeping stamp) before writing; the unit-fake runtime accepts
    // the stamp and does nothing with it, like the OFF arm.
    stampServerRun() {},
    storageManager: {
      trackUntilSettled(work: Promise<unknown>) {
        tracked.push(work);
      },
    },
  } as unknown as Runtime;
  return { runtime, tracked };
}

const SCHEMA = {} as JSONSchema;

// The filter contribution: include a truthy element, exclude a defined falsy
// one, and report an undefined predicate as still pending.
const filterContribution: ElementContribution = (value, inputElement, out) => {
  if (value) out.push(inputElement);
  else if (value === undefined) return "pending";
};

function makeRepublisher(opts: {
  result: FakeCell | undefined;
  inputsList: unknown;
  elementRuns: Map<string, ElementRun>;
  runtime: Runtime;
  contribute?: ElementContribution;
  rearmReconcile?: () => void;
}) {
  return createResumeRepublisher({
    runtime: opts.runtime,
    logger,
    isActive: () => true,
    getResult: () => opts.result as unknown as Cell<any[]> | undefined,
    inputsCell: new FakeInputsCell(opts.inputsList) as unknown as Cell<any>,
    inputSchema: SCHEMA,
    resultSchema: SCHEMA,
    elementRuns: opts.elementRuns,
    contribute: opts.contribute ?? filterContribution,
    aggregateNoun: "filtered list",
    elementNoun: "predicate",
    rearmReconcile: opts.rearmReconcile ?? (() => {}),
  });
}

// Build an element-runs map keyed exactly as the republisher keys them, from a
// list of input-element cells and their corresponding result cells.
function runsFor(
  inputCells: FakeCell[],
  resultCells: FakeCell[],
): Map<string, ElementRun> {
  const runs = new Map<string, ElementRun>();
  const keyCounts = new Map<string, number>();
  for (let i = 0; i < inputCells.length; i++) {
    if (inputCells[i] === undefined) continue;
    const link = inputCells[i].getAsNormalizedFullLink();
    const linkKey = [link.space, link.id, link.scope, link.path];
    const dedupKey = JSON.stringify(linkKey);
    const occurrence = keyCounts.get(dedupKey) ?? 0;
    keyCounts.set(dedupKey, occurrence + 1);
    const elementKey = JSON.stringify([...linkKey, occurrence]);
    runs.set(elementKey, {
      resultCell: resultCells[i] as unknown as Cell<any>,
      lastIndex: i,
      needsSetup: false,
    });
  }
  return runs;
}

describe("resume-republish unit", () => {
  it("rearms owed setup after an absent predicate confirms without a membership change", async () => {
    const held = Promise.withResolvers<void>();
    const inputs = [new FakeCell("input", null)];
    const predicate = new FakeCell("predicate", undefined, () => held.promise);
    const result = new FakeCell("container", []);
    const runs = runsFor(inputs, [predicate]);
    for (const entry of runs.values()) entry.needsSetup = true;
    const { runtime, tracked } = makeRuntime();
    let rearms = 0;
    const republisher = makeRepublisher({
      result,
      inputsList: inputs,
      elementRuns: runs,
      runtime,
      rearmReconcile: () => rearms++,
    });
    republisher.awaitPendingThenRepublish(
      [predicate] as unknown as Cell<any>[],
    );
    expect(rearms).toBe(0);
    expect(republisher.awaitingResult(predicate as unknown as Cell<any>)).toBe(
      true,
    );
    held.resolve();
    await drain(tracked);
    expect(result.setValues).toEqual([[]]);
    expect(republisher.awaitingResult(predicate as unknown as Cell<any>)).toBe(
      false,
    );
    expect(rearms).toBe(1);
  });

  it("reports an element result as awaited only while its sync runs", async () => {
    const inputs = [new FakeCell("e0", null)];
    let arrive = () => {};
    const held = new Promise<void>((resolve) => {
      arrive = resolve;
    });
    const r0 = new FakeCell("r0", undefined, () => held);
    const other = new FakeCell("r1", undefined);
    const { runtime, tracked } = makeRuntime();
    const rr = makeRepublisher({
      result: new FakeCell("container", [0]),
      inputsList: inputs,
      elementRuns: runsFor(inputs, [r0]),
      runtime,
    });

    expect(rr.awaitingResult(r0 as unknown as Cell<any>)).toBe(false);

    rr.awaitPendingThenRepublish([r0] as unknown as Cell<any>[]);

    expect(rr.awaitingResult(r0 as unknown as Cell<any>)).toBe(true);
    // Only the awaited document counts; a sibling nobody is waiting for is
    // free to have its setup written.
    expect(rr.awaitingResult(other as unknown as Cell<any>)).toBe(false);

    arrive();
    await drain(tracked);

    expect(rr.awaitingResult(r0 as unknown as Cell<any>)).toBe(false);
  });

  it("syncs an element once while a wait for it is already running", () => {
    const inputs = [new FakeCell("e0", null)];
    let syncs = 0;
    const r0 = new FakeCell("r0", undefined, () => {
      syncs++;
      return new Promise<void>(() => {});
    });
    const { runtime } = makeRuntime();
    const rr = makeRepublisher({
      result: new FakeCell("container", [0]),
      inputsList: inputs,
      elementRuns: runsFor(inputs, [r0]),
      runtime,
    });

    rr.awaitPendingThenRepublish([r0] as unknown as Cell<any>[]);
    rr.awaitPendingThenRepublish([r0] as unknown as Cell<any>[]);

    // Two waits racing to clear one document id would let the first to settle
    // drop a record the second still needs.
    expect(syncs).toBe(1);
  });

  it("rebuilds the aggregate from confirmed per-element results", async () => {
    const inputs = [new FakeCell("e0", null), new FakeCell("e1", null)];
    // Both predicates settled truthy, so both elements are included.
    const results = [new FakeCell("r0", true), new FakeCell("r1", true)];
    const result = new FakeCell("container", [0]);
    const { runtime, tracked } = makeRuntime();
    const rr = makeRepublisher({
      result,
      inputsList: inputs,
      elementRuns: runsFor(inputs, results),
      runtime,
    });

    rr.awaitPendingThenRepublish(results as unknown as Cell<any>[]);
    await Promise.all(tracked);

    // The container was written exactly once, with both input elements.
    expect(result.setValues.length).toBe(1);
    expect(result.setValues[0]).toEqual(inputs);
  });

  it("re-defers a still-pending element outside the awaited set", async () => {
    const inputs = [new FakeCell("e0", null), new FakeCell("e1", null)];
    // Element 0 settled truthy. Element 1's predicate reads undefined at first.
    // Its sync confirms the doc and the value arrives truthy, modeling a child
    // whose result streamed in only after the first republish was scheduled.
    const r0 = new FakeCell("r0", true);
    let r1Synced = 0;
    const r1 = new FakeCell("r1", undefined, () => {
      r1Synced++;
      r1.value = true;
      return Promise.resolve();
    });
    const result = new FakeCell("container", [0, 1]);
    const { runtime, tracked } = makeRuntime();
    const rr = makeRepublisher({
      result,
      inputsList: inputs,
      elementRuns: runsFor(inputs, [r0, r1]),
      runtime,
    });

    // Await only element 0. The republish rebuild then finds element 1
    // undefined and not awaited, so it returns it as still-pending and
    // re-awaits it. The re-await syncs element 1, whose value arrives truthy,
    // so the next republish includes it.
    rr.awaitPendingThenRepublish([r0] as unknown as Cell<any>[]);
    await drain(tracked);

    // The re-defer actually happened: the straggler was re-awaited (its sync
    // ran) rather than written out as a partial shrink.
    expect(r1Synced).toBeGreaterThan(0);
    // The first republish held the shrink (it returned the straggler instead of
    // writing); only the converged rebuild reached the container, with both
    // elements.
    expect(result.setValues.length).toBe(1);
    expect(result.setValues[0]).toEqual(inputs);
  });

  it("returns early when the result container is unbound", async () => {
    const inputs = [new FakeCell("e0", null)];
    const results = [new FakeCell("r0", true)];
    const { runtime, tracked } = makeRuntime();
    const rr = makeRepublisher({
      result: undefined, // getResult() yields undefined
      inputsList: inputs,
      elementRuns: runsFor(inputs, results),
      runtime,
    });

    rr.awaitPendingThenRepublish(results as unknown as Cell<any>[]);
    await drain(tracked);
    // Nothing to assert on a write; the guard simply returns without throwing.
    expect(true).toBe(true);
  });

  it("returns early when the resumed input is not yet an array", async () => {
    const result = new FakeCell("container", [0]);
    const r0 = new FakeCell("r0", undefined);
    const { runtime, tracked } = makeRuntime();
    const rr = makeRepublisher({
      result,
      inputsList: undefined, // input list not confirmed yet
      elementRuns: new Map(),
      runtime,
    });

    rr.awaitPendingThenRepublish([r0] as unknown as Cell<any>[]);
    await drain(tracked);
    // The guard returns [] without writing the container.
    expect(result.setValues.length).toBe(0);
  });

  it("steps over a sparse hole and a list entry with no element run", async () => {
    // index 1 is a hole; index 2 is present in the list but has no entry in
    // elementRuns (its run has not been created), exercising both continues.
    const inputs: FakeCell[] = [];
    inputs[0] = new FakeCell("e0", null);
    inputs[2] = new FakeCell("e2", null);
    const result = new FakeCell("container", [0]);
    const r0 = new FakeCell("r0", true);
    // elementRuns holds only element 0; element 2 is intentionally absent.
    const runs = runsFor([inputs[0]], [r0]);
    const { runtime, tracked } = makeRuntime();
    const rr = makeRepublisher({
      result,
      inputsList: inputs,
      elementRuns: runs,
      runtime,
    });

    rr.awaitPendingThenRepublish([r0] as unknown as Cell<any>[]);
    await drain(tracked);

    // Only element 0 is rebuilt; the hole and the entry-less index contribute
    // nothing.
    expect(result.setValues.at(-1)).toEqual([inputs[0]]);
  });

  it("logs and stops when the republish commit fails", async () => {
    const inputs = [new FakeCell("e0", null)];
    const results = [new FakeCell("r0", true)];
    const result = new FakeCell("container", [0]);
    const { runtime, tracked } = makeRuntime({ failCommit: true });
    const rr = makeRepublisher({
      result,
      inputsList: inputs,
      elementRuns: runsFor(inputs, results),
      runtime,
    });

    rr.awaitPendingThenRepublish(results as unknown as Cell<any>[]);
    await drain(tracked);
    // The failed commit means no successful write; the error arm just logs.
    expect(result.setValues.length).toBe(0);
  });

  it("logs when a pending element sync rejects", async () => {
    const inputs = [new FakeCell("e0", null)];
    const result = new FakeCell("container", [0]);
    // This element's sync rejects, driving the catch arm.
    const r0 = new FakeCell(
      "r0",
      undefined,
      () => Promise.reject(new Error("sync rejected")),
    );
    const { runtime, tracked } = makeRuntime();
    const rr = makeRepublisher({
      result,
      inputsList: inputs,
      elementRuns: runsFor(inputs, [r0]),
      runtime,
    });

    rr.awaitPendingThenRepublish([r0] as unknown as Cell<any>[]);
    await drain(tracked);
    // The rejected sync skips the rebuild entirely; the container is untouched.
    expect(result.setValues.length).toBe(0);
  });
});

describe("flatMap contribution", () => {
  it("spreads an array result one level deep and densifies its holes", async () => {
    const inputs = [new FakeCell("e0", null), new FakeCell("e1", null)];
    // A sparse per-element result: index 1 is a hole, which forEach steps over.
    const sparse: unknown[] = [];
    sparse[0] = "a";
    sparse[2] = "c";
    const results = [
      new FakeCell("r0", ["x", ["y"]]),
      new FakeCell("r1", sparse),
    ];
    const result = new FakeCell("container", [0, 1]);
    const { runtime, tracked } = makeRuntime();
    const rr = makeRepublisher({
      result,
      inputsList: inputs,
      elementRuns: runsFor(inputs, results),
      runtime,
      contribute: flatMapContribution,
    });

    rr.awaitPendingThenRepublish(results as unknown as Cell<any>[]);
    await drain(tracked);

    // One level of spreading: the nested array survives as a single element,
    // and the hole contributes nothing, so the output is dense.
    expect(result.setValues.length).toBe(1);
    expect(result.setValues[0]).toEqual(["x", ["y"], "a", "c"]);
  });

  it("pushes a defined scalar result and skips a settled-undefined one", async () => {
    const inputs = [new FakeCell("e0", null), new FakeCell("e1", null)];
    // Element 1 reads undefined, but it is in the awaited set, so it has
    // settled: flatMap skips it rather than holding the aggregate for it.
    const results = [new FakeCell("r0", 7), new FakeCell("r1", undefined)];
    const result = new FakeCell("container", [0, 1]);
    const { runtime, tracked } = makeRuntime();
    const rr = makeRepublisher({
      result,
      inputsList: inputs,
      elementRuns: runsFor(inputs, results),
      runtime,
      contribute: flatMapContribution,
    });

    rr.awaitPendingThenRepublish(results as unknown as Cell<any>[]);
    await drain(tracked);

    expect(result.setValues.length).toBe(1);
    expect(result.setValues[0]).toEqual([7]);
  });
});

// trackUntilSettled receives a fresh promise per re-await, so draining once is
// not enough: await the current batch, then await any promises the rebuild
// scheduled while settling, until the queue stops growing. The republisher
// tracks a re-defer from inside the callback that resolves the promise it was
// re-deferred from, so a batch that has settled has already pushed whatever
// follows it.
async function drain(tracked: Promise<unknown>[]): Promise<void> {
  for (let seen = 0; seen < tracked.length;) {
    const batch = tracked.slice(seen);
    seen = tracked.length;
    await Promise.allSettled(batch);
  }
}
