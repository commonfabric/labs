import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";

import { Identity } from "@commonfabric/identity";
import { StorageManager } from "@commonfabric/runner/storage/cache.deno";

import { equalsKey } from "../../src/builder/equals-key.ts";
import { popFrame, pushFrame } from "../../src/builder/pattern.ts";
import type { Cell } from "../../src/cell.ts";
import { Runtime } from "../../src/runtime.ts";
import type {
  IExtendedStorageTransaction,
  MemorySpace,
} from "../../src/storage/interface.ts";
import { createTrustedBuilder } from "../support/trusted-builder.ts";

const signer = await Identity.fromPassphrase("equals-key operator");
const space = signer.did() as MemorySpace;

describe("equalsKey()", () => {
  let storageManager: ReturnType<typeof StorageManager.emulate>;
  let runtime: Runtime;
  let tx: IExtendedStorageTransaction;
  let target: Cell<unknown>;
  let alias: Cell<unknown>;
  let other: Cell<unknown>;

  beforeEach(() => {
    storageManager = StorageManager.emulate({ as: signer });
    runtime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager,
    });
    tx = runtime.edit();
    target = runtime.getCell<unknown>(space, "target", undefined, tx);
    target.set({ title: "Target" });
    alias = runtime.getCell<unknown>(space, "alias", undefined, tx);
    alias.set(target);
    other = runtime.getCell<unknown>(space, "other", undefined, tx);
    other.set({ title: "Other" });
  });

  afterEach(async () => {
    tx.abort();
    await runtime?.dispose();
    await storageManager?.close();
  });

  /** Runs `fn` in a `lift()` frame reading through `tx`. */
  const inLift = <T>(fn: () => T): T => {
    const frame = pushFrame({ runtime, tx, space, frameKind: "lift" });
    try {
      return fn();
    } finally {
      popFrame(frame);
    }
  };

  it("returns one key for a cell and an alias of it in a frame with a transaction", () => {
    inLift(() => {
      expect(equalsKey(alias)).toBe(equalsKey(target));
      expect(equalsKey(other)).not.toBe(equalsKey(target));
    });
  });

  it("returns equal keys exactly where `equals()` returns `true`", () => {
    const { equals } = createTrustedBuilder(runtime).commonfabric;
    const cells = [target, alias, other, target.key("title")];
    inLift(() => {
      for (const a of cells) {
        for (const b of cells) {
          expect(equalsKey(a) === equalsKey(b)).toBe(equals(a, b));
        }
      }
    });
  });

  it("returns the key of the link as given outside a frame with a transaction", () => {
    expect(equalsKey(target)).toBe(equalsKey(target.getAsLink()));
    expect(equalsKey(alias)).not.toBe(equalsKey(target));
  });

  it("returns `undefined` for a value with no place in the graph", () => {
    inLift(() => {
      expect(equalsKey({ title: "Target" })).toBeUndefined();
      expect(equalsKey(undefined)).toBeUndefined();
    });
  });

  it("is the function the pattern surface binds", () => {
    expect(createTrustedBuilder(runtime).commonfabric.equalsKey).toBe(
      equalsKey,
    );
  });
});
