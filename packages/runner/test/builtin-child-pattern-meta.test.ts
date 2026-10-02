import { expect } from "@std/expect";
import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";

import type { OpaqueCell } from "@commonfabric/api";
import { Identity } from "@commonfabric/identity";

import type { Cell } from "../src/cell.ts";
import { getMetaLink } from "../src/link-utils.ts";
import { Runtime } from "../src/runtime.ts";
import { StorageManager } from "../src/storage/cache.deno.ts";
import type { IExtendedStorageTransaction } from "../src/storage/interface.ts";
import { createTrustedBuilder } from "./support/trusted-builder.ts";

const signer = await Identity.fromPassphrase("builtin child pattern meta");
const space = signer.did();

describe("builtin-child-pattern-meta", () => {
  // A builtin's parent cell is the result cell of the piece running it, so a
  // key named `pattern` on that parent is the pattern author's own output.
  // Each case gives the parent result such a key, runs a list builtin, and
  // reads the `pattern` meta field of a cell the builtin minted. The cell's
  // value is read beside it, which pins the document under assertion as that
  // cell rather than a link along the way to it.

  let storageManager: ReturnType<typeof StorageManager.emulate>;
  let runtime: Runtime;
  let tx: IExtendedStorageTransaction;
  let pattern: ReturnType<
    typeof createTrustedBuilder
  >["commonfabric"]["pattern"];

  beforeEach(() => {
    storageManager = StorageManager.emulate({ as: signer });
    runtime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager,
    });
    tx = runtime.edit();
    ({ pattern } = createTrustedBuilder(runtime).commonfabric);
  });

  afterEach(async () => {
    if (tx.status().status === "ready") {
      runtime.prepareTxForCommit(tx);
      await tx.commit();
    }
    await runtime?.dispose();
    await storageManager?.close();
  });

  /**
   * Runs `apply` over the list `[1, 2]` inside a piece whose result also
   * carries `pattern: "^[a-z]+$"`, and returns that result cell once the
   * builtin has settled. Each element's op returns `{ element }`.
   */
  async function runListBuiltin(
    name: string,
    apply: (values: OpaqueCell<number[]>, op: unknown) => unknown,
  ): Promise<Cell<{ pattern: string; out: unknown[] }>> {
    // deno-lint-ignore no-explicit-any
    const op = pattern(({ element }: any) => ({ element }));
    const parentPattern = pattern<{ values: number[] }>(({ values }) => ({
      pattern: "^[a-z]+$",
      out: apply(values as unknown as OpaqueCell<number[]>, op),
    }));
    const resultCell = runtime.getCell<{ pattern: string; out: unknown[] }>(
      space,
      `${name} parent with a pattern key`,
      undefined,
      tx,
    );
    const result = runtime.run(
      tx,
      parentPattern,
      { values: [1, 2] },
      resultCell,
    );
    runtime.prepareTxForCommit(tx);
    await tx.commit();
    tx = runtime.edit();
    await result.pull();
    await runtime.idle();
    expect(result.key("pattern").get()).toBe("^[a-z]+$");
    return result;
  }

  /** Expects no `pattern` meta field on the container `result.out` links to. */
  function expectContainerUnmarked(
    result: Cell<{ pattern: string; out: unknown[] }>,
  ): void {
    const container = result.key("out").resolveAsCell();

    expect(container.get()).toHaveLength(2);
    expect(getMetaLink(container, "result")?.id).toBe(
      result.getAsNormalizedFullLink().id,
    );
    expect(container.getMetaRaw("pattern")).toBeUndefined();
  }

  /** Expects no `pattern` meta field on the first element's result cell. */
  function expectElementUnmarked(
    result: Cell<{ pattern: string; out: unknown[] }>,
  ): void {
    const element = result.key("out").resolveAsCell().key(0).resolveAsCell();

    expect(element.get()).toEqual({ element: 1 });
    expect(element.getMetaRaw("pattern")).toBeUndefined();
  }

  describe("map", () => {
    const apply = (values: OpaqueCell<number[]>, op: unknown) =>
      // deno-lint-ignore no-explicit-any
      values.mapWithPattern(op as any, {});

    it("leaves the result container's `pattern` meta field unwritten", async () => {
      expectContainerUnmarked(await runListBuiltin("map", apply));
    });

    it("leaves an element's result cell's `pattern` meta field unwritten", async () => {
      expectElementUnmarked(await runListBuiltin("map", apply));
    });
  });

  describe("filter", () => {
    // A filter's container links to the elements it keeps rather than to the
    // result cells its predicate runs write, so the container is the one cell
    // here a case can reach.

    const apply = (values: OpaqueCell<number[]>, op: unknown) =>
      // deno-lint-ignore no-explicit-any
      values.filterWithPattern(op as any, {});

    it("leaves the result container's `pattern` meta field unwritten", async () => {
      expectContainerUnmarked(await runListBuiltin("filter", apply));
    });
  });

  describe("flatMap", () => {
    const apply = (values: OpaqueCell<number[]>, op: unknown) =>
      // deno-lint-ignore no-explicit-any
      values.flatMapWithPattern(op as any, {});

    it("leaves the result container's `pattern` meta field unwritten", async () => {
      expectContainerUnmarked(await runListBuiltin("flatMap", apply));
    });

    it("leaves an element's result cell's `pattern` meta field unwritten", async () => {
      expectElementUnmarked(await runListBuiltin("flatMap", apply));
    });
  });
});
