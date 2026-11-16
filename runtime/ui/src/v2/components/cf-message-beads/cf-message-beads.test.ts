// First, so that the document it installs is there when Lit loads.
import { mount } from "../../test-utils/dom.ts";

import { expect } from "@std/expect";
import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import type { BuiltInLLMMessage } from "@commonfabric/api";

import {
  createMockCellHandle,
  pushUpdate,
} from "../../test-utils/mock-cell-handle.ts";
import { CFMessageBeads } from "./index.ts";

/** A component mounted with `properties`. */
function beadsWith(
  properties: Partial<Pick<CFMessageBeads, "messages" | "pending" | "label">>,
): Promise<CFMessageBeads> {
  return mount(Object.assign(new CFMessageBeads(), properties));
}

const beadsOf = (element: CFMessageBeads) => [
  ...element.shadowRoot!.querySelectorAll<HTMLElement>("li.bead"),
];

const listOf = (element: CFMessageBeads) =>
  element.shadowRoot!.querySelector<HTMLElement>("ul.bead-list");

const refineButton = (element: CFMessageBeads) =>
  element.shadowRoot!.querySelector<HTMLButtonElement>("button.refine-btn");

/** Whether the component's shadow root holds an element matching `selector`. */
const shows = (element: CFMessageBeads, selector: string) =>
  element.shadowRoot!.querySelector(selector) !== null;

const user = (content: string): BuiltInLLMMessage => ({
  role: "user",
  content,
});

const toolCall: BuiltInLLMMessage = {
  role: "assistant",
  content: [
    { type: "text", text: "Let me look." },
    { type: "tool-call", toolCallId: "1", toolName: "search", input: {} },
  ],
};

const toolResult: BuiltInLLMMessage = {
  role: "tool",
  content: [{
    type: "tool-result",
    toolCallId: "1",
    toolName: "search",
    output: { type: "text", value: "Found it." },
  }],
};

