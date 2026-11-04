import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { Identity } from "@commonfabric/identity";
import {
  FabricUnavailable,
  UNAVAILABLE_PENDING,
  UNAVAILABLE_SYNCING,
  unavailableError,
  unavailableMismatch,
} from "@commonfabric/data-model/availability";
import { StorageManager } from "@commonfabric/runner/storage/cache.deno";

import type { Cell } from "../../src/cell.ts";
import type { RuntimeProgram } from "../../src/harness/types.ts";
import type { NormalizedFullLink } from "../../src/link-types.ts";
import { parseLink } from "../../src/link-utils.ts";
import { Runtime } from "../../src/runtime.ts";
import { getTransactionReadActivities } from "../../src/storage/transaction-inspection.ts";

const signer = await Identity.fromPassphrase("forward-reference");
const space = signer.did();

/**
 * Each pattern returns one of its inputs through a forwarding builtin. `count`
 * declares a default and is never written, so what a reader of `v` sees is
 * what the forwarded reference carries.
 */
const SOURCE = `import { pattern, type Default } from "commonfabric";
interface Input {
  count: number | Default<0>;
  on: boolean | Default<true>;
  off: boolean | Default<false>;
}
export const Ternary = pattern<Input>(({ count, on }) => ({ v: on ? count : 1 }));
export const And = pattern<Input>(({ count, on }) => ({ v: on && count }));
export const Or = pattern<Input>(({ count, off }) => ({ v: off || count }));
`;

/** The builtin each export lowers to, and the export's name. */
const builtins = [
  { builtin: "ifElse", exportName: "Ternary" },
  { builtin: "when", exportName: "And" },
  { builtin: "unless", exportName: "Or" },
] as const;

describe("forward-reference", () => {
  let storageManager: ReturnType<typeof StorageManager.emulate>;
  let runtime: Runtime;
  let cancels: (() => void)[];

  beforeEach(() => {
    storageManager = StorageManager.emulate({ as: signer });
    runtime = new Runtime({ apiUrl: new URL(import.meta.url), storageManager });
    cancels = [];
  });

  afterEach(async () => {
    for (const cancel of cancels) cancel();
    await runtime.idle();
    await runtime.storageManager.synced();
    await runtime.dispose();
    await storageManager.close();
  });

  /**
   * Runs `exportName` over `argument`, an existing cell the runtime writes
   * nothing into. Returns the result cell, which carries no schema, and the
   * pattern's result schema.
   */
  async function run(exportName: string, argument: Record<string, unknown>) {
    const program: RuntimeProgram = {
      main: "/main.tsx",
      mainExport: exportName,
      files: [{ name: "/main.tsx", contents: SOURCE }],
    };
    const tx = runtime.edit();
    const pattern = await runtime.patternManager.compilePattern(program, {
      space,
      tx,
    });
    const result = runtime.getCell<{ v: number }>(
      space,
      `result ${exportName}`,
      undefined,
      tx,
    );
    const argumentCell = runtime.getCell<any>(
      space,
      `argument ${exportName}`,
      undefined,
      tx,
    );
    argumentCell.setRaw(argument);
    const typed = runtime.run(tx, pattern, argumentCell as never, result);
    await tx.commit().settled;
    cancels.push(typed.sink(() => {}));
    await runtime.settled();
    await runtime.idle();
    return { result, argumentCell, resultSchema: pattern.resultSchema! };
  }

  /**
   * The reference the builtin wrote: `v` redirects to the node's output slot,
   * which links to the cell the builtin owns, which holds the reference.
   */
  function forwardedReference(result: Cell<{ v: number }>): NormalizedFullLink {
    const raw = result.getRaw() as { v: unknown };
    const slot = parseLink(raw.v, result.getAsNormalizedFullLink())!;
    const slotRaw = runtime.getCellFromLink({ ...slot, schema: undefined })
      .getRaw();
    const owned = parseLink(slotRaw, { ...slot, schema: undefined })!;
    const ownedRaw = runtime.getCellFromLink({
      ...owned,
      schema: undefined,
      path: [],
    }).getRaw();
    return parseLink(ownedRaw, { ...owned, schema: undefined, path: [] })!;
  }

  for (const { builtin, exportName } of builtins) {
    describe(`\`${builtin}\` forwarding an input the argument does not hold`, () => {
      it("writes a reference that carries the input's schema", async () => {
        const { result } = await run(exportName, {});
        expect(forwardedReference(result).schema).toBeDefined();
      });

      it("reads the input's default through the pattern's result schema", async () => {
        const { result, resultSchema } = await run(exportName, {});
        expect(result.asSchema(resultSchema).get().v).toBe(0);
      });

      it("reads the input's default by the field's own path", async () => {
        const { result } = await run(exportName, {});
        expect(result.key("v").asSchema({ type: "number" }).get()).toBe(0);
      });

      it("propagates native condition states instead of a schema default and recovers", async () => {
        const conditionKey = exportName === "Or" ? "off" : "on";
        const { result, argumentCell } = await run(exportName, {});
        const states = [
          UNAVAILABLE_PENDING,
          UNAVAILABLE_SYNCING,
          unavailableError(new Error("condition failed")),
          unavailableMismatch("condition must be boolean"),
        ];
        for (const state of states) {
          const tx = runtime.edit();
          argumentCell.withTx(tx).key(conditionKey).setRaw(state);
          runtime.prepareTxForCommit(tx);
          expect((await tx.commit().settled).error).toBeUndefined();
          await runtime.settled();
          const unavailable = result.key("v").resolveAsCell().getRaw();
          expect(unavailable).toBeInstanceOf(FabricUnavailable);
          expect(unavailable).toEqual(state);

          const recoveryTx = runtime.edit();
          argumentCell.withTx(recoveryTx).key(conditionKey).set(
            exportName !== "Or",
          );
          runtime.prepareTxForCommit(recoveryTx);
          expect((await recoveryTx.commit().settled).error).toBeUndefined();
          await runtime.settled();
          expect(result.key("v").asSchema({ type: "number" }).get()).toBe(0);
          expect(forwardedReference(result).schema).toBeDefined();
        }
      });
    });
  }

  describe("a forwarded input whose document the replica lacks", () => {
    // The input's own default stands in, as it does for a reader of the input
    // itself, and the document's read is registered so the reader runs again
    // when it arrives.

    it("reads the default and registers the document's read, in both modes", async () => {
      const missing = runtime.getCell(space, "missing count", undefined);
      const { result, resultSchema } = await run("Ternary", {
        count: missing.getAsLink(),
      });
      const missingId = missing.getAsNormalizedFullLink().id;
      for (const lazy of [false, true]) {
        const tx = runtime.edit();
        tx.markLazyMaterialize(lazy);
        try {
          const value = result.asSchema(resultSchema).withTx(tx).get();
          expect(value.v).toBe(0);
          const reads = [...(getTransactionReadActivities(tx) ?? [])];
          expect(reads.some((activity) => activity.id === missingId)).toBe(
            true,
          );
        } finally {
          await tx.commit().settled;
        }
      }
    });
  });
});
