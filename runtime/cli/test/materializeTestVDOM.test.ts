import { expect } from "@std/expect";
import { Identity } from "@commonfabric/identity";
import { Runtime } from "@commonfabric/runner";
import { StorageManager } from "@commonfabric/runner/storage/cache.deno";
import { describe, it } from "@commonfabric/test-support/test";
import { materializeTestVDOM } from "../lib/materialize-test-vdom.ts";

/**
 * Runs `body` with a cell holding the view `"hello"`, and a function that
 * replaces that view with `next` and waits for the runtime to go idle.
 */
async function withView(
  body: (
    view: ReturnType<Runtime["getCell"]>,
    replace: (next: string | { type: string; name: string }) => Promise<void>,
  ) => Promise<void>,
): Promise<void> {
  const signer = await Identity.fromPassphrase("materialize-test-vdom");
  const space = signer.did();
  const runtime = new Runtime({
    apiUrl: new URL(import.meta.url),
    storageManager: StorageManager.emulate({ as: signer }),
  });
  try {
    const view = runtime.getCell<unknown>(space, "view");
    const replace = async (next: string | { type: string; name: string }) => {
      const tx = runtime.edit();
      view.withTx(tx).setRawUntyped(next);
      await tx.commit().settled;
      await runtime.idle();
    };
    await replace("hello");
    await body(view, replace);
  } finally {
    await runtime.dispose();
  }
}

describe("materializeTestVDOM()", () => {
  it("resolves when the view stays one the renderer can draw", async () => {
    await withView(async (view, replace) => {
      await materializeTestVDOM(view, () => replace("goodbye"));
    });
  });

  it("throws when the view becomes one the renderer cannot draw while it settles", async () => {
    await withView(async (view, replace) => {
      await expect(
        materializeTestVDOM(
          view,
          () => replace({ type: "not-a-vnode", name: "div" }),
        ),
      ).rejects.toThrow("VDOM materialization failed: Invalid VDOM content");
    });
  });
});
