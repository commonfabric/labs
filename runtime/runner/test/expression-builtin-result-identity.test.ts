/**
 * Expression result-store identity across branch-literal edits at a fixed
 * output spot, with condition-scoped storage and a required output binding.
 */

import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";

import { Identity } from "@commonfabric/identity";
import { StorageManager } from "@commonfabric/runner/storage/cache.deno";

import type { NodeFactory } from "../src/builder/types.ts";
import { ownedResultCause } from "../src/builtins/scope-policy.ts";
import { type Cell, createCell } from "../src/cell.ts";
import { parseLink } from "../src/link-utils.ts";
import { Runtime } from "../src/runtime.ts";
import { createTrustedBuilder } from "./support/trusted-builder.ts";

const signer = await Identity.fromPassphrase("test operator");
const space = signer.did();

type Builder = ReturnType<typeof createTrustedBuilder>["commonfabric"];
type Root = NodeFactory<{ condition: boolean }, { value: unknown }>;

/**
 * Runs `first` into a fresh piece over a user-scoped `condition`, then edits
 * the piece to `second`, and returns the link stored in the `value` spot after
 * each run together with the value it resolved to.
 */
async function acrossEdit(
  op: string,
  condition: boolean,
  build: (builder: Builder) => { first: Root; second: Root },
) {
  const storageManager = StorageManager.emulate({ as: signer });
  const runtime = new Runtime({
    apiUrl: new URL(import.meta.url),
    storageManager,
  });
  const tx = runtime.edit();
  try {
    const { first, second } = build(createTrustedBuilder(runtime).commonfabric);
    const conditionBase = runtime.getCell<boolean>(
      space,
      `${op} result identity condition`,
      undefined,
      tx,
    );
    const conditionCell = createCell<boolean>(
      runtime,
      { ...conditionBase.getAsNormalizedFullLink(), scope: "user" },
      tx,
    );
    conditionCell.set(condition);
    const resultCell = runtime.getCell<{ value: unknown }>(
      space,
      `${op} result identity`,
      undefined,
      tx,
    );
    const stored = (result: Cell<{ value: unknown }>) => {
      const link = parseLink(
        result.key("value").getRaw({ lastNode: "writeRedirect" }),
        result,
      );
      return {
        id: link?.id,
        scope: link?.scope,
        value: result.key("value").get(),
      };
    };

    const result = runtime.run(
      tx,
      first,
      { condition: conditionCell },
      resultCell,
    );
    runtime.prepareTxForCommit(tx);
    await tx.commit().settled;
    await runtime.idle();
    await runtime.storageManager.synced();
    await result.pull();
    const before = stored(result);

    const editTx = runtime.edit();
    const edited = runtime.run(
      editTx,
      second,
      { condition: conditionCell },
      resultCell,
    );
    runtime.prepareTxForCommit(editTx);
    await editTx.commit().settled;
    await runtime.idle();
    await runtime.storageManager.synced();
    await edited.pull();
    const after = stored(edited);
    return { before, after };
  } finally {
    await runtime.dispose();
    await storageManager.close();
  }
}

describe("expression-builtin-result-identity", () => {
  it("keeps the `ifElse()` result store when branch literals change", async () => {
    const { before, after } = await acrossEdit(
      "ifElse",
      true,
      ({ ifElse, pattern }) => ({
        first: pattern<{ condition: boolean }>(({ condition }) => ({
          value: ifElse(condition, "left-1", "right-1"),
        })),
        second: pattern<{ condition: boolean }>(({ condition }) => ({
          value: ifElse(condition, "left-2", "right-2"),
        })),
      }),
    );
    expect(before.value).toBe("left-1");
    expect(after.value).toBe("left-2");
    // The store follows the condition's scope (scoped-cell-instances.md).
    expect(before.scope).toBe("user");
    expect(after.scope).toBe("user");
    expect(after.id).toBe(before.id);
  });

  it("keeps the `when()` result store when its value literal changes", async () => {
    const { before, after } = await acrossEdit(
      "when",
      true,
      ({ when, pattern }) => ({
        first: pattern<{ condition: boolean }>(({ condition }) => ({
          value: when(condition, "value-1"),
        })),
        second: pattern<{ condition: boolean }>(({ condition }) => ({
          value: when(condition, "value-2"),
        })),
      }),
    );
    expect(before.value).toBe("value-1");
    expect(after.value).toBe("value-2");
    expect(before.scope).toBe("user");
    expect(after.id).toBe(before.id);
  });

  it("keeps the `unless()` result store when its fallback literal changes", async () => {
    const { before, after } = await acrossEdit(
      "unless",
      false,
      ({ unless, pattern }) => ({
        first: pattern<{ condition: boolean }>(({ condition }) => ({
          value: unless(condition, "fallback-1"),
        })),
        second: pattern<{ condition: boolean }>(({ condition }) => ({
          value: unless(condition, "fallback-2"),
        })),
      }),
    );
    expect(before.value).toBe("fallback-1");
    expect(after.value).toBe("fallback-2");
    expect(before.scope).toBe("user");
    expect(after.id).toBe(before.id);
  });

  it("throws when the output binding has no write redirect", async () => {
    const storageManager = StorageManager.emulate({ as: signer });
    const runtime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager,
    });
    try {
      const piece = runtime.getCell(space, "no output spot");
      const inputs = runtime.getImmutableCell(space, { condition: true });
      // A node whose output binding reaches no write redirect: nothing reads
      // the spot, so nothing can name the store every runtime must share.
      expect(() =>
        ownedResultCause("ifElse", {
          inputs,
          parents: piece.entityId,
        }, piece)
      ).toThrow(
        "ifElse: result store requires a write-redirect output binding",
      );
    } finally {
      await runtime.dispose();
      await storageManager.close();
    }
  });
});
