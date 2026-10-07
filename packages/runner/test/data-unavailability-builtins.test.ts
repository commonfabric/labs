import {
  FabricUnavailable,
  UNAVAILABLE_PENDING,
  UNAVAILABLE_SYNCING,
  unavailableError,
  unavailableMismatch,
} from "@commonfabric/data-model/availability";
import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";

import type { OpaqueCell } from "@commonfabric/api";

import { Identity } from "@commonfabric/identity";
import { StorageManager } from "@commonfabric/runner/storage/cache.deno";

import type { JSONSchema } from "../src/builder/types.ts";
import { type Cell, createCell } from "../src/cell.ts";
import { createBuilder } from "../src/builder/factory.ts";
import { parseLink } from "../src/link-utils.ts";
import { Runtime } from "../src/runtime.ts";
import type { IExtendedStorageTransaction } from "../src/storage/interface.ts";
import { createTrustedBuilder } from "./support/trusted-builder.ts";

const signer = await Identity.fromPassphrase(
  "data unavailability builtins test",
);
const space = signer.did();

const numberSchema = {
  type: "number",
} as const satisfies JSONSchema;

const booleanSchema = {
  type: "boolean",
} as const satisfies JSONSchema;

const numberArraySchema = {
  type: "array",
  items: numberSchema,
} as const satisfies JSONSchema;

const numberElementArgumentSchema = {
  type: "object",
  properties: {
    element: numberSchema,
  },
  required: ["element"],
  additionalProperties: false,
} as const satisfies JSONSchema;

