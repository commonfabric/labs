import { expect } from "@std/expect";
import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";

import type { OpaqueCell } from "@commonfabric/api";
import { Identity } from "@commonfabric/identity";

import type { Cell } from "../src/cell.ts";
import { ensurePieceRunningVerdict } from "../src/ensure-piece-running.ts";
import { Runtime } from "../src/runtime.ts";
import { StorageManager } from "../src/storage/cache.deno.ts";
import type { IExtendedStorageTransaction } from "../src/storage/interface.ts";
import { createTrustedBuilder } from "./support/trusted-builder.ts";

const signer = await Identity.fromPassphrase("list element owning root");
const space = signer.did();

describe("list-element-owning-root", () => {
  // A list coordinator runs its op once per element, each run writing its own
  // result cell. An event addressed to a cell inside that run starts the
  // piece whose chain of `result` back-links the element's result cell leads
  // to, which is the piece running the coordinator: starting it is what
  // rebuilds the coordinator and, through it, the element's run. Each case
  // resolves that chain from an element's result cell.

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
   * Runs `apply` over the list `[1, 2]` inside a piece, each element's op
   * returning `{ element }`, and returns that piece's result cell once the
   * builtin has settled.
   */
  async function runListBuiltin(
    name: string,
    apply: (values: OpaqueCell<number[]>, op: unknown) => unknown,
  ): Promise<Cell<{ out: unknown[] }>> {
    // deno-lint-ignore no-explicit-any
    const op = pattern(({ element }: any) => ({ element }));
    const parentPattern = pattern<{ values: number[] }>(({ values }) => ({
      out: apply(values as unknown as OpaqueCell<number[]>, op),
    }));
    const resultCell = runtime.getCell<{ out: unknown[] }>(
      space,
      `${name} owning root parent`,
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
    return result;
  }

  /** Expects the first element's result cell to resolve to `result`'s piece. */
  async function expectElementOwnedByParent(
    result: Cell<{ out: unknown[] }>,
  ): Promise<void> {
    const element = result.key("out").resolveAsCell().key(0).resolveAsCell();
    expect(element.get()).toEqual({ element: 1 });

    const verdict = await ensurePieceRunningVerdict(
      runtime,
      element.getAsNormalizedFullLink(),
    );

    expect(verdict.root?.id).toBe(result.getAsNormalizedFullLink().id);
  }

  describe("map", () => {
    it("resolves an element's result cell to the piece running the coordinator", async () => {
      await expectElementOwnedByParent(
        await runListBuiltin(
          "map",
          (values, op) =>
            // deno-lint-ignore no-explicit-any
            values.mapWithPattern(op as any, {}),
        ),
      );
    });
  });

  describe("flatMap", () => {
    it("resolves an element's result cell to the piece running the coordinator", async () => {
      await expectElementOwnedByParent(
        await runListBuiltin(
          "flatMap",
          (values, op) =>
            // deno-lint-ignore no-explicit-any
            values.flatMapWithPattern(op as any, {}),
        ),
      );
    });
  });
});
