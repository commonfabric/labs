/**
 * What the list builtins' coordinators do with work they cannot finish in the
 * reconcile that started it: the resume settle a reconcile schedules and then
 * fails to commit, and the setup a reused element owes while its run loads or
 * its result is awaited. Each coordinator is driven directly, one reconcile at
 * a time, so the case decides what each pass sees.
 */

import { expect } from "@std/expect";
import { stub } from "@std/testing/mock";
import { Identity } from "@commonfabric/identity";
import { getLogger } from "@commonfabric/logger";
import {
  afterEach,
  beforeEach,
  describe,
  it,
} from "@commonfabric/test-support/test";

import type { Pattern } from "../src/builder/types.ts";
import { filter, FILTER_INPUT_SCHEMA } from "../src/builtins/filter.ts";
import { flatMap, FLATMAP_INPUT_SCHEMA } from "../src/builtins/flatmap.ts";
import {
  listCoordinatorPlan,
  listElementResultCell,
} from "../src/builtins/list-coordinator-plan.ts";
import { map, MAP_INPUT_SCHEMA } from "../src/builtins/map.ts";
import type { Cell } from "../src/cell.ts";
import { Runtime } from "../src/runtime.ts";
import { RetryImmediately } from "../src/scheduler/retry-immediately.ts";
import { StorageManager } from "../src/storage/cache.deno.ts";
import { createTrustedBuilder } from "./support/trusted-builder.ts";

const signer = await Identity.fromPassphrase("list builtin deferred setup");
const space = signer.did();

const BUILTINS = [
  ["map", map, MAP_INPUT_SCHEMA],
  ["filter", filter, FILTER_INPUT_SCHEMA],
  ["flatMap", flatMap, FLATMAP_INPUT_SCHEMA],
] as const;

/** How many failed resume settles the logger of the builtin `name` reported. */
const failedSettles = (name: string): number =>
  getLogger(`runner.${name.toLowerCase()}`).countsByKey["resume-input"]?.warn ??
    0;

type Builtin = (typeof BUILTINS)[number][1];
type Inputs = { list: unknown[]; op: Pattern };

