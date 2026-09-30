import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { reconcileTiles } from "../tiles-client.ts";

// The parts of the DOM `reconcileTiles()` uses, over a plain tree of nodes.
// `tiles-client.browser.test.ts` runs the same function against a real DOM.
class FakeDocument {
  activeElement: FakeElement | null = null;
}

class FakeElement {
  parent: FakeElement | null = null;
  scrollTop = 0;
  readonly #children: FakeElement[] = [];

  constructor(
    readonly ownerDocument: FakeDocument,
    readonly localName: string,
    readonly attributes: Readonly<Record<string, string>>,
    children: FakeElement[],
  ) {
    for (const child of children) this.append(child);
  }

  get children(): FakeElement[] & { item(index: number): FakeElement | null } {
    const children = [...this.#children];
    return Object.assign(children, {
      item: (index: number) => children[index] ?? null,
    });
  }

  get outerHTML(): string {
    const attributes = Object.entries(this.attributes)
      .map(([name, value]) => ` ${name}="${value}"`).join("");
    return `<${this.localName}${attributes}>${
      this.#children.map((child) => child.outerHTML).join("")
    }</${this.localName}>`;
  }

  getAttribute(name: string): string | null {
    return this.attributes[name] ?? null;
  }

  querySelectorAll(selector: "a" | "[data-focus-key]"): FakeElement[] {
    const matches = (element: FakeElement) =>
      selector === "a"
        ? element.localName === "a"
        : element.getAttribute("data-focus-key") !== null;
    return this.#children.flatMap((child) => [
      ...(matches(child) ? [child] : []),
      ...child.querySelectorAll(selector),
    ]);
  }

  contains(other: FakeElement): boolean {
    for (let node: FakeElement | null = other; node; node = node.parent) {
      if (node === this) return true;
    }
    return false;
  }

  append(child: FakeElement): void {
    this.insertBefore(child, null);
  }

  insertBefore(child: FakeElement, reference: FakeElement | null): void {
    child.remove();
    const index = reference ? this.#children.indexOf(reference) : -1;
    this.#children.splice(index === -1 ? this.#children.length : index, 0, child);
    child.parent = this;
  }

  replaceWith(other: FakeElement): void {
    const parent = this.parent!;
    parent.insertBefore(other, this);
    this.remove();
  }

  remove(): void {
    if (!this.parent) return;
    this.parent.#children.splice(this.parent.#children.indexOf(this), 1);
    this.parent = null;
  }

  focus(): void {
    this.ownerDocument.activeElement = this;
  }
}

const page = new FakeDocument();

function element(
  localName: string,
  attributes: Record<string, string> = {},
  ...children: FakeElement[]
): FakeElement {
  return new FakeElement(page, localName, attributes, children);
}

function tile(
  label: string,
  status: string,
  ...children: FakeElement[]
): FakeElement {
  return element(
    "div",
    { class: `tile ${status}`, "data-tile-label": label },
    ...children,
  );
}

function board(...tiles: FakeElement[]): FakeElement {
  page.activeElement = null;
  return element("div", {}, ...tiles);
}

function update(container: FakeElement, ...tiles: FakeElement[]): void {
  reconcileTiles(
    container as unknown as Element,
    tiles as unknown as HTMLElement[],
  );
}

// A list of recent runs, each with a title link and an arrow link that share
// an href, as the recent-runs tile renders them.
function runList(...titles: string[]): FakeElement {
  return element(
    "div",
    { class: "evscroll", "data-focus-key": "runs" },
    ...titles.flatMap((title) => [
      element("a", {
        "data-focus-key": `title-${title}`,
        href: `/runs/${title}`,
      }),
      element("a", {
        "data-focus-key": `arrow-${title}`,
        href: `/runs/${title}`,
      }),
    ]),
  );
}

