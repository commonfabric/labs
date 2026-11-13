// First, so that the document it installs is there when Lit loads.
import { window } from "./dom.ts";

import { expect } from "@std/expect";
import { afterEach, describe, it } from "@std/testing/bdd";
import { ReactiveElement } from "lit";

import { type BetweenButtons, betweenButtons } from "./tab-order.ts";

/**
 * A control to place between the buttons, whose updates wait for a later task,
 * as a control's do while it waits on what it shows.
 */
class Control extends ReactiveElement {
  protected override async scheduleUpdate(): Promise<void> {
    await new Promise((resolve) => window.setTimeout(resolve));
    super.scheduleUpdate();
  }
}
customElements.define("tab-order-control", Control);

/**
 * Names `node` by its part in `page`, else by its tag. A failed matcher
 * prints these names, where printing a node would walk its whole document.
 */
const nameIn = (page: BetweenButtons<Control>) => (node: Element | null) =>
  node === page.before
    ? "before"
    : node === page.after
    ? "after"
    : node === page.control
    ? "control"
    : node?.localName;

describe("betweenButtons()", () => {
  afterEach(() => document.body.replaceChildren());

  it("places the rendered control between two buttons after what the page holds", async () => {
    const existing = document.createElement("p");
    document.body.append(existing);
    const control = new Control();
    const page = await betweenButtons(control);
    expect(page.control === control).toBe(true);
    expect(control.hasUpdated).toBe(true);
    expect(page.before.localName).toBe("button");
    expect(page.after.localName).toBe("button");
    expect([...document.body.children].map(nameIn(page))).toEqual([
      "p",
      "before",
      "control",
      "after",
    ]);
  });

  it("focuses the button before the control", async () => {
    const page = await betweenButtons(new Control());
    expect(nameIn(page)(document.activeElement)).toBe("before");
  });

  it("removes the control and both buttons on disposal, and nothing else", async () => {
    const existing = document.createElement("p");
    document.body.append(existing);
    {
      using _page = await betweenButtons(new Control());
      expect(document.body.children.length).toBe(4);
    }
    expect([...document.body.children].map((node) => node.localName))
      .toEqual(["p"]);
  });
});
