/**
 * Rendering with the reconciler and the applicator in one process, which is
 * how the CLI turns a piece's UI into HTML.
 *
 * The tree under test is shaped the way the renderer's schema delivers one:
 * props and children arrive as cells rather than as plain values, and the
 * children are cells one level down again. A renderer that cannot follow those
 * cells produces a bare tag with nothing inside it.
 */

import { assertEquals } from "@std/assert";
import { Identity } from "@commonfabric/identity";
import { Runtime } from "@commonfabric/runner";
import { StorageManager } from "@commonfabric/runner/storage/cache.deno";
import { renderInProcess } from "../src/in-process.ts";
import { MockDoc } from "../src/mock-doc.ts";

const signer = await Identity.fromPassphrase("test in-process render");
const space = signer.did();

function makeRuntime() {
  return new Runtime({
    apiUrl: new URL(import.meta.url),
    storageManager: StorageManager.emulate({ as: signer }),
  });
}

function makeContainer() {
  const mock = new MockDoc(
    '<!DOCTYPE html><html><body><div id="root"></div></body></html>',
  );
  return {
    container: mock.document.getElementById("root")!,
    options: {
      document: mock.document,
      setProp: mock.renderOptions.setProp,
    },
  };
}

Deno.test("in-process render - piece UI to HTML", async (t) => {
  const runtime = makeRuntime();
  try {
    await t.step("renders nested elements, props and text", async () => {
      const tx = runtime.edit();
      const vdom = runtime.getCell<unknown>(space, "greeting", undefined, tx);
      vdom.set({
        type: "vnode",
        name: "div",
        props: { id: "hello" },
        children: [
          {
            type: "vnode",
            name: "p",
            props: { class: "line" },
            children: ["Hello world!"],
          },
          {
            type: "vnode",
            name: "span",
            props: {},
            children: ["and again"],
          },
        ],
      });
      await tx.commit().settled;

      const { container, options } = makeContainer();
      const render = renderInProcess(container, vdom, options);
      await runtime.idle();
      render.flush();

      assertEquals(
        container.innerHTML,
        '<div id="hello"><p class="line">Hello world!</p>' +
          "<span>and again</span></div>",
      );
      render.cancel();
    });

    await t.step("follows a cell in child position", async () => {
      const tx = runtime.edit();
      const label = runtime.getCell<unknown>(space, "label", undefined, tx);
      label.set("first");
      const vdom = runtime.getCell<unknown>(space, "labeled", undefined, tx);
      vdom.set({
        type: "vnode",
        name: "div",
        props: {},
        children: [label],
      });
      await tx.commit().settled;

      const { container, options } = makeContainer();
      const render = renderInProcess(container, vdom, options);
      await runtime.idle();
      render.flush();
      assertEquals(container.innerHTML, "<div>first</div>");

      const update = runtime.edit();
      label.withTx(update).set("second");
      await update.commit().settled;
      await runtime.idle();
      render.flush();
      assertEquals(container.innerHTML, "<div>second</div>");

      render.cancel();
    });

    await t.step("converts a style object to a style attribute", async () => {
      const tx = runtime.edit();
      const vdom = runtime.getCell<unknown>(space, "styled", undefined, tx);
      vdom.set({
        type: "vnode",
        name: "div",
        props: { style: { backgroundColor: "red", marginTop: 10 } },
        children: [],
      });
      await tx.commit().settled;

      const { container, options } = makeContainer();
      const render = renderInProcess(container, vdom, options);
      await runtime.idle();
      render.flush();

      assertEquals(
        container.innerHTML,
        '<div style="background-color: red; margin-top: 10px"></div>',
      );
      render.cancel();
    });

    await t.step("cancelling clears the container", async () => {
      const tx = runtime.edit();
      const vdom = runtime.getCell<unknown>(space, "transient", undefined, tx);
      vdom.set({
        type: "vnode",
        name: "div",
        props: {},
        children: ["gone soon"],
      });
      await tx.commit().settled;

      const { container, options } = makeContainer();
      const render = renderInProcess(container, vdom, options);
      await runtime.idle();
      render.flush();
      assertEquals(container.innerHTML, "<div>gone soon</div>");

      render.cancel();
      assertEquals(container.innerHTML, "");
    });

    await t.step("announces each applied batch", async () => {
      const tx = runtime.edit();
      const text = runtime.getCell<unknown>(
        space,
        "watched-text",
        undefined,
        tx,
      );
      text.set("one");
      const vdom = runtime.getCell<unknown>(space, "watched", undefined, tx);
      vdom.set({
        type: "vnode",
        name: "div",
        props: {},
        children: [text],
      });
      await tx.commit().settled;

      const { container, options } = makeContainer();
      const applied: string[] = [];
      const render = renderInProcess(container, vdom, {
        ...options,
        onApplied: () => applied.push(container.innerHTML),
      });
      await runtime.idle();
      render.flush();
      assertEquals(applied.length > 0, true);
      assertEquals(applied[applied.length - 1], "<div>one</div>");

      const update = runtime.edit();
      text.withTx(update).set("two");
      await update.commit().settled;
      await runtime.idle();
      render.flush();
      assertEquals(applied[applied.length - 1], "<div>two</div>");

      render.cancel();
    });
  } finally {
    await runtime.dispose();
  }
});

