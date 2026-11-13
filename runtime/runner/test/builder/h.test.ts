import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";

import { Identity } from "@commonfabric/identity";

import { h, UiAction } from "../../src/builder/h.ts";
import { Runtime } from "../../src/runtime.ts";
import { StorageManager } from "../../src/storage/cache.deno.ts";

const signer = await Identity.fromPassphrase("builder h");
const space = signer.did();

describe("h", () => {
  let runtime: Runtime;
  let storageManager: ReturnType<typeof StorageManager.emulate>;

  beforeEach(() => {
    storageManager = StorageManager.emulate({ as: signer });
    runtime = new Runtime({ apiUrl: new URL(import.meta.url), storageManager });
  });

  afterEach(async () => {
    await runtime.dispose();
    await storageManager.close();
  });

  describe("h()", () => {
    it("binds a `$` prop given a query result to the link of the cell it was read from", () => {
      const cell = runtime.getImmutableCell(space, { text: "hello" });
      const other = runtime.getImmutableCell(space, { text: "goodbye" });

      const vnode = h("cf-input", { $value: cell.getAsQueryResult() });

      expect(vnode.props).toEqual({
        $value: cell.getAsLink({ includeSchema: true }),
      });
      expect(vnode.props?.$value).not.toEqual(other.getAsLink());
    });

    it("binds each field of a `$` record given query results", () => {
      const first = runtime.getImmutableCell(space, { n: 1 });
      const second = runtime.getImmutableCell(space, { n: 2 });

      const vnode = h("cf-iframe", {
        $context: {
          first: first.getAsQueryResult(),
          second: second.getAsQueryResult(),
        },
      });

      expect(vnode.props).toEqual({
        $context: {
          first: first.getAsLink(),
          second: second.getAsLink(),
        },
      });
    });
  });

  describe("UiAction()", () => {
    it("passes through the props it does not consume, and renames `action` to its data attribute", () => {
      const props = { action: "save", class: "primary", children: "Save" };

      const vnode = UiAction(props);

      expect(vnode).toEqual({
        type: "vnode",
        name: "ct-button",
        props: { class: "primary", "data-ui-action": "save" },
        children: ["Save"],
      });
    });
  });
});
