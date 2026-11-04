import { UNAVAILABLE_PENDING } from "@commonfabric/data-model/availability";
import { assertEquals, assertRejects } from "@std/assert";

import { Identity } from "@commonfabric/identity";
import { type Cell, Runtime } from "@commonfabric/runner";
import { StorageManager } from "@commonfabric/runner/storage/cache.deno";
import { materializeTestVDOM } from "../lib/materialize-test-vdom.ts";

Deno.test("materializeTestVDOM reports reconciliation errors after mounting", async () => {
  const signer = await Identity.fromPassphrase("cli materialize vdom test");
  const storageManager = StorageManager.emulate({ as: signer });
  const runtime = new Runtime({
    storageManager,
    apiUrl: new URL("http://localhost"),
  });
  const dummyCell = runtime.getCell(
    signer.did(),
    "materialize-vdom-dummy",
    undefined,
    runtime.edit(),
  );
  const CellImpl = dummyCell.constructor;

  class MockCell extends (CellImpl as any) {
    #subscribers = new Set<(value: unknown) => void>();

    constructor(private value: unknown) {
      super(runtime, undefined, undefined, false, undefined, "cell");
    }

    pull(): Promise<unknown> {
      return Promise.resolve(this.value);
    }

    asSchema(): this {
      return this;
    }

    get(): unknown {
      return this.value;
    }

    sink(callback: (value: unknown) => void): () => void {
      this.#subscribers.add(callback);
      callback(this.value);
      return () => this.#subscribers.delete(callback);
    }

    set(value: unknown): void {
      this.value = value;
      for (const subscriber of this.#subscribers) subscriber(value);
    }
  }

  const root = new MockCell(["ready"]);
  try {
    root.set(UNAVAILABLE_PENDING);
    await materializeTestVDOM(
      root as unknown as Cell<unknown>,
      () => Promise.resolve(),
    );

    root.set(["ready"]);
    const error = await assertRejects(
      () =>
        materializeTestVDOM(root as unknown as Cell<unknown>, () => {
          root.set({ invalid: true });
          return Promise.resolve();
        }),
      Error,
      "VDOM materialization failed: Invalid VDOM content",
    );
    assertEquals(
      error.cause instanceof Error && error.cause.message,
      "Invalid VDOM content: expected WorkerVNode, string, or number, got object",
    );
  } finally {
    await runtime.dispose();
    await storageManager.close();
  }
});