describe("raw builtin data unavailability propagation", () => {
  let storageManager: ReturnType<typeof StorageManager.emulate>;
  let runtime: Runtime;
  let tx: IExtendedStorageTransaction;
  let pattern: ReturnType<typeof createBuilder>["commonfabric"]["pattern"];
  let lift: ReturnType<typeof createBuilder>["commonfabric"]["lift"];
  let ifElse: ReturnType<typeof createBuilder>["commonfabric"]["ifElse"];
  let when: ReturnType<typeof createBuilder>["commonfabric"]["when"];
  let unless: ReturnType<typeof createBuilder>["commonfabric"]["unless"];

  beforeEach(() => {
    storageManager = StorageManager.emulate({ as: signer });
    runtime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager,
    });
    tx = runtime.edit();

    const { commonfabric } = createTrustedBuilder(runtime);
    ({ pattern, lift, ifElse, when, unless } = commonfabric);
  });

  afterEach(async () => {
    if (tx.status().status === "ready") {
      runtime.prepareTxForCommit(tx);
      await tx.commit().settled;
    }
    await runtime?.dispose();
    await storageManager?.close();
  });

  async function commitAndPull<T>(result: Cell<T>): Promise<void> {
    runtime.prepareTxForCommit(tx);
    await tx.commit().settled;
    tx = runtime.edit();
    await result.pull();
    await runtime.idle();
  }

  function finalRaw(cell: Cell<any>): unknown {
    return cell.resolveAsCell().getRaw();
  }

  function unaryNumberListOpPattern(
    fn: (element: any) => any,
    resultSchema: JSONSchema,
  ) {
    return pattern<{ element: number }, unknown>(
      ({ element }) => fn(element),
      numberElementArgumentSchema,
      resultSchema,
    );
  }

  it("propagates an unavailable condition through control builtins", async () => {
    const marker = UNAVAILABLE_PENDING;
    const Root = pattern<{ condition: boolean }>(({ condition }) => ({
      ifElse: ifElse(condition, "yes", "no"),
      when: when(condition, "yes"),
      unless: unless(condition, "no"),
    }));
    const resultCell = runtime.getCell<any>(
      space,
      "unavailable control condition",
      undefined,
      tx,
    );
    const result = runtime.run(
      tx,
      Root,
      { condition: marker as unknown as boolean },
      resultCell,
    );

    await commitAndPull(result);

    expect(finalRaw(result.key("ifElse"))).toBe(marker);
    expect(finalRaw(result.key("when"))).toBe(marker);
    expect(finalRaw(result.key("unless"))).toBe(marker);
  });

  it("keeps user-scoped control result stores through unavailable states and recovery", async () => {
    const conditionBase = runtime.getCell<boolean>(
      space,
      "scoped unavailable condition",
      undefined,
      tx,
    );
    const condition = createCell<boolean>(runtime, {
      ...conditionBase.getAsNormalizedFullLink(),
      scope: "user",
    }, tx);
    condition.setRawUntyped(UNAVAILABLE_PENDING);
    const Root = pattern<{ condition: boolean }>(({ condition }) => ({
      ifElse: ifElse(condition, "yes", "no"),
      when: when(condition, "yes"),
      unless: unless(condition, "no"),
    }));
    const resultCell = runtime.getCell<any>(
      space,
      "scoped unavailable control results",
      undefined,
      tx,
    );
    const result = runtime.run(tx, Root, { condition }, resultCell);
    await commitAndPull(result);
    const names = ["ifElse", "when", "unless"] as const;
    const store = (name: typeof names[number]) => {
      const cell = result.key(name);
      return parseLink(cell.getRaw({ lastNode: "writeRedirect" }), cell);
    };
    const before = names.map(store);
    for (const link of before) {
      expect(link?.id).toBeDefined();
      expect(link?.scope).toBe("user");
    }
    for (
      const marker of [
        UNAVAILABLE_PENDING,
        UNAVAILABLE_SYNCING,
        unavailableError(new Error("scoped condition failed")),
        unavailableMismatch("scoped condition must be boolean"),
      ]
    ) {
      condition.withTx(tx).setRawUntyped(marker);
      await commitAndPull(result);
      for (const name of names) {
        expect(finalRaw(result.key(name))).toBeInstanceOf(FabricUnavailable);
        expect(finalRaw(result.key(name))).toEqual(marker);
      }
      condition.withTx(tx).set(true);
      await commitAndPull(result);
      expect(result.key("ifElse").get()).toBe("yes");
      expect(result.key("when").get()).toBe("yes");
      expect(result.key("unless").get()).toBe(true);
      for (const [index, name] of names.entries()) {
        expect(store(name)?.id).toBe(before[index]?.id);
        expect(store(name)?.scope).toBe("user");
      }
    }
  });

  it("publishes syncing while a linked condition establishes coverage", async () => {
    const missingCondition = runtime.getCell<boolean>(
      space,
      "missing linked control condition",
    );
    const missingConditionId = missingCondition.getAsNormalizedFullLink().id;
    const provider = storageManager.open(space);
    const originalSync = provider.sync.bind(provider);
    const started = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    provider.sync = async (id, selector, scope, instance) => {
      if (id === missingConditionId) {
        started.resolve();
        await release.promise;
      }
      return await originalSync(id, selector, scope, instance);
    };

    try {
      const Root = pattern<{ condition: boolean }>(({ condition }) => ({
        ifElse: ifElse(condition, "yes", "no"),
        when: when(condition, "yes"),
        unless: unless(condition, "no"),
      }));
      const resultCell = runtime.getCell<any>(
        space,
        "missing linked control outputs",
        undefined,
        tx,
      );
      const inputs = runtime.getCell<{ condition: boolean }>(
        space,
        "linked control inputs",
        Root.argumentSchema,
        tx,
      );
      inputs.set({ condition: false });
      const result = runtime.run(tx, Root, inputs, resultCell);

      runtime.prepareTxForCommit(tx);
      await tx.commit().settled;
      tx = runtime.edit();
      await result.pull();

      inputs.withTx(tx).key("condition").setRawUntyped(
        missingCondition.getAsLink(),
      );
      runtime.prepareTxForCommit(tx);
      await tx.commit().settled;
      tx = runtime.edit();
      const pull = result.pull();
      await started.promise;
      await runtime.idle();

      expect(finalRaw(result.key("ifElse"))).toBe(
        UNAVAILABLE_SYNCING,
      );
      expect(finalRaw(result.key("when"))).toBe(UNAVAILABLE_SYNCING);
      expect(finalRaw(result.key("unless"))).toBe(UNAVAILABLE_SYNCING);

      release.resolve();
      await storageManager.synced();
      await pull;
      await runtime.idle();
      tx.abort();
      tx = runtime.edit();

      const current = result.withTx(tx);
      expect(current.key("ifElse").get()).toBe("no");
      expect(current.key("when").resolveAsCell().getRaw()).toBeUndefined();
      expect(current.key("unless").get()).toBe("no");
    } finally {
      release.resolve();
      provider.sync = originalSync;
    }
  });

  it("does not propagate an unavailable unselected ifElse branch", async () => {
    const ignored = unavailableError(new Error("unselected"));
    const Root = pattern<{
      condition: boolean;
      selected: string;
      ignored: string;
    }>(({ condition, selected, ignored }) => ({
      out: ifElse(condition, selected, ignored),
    }));
    const resultCell = runtime.getCell<any>(
      space,
      "unavailable unselected branch",
      undefined,
      tx,
    );
    const result = runtime.run(tx, Root, {
      condition: true,
      selected: "selected",
      ignored: ignored as unknown as string,
    }, resultCell);

    await commitAndPull(result);

    expect(result.key("out").get()).toBe("selected");
  });

  it("propagates a whole-list marker without invoking list callbacks", async () => {
    const marker = UNAVAILABLE_SYNCING;
    let mapCalls = 0;
    let filterCalls = 0;
    let flatMapCalls = 0;
    const mapOp = unaryNumberListOpPattern(
      (element) =>
        lift((value: number) => {
          mapCalls++;
          return value * 2;
        })(element),
      numberSchema,
    );
    const filterOp = unaryNumberListOpPattern(
      (element) =>
        lift((value: number) => {
          filterCalls++;
          return value > 0;
        })(element),
      booleanSchema,
    );
    const flatMapOp = unaryNumberListOpPattern(
      (element) =>
        lift((value: number) => {
          flatMapCalls++;
          return [value, value];
        })(element),
      numberArraySchema,
    );
    const Root = pattern<{ values: number[] }>(({ values }) => {
      const list = values as unknown as OpaqueCell<number[]>;
      return {
        values,
        mapped: list.mapWithPattern(mapOp as any, {}),
        filtered: list.filterWithPattern(filterOp as any, {}),
        flattened: list.flatMapWithPattern(flatMapOp as any, {}),
      };
    });
    const resultCell = runtime.getCell<any>(
      space,
      "unavailable whole list",
      undefined,
      tx,
    );
    const result = runtime.run(tx, Root, {
      values: marker as unknown as number[],
    }, resultCell);

    await commitAndPull(result);

    expect(mapCalls).toBe(0);
    expect(filterCalls).toBe(0);
    expect(flatMapCalls).toBe(0);
    expect(finalRaw(result.key("mapped"))).toBe(marker);
    expect(finalRaw(result.key("filtered"))).toBe(marker);
    expect(finalRaw(result.key("flattened"))).toBe(marker);

    result.withTx(tx).key("values").set([2, 4]);
    await commitAndPull(result);

    expect(mapCalls).toBe(2);
    expect(filterCalls).toBe(2);
    expect(flatMapCalls).toBe(2);
    expect(result.key("mapped").get()).toEqual([4, 8]);
    expect(result.key("filtered").get()).toEqual([2, 4]);
    expect(result.key("flattened").get()).toEqual([2, 2, 4, 4]);
  });

  it("preserves a per-element map marker at its input position", async () => {
    const marker = UNAVAILABLE_PENDING;
    let calls = 0;
    const op = unaryNumberListOpPattern((element) =>
      lift((value: number) => {
        calls++;
        return value * 2;
      })(element), numberSchema);
    const Root = pattern<{ values: number[] }>(({ values }) => ({
      values,
      mapped: (values as unknown as OpaqueCell<number[]>).mapWithPattern(
        op as any,
        {},
      ),
    }));
    const resultCell = runtime.getCell<any>(
      space,
      "unavailable map element",
      undefined,
      tx,
    );
    const result = runtime.run(tx, Root, {
      values: [1, marker as unknown as number, 3],
    }, resultCell);

    await commitAndPull(result);

    expect(calls).toBe(2);
    expect(finalRaw(result.key("mapped").key(0))).toBe(2);
    const mappedMarker = finalRaw(
      result.key("mapped").key(1),
    ) as FabricUnavailable;
    expect(mappedMarker.reason).toBe("pending");
    expect(mappedMarker.isPending()).toBe(true);
    expect(finalRaw(result.key("mapped").key(2))).toBe(6);

    result.withTx(tx).key("values").set([1, 2, 3]);
    await commitAndPull(result);

    expect(calls).toBe(3);
    expect(result.key("mapped").get()).toEqual([2, 4, 6]);
  });

  it("promotes an unavailable filter predicate to the aggregate", async () => {
    const marker = unavailableError(new Error("predicate failed"));
    let calls = 0;
    const op = unaryNumberListOpPattern((element) =>
      lift((value: number) => {
        calls++;
        return value > 0;
      })(element), booleanSchema);
    const Root = pattern<{ values: number[] }>(({ values }) => ({
      values,
      filtered: (values as unknown as OpaqueCell<number[]>).filterWithPattern(
        op as any,
        {},
      ),
    }));
    const resultCell = runtime.getCell<any>(
      space,
      "unavailable filter predicate",
      undefined,
      tx,
    );
    const result = runtime.run(tx, Root, {
      values: [1, marker as unknown as number, 3],
    }, resultCell);

    await commitAndPull(result);

    expect(calls).toBe(2);
    const output = finalRaw(result.key("filtered")) as FabricUnavailable;
    expect(output.reason).toBe("error");
    expect(output.errorMessage).toBe("predicate failed");

    result.withTx(tx).key("values").set([1, 2, 3]);
    await commitAndPull(result);

    expect(calls).toBe(3);
    expect(result.key("filtered").get()).toEqual([1, 2, 3]);
  });

  it("promotes an unavailable flatMap child to the aggregate", async () => {
    const marker = UNAVAILABLE_PENDING;
    let calls = 0;
    const op = unaryNumberListOpPattern((element) =>
      lift((value: number) => {
        calls++;
        return [value, value * 10];
      })(element), numberArraySchema);
    const Root = pattern<{ values: number[] }>(({ values }) => ({
      values,
      flattened: (values as unknown as OpaqueCell<number[]>).flatMapWithPattern(
        op as any,
        {},
      ),
    }));
    const resultCell = runtime.getCell<any>(
      space,
      "unavailable flatMap child",
      undefined,
      tx,
    );
    const result = runtime.run(tx, Root, {
      values: [1, marker as unknown as number, 3],
    }, resultCell);

    await commitAndPull(result);

    expect(calls).toBe(2);
    const flattenedMarker = finalRaw(
      result.key("flattened"),
    ) as FabricUnavailable;
    expect(flattenedMarker.reason).toBe("pending");
    expect(flattenedMarker.isPending()).toBe(true);

    result.withTx(tx).key("values").set([1, 2, 3]);
    await commitAndPull(result);

    expect(calls).toBe(3);
    expect(result.key("flattened").get()).toEqual([1, 10, 2, 20, 3, 30]);
  });

  it("selects aggregate markers by precedence then input order", async () => {
    const firstError = unavailableError(new Error("first"));
    const secondError = unavailableError(new Error("second"));
    const op = unaryNumberListOpPattern(
      (element) => lift((value: number) => value > 0)(element),
      booleanSchema,
    );
    const Root = pattern<{ values: number[] }>(({ values }) => ({
      filtered: (values as unknown as OpaqueCell<number[]>).filterWithPattern(
        op as any,
        {},
      ),
    }));
    const resultCell = runtime.getCell<any>(
      space,
      "unavailable aggregate precedence",
      undefined,
      tx,
    );
    const result = runtime.run(tx, Root, {
      values: [
        unavailableMismatch() as unknown as number,
        UNAVAILABLE_PENDING as unknown as number,
        firstError as unknown as number,
        secondError as unknown as number,
        UNAVAILABLE_SYNCING as unknown as number,
      ],
    }, resultCell);

    await commitAndPull(result);

    const output = finalRaw(result.key("filtered")) as FabricUnavailable;
    expect(output.reason).toBe("error");
    expect(output.errorKind).toBe("schemaMismatch");
  });
});
