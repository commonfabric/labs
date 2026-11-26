import { expect } from "@std/expect";

import { Identity } from "@commonfabric/identity";
import {
  afterEach,
  beforeEach,
  describe,
  it,
} from "@commonfabric/test-support/test";

import { h } from "../src/builder/h.ts";
import { Runtime } from "../src/runtime.ts";
import { StorageManager } from "../src/storage/cache.deno.ts";

const signer = await Identity.fromPassphrase("h binding link");

describe("h()", () => {
  let storage: ReturnType<typeof StorageManager.emulate>;
  let runtime: Runtime;
  let disposed: boolean;

  beforeEach(() => {
    storage = StorageManager.emulate({ as: signer });
    runtime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager: storage,
    });
    disposed = false;
  });

  afterEach(async () => {
    if (!disposed) await runtime.dispose();
    await storage.close();
  });

  it("binds a `$` prop to the link of the cell it is given", () => {
    const cell = runtime.getImmutableCell(signer.did(), { glaze: "maple" });

    const vnode = h("cf-input", { $value: cell });

    expect(vnode.props?.$value).toEqual(
      cell.getAsLink({ includeSchema: true }),
    );
  });

  it("throws what the cell's link throws when that is not a missing link context", async () => {
    // Disposing the runtime releases the snapshot the immutable cell names,
    // so making its link fails, and the binding has no link to stand in for.

    const cell = runtime.getImmutableCell(signer.did(), { glaze: "maple" });
    await runtime.dispose();
    disposed = true;

    expect(() => h("cf-input", { $value: cell })).toThrow(
      "Unknown or expired immutable cell",
    );
  });
});
