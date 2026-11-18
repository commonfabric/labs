import { expect } from "@std/expect";
import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";

import { Identity } from "@commonfabric/identity";
import { StorageManager } from "@commonfabric/runner/storage/cache.deno";

import { releaseRemovedElements } from "../../src/builtins/list-element-keys.ts";
import type { ElementRun } from "../../src/builtins/list-element-rollback.ts";
import type { Cell } from "../../src/cell.ts";
import { Runtime } from "../../src/runtime.ts";

const signer = await Identity.fromPassphrase("release removed elements");
const space = signer.did();

describe("releaseRemovedElements()", () => {
  // The runner's `releaseChild()` is replaced so a case can say which
  // children's release throws; the cells are real, and nothing is running
  // under them.

  let storageManager: ReturnType<typeof StorageManager.emulate>;
  let runtime: Runtime;
  let released: string[];
  let failing: Map<string, Error>;

  beforeEach(() => {
    storageManager = StorageManager.emulate({ as: signer });
    runtime = new Runtime({ apiUrl: new URL(import.meta.url), storageManager });
    released = [];
    failing = new Map();
    runtime.runner.releaseChild = <T>(resultCell: Cell<T>) => {
      const id = resultCell.getAsNormalizedFullLink().id;
      released.push(id);
      const failure = failing.get(id);
      if (failure) throw failure;
      return true;
    };
  });

  afterEach(async () => {
    await runtime.dispose();
    await storageManager.close();
  });

  /** An element map holding one run per name, keyed by that name. */
  function runsFor(...names: string[]): Map<string, ElementRun> {
    return new Map(names.map((name, lastIndex) => [name, {
      resultCell: runtime.getCell(space, `element ${name}`),
      lastIndex,
      needsSetup: false,
    }]));
  }

  function idOf(runs: Map<string, ElementRun>, name: string): string {
    return runs.get(name)!.resultCell.getAsNormalizedFullLink().id;
  }

  it("releases and drops every run whose key is gone, and keeps the rest", () => {
    const runs = runsFor("a", "b", "c");
    const ids = { a: idOf(runs, "a"), c: idOf(runs, "c") };
    releaseRemovedElements(runtime, runs, new Set(["b"]));
    expect(released).toEqual([ids.a, ids.c]);
    expect([...runs.keys()]).toEqual(["b"]);
  });

  it("throws the one release failure after releasing the others, keeping the failed run", () => {
    const runs = runsFor("a", "b", "c");
    const failure = new Error("release a failed");
    failing.set(idOf(runs, "a"), failure);
    let thrown: unknown;
    try {
      releaseRemovedElements(runtime, runs, new Set());
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBe(failure);
    expect(released).toHaveLength(3);
    expect([...runs.keys()]).toEqual(["a"]);
  });

  it("throws an `AggregateError` holding every failure when several releases fail", () => {
    const runs = runsFor("a", "b", "c");
    const failures = [new Error("release a failed"), new Error("c failed")];
    failing.set(idOf(runs, "a"), failures[0]);
    failing.set(idOf(runs, "c"), failures[1]);
    let thrown: unknown;
    try {
      releaseRemovedElements(runtime, runs, new Set());
    } catch (error) {
      thrown = error;
    }
    if (!(thrown instanceof AggregateError)) {
      throw new Error(`expected an AggregateError, got ${thrown}`);
    }
    expect(thrown.message).toBe("Multiple list child releases failed");
    expect(thrown.errors).toEqual(failures);
    expect([...runs.keys()]).toEqual(["a", "c"]);
  });
});