describe("CFMessageBeads", () => {
  afterEach(() => document.body.replaceChildren());

  describe("without messages", () => {
    it("shows its slotted placeholder", async () => {
      const element = await beadsWith({});

      expect(shows(element, ".placeholder slot")).toBe(true);
      expect(shows(element, "ul.bead-list")).toBe(false);
      expect(element.hasAttribute("has-messages")).toBe(false);
    });

    it("shows a spinner in place of the placeholder while pending", async () => {
      const element = await beadsWith({ pending: true });

      expect(shows(element, ".spinner")).toBe(true);
      expect(shows(element, ".placeholder")).toBe(false);
    });
  });

  describe("beads", () => {
    it("colors each bead by who spoke and whether it called a tool", async () => {
      const element = await beadsWith({
        messages: [
          user("Hello"),
          toolCall,
          toolResult,
          { role: "assistant", content: "Done." },
          { role: "assistant", content: [{ type: "text", text: "Done." }] },
        ],
      });

      expect(beadsOf(element).map((bead) => bead.className)).toEqual([
        "bead blue",
        "bead amber",
        "bead purple",
        "bead green",
        "bead green",
      ]);
      expect(element.hasAttribute("has-messages")).toBe(true);
    });

    it("labels each bead with a one-line summary of its message", async () => {
      const long = "x".repeat(60);
      const element = await beadsWith({
        messages: [
          user("Hello"),
          user(long),
          toolCall,
          toolResult,
          {
            role: "user",
            content: [{ type: "image", image: "https://example.com/a.png" }],
          },
          { role: "assistant", content: [{ type: "text", text: long }] },
          { role: "assistant", content: [] },
        ],
      });

      expect(beadsOf(element).map((bead) => bead.getAttribute("aria-label")))
        .toEqual([
          "user: Hello",
          `user: ${"x".repeat(50)}…`,
          "→ search",
          "← search",
          "user: [image]",
          `assistant: ${"x".repeat(50)}…`,
          "assistant",
        ]);
    });

    it("labels a bead whose message has no content with its role", async () => {
      // What a cell holds is checked only to be an object per message.
      const element = await beadsWith({
        messages: [user("Hello"), { role: "assistant" } as BuiltInLLMMessage],
      });

      expect(beadsOf(element).map((bead) => bead.getAttribute("aria-label")))
        .toEqual(["user: Hello", "assistant"]);
      expect(beadsOf(element)[1].className).toBe("bead green");
    });

    it("names the list after `label`, and shows the label, when one is set", async () => {
      const element = await beadsWith({ messages: [user("Hello")] });
      expect(listOf(element)?.getAttribute("aria-label")).toBe(
        "Message history",
      );
      expect(shows(element, ".label")).toBe(false);

      element.label = "Research";
      await element.updateComplete;

      expect(listOf(element)?.getAttribute("aria-label")).toBe("Research");
      expect(element.shadowRoot!.querySelector(".label")?.textContent).toBe(
        "Research",
      );
    });

    it("follows a bound cell's messages as they change", async () => {
      const messages = createMockCellHandle([user("Hello")]);
      const element = await beadsWith({ messages });
      expect(beadsOf(element)).toHaveLength(1);

      pushUpdate(messages, [user("Hello"), user("Again")]);
      await element.updateComplete;

      expect(beadsOf(element).map((bead) => bead.getAttribute("aria-label")))
        .toEqual(["user: Hello", "user: Again"]);
    });
  });

  describe("refine button", () => {
    it("emits `cf-refine` when clicked", async () => {
      const element = await beadsWith({ messages: [user("Hello")] });
      let refinements = 0;
      element.addEventListener("cf-refine", () => refinements++);

      refineButton(element)!.click();

      expect(refinements).toBe(1);
    });

    it("gives way to a spinner while pending", async () => {
      const element = await beadsWith({
        messages: [user("Hello")],
        pending: true,
      });

      expect(shows(element, ".spinner")).toBe(true);
      expect(shows(element, "button.refine-btn")).toBe(false);
    });
  });

  describe("tooltip", () => {
    // The document lays nothing out, so each case supplies the geometry the
    // tooltip is placed by: every tooltip measures 40 by 20, and each bead
    // measures as the case says.

    const original = Object.getOwnPropertyDescriptor(
      HTMLDivElement.prototype,
      "getBoundingClientRect",
    );
    beforeEach(() => {
      Object.defineProperty(HTMLDivElement.prototype, "getBoundingClientRect", {
        configurable: true,
        value: () => new DOMRect(0, 0, 40, 20),
      });
    });
    afterEach(() => {
      if (original) {
        Object.defineProperty(
          HTMLDivElement.prototype,
          "getBoundingClientRect",
          original,
        );
      } else {
        Reflect.deleteProperty(
          HTMLDivElement.prototype,
          "getBoundingClientRect",
        );
      }
    });

    /** Moves the pointer onto `bead`, which measures 6 by 6 at `left`, `top`. */
    const enter = (bead: HTMLElement, left = 50, top = 100) => {
      bead.getBoundingClientRect = () => new DOMRect(left, top, 6, 6);
      bead.dispatchEvent(new MouseEvent("mouseenter"));
    };
    const tooltips = () => [
      ...document.querySelectorAll<HTMLElement>(
        "[data-cf-message-beads-tooltip]",
      ),
    ];
    const position = () =>
      tooltips().map(({ style }) => ({ top: style.top, left: style.left }));

    it("shows the hovered bead's label centered above the bead", async () => {
      const element = await beadsWith({ messages: [user("Hi")] });

      enter(beadsOf(element)[0]);

      expect(tooltips().map((tooltip) => tooltip.textContent)).toEqual([
        "user: Hi",
      ]);
      expect(tooltips()[0].style.position).toBe("fixed");
      expect(position()).toEqual([{ top: "76px", left: "33px" }]);
    });

    it("shows the tooltip below a bead too near the top of the viewport", async () => {
      const element = await beadsWith({ messages: [user("Hi")] });

      enter(beadsOf(element)[0], 50, 10);

      expect(position()).toEqual([{ top: "20px", left: "33px" }]);
    });

    it("keeps the tooltip inside the viewport's sides", async () => {
      const element = await beadsWith({ messages: [user("Hi")] });
      const [bead] = beadsOf(element);

      enter(bead, 2);
      expect(position()).toEqual([{ top: "76px", left: "4px" }]);

      enter(bead, innerWidth - 10);
      expect(position()).toEqual([
        { top: "76px", left: `${innerWidth - 44}px` },
      ]);
    });

    it("moves one tooltip from bead to bead", async () => {
      const element = await beadsWith({
        messages: [user("Hi"), user("There")],
      });
      const [first, second] = beadsOf(element);

      enter(first);
      enter(second);

      expect(tooltips().map((tooltip) => tooltip.textContent)).toEqual([
        "user: There",
      ]);
    });

    it("removes the tooltip when the pointer leaves the bead", async () => {
      const element = await beadsWith({ messages: [user("Hi")] });
      const [bead] = beadsOf(element);
      enter(bead);

      bead.dispatchEvent(new MouseEvent("mouseleave"));

      expect(tooltips()).toEqual([]);
    });

    it("removes the tooltip when the component leaves the document", async () => {
      const element = await beadsWith({ messages: [user("Hi")] });
      enter(beadsOf(element)[0]);

      element.remove();

      expect(tooltips()).toEqual([]);
    });

    it("shows nothing for a bead whose message has gone before it rendered again", async () => {
      const messages = createMockCellHandle([user("Hi"), user("There")]);
      const element = await beadsWith({ messages });
      const [, second] = beadsOf(element);

      pushUpdate(messages, [user("Hi")]);
      enter(second);

      expect(tooltips()).toEqual([]);
    });
  });
});
