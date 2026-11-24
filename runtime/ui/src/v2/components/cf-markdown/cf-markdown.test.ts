// First, so that the document it installs is there when Lit loads.
import { mount } from "../../test-utils/dom.ts";

import { expect } from "@std/expect";
import { afterEach, describe, it } from "@std/testing/bdd";
import { spy } from "@std/testing/mock";

import {
  createMockCellHandle,
  holdReads,
  pushRefusal,
  pushUpdate,
} from "../../test-utils/mock-cell-handle.ts";
import { defaultTheme } from "../theme-context.ts";
import { CFMarkdown } from "./index.ts";

/** A markdown element mounted with `properties`. */
function markdownWith(properties: Partial<CFMarkdown>): Promise<CFMarkdown> {
  return mount(Object.assign(new CFMarkdown(), properties));
}

/**
 * Resolves once every promise the mock worker's answers settle has run: the
 * answers arrive as microtasks, so one macrotask boundary is past them all.
 */
const answersDelivered = () =>
  new Promise<void>((resolve) => setTimeout(resolve, 0));

/** The element's content wrapper. */
const content = (element: CFMarkdown) =>
  element.shadowRoot!.querySelector(".markdown-content")!;

describe("cf-markdown", () => {
  // `cf-markdown.browser.test.ts` covers the rendering of each kind of
  // markdown in a browser; these cases cover what the element itself decides.

  afterEach(() => document.body.replaceChildren());

  it("starts with empty content in the default variant, neither streaming nor compact", async () => {
    const element = await markdownWith({});

    expect(element.content).toBe("");
    expect([...content(element).classList]).toEqual(["markdown-content"]);
    expect(content(element).textContent!.trim()).toBe("");
  });

  it("renders a string as markdown", async () => {
    const element = await markdownWith({ content: "# Title\n\nSome **bold**" });

    expect(content(element).querySelector("h1")?.textContent).toBe("Title");
    expect(content(element).querySelector("strong")?.textContent).toBe("bold");
  });

  it("classes its content by variant, streaming, and compact", async () => {
    const element = await markdownWith({
      variant: "inverse",
      streaming: true,
      compact: true,
    });

    expect([...content(element).classList].sort()).toEqual([
      "compact",
      "inverse",
      "markdown-content",
      "streaming",
    ]);
  });

  it("shows a character reference as the character, and markup as text", async () => {
    // marked leaves `<i` without its `>` in the text, where an HTML parser
    // given it unescaped would take it for the start of a tag.
    const element = await markdownWith({ content: "a &amp; b &lt;i&gt; <i" });

    expect(content(element).textContent!.trim()).toBe("a & b <i> <i");
    expect(content(element).querySelectorAll("i").length).toBe(0);
  });

  it("reports the index and state of a task-list checkbox a reader toggles", async () => {
    const element = await markdownWith({ content: "- [ ] one\n- [x] two" });
    const changes: unknown[] = [];
    element.addEventListener("cf-checkbox-change", (event) => {
      if (event instanceof CustomEvent) changes.push(event.detail);
    });
    const second = content(element).querySelectorAll("input")[1];

    second.checked = false;
    second.dispatchEvent(new Event("change"));

    expect(changes).toEqual([{ index: 1, checked: false }]);
  });

  it("writes a theme given to it onto itself", async () => {
    const element = await markdownWith({ theme: defaultTheme });

    expect(element.style.getPropertyValue("--cf-theme-font-family")).toBe(
      defaultTheme.fontFamily,
    );
  });

  describe("a cell as content", () => {
    it("renders the cell's text, and renders again when it changes", async () => {
      const cell = createMockCellHandle("first");
      const element = await markdownWith({ content: cell });
      expect(content(element).textContent!.trim()).toBe("first");

      pushUpdate(cell, "second");
      await element.updateComplete;

      expect(content(element).textContent!.trim()).toBe("second");
    });

    it("shows the placeholder for content the worker refuses", async () => {
      const cell = createMockCellHandle("shown before the seal");
      const element = await markdownWith({ content: cell });

      pushRefusal(cell);
      await element.updateComplete;

      expect(content(element).textContent!.trim()).toBe(
        "Content hidden by policy",
      );
    });

    it("renders a cell that has read nothing once the worker answers its read", async () => {
      const cell = createMockCellHandle<string>();
      const answer = holdReads(cell);
      const element = await markdownWith({ content: cell });
      expect(content(element).textContent!.trim()).toBe("");

      answer({ value: "loaded" });
      await answersDelivered();
      await element.updateComplete;

      expect(content(element).textContent!.trim()).toBe("loaded");
    });

    it("renders nothing for a cell that is no longer its content when the read is answered", async () => {
      const cell = createMockCellHandle<string>();
      const answer = holdReads(cell);
      const element = await markdownWith({ content: cell });
      element.content = "replacement";
      await element.updateComplete;
      const updates = spy(element, "requestUpdate");

      answer({ value: "loaded" });
      await answersDelivered();

      expect(updates.calls.length).toBe(0);
    });

    it("stops following a cell it is no longer bound to", async () => {
      const cell = createMockCellHandle("first");
      const element = await markdownWith({ content: cell });
      element.content = "replacement";
      await element.updateComplete;
      const updates = spy(element, "requestUpdate");

      pushUpdate(cell, "second");

      expect(updates.calls.length).toBe(0);
      expect(content(element).textContent!.trim()).toBe("replacement");
    });

    it("stops following its cell once removed from the page", async () => {
      const cell = createMockCellHandle("first");
      const element = await markdownWith({ content: cell });
      element.remove();
      const updates = spy(element, "requestUpdate");

      pushUpdate(cell, "second");

      expect(updates.calls.length).toBe(0);
    });

    it("follows its cell again once put back in the page", async () => {
      const cell = createMockCellHandle("first");
      const element = await markdownWith({ content: cell });
      element.remove();
      document.body.append(element);
      await element.updateComplete;

      pushUpdate(cell, "second");
      await element.updateComplete;

      expect(content(element).textContent!.trim()).toBe("second");
    });
  });
});
