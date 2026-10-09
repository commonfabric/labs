/**
 * Tests for CFPicker component
 */

import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";
import { spy } from "@std/testing/mock";

import { renderInProcess } from "@commonfabric/html/in-process";
import { MockDoc } from "@commonfabric/html/mock-doc";
import { Identity } from "@commonfabric/identity";
import { Runtime } from "@commonfabric/runner";
import { componentReadContracts } from "@commonfabric/runner/component-read-contract";
import { rendererVDOMSchema } from "@commonfabric/runner/schemas";
import { StorageManager } from "@commonfabric/runner/storage/cache.deno";
import {
  $conn,
  type CellHandle,
  isCellHandle,
} from "@commonfabric/runtime-client";

import {
  createMockCellHandle,
  holdReads,
  pushRefusal,
  writesSent,
} from "../../test-utils/mock-cell-handle.ts";
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

  it("shows only its children while no items are bound, and its empty state for an empty list", () => {
    // A view's render policy withholds an `items` binding the viewer may not
    // see, and then no items arrive. The view puts the access placeholder in
    // the picker's children while the list's space is out of reach.
    const element = new CFPicker();
    expect(templateText(element.render())).toBe("<slot></slot>");
    element.items = [];
    element.willUpdate(new Map([["items", undefined]]));
    expect(templateText(element.render())).toContain("No items");
    expect(templateText(element.render())).not.toContain("<slot>");
  });

  it("reads its items as its component read contract says it does", () => {
    // The reconciler decides the `$items` binding on this read, and on each
    // item read as the `cf-render` it is handed to reads its cell, so the
    // contract has to name the read the picker makes.
    const { cell } = createRenderableCellHandle<unknown[]>([]);
    const subscribed = spy(cell.runtime()[$conn](), "subscribe");
    const element = new CFPicker();
    element.items = cell;
    try {
      element.willUpdate(new Map([["items", undefined]]));
      expect(subscribed.calls).toHaveLength(1);
      expect(subscribed.calls[0].args[0].ref().schema).toEqual(
        componentReadContracts["cf-picker"].items.schema,
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

describe("CFPicker stepping", () => {
  // Previous and next move the selection from the index its cell holds,
  // wrapping at either end, so they compute their write from that read: from
  // the worker's answer, never from a cell it has not read or may not show.

  /**
   * The element's own members these tests drive. A Lit element mounts only
   * in a browser, so without one the tests bind it and step through these,
   * on an element that was never connected.
   */
  type PickerInternals = {
    items: string[];
    selectedIndex: CellHandle<number>;
    willUpdate(changedProperties: Map<string, unknown>): void;
    _selectNext(): void;
    _selectPrevious(): void;
  };

  /** A picker of three items whose selection is `selectedIndex`. */
  const pickerAt = (selectedIndex: CellHandle<number>): PickerInternals => {
    const element = new CFPicker() as unknown as PickerInternals;
    element.items = ["first", "second", "third"];
    element.selectedIndex = selectedIndex;
    element.willUpdate(
      new Map([["items", undefined], ["selectedIndex", undefined]]),
    );
    return element;
  };

  /** The index each step from `held` writes. */
  const written = (held: number, step: "next" | "previous") => {
    const selectedIndex = createMockCellHandle(held);
    const element = pickerAt(selectedIndex);
    if (step === "next") element._selectNext();
    else element._selectPrevious();
    return writesSent(selectedIndex).map((write) => write.value);
  };

  it("steps from an index in range, wrapping at either end", () => {
    expect(written(1, "next")).toEqual([2]);
    expect(written(1, "previous")).toEqual([0]);
    expect(written(2, "next")).toEqual([0]);
    expect(written(0, "previous")).toEqual([2]);
  });

  it("steps from an index past the end as from that index, wrapped", () => {
    // Three items, index 5: next is (5 + 1) mod 3, previous (5 - 1) mod 3.
    expect(written(5, "next")).toEqual([0]);
    expect(written(5, "previous")).toEqual([1]);
  });

  it("writes nothing while the worker has not answered the selection's read", () => {
    const selectedIndex = createMockCellHandle<number>();
    holdReads(selectedIndex);
    const element = pickerAt(selectedIndex);

    element._selectNext();
    element._selectPrevious();

    expect(writesSent(selectedIndex)).toEqual([]);
  });

  it("writes nothing while the worker refuses the selection's read", () => {
    const selectedIndex = createMockCellHandle(1);
    const element = pickerAt(selectedIndex);
    pushRefusal(selectedIndex);

    element._selectNext();
    element._selectPrevious();

    expect(writesSent(selectedIndex)).toEqual([]);
  });
});
