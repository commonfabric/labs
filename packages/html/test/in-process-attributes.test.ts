import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";

import { Identity } from "@commonfabric/identity";
import { Runtime } from "@commonfabric/runner";
import { StorageManager } from "@commonfabric/runner/storage/cache.deno";

import { renderInProcess } from "../src/in-process.ts";
import { MockDoc } from "../src/mock-doc.ts";

describe("in-process-attributes", () => {
  it("reflects successive property values on the same rendered element", async () => {
    const signer = await Identity.fromPassphrase("in-process attributes");
    const runtime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager: StorageManager.emulate({ as: signer }),
    });
    const mock = new MockDoc('<div id="root"></div>');
    const container = mock.document.getElementById("root")!;
    let render: ReturnType<typeof renderInProcess> | undefined;
    try {
      const tx = runtime.edit();
      const vdom = runtime.getCell<unknown>(
        signer.did(),
        "attributes",
        undefined,
        tx,
      );
      vdom.set({
        type: "vnode",
        name: "span",
        props: { "aria-label": "green vote", style: "color: green" },
        children: ["V"],
      });
      await tx.commit();
      render = renderInProcess(container, vdom, {
        document: mock.document,
        setProp: mock.renderOptions.setProp,
      });
      await runtime.idle();
      render.flush();
      const element = container.firstChild;
      expect(element).toBeDefined();
      expect(element).not.toBeNull();
      expect(container.innerHTML).toBe(
        '<span aria-label="green vote" style="color: green">V</span>',
      );

      for (const color of ["yellow", "green"]) {
        const update = runtime.edit();
        vdom.withTx(update).key("props").set({
          "aria-label": `${color} vote`,
          style: `color: ${color}`,
        });
        await update.commit();
        await runtime.idle();
        render.flush();
        expect(container.firstChild).toBe(element);
        expect(container.innerHTML).toBe(
          `<span aria-label="${color} vote" style="color: ${color}">V</span>`,
        );
      }
    } finally {
      render?.cancel();
      await runtime.dispose();
    }
  });

  it("updates and removes ARIA attributes through the default property setter", async () => {
    const signer = await Identity.fromPassphrase("in-process ARIA attributes");
    const runtime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager: StorageManager.emulate({ as: signer }),
    });
    const mock = new MockDoc('<div id="root"></div>');
    const container = mock.document.getElementById("root")!;
    const elementDescriptor = Object.getOwnPropertyDescriptor(
      globalThis,
      "Element",
    );
    // The default setter uses the ambient DOM constructor to recognize nodes.
    // Retain MockDoc's DOM methods while exercising the production setter.
    Object.defineProperty(globalThis, "Element", {
      configurable: true,
      value: container.constructor,
    });
    let render: ReturnType<typeof renderInProcess> | undefined;
    try {
      const tx = runtime.edit();
      const vdom = runtime.getCell<unknown>(
        signer.did(),
        "aria",
        undefined,
        tx,
      );
      vdom.set({
        type: "vnode",
        name: "button",
        props: { "aria-label": "Edit name", "aria-expanded": false },
        children: ["Edit"],
      });
      await tx.commit();
      render = renderInProcess(container, vdom, { document: mock.document });
      await runtime.idle();
      render.flush();
      const element = container.firstChild as Element;
      expect(element.getAttribute("aria-label")).toBe("Edit name");
      expect(element.getAttribute("aria-expanded")).toBe("false");
      expect(Object.hasOwn(element, "aria-label")).toBe(false);

      const updates = [
        { "aria-label": "Save name", "aria-expanded": true },
        { "aria-label": null, "aria-expanded": false },
        { "aria-label": "Edit again", "aria-expanded": undefined },
        {},
      ];
      for (const props of updates) {
        const update = runtime.edit();
        vdom.withTx(update).key("props").set(props);
        await update.commit();
        await runtime.idle();
        render.flush();
        expect(container.firstChild).toBe(element);
        for (const key of ["aria-label", "aria-expanded"] as const) {
          const value = props[key];
          if (value == null) {
            expect(element.hasAttribute(key)).toBe(false);
          } else {
            expect(element.getAttribute(key)).toBe(String(value));
          }
        }
      }
    } finally {
      render?.cancel();
      await runtime.dispose();
      if (elementDescriptor) {
        Object.defineProperty(globalThis, "Element", elementDescriptor);
      } else {
        Reflect.deleteProperty(globalThis, "Element");
      }
    }
  });
});