describe("reconcileTiles()", () => {
  it("keeps an unchanged tile's element and replaces a changed tile where it stands", () => {
    const labs = tile("labs ci", "good");
    const loom = tile("loom ci", "good");
    const dau = tile("dau", "good");
    const container = board(labs, loom, dau);
    const failing = tile("loom ci", "bad");
    update(container, tile("labs ci", "good"), failing, tile("dau", "good"));
    expect([...container.children]).toEqual([labs, failing, dau]);
    expect(loom.parent).toBeNull();
  });

  it("adds, removes and reorders tiles by label, keeping the elements of tiles it keeps", () => {
    const labs = tile("labs ci", "good");
    const loom = tile("loom ci", "good");
    const dau = tile("dau", "good");
    const container = board(labs, loom, dau);
    const spend = tile("model spend", "warn");
    update(container, tile("dau", "good"), tile("labs ci", "good"), spend);
    expect([...container.children]).toEqual([dau, labs, spend]);
    expect(loom.parent).toBeNull();
  });

  it("moves focus from a replaced tile to its replacement", () => {
    const labs = tile("labs ci", "good");
    const container = board(labs);
    labs.focus();
    const failing = tile("labs ci", "bad");
    update(container, failing);
    expect(page.activeElement).toBe(failing);
  });

  it("moves focus inside a replaced tile to the element with the same focus key", () => {
    const targets = () =>
      element("div", { tabindex: "0", "data-focus-key": "targets" });
    const container = board(tile("production", "good", targets()));
    container.querySelectorAll("[data-focus-key]")[0].focus();
    const next = targets();
    update(container, tile("production", "bad", next));
    expect(page.activeElement).toBe(next);
  });

  it("moves focus to the keyed link rather than another link with the same href", () => {
    const container = board(tile("recent main runs", "good", runList("b", "a")));
    container.querySelectorAll("a")[3].focus();
    update(container, tile("recent main runs", "good", runList("c", "b", "a")));
    expect(page.activeElement?.getAttribute("data-focus-key")).toBe("arrow-a");
    expect(container.contains(page.activeElement!)).toBe(true);
  });

  it("moves focus from a link with no focus key to the link with the same href", () => {
    const links = (...hrefs: string[]) =>
      hrefs.map((href) => element("a", { href }));
    const container = board(tile("flaky tests", "good", ...links("/b", "/a")));
    container.querySelectorAll("a")[1].focus();
    const next = links("/c", "/b", "/a");
    update(container, tile("flaky tests", "warn", ...next));
    expect(page.activeElement).toBe(next[2]);
  });

  it("leaves focus behind when the focused element has no counterpart", () => {
    const unkeyed = element("div", { tabindex: "0" });
    const container = board(tile("production", "good", unkeyed));
    unkeyed.focus();
    update(container, tile("production", "bad", element("div", { tabindex: "0" })));
    expect(page.activeElement).toBe(unkeyed);
    expect(container.contains(unkeyed)).toBe(false);
  });

  it("gives the element with the same focus key the scroll position of a scrolled keyed element", () => {
    const unkeyed = element("div", { class: "notes" });
    const container = board(
      tile("recent main runs", "good", runList("b", "a"), unkeyed),
    );
    container.querySelectorAll("[data-focus-key]")[0].scrollTop = 25;
    unkeyed.scrollTop = 10;
    const nextList = runList("c", "b", "a");
    const nextNotes = element("div", { class: "notes" });
    update(container, tile("recent main runs", "warn", nextList, nextNotes));
    expect(nextList.scrollTop).toBe(25);
    expect(nextNotes.scrollTop).toBe(0);
  });

  it("keeps focus and scroll position in a tile when a tile before it leaves the page", () => {
    const container = board(
      tile("scheduled workflows", "bad"),
      tile("recent main runs", "good", runList("b", "a")),
    );
    const [list] = container.children.item(1)!.querySelectorAll(
      "[data-focus-key]",
    );
    list.scrollTop = 25;
    container.querySelectorAll("a")[3].focus();
    const nextList = runList("c", "b", "a");
    update(container, tile("recent main runs", "warn", nextList));
    expect(container.children).toHaveLength(1);
    expect(nextList.scrollTop).toBe(25);
    expect(page.activeElement?.getAttribute("data-focus-key")).toBe("arrow-a");
    expect(nextList.contains(page.activeElement!)).toBe(true);
  });
});