describe("list builtin deferred setup", () => {
  let storage: ReturnType<typeof StorageManager.emulate>;
  let runtime: Runtime;
  let cancels: (() => void)[];

  beforeEach(() => {
    storage = StorageManager.emulate({ as: signer });
    runtime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager: storage,
    });
    cancels = [];
  });

  afterEach(async () => {
    for (const cancel of cancels) cancel();
    await storage.synced();
    await runtime.dispose();
    await storage.close();
  });

  /** An op whose argument names `index`, so a moved element re-runs it. */
  function indexUsingOp(): Pattern {
    const { pattern } = createTrustedBuilder(runtime).commonfabric;
    return pattern((
      { element, index }: { element: number; index: number },
    ) => ({ element, index }));
  }

  /** Commits `tx`, failing the case on a refusal. */
  async function commit(tx: ReturnType<Runtime["edit"]>) {
    expect((await tx.commit().settled).error).toBeUndefined();
  }

  /** A coordinator for `builtin` over `inputs`, writing into `output`. */
  function coordinate(
    builtin: Builtin,
    inputs: Cell<Inputs>,
    parent: Cell<unknown>,
    output: ReturnType<Cell<unknown>["getAsNormalizedFullLink"]>,
    awaitSync: boolean,
  ) {
    const coordinator = builtin(
      inputs.withTx(),
      () => {},
      (cancel) => {
        if (cancel) cancels.push(cancel);
      },
      {},
      parent.withTx(),
      runtime,
      output,
      awaitSync,
    );
    if (typeof coordinator === "function") {
      throw new Error("Expected a registered coordinator");
    }
    return coordinator;
  }

  /**
   * Holds every load of the document `id` asked for while `holding()` is
   * true, until `release` resolves.
   */
  function holdLoadsOf(
    id: () => string,
    holding: () => boolean,
    release: Promise<void>,
  ) {
    const storageManager = runtime.storageManager;
    const original = storageManager.syncCell;
    return stub(
      storageManager,
      "syncCell",
      function <T>(cell: Cell<T>, ...rest: unknown[]): Promise<Cell<T>> {
        return holding() && cell.getAsNormalizedFullLink().id === id()
          ? release.then(() => cell)
          : Reflect.apply(original, storageManager, [cell, ...rest]);
      },
    );
  }

  describe("the resume settle of an empty input", () => {
    // A resume reconcile that finds its durable container holding rows while
    // the input list reads empty holds the container and settles it once the
    // input's load confirms. The settle writes through the container that
    // reconcile installed, so it writes nothing, and fails at nothing, when
    // that reconcile did not commit.

    for (const [name, builtin, schema] of BUILTINS) {
      for (const committed of [true, false]) {
        it(`${committed ? "clears" : "leaves"} a ${name} container whose resume reconcile ${committed ? "committed" : "was aborted"}`, async () => {
          const op = indexUsingOp();
          let tx = runtime.edit();
          const stale = runtime.getCell<number>(space, "stale", undefined, tx);
          stale.set(5);
          const inputs = runtime.getCell<Inputs>(
            space,
            `${name}-settle-inputs`,
            undefined,
            tx,
          );
          inputs.set({ list: [], op });
          const parent = runtime.getCell(
            space,
            `${name}-settle`,
            undefined,
            tx,
          );
          const output = runtime.getCell(space, `${name}-settle-output`)
            .getAsNormalizedFullLink();
          const plan = listCoordinatorPlan(
            runtime,
            tx,
            name,
            inputs,
            schema,
            parent,
            output,
          );
          plan.container.set([stale]);
          const container = plan.container.withTx();
          await commit(tx);

          const release = Promise.withResolvers<void>();
          let holding = false;
          using _hold = holdLoadsOf(
            () => inputs.getAsNormalizedFullLink().id,
            () => holding,
            release.promise,
          );
          const failedBefore = failedSettles(name);
          const coordinator = coordinate(builtin, inputs, parent, output, true);
          tx = runtime.edit();
          holding = true;
          const pass = coordinator.action(tx);
          holding = false;
          expect(pass).toBeUndefined();
          if (committed) await commit(tx);
          else tx.abort("superseded");
          release.resolve();
          await storage.synced();

          expect(container.getRaw()).toHaveLength(committed ? 0 : 1);
          expect(failedSettles(name)).toBe(failedBefore);
        });
      }
    }
  });

  describe("a reused element whose run must load first", () => {
    // Running an op whose execution family is not loaded yet starts the load
    // and returns its promise, which rejects with `RetryImmediately` once the
    // family is in. The reconcile hands that load back instead of issuing the
    // element's setup, and the pass the retry runs issues it.

    for (const [name, builtin] of BUILTINS) {
      it(`hands back the load from a ${name} pass and issues the setup on the next`, async () => {
        const op = indexUsingOp();
        let tx = runtime.edit();
        const first = runtime.getCell<number>(space, "first", undefined, tx);
        const second = runtime.getCell<number>(space, "second", undefined, tx);
        first.set(1);
        second.set(2);
        const inputs = runtime.getCell<Inputs>(
          space,
          `${name}-load-inputs`,
          undefined,
          tx,
        );
        inputs.set({ list: [first, second], op });
        const parent = runtime.getCell(space, `${name}-load`, undefined, tx);
        const output = runtime.getCell(space, `${name}-load-output`)
          .getAsNormalizedFullLink();
        await commit(tx);

        // The elements' runs are held absent: what is counted is the setup
        // each reconcile issues.
        let setups = 0;
        using _run = stub(
          runtime.runner,
          "run",
          ((...args: unknown[]) => {
            setups++;
            return args[3];
          }) as typeof runtime.runner.run,
        );
        let loading = false;
        let loads = 0;
        const runInTransaction = runtime.runner.runInTransaction.bind(
          runtime.runner,
        );
        using _runInTransaction = stub(
          runtime.runner,
          "runInTransaction",
          ((...args: Parameters<typeof runInTransaction>) => {
            if (!loading) return runInTransaction(...args);
            loads++;
            return Promise.reject(new RetryImmediately("Family loaded"));
          }) as typeof runtime.runner.runInTransaction,
        );
        const coordinator = coordinate(builtin, inputs, parent, output, false);

        tx = runtime.edit();
        expect(coordinator.action(tx)).toBeUndefined();
        await commit(tx);
        await storage.synced();
        expect(setups).toBe(2);

        tx = runtime.edit();
        inputs.withTx(tx).key("list").set([second, first]);
        await commit(tx);

        tx = runtime.edit();
        loading = true;
        const loadingPass = coordinator.action(tx);
        loading = false;
        await expect(loadingPass).rejects.toBeInstanceOf(RetryImmediately);
        expect(loads).toBe(2);
        expect(setups).toBe(2);
        tx.abort("retried in a fresh transaction");

        tx = runtime.edit();
        expect(coordinator.action(tx)).toBeUndefined();
        await commit(tx);
        expect(setups).toBe(4);
      });
    }
  });

  describe("a reused element whose result is awaited", () => {
    // A moved element's setup written while its result document is still
    // being awaited could not land, so the reconcile owes it instead, and
    // issues it on the first pass after the wait ends.

    for (const [name, builtin, schema] of BUILTINS.slice(1)) {
      it(`owes a moved ${name} element's setup until its result arrives`, async () => {
        const op = indexUsingOp();
        let tx = runtime.edit();
        const first = runtime.getCell<number>(space, "first", undefined, tx);
        const second = runtime.getCell<number>(space, "second", undefined, tx);
        first.set(1);
        second.set(2);
        const inputs = runtime.getCell<Inputs>(
          space,
          `${name}-await-inputs`,
          undefined,
          tx,
        );
        inputs.set({ list: [first, second], op });
        const parent = runtime.getCell(space, `${name}-await`, undefined, tx);
        const output = runtime.getCell(space, `${name}-await-output`)
          .getAsNormalizedFullLink();
        const plan = listCoordinatorPlan(
          runtime,
          tx,
          name,
          inputs,
          schema,
          parent,
          output,
        );
        plan.container.set([]);
        const children = new Set(
          [...plan.elementKeys.values()].map((key) =>
            listElementResultCell(runtime, tx, name, plan.container, key)
              .getAsNormalizedFullLink().id
          ),
        );
        await commit(tx);

        const release = Promise.withResolvers<void>();
        const storageManager = runtime.storageManager;
        const original = storageManager.syncCell;
        using _hold = stub(
          storageManager,
          "syncCell",
          function <T>(cell: Cell<T>, ...rest: unknown[]): Promise<Cell<T>> {
            return children.has(cell.getAsNormalizedFullLink().id)
              ? release.promise.then(() => cell)
              : Reflect.apply(original, storageManager, [cell, ...rest]);
          },
        );
        let setups = 0;
        using _run = stub(
          runtime.runner,
          "run",
          ((...args: unknown[]) => {
            setups++;
            return args[3];
          }) as typeof runtime.runner.run,
        );
        const coordinator = coordinate(builtin, inputs, parent, output, true);

        tx = runtime.edit();
        coordinator.action(tx);
        await commit(tx);
        expect(setups).toBe(2);

        tx = runtime.edit();
        inputs.withTx(tx).key("list").set([second, first]);
        await commit(tx);
        tx = runtime.edit();
        coordinator.action(tx);
        await commit(tx);
        expect(setups).toBe(2);

        release.resolve();
        await storage.synced();
        tx = runtime.edit();
        coordinator.action(tx);
        await commit(tx);
        expect(setups).toBe(4);
      });
    }
  });
});