Deno.test("in-process render - delivers events", async (t) => {
  const runtime = makeRuntime();
  try {
    /**
     * Renders a button whose click sends to a stream counted by a handler,
     * clicks it, and returns how many clicks reached the handler.
     */
    const clicks = async (name: string, dispatchEvents?: boolean) => {
      const stream = runtime.getCell<unknown>(space, `${name}-clicks`, {
        asCell: ["stream"],
      });
      const count = runtime.getCell<number>(space, `${name}-count`);
      const vdom = runtime.getCell<unknown>(space, `${name}-button`);
      const tx = runtime.edit();
      count.withTx(tx).set(0);
      vdom.withTx(tx).set({
        type: "vnode",
        name: "button",
        props: { onClick: stream },
        children: ["Press"],
      });
      await tx.commit().settled;
      const cancelHandler = runtime.scheduler.addEventHandler((tx) => {
        const current = count.withTx(tx);
        current.set((current.get() ?? 0) + 1);
      }, stream.getAsNormalizedFullLink());

      const { container, options } = makeContainer();
      const render = renderInProcess(container, vdom, {
        ...options,
        dispatchEvents,
      });
      await runtime.idle();
      render.flush();
      const button = container.firstChild!;
      button.dispatchEvent(new Event("click"));
      await runtime.idle();
      await runtime.storageManager.synced();
      await runtime.idle();
      render.cancel();
      cancelHandler();
      return count.get();
    };

    await t.step("hands a click to the reconciler's handler", async () => {
      assertEquals(await clicks("delivered", true), 1);
    });

    await t.step("drops a click unless asked to deliver events", async () => {
      assertEquals(await clicks("dropped"), 0);
    });
  } finally {
    await runtime.dispose();
  }
});

Deno.test("in-process render - reports a bound prop without a runtime client", async (t) => {
  const runtime = makeRuntime();
  try {
    await t.step("a $value binding names its cell", async () => {
      const tx = runtime.edit();
      const value = runtime.getCell<unknown>(
        space,
        "bound-value",
        undefined,
        tx,
      );
      value.set("typed");
      const vdom = runtime.getCell<unknown>(space, "bound", undefined, tx);
      vdom.set({
        type: "vnode",
        name: "cf-input",
        props: { $value: value },
        children: [],
      });
      await tx.commit().settled;

      const { container, options } = makeContainer();
      const render = renderInProcess(container, vdom, options);
      await runtime.idle();
      render.flush();

      // No client-side runtime is present, so the applicator hands the element
      // the reference rather than a live handle; the mock document renders any
      // object-valued property as "[binding]".
      assertEquals(
        container.innerHTML,
        '<cf-input value="[binding]"></cf-input>',
      );
      render.cancel();
    });
  } finally {
    await runtime.dispose();
  }
});
