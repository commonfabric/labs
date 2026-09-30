/**
 * What the builder does with a pattern whose result object literal carries a
 * function member (a method) or a getter.
 *
 * A pattern `.tsx` file cannot return either: the ts-transformers
 * pattern-context validation pass rejects object-literal methods, getters and
 * setters. So these tests build the pattern through the builder API directly
 * (`createBuilder()` and then `commonfabric.pattern()`), which is plain
 * function calls and is not run through that validator.
 *
 * Both member kinds throw when the pattern is built, at the point where the
 * builder binds the pattern's result through `withAliasBindings()`
 * (`packages/runner/src/builder/to-encodable-form.ts`). A method is a live
 * function on the result object, and the binding refuses a function that is
 * not a builder artifact. A getter makes the result object something other
 * than an inert plain object, and the binding refuses that as a write does.
 */

import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";

import { Identity } from "@commonfabric/identity";
import { StorageManager } from "@commonfabric/runner/storage/cache.deno";
import { createBuilder } from "../src/builder/factory.ts";
import { createTrustedBuilder } from "./support/trusted-builder.ts";
import { Runtime } from "../src/runtime.ts";
import { type IExtendedStorageTransaction } from "../src/storage/interface.ts";

const signer = await Identity.fromPassphrase("test operator");

describe("Pattern result object with a function member", () => {
  let storageManager: ReturnType<typeof StorageManager.emulate>;
  let runtime: Runtime;
  let tx: IExtendedStorageTransaction;
  let pattern: ReturnType<typeof createBuilder>["commonfabric"]["pattern"];

  const bindBuilder = () => {
    const { commonfabric } = createTrustedBuilder(runtime);
    ({ pattern } = commonfabric);
  };

  beforeEach(() => {
    storageManager = StorageManager.emulate({ as: signer });
    runtime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager,
    });
    tx = runtime.edit();
    bindBuilder();
  });

  async function commitTx() {
    if (tx.status().status !== "ready") {
      return { ok: undefined, error: undefined };
    }
    runtime.prepareTxForCommit(tx);
    return await tx.commit();
  }

  afterEach(async () => {
    await commitTx();
    await runtime?.dispose();
    await storageManager?.close();
  });

  it("throws when the result object carries a method member", () => {
    // The pattern returns an object literal carrying both a plain field and a
    // method. Building it binds the result, which refuses the method: a
    // function that is not a builder artifact has no place in a pattern.

    expect(() =>
      pattern<Record<string, never>>(() => {
        return {
          ok: true,
          read() {
            return 1;
          },
        } as unknown as Record<string, never>;
      })
    ).toThrow("not a builder artifact");
  });

  it("throws when the result object carries a getter member", () => {
    // The pattern returns an object literal carrying both a plain field and a
    // getter. The getter makes the object something other than plain data, so
    // building the pattern refuses it.

    expect(() =>
      pattern<Record<string, never>>(() => {
        return {
          ok: true,
          get derived() {
            return 2;
          },
        } as unknown as Record<string, never>;
      })
    ).toThrow("object that is not an inert plain object");
  });
});
