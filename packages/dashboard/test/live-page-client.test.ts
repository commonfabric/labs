import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { type Part, reconcileMain } from "../live-page-client.ts";

// The parts of the DOM `reconcileMain()` uses, over a plain tree of nodes.
// `live-page-client.browser.test.ts` runs the same function against a real
// DOM.
class FakePart implements Part<FakePart> {
  parent: FakePart | null = null;
  readonly #children: (FakePart | string)[];

  constructor(
    readonly name: string,
    readonly attributes: string,
    ...children: (FakePart | string)[]
  ) {
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
    return `<${this.name}${this.attributes}>${this.innerHTML}</${this.name}>`;
  }

  replaceWith(next: FakePart): void {
    const siblings = this.parent!.#children;
    siblings[siblings.indexOf(this)] = next;
    const from = next.parent;
    if (from) from.#children.splice(from.#children.indexOf(next), 1);
    next.parent = this.parent;
    this.parent = null;
  }
}

const part = (name: string, ...children: (FakePart | string)[]) =>
  new FakePart(name, "", ...children);

/** A page holding `main`, so that `main` can be replaced. */
function onPage(main: FakePart): FakePart {
  return part("body", main);
}

describe("reconcileMain()", () => {
  it("replaces only what changed, keeping the parts around it", () => {
    const back = part("a", "← dashboard");
    const age = part("span", "1h ago");
    const rows = part("table", part("tr", "a"));
    const main = part("main", part("div", back, age), rows);
    const body = onPage(main);
    expect(reconcileMain(
      main,
      part(
        "main",
        part("div", part("a", "← dashboard"), part("span", "2h ago")),
        part("table", part("tr", "a")),
      ),
    )).toBe(true);
    expect(body.children).toEqual([main]);
    expect(main.children[0].children[0]).toBe(back);
    expect(main.children[0].children[1]).not.toBe(age);
    expect(main.children[1]).toBe(rows);
    expect(main.outerHTML).toBe(
      "<main><div><a>← dashboard</a><span>2h ago</span></div>" +
        "<table><tr>a</tr></table></main>",
    );
  });

  it("leaves main alone when the rendering is the same", () => {
    const main = part("main", part("b", "same"));
    const body = onPage(main);
    expect(reconcileMain(main, part("main", part("b", "same")))).toBe(false);
    expect(body.children).toEqual([main]);
  });

  it("replaces an element whole when its children, text, or attributes differ", () => {
    for (
      const next of [
        part("main", "x", part("p", "one"), part("p", "two")),
        part("main", "y", part("p", "changed")),
        new FakePart("main", ' class="wide"', "x", part("p", "one")),
      ]
    ) {
      const main = part("main", "x", part("p", "one"));
      const body = onPage(main);
      expect(reconcileMain(main, next)).toBe(true);
      expect(body.children).toEqual([next]);
    }
  });

  it("reads an attribute repeating an element's content as an attribute", () => {
    const title = ' title="<p>one</p>"';
    const main = new FakePart("main", title, part("p", "one"));
    const body = onPage(main);
    expect(reconcileMain(main, new FakePart("main", title, part("p", "two"))))
      .toBe(true);
    expect(body.children).toEqual([main]);
    expect(main.outerHTML).toBe(`<main${title}><p>two</p></main>`);
  });
});
