import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";

import type { OpaqueCell } from "@commonfabric/api";
import { Identity } from "@commonfabric/identity";
import { StorageManager } from "@commonfabric/runner/storage/cache.deno";
import type { Cell } from "../src/cell.ts";
import {
  createTrustedBuilder,
  trustExecutable,
} from "./support/trusted-builder.ts";
import { Runtime } from "../src/runtime.ts";
import { entityKey } from "../src/scheduler/keys.ts";
import { observePendingDeferredStarts } from "./support/telemetry-observers.ts";

// The four guarantees a child run carries beyond "whoever created it stops it".
// Each drives the public API only: a parent pattern, a child reached through
// it, and start/stop/abort in the order that distinguishes the cases.

const signer = await Identity.fromPassphrase("child run ownership");
const space = signer.did();

describe("child run ownership", () => {
  let storageManager: ReturnType<typeof StorageManager.emulate>;
  let runtime: Runtime;

  // The registration key the runner indexes cancels by: the scope segment is
  // the runtime's scope INSTANCE (resolveScopeKey), not the raw scope name
  // (stage E re-keying) — entityKey is the shared constructor for the format.
  function key(cell: Cell<unknown>) {
    return entityKey(
      cell.getAsNormalizedFullLink(),
      runtime.scopeKeyIdentity,
    );
  }

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

  it("rolls back a nested child when its parent transaction aborts", async () => {
    const { lift, pattern } = createTrustedBuilder(runtime).commonfabric;
    const Child = pattern<{ value: number }>(({ value }) => ({
      doubled: lift((input: number) => input * 2)(value),
    }));
    const Parent = pattern<{ value: number }>(({ value }) => ({
      child: Child({ value }),
    }));
    const tx = runtime.edit();
    const parent = runtime.getCell(
      space,
      "aborted nested child parent",
      undefined,
      tx,
    );
    const before = new Set(runtime.runner.cancels.keys());
    runtime.run(tx, Parent, { value: 3 }, parent);
    const created = [...runtime.runner.cancels.keys()].filter((k) =>
      !before.has(k)
    );
    expect(created.length).toBeGreaterThanOrEqual(2);

    expect(tx.abort("parent setup rejected").error).toBeUndefined();
    await runtime.idle();

    expect(created.filter((k) => runtime.runner.cancels.has(k))).toEqual([]);
  });

  it("keeps a directly started nested child after its parent stops", async () => {
    const { lift, pattern } = createTrustedBuilder(runtime).commonfabric;
    const Child = pattern<{ value: number }>(({ value }) => ({
      doubled: lift((input: number) => input * 2)(value),
    }));
    const Parent = pattern<{ value: number }>(({ value }) => ({
      child: Child({ value }),
    }));
    const tx = runtime.edit();
    const parent = runtime.getCell<{ child: { doubled: number } }>(
      space,
      "directly started nested child parent",
      undefined,
      tx,
    );
    const result = runtime.run(tx, Parent, { value: 3 }, parent);
    expect((await tx.commit()).error).toBeUndefined();
    await runtime.idle();
    expect(await result.pull()).toEqual({ child: { doubled: 6 } });
    const child = result.key("child").resolveAsCell() as Cell<
      { doubled: number }
    >;

    const directStart = runtime.start(child);
    runtime.runner.stop(parent);

    await expect(directStart).resolves.toBe(true);
    expect(runtime.runner.cancels.has(key(child))).toBe(true);
    runtime.runner.stop(child);
  });

  it("keeps a directly started map child after its parent stops", async () => {
    const { lift, pattern } = createTrustedBuilder(runtime).commonfabric;
    const op = pattern(({ element }: { element: number }) =>
      lift((value: number) => value)(element)
    );
    const Parent = pattern<{ values?: number[] }>(({ values }) => {
      const list = values as unknown as OpaqueCell<number[]>;
      return {
        values,
        out: list.mapWithPattern(
          op as unknown as Parameters<typeof list.mapWithPattern>[0],
          {},
        ),
      };
    });
    const tx = runtime.edit();
    const parent = runtime.getCell<Record<string, unknown>>(
      space,
      "directly started map child parent",
      undefined,
      tx,
    );
    let child: Cell<unknown> | undefined;
    const capture = (args: unknown[]) => {
      const options = args[4] as
        | { doNotUpdateOnPatternChange?: boolean }
        | undefined;
      if (child === undefined && options?.doNotUpdateOnPatternChange === true) {
        child = args[3] as Cell<unknown>;
      }
    };
    const runner = runtime.runner as unknown as Record<string, unknown>;
    const originalRun = runtime.runner.run;
    const originalRunChild = runner.runChild as
      | ((...args: unknown[]) => unknown)
      | undefined;
    runtime.runner.run = ((...args: unknown[]) => {
      capture(args);
      return Reflect.apply(originalRun, runtime.runner, args);
    }) as typeof runtime.runner.run;
    if (originalRunChild !== undefined) {
      runner.runChild = (...args: unknown[]) => {
        capture(args);
        return Reflect.apply(originalRunChild, runtime.runner, args);
      };
    }
    try {
      runtime.run(tx, Parent, { values: [1] }, parent);
      expect((await tx.commit()).error).toBeUndefined();
      await runtime.idle();
      await parent.pull();
    } finally {
      runtime.runner.run = originalRun;
      if (originalRunChild !== undefined) runner.runChild = originalRunChild;
    }
    expect(child).toBeDefined();

    const directStart = runtime.start(child!);
    runtime.runner.stop(parent);

    await expect(directStart).resolves.toBe(true);
    expect(runtime.runner.cancels.has(key(child!))).toBe(true);
    runtime.runner.stop(child!);
  });

  it("tombstones a pending commit-gated start on an explicit stop", async () => {
    const { lift, pattern } = createTrustedBuilder(runtime).commonfabric;
    const Piece = pattern<{ value: number }>(({ value }) => ({
      doubled: lift((input: number) => input * 2)(value),
    }));
    const tx = runtime.edit();
    tx.tx.immediate = true;
    (tx.tx as { deferRunnerStartUntilCommit?: boolean })
      .deferRunnerStartUntilCommit = true;
    const result = runtime.getCell<Record<string, unknown>>(
      space,
      "stopped before its deferred start",
      undefined,
      tx,
    );
    runtime.run(tx, Piece, { value: 3 }, result.withTx(tx));

    runtime.runner.stop(result);
    expect((await tx.commit()).error).toBeUndefined();
    await runtime.idle();

    expect(runtime.runner.cancels.has(key(result))).toBe(false);
  });

  it("cancels a pending commit-gated start on release", async () => {
    const { lift, pattern } = createTrustedBuilder(runtime).commonfabric;
    const Piece = pattern<{ value: number }>(({ value }) => ({
      doubled: lift((input: number) => input * 2)(value),
    }));
    const tx = runtime.edit();
    tx.tx.immediate = true;
    (tx.tx as { deferRunnerStartUntilCommit?: boolean })
      .deferRunnerStartUntilCommit = true;
    const result = runtime.getCell<Record<string, unknown>>(
      space,
      "released before its deferred start",
      undefined,
      tx,
    );
    runtime.run(tx, Piece, { value: 3 }, result.withTx(tx));

    // The launch holds this result through the pending start alone: nothing is
    // registered under its key until that start installs.
    expect(runtime.runner.cancels.has(key(result))).toBe(false);

    runtime.runner.releaseChild(result, undefined);
    expect((await tx.commit()).error).toBeUndefined();
    await runtime.idle();

    expect(runtime.runner.cancels.has(key(result))).toBe(false);
  });

  it("tombstones a pending commit-gated start when the runtime stops", async () => {
    const { lift, pattern } = createTrustedBuilder(runtime).commonfabric;
    const Piece = pattern<{ value: number }>(({ value }) => ({
      doubled: lift((input: number) => input * 2)(value),
    }));
    const tx = runtime.edit();
    tx.tx.immediate = true;
    (tx.tx as { deferRunnerStartUntilCommit?: boolean })
      .deferRunnerStartUntilCommit = true;
    const result = runtime.getCell<Record<string, unknown>>(
      space,
      "stopped by teardown before its deferred start",
      undefined,
      tx,
    );
    runtime.run(tx, Piece, { value: 3 }, result.withTx(tx));

    runtime.runner.stopAll();
    expect((await tx.commit()).error).toBeUndefined();
    await runtime.idle();

    expect(runtime.runner.cancels.has(key(result))).toBe(false);
  });

  it("keeps a child whose setup transaction fails on a stale basis", async () => {
    const { lift, pattern } = createTrustedBuilder(runtime).commonfabric;
    const Child = pattern<{ value: number }>(({ value }) => ({
      doubled: lift((input: number) => input * 2)(value),
    }));
    const Parent = pattern<{ value: number }>(({ value }) => ({
      child: Child({ value }),
    }));
    const tx = runtime.edit();
    const parent = runtime.getCell(
      space,
      "stale basis parent",
      undefined,
      tx,
    );
    const before = new Set(runtime.runner.cancels.keys());
    runtime.run(tx, Parent, { value: 3 }, parent);
    const created = [...runtime.runner.cancels.keys()].filter((k) =>
      !before.has(k)
    );
    expect(created.length).toBeGreaterThanOrEqual(2);

    // A conflict is resolved by re-running against fresher state, and that
    // re-run reuses what is already registered.
    (tx.tx as unknown as { commit: () => Promise<unknown> }).commit = () =>
      Promise.resolve({
        error: { name: "ConflictError", message: "stale basis" },
      });
    await tx.commit();
    await runtime.idle();

    expect(created.filter((k) => runtime.runner.cancels.has(k)))
      .toEqual(created);
    for (const cell of [parent]) runtime.runner.stop(cell);
  });

  it("declines to release a registration it does not own", async () => {
    const { lift, pattern } = createTrustedBuilder(runtime).commonfabric;
    const Piece = pattern<{ value: number }>(({ value }) => ({
      doubled: lift((input: number) => input * 2)(value),
    }));
    const tx = runtime.edit();
    const result = runtime.getCell<Record<string, unknown>>(
      space,
      "released by a stale owner",
      undefined,
      tx,
    );
    runtime.run(tx, Piece, { value: 3 }, result);
    expect((await tx.commit()).error).toBeUndefined();
    await runtime.idle();
    expect(runtime.runner.cancels.has(key(result))).toBe(true);

    // A release naming a registration that is no longer current belongs to an
    // attempt something else replaced, so it leaves the live one alone.
    runtime.runner.releaseChild(result, () => {});

    expect(runtime.runner.cancels.has(key(result))).toBe(true);
    runtime.runner.stop(result);
  });

  it("keeps a child started before its parent stops", async () => {
    const { lift, pattern } = createTrustedBuilder(runtime).commonfabric;
    const Child = pattern<{ value: number }>(({ value }) => ({
      doubled: lift((input: number) => input * 2)(value),
    }));
    const Parent = pattern<{ value: number }>(({ value }) => ({
      child: Child({ value }),
    }));
    const tx = runtime.edit();
    const parent = runtime.getCell<{ child: { doubled: number } }>(
      space,
      "child started before its parent stops",
      undefined,
      tx,
    );
    const result = runtime.run(tx, Parent, { value: 3 }, parent);
    expect((await tx.commit()).error).toBeUndefined();
    await runtime.idle();
    const child = result.key("child").resolveAsCell() as Cell<
      { doubled: number }
    >;

    // The start settles first, so the release consults the recorded lifetime
    // rather than an attempt still in flight.
    await expect(runtime.start(child)).resolves.toBe(true);
    runtime.runner.stop(parent);

    expect(runtime.runner.cancels.has(key(child))).toBe(true);
    const update = runtime.edit();
    child.getArgumentCell()!.withTx(update).key("value").set(5);
    expect((await update.commit()).error).toBeUndefined();
    expect(await child.pull()).toEqual({ doubled: 10 });
    runtime.runner.stop(child);
  });

  it("stops tracking a commit-gated start once it installs", async () => {
    const { lift, pattern } = createTrustedBuilder(runtime).commonfabric;
    const Piece = pattern<{ value: number }>(({ value }) => ({
      doubled: lift((input: number) => input * 2)(value),
    }));
    const tx = runtime.edit();
    tx.tx.immediate = true;
    (tx.tx as { deferRunnerStartUntilCommit?: boolean })
      .deferRunnerStartUntilCommit = true;
    const result = runtime.getCell<Record<string, unknown>>(
      space,
      "deferred start that installs",
      undefined,
      tx,
    );
    const pending = observePendingDeferredStarts(runtime);
    runtime.run(tx, Piece, { value: 3 }, result.withTx(tx));

    expect(pending.keys()).toBe(1);

    expect((await tx.commit()).error).toBeUndefined();
    await runtime.idle();

    // The installed registration owns itself from here, so nothing is left
    // waiting to be tombstoned.
    expect(runtime.runner.cancels.has(key(result))).toBe(true);
    expect(pending.keys()).toBe(0);
    expect(pending.settled("installed")).toBe(1);
    expect(pending.settled("cancelled")).toBe(0);
    pending.restore();
    runtime.runner.stop(result);
  });

  it("stops tracking a commit-gated start when its transaction fails", async () => {
    const { lift, pattern } = createTrustedBuilder(runtime).commonfabric;
    const Piece = pattern<{ value: number }>(({ value }) => ({
      doubled: lift((input: number) => input * 2)(value),
    }));
    const tx = runtime.edit();
    tx.tx.immediate = true;
    (tx.tx as { deferRunnerStartUntilCommit?: boolean })
      .deferRunnerStartUntilCommit = true;
    const result = runtime.getCell<Record<string, unknown>>(
      space,
      "deferred start whose transaction fails",
      undefined,
      tx,
    );
    const pending = observePendingDeferredStarts(runtime);
    runtime.run(tx, Piece, { value: 3 }, result.withTx(tx));

    expect(pending.keys()).toBe(1);

    expect(tx.abort("setup rejected").error).toBeUndefined();
    await runtime.idle();

    // The start will never install, so it settles as cancelled and leaves
    // nothing behind for the result's key.
    expect(runtime.runner.cancels.has(key(result))).toBe(false);
    expect(pending.keys()).toBe(0);
    expect(pending.settled("cancelled")).toBe(1);
    expect(pending.settled("installed")).toBe(0);
    pending.restore();
  });

  it("stops tracking a commit-gated pattern run when its transaction fails", async () => {
    const { lift, pattern } = createTrustedBuilder(runtime).commonfabric;
    const Piece = pattern<{ value: number }>(({ value }) => ({
      doubled: lift((input: number) => input * 2)(value),
    }));
    // The commit-gated run a navigateTo handler schedules goes through its own
    // entry point, reached here directly: driving it through a handler would
    // mean failing whichever storage transaction the dispatch happened to
    // land on.
    const harness = runtime.runner.accessForTestingOnly;
    const tx = runtime.edit();
    const receipt = runtime.getCell<Record<string, unknown>>(
      space,
      "deferred pattern run whose transaction fails",
      undefined,
      tx,
    );
    const pending = observePendingDeferredStarts(runtime);
    harness.runPatternAfterSuccessfulCommit(
      tx,
      receipt,
      trustExecutable(runtime, Piece),
      { value: 3 },
      true,
    );
    expect(pending.keys()).toBe(1);

    expect(tx.abort("handler rejected").error).toBeUndefined();
    await runtime.idle();

    expect(pending.keys()).toBe(0);
    expect(pending.settled("cancelled")).toBe(1);
    expect(pending.settled("installed")).toBe(0);
    expect(runtime.runner.cancels.has(key(receipt))).toBe(false);
    pending.restore();
  });

  it("declines to release a result that has no registration", () => {
    const result = runtime.getCell<Record<string, unknown>>(
      space,
      "released while never started",
    );
    expect(runtime.runner.cancels.has(key(result))).toBe(false);

    runtime.runner.releaseChild(result, undefined);

    expect(runtime.runner.cancels.has(key(result))).toBe(false);
  });
});
