import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { type Part, reconcileMain } from "../live-page-client.ts";

// The parts of the DOM `reconcileMain()` uses, over a plain tree of nodes.
// `live-page-client.browser.test.ts` runs the same function against a real
// DOM.
class FakePart implements Part<FakePart> {
  parent: FakePart | null = null;
  readonly #children: (FakePart | string)[];

  constructor(readonly name: string, ...children: (FakePart | string)[]) {
    this.#children = children;
    for (const child of children) {
      if (typeof child !== "string") child.parent = this;
    }
  }

  get children(): FakePart[] {
    return this.#children.flatMap((child) =>
      typeof child === "string" ? [] : [child]
    );
  }

  get innerHTML(): string {
    return this.#children.map((child) =>
      typeof child === "string" ? child : child.outerHTML
    ).join("");
  }

  get outerHTML(): string {
    return `<${this.name}>${this.innerHTML}</${this.name}>`;
  }

  replaceWith(next: FakePart): void {
    const siblings = this.parent!.#children;
    siblings[siblings.indexOf(this)] = next;
    next.parent = this.parent;
    this.parent = null;
  }
}

/** A page holding `main`, so that `main` can be replaced. */
function onPage(main: FakePart): FakePart {
  return new FakePart("body", main);
}

describe("reconcileMain()", () => {
  it("replaces only the parts of main that changed", () => {
    const top = new FakePart("div", "1h ago");
    const rows = new FakePart("table", "a");
    const main = new FakePart("main", top, rows);
    const body = onPage(main);
    const newTop = new FakePart("div", "2h ago");
    expect(
      reconcileMain(main, new FakePart("main", newTop, new FakePart("table", "a"))),
    ).toBe(true);
    expect(body.children).toEqual([main]);
    expect(main.children).toEqual([newTop, rows]);
  });

  it("leaves main alone when the rendering is the same", () => {
    const main = new FakePart("main", new FakePart("b", "same"));
    const body = onPage(main);
    expect(reconcileMain(main, new FakePart("main", new FakePart("b", "same"))))
      .toBe(false);
    expect(body.children).toEqual([main]);
  });

  it("replaces main whole when its parts or the text between them differ", () => {
    for (
      const next of [
        new FakePart("main", "before", new FakePart("p", "one"), new FakePart("p", "two")),
        new FakePart("main", "after", new FakePart("p", "one")),
      ]
    ) {
      const main = new FakePart("main", "before", new FakePart("p", "one"));
      const body = onPage(main);
      expect(reconcileMain(main, next)).toBe(true);
      expect(body.children).toEqual([next]);
    }
  });
});
