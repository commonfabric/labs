import {
  resetContentAddressedSchemasConfig,
  setContentAddressedSchemasConfig,
} from "../src/schema-doc-config.ts";
import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";

import { Identity } from "@commonfabric/identity";
import { StorageManager } from "@commonfabric/runner/storage/cache.deno";
import { h } from "../src/builder/h.ts";
import { createCell } from "../src/cell.ts";
import { Runtime } from "../src/runtime.ts";

describe("jsx", () => {
  // These pins were written against the flag-on writer (reference-form
  // link schemas); the flag's build default is off, so they opt in.
  beforeEach(() => {
    setContentAddressedSchemasConfig(true);
  });
  afterEach(() => {
    resetContentAddressedSchemasConfig();
  });

  describe("fragments", () => {
    it("returns a `cf-fragment` vnode for a fragment with one child", () => {
      const fragment = (
        <>
          <p>Hello world</p>
        </>
      );

      expect(fragment).toMatchObject(
        <cf-fragment>
          <p>Hello world</p>
        </cf-fragment>,
      );
    });

    it("returns a `cf-fragment` vnode carrying every child", () => {
      const fragment = (
        <>
          <p>Grocery List</p>
          <ul>
            <li>Buy Milk</li>
          </ul>
        </>
      );

      expect(fragment).toMatchObject(
        <cf-fragment>
          <p>Grocery List</p>
          <ul>
            <li>Buy Milk</li>
          </ul>
        </cf-fragment>,
      );
    });

    it("nests a fragment inside the element holding it", () => {
      const grocery = (
        <>
          <p>Grocery List</p>
          <ul>
            <li>Buy Milk</li>
          </ul>
        </>
      );

      expect(<div>{grocery}</div>).toMatchObject(
        <div>
          <cf-fragment>
            <p>Grocery List</p>
            <ul>
              <li>Buy Milk</li>
            </ul>
          </cf-fragment>
        </div>,
      );
    });
  });

  describe("binding props", () => {
    it("stores a binding prop as an explicit cell link", async () => {
      const signer = await Identity.fromPassphrase("jsx binding props");
      const runtime = new Runtime({
        storageManager: StorageManager.emulate({ as: signer }),
        apiUrl: new URL("http://localhost"),
      });
      try {
        const tx = runtime.edit();
        const cell = runtime.getCell(
          signer.did(),
          "jsx-binding",
          undefined,
          tx,
        );
        cell.set("hello");

        const vnode = h("cf-cfc-authorship", { $value: cell }, []);
        const link = (vnode.props as any).$value["/"]["link@1"];

        expect(link.id).toBe(cell.getAsNormalizedFullLink().id);
        expect(link.space).toBe(signer.did());
        expect(link.path).toEqual([]);
      } finally {
        await runtime.dispose();
      }
    });

    it("keeps a binding prop as a cell when there is no link context", async () => {
      const signer = await Identity.fromPassphrase(
        "jsx standalone binding props",
      );
      const runtime = new Runtime({
        storageManager: StorageManager.emulate({ as: signer }),
        apiUrl: new URL("http://localhost"),
      });
      try {
        const cell = createCell(runtime, { path: [] });

        const vnode = h("cf-cfc-authorship", { $value: cell }, []);

        expect((vnode.props as any).$value).toBe(cell);
      } finally {
        await runtime.dispose();
      }
    });
  });
});
