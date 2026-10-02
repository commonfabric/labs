/**
 * Tests for CFPicker component
 */

import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";
import { spy } from "@std/testing/mock";
import { nothing } from "lit";

import { renderInProcess } from "@commonfabric/html/in-process";
import { MockDoc } from "@commonfabric/html/mock-doc";
import { Identity } from "@commonfabric/identity";
import { Runtime } from "@commonfabric/runner";
import { nestedRenderReadContracts } from "@commonfabric/runner/component-read-contract";
import { rendererVDOMSchema } from "@commonfabric/runner/schemas";
import { StorageManager } from "@commonfabric/runner/storage/cache.deno";
import { $conn, isCellHandle } from "@commonfabric/runtime-client";

import { createRenderableCellHandle } from "../../test-utils/mock-vdom-connection.ts";
import { CFPicker } from "./index.ts";

/** The text of a Lit template and every template nested in its values. */
function templateText(node: unknown): string {
  const template = node as { strings?: unknown; values?: unknown[] };
  if (!Array.isArray(template?.strings)) {
    return node === null || node === undefined ? "" : String(node);
  }
  return template.strings.map((part, index) =>
    part +
    (index < (template.values?.length ?? 0)
      ? templateText(template.values?.[index])
      : "")
  ).join("");
}

describe("CFPicker", () => {
  it("should be defined", () => {
    expect(CFPicker).toBeDefined();
  });

  it("should have customElement definition", () => {
    expect(customElements.get("cf-picker")).toBe(CFPicker);
  });

  it("should create element instance", () => {
    const element = new CFPicker();
    expect(element).toBeInstanceOf(CFPicker);
  });

  it("should have default properties", () => {
    const element = new CFPicker();
    expect(element.disabled).toBe(false);
    expect(element.minHeight).toBe("");
  });

  it("should have disabled state property", () => {
    const element = new CFPicker();
    expect(element.disabled).toBe(false);

    element.disabled = true;
    expect(element.disabled).toBe(true);
  });

  it("should expose public API methods", () => {
    const element = new CFPicker();
    expect(typeof element.getSelectedIndex).toBe("function");
    expect(typeof element.getSelectedItem).toBe("function");
    expect(typeof element.selectByIndex).toBe("function");
  });

  it("should initialize with index 0", () => {
    const element = new CFPicker();
    expect(element.getSelectedIndex()).toBe(0);
  });

  it("should accept custom minHeight", () => {
    const element = new CFPicker();
    element.minHeight = "300px";
    expect(element.minHeight).toBe("300px");
  });

  it("shows nothing while no items are bound, and its empty state for an empty list", () => {
    // A view's render policy withholds an `items` binding the viewer may not
    // see, and then no items arrive.
    const element = new CFPicker();
    expect(element.render()).toBe(nothing);
    element.items = [];
    element.willUpdate(new Map([["items", undefined]]));
    expect(templateText(element.render())).toContain("No items");
  });

  it("reads its items as the nested render registry says it does", () => {
    // The reconciler decides the `$items` binding on this read, and on each
    // item read as the `cf-render` it is handed to reads its cell, so the
    // registry entry has to name the read the picker makes.
    const { cell } = createRenderableCellHandle<unknown[]>([]);
    const subscribed = spy(cell.runtime()[$conn](), "subscribe");
    const element = new CFPicker();
    element.items = cell;
    try {
      element.willUpdate(new Map([["items", undefined]]));
      expect(subscribed.calls).toHaveLength(1);
      expect(subscribed.calls[0].args[0].ref().schema).toEqual(
        nestedRenderReadContracts["cf-picker"].items.schema,
      );
    } finally {
      element.items = [];
      element.willUpdate(new Map([["items", cell]]));
      subscribed.restore();
    }
  });

  it("subscribes to opaque items and keeps the selected item addressable", async () => {
    const signer = await Identity.fromPassphrase("picker opaque subscription");
    const space = signer.did();
    const runtime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager: StorageManager.emulate({ as: signer }),
    });
    const itemSchema = {
      type: "object",
      properties: { $UI: true, hidden: true },
    } as const;
    const list = runtime.getCell(space, "items", {
      type: "array",
      items: itemSchema,
    });
    const items = [0, 1].map((index) =>
      runtime.getCell(space, `item-${index}`, undefined)
    );
    const hidden = [0, 1].map((index) =>
      runtime.getCell(space, `hidden-${index}`, { type: "string" })
    );
    const ui = [0, 1].map((index) =>
      runtime.getCell(space, `ui-${index}`, undefined)
    );
    try {
      await runtime.editWithRetry((tx) => {
        for (const [index, item] of items.entries()) {
          hidden[index].withTx(tx).set(`hidden ${index}`);
          ui[index].withTx(tx).set({
            type: "vnode",
            name: "span",
            props: {},
            children: [`item ${index}`],
          });
          item.withTx(tx).set({ $UI: ui[index], hidden: hidden[index] });
        }
        list.withTx(tx).set(items);
      });
      const { cell } = createRenderableCellHandle(
        items.map((item) => item.getAsLink()),
        list.getAsNormalizedFullLink(),
      );
      const subscribed = spy(cell.runtime()[$conn](), "subscribe");
      const element = new CFPicker();
      element.items = cell;
      try {
        element.willUpdate(new Map([["items", undefined]]));
        expect(subscribed.calls).toHaveLength(1);
        const subscription = subscribed.calls[0].args[0].ref();
        const tx = runtime.readTx();
        try {
          const value = runtime.getCellFromLink(subscription, undefined, tx)
            .get();
          expect(value).toHaveLength(2);
          const reads = tx.tx.getReactivityLog!().reads.map((read) => read.id);
          expect(reads).toContain(list.getAsNormalizedFullLink().id);
          for (const unused of [...items, ...ui, ...hidden]) {
            expect(reads).not.toContain(unused.getAsNormalizedFullLink().id);
          }
        } finally {
          tx.clearReadOnly?.();
          tx.abort();
        }
        const selected = element.getSelectedItem();
        expect(isCellHandle(selected)).toBe(true);
        expect(selected.ref().id).toBe(list.getAsNormalizedFullLink().id);
        expect(selected.ref().path).toEqual(["0"]);
        const selectedTx = runtime.readTx();
        try {
          runtime.getCellFromLink(selected.ref(), undefined, selectedTx)
            .key("$UI").asSchema(rendererVDOMSchema).get({
              traverseCells: true,
            });
          const reads = selectedTx.tx.getReactivityLog!().reads.map((read) =>
            read.id
          );
          expect(reads).toContain(ui[0].getAsNormalizedFullLink().id);
          expect(reads).not.toContain(items[1].getAsNormalizedFullLink().id);
          expect(reads).not.toContain(ui[1].getAsNormalizedFullLink().id);
          expect(reads).not.toContain(hidden[1].getAsNormalizedFullLink().id);
        } finally {
          selectedTx.clearReadOnly?.();
          selectedTx.abort();
        }
        const mock = new MockDoc('<div id="root"></div>');
        const container = mock.document.getElementById("root")!;
        const rendering = renderInProcess(
          container,
          runtime.getCellFromLink(selected.ref()),
          mock.renderOptions,
        );
        try {
          await runtime.idle();
          rendering.flush();
          expect(container.innerHTML).toBe("<span>item 0</span>");
        } finally {
          rendering.cancel();
        }
      } finally {
        element.items = [];
        element.willUpdate(new Map([["items", cell]]));
        subscribed.restore();
      }
    } finally {
      await runtime.storageManager.synced();
      await runtime.dispose();
    }
  });
});
