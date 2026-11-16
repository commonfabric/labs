/**
 * Tests for CFCopyButton component
 */

// First, so that the document it installs is there when Lit loads.
import { mount } from "../../test-utils/dom.ts";

import { expect } from "@std/expect";
import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { FakeTime } from "@std/testing/time";
import { CFCopyButton } from "./index.ts";

/** What a `cf-copy-success` or `cf-copy-error` event carried. */
type CopyOutcome =
  | { type: "cf-copy-success"; detail: { text: string; length: number } }
  | { type: "cf-copy-error"; detail: { error: Error; text: string } };

/**
 * Stands in for `ClipboardItem`, keeping the blobs it was made with. The
 * document's own converts a blob from outside its window into the text
 * `[object Blob]`, as no browser would.
 */
class RecordedClipboardItem {
  readonly data: Record<string, Blob>;

  constructor(data: Record<string, Blob>) {
    this.data = data;
  }
}

/**
 * A clipboard standing in for the browser's on `navigator`, which records
 * what is written to it, or refuses every write with `refusal`.
 */
function installClipboard(refusal?: Error) {
  const texts: string[] = [];
  const items: unknown[][] = [];
  const settle = () =>
    refusal === undefined ? Promise.resolve() : Promise.reject(refusal);
  Object.defineProperty(navigator, "clipboard", {
    configurable: true,
    value: {
      writeText: (text: string) => {
        texts.push(text);
        return settle();
      },
      write: (data: unknown[]) => {
        items.push(data);
        return settle();
      },
    },
  });
  return { texts, items };
}

/** Removes what {@link installClipboard} and the test put on the page. */
function cleanUp() {
  Reflect.deleteProperty(navigator, "clipboard");
  document.body.replaceChildren();
}

/** A mounted button with `settings`. */
function button(settings: Partial<CFCopyButton>): Promise<CFCopyButton> {
  return mount(Object.assign(new CFCopyButton(), settings));
}

/** Clicks the inner button, and resolves with the outcome it reports. */
function click(element: CFCopyButton): Promise<CopyOutcome> {
  const outcome = Promise.withResolvers<CopyOutcome>();
  for (const type of ["cf-copy-success", "cf-copy-error"] as const) {
    element.addEventListener(
      type,
      (event) =>
        outcome.resolve(
          { type, detail: (event as CustomEvent).detail } as CopyOutcome,
        ),
      { once: true },
    );
  }
  inner(element).click();
  return outcome.promise;
}

/** The `cf-button` the component renders. */
function inner(element: CFCopyButton): HTMLElement {
  return element.shadowRoot!.querySelector("cf-button")!;
}

describe("CFCopyButton", () => {
  it("should be defined", () => {
    expect(CFCopyButton).toBeDefined();
  });

  it("should have customElement definition", () => {
    expect(customElements.get("cf-copy-button")).toBe(CFCopyButton);
  });

  it("should create element instance", () => {
    const element = new CFCopyButton();
    expect(element).toBeInstanceOf(CFCopyButton);
  });

  it("should have default properties", () => {
    const element = new CFCopyButton();
    expect(element.text).toBe("");
    expect(element.variant).toBe("secondary");
    expect(element.size).toBe("md");
    expect(element.disabled).toBe(false);
    expect(element.feedbackDuration).toBe(2000);
    expect(element.iconOnly).toBe(false);
  });

  it("should accept string text property", () => {
    const element = new CFCopyButton();
    element.text = "Hello World";
    expect(element.text).toBe("Hello World");
  });

  it("should accept object text property for multi-MIME support", () => {
    const element = new CFCopyButton();
    element.text = {
      "text/plain": "Hello World",
      "text/html": "<b>Hello World</b>",
    };
    expect(element.text).toEqual({
      "text/plain": "Hello World",
      "text/html": "<b>Hello World</b>",
    });
  });

  it("should accept object with multiple MIME types", () => {
    const element = new CFCopyButton();
    element.text = {
      "text/plain": "Plain text",
      "text/html": "<p>HTML text</p>",
      "text/rtf": "{\\rtf1 RTF text}",
    };
    expect(Object.keys(element.text)).toEqual([
      "text/plain",
      "text/html",
      "text/rtf",
    ]);
  });

  describe("a click", () => {
    afterEach(cleanUp);

    it("writes string text to the clipboard as plain text, and dispatches `cf-copy-success`", async () => {
      const clipboard = installClipboard();
      const element = await button({ text: "Hello World" });

      const outcome = await click(element);

      expect(clipboard.texts).toEqual(["Hello World"]);
      expect(clipboard.items).toEqual([]);
      expect(outcome).toEqual({
        type: "cf-copy-success",
        detail: { text: "Hello World", length: 11 },
      });
    });

    it("writes each MIME type of object text into one clipboard item, and reports its plain text", async () => {
      const clipboard = installClipboard();
      const original = globalThis.ClipboardItem;
      Reflect.set(globalThis, "ClipboardItem", RecordedClipboardItem);
      let item: RecordedClipboardItem;
      let outcome: CopyOutcome;
      try {
        const element = await button({
          text: { "text/html": "<b>Hi</b>", "text/plain": "Hi" },
        });
        outcome = await click(element);
        expect(clipboard.items.map((data) => data.length)).toEqual([1]);
        item = clipboard.items[0][0] as RecordedClipboardItem;
      } finally {
        globalThis.ClipboardItem = original;
      }

      expect(clipboard.texts).toEqual([]);
      expect(item).toBeInstanceOf(RecordedClipboardItem);
      const contents = await Promise.all(
        Object.entries(item.data).map(async ([type, blob]) => [
          type,
          blob.type,
          await blob.text(),
        ]),
      );
      expect(contents).toEqual([
        ["text/html", "text/html", "<b>Hi</b>"],
        ["text/plain", "text/plain", "Hi"],
      ]);
      expect(outcome).toEqual({
        type: "cf-copy-success",
        detail: { text: "Hi", length: 2 },
      });
    });

    it("reports the first MIME type's content as the text of object text with no plain text", async () => {
      installClipboard();
      const element = await button({ text: { "text/html": "<b>Hi</b>" } });

      const outcome = await click(element);

      expect(outcome.detail.text).toBe("<b>Hi</b>");
    });

    it("dispatches `cf-copy-error` with the clipboard's error and the text when the clipboard refuses", async () => {
      const refusal = new Error("Write permission denied");
      installClipboard(refusal);
      const element = await button({ text: { "text/html": "<b>Hi</b>" } });

      const outcome = await click(element);

      expect(outcome).toEqual({
        type: "cf-copy-error",
        detail: { error: refusal, text: "<b>Hi</b>" },
      });
      await element.updateComplete;
      expect(inner(element).getAttribute("title")).toBe("Copy to clipboard");
    });

    it("writes nothing, and dispatches nothing, when disabled or given no text", async () => {
      const clipboard = installClipboard();
      const events: Event[] = [];
      const time = new FakeTime();
      try {
        for (
          const settings of [{ text: "Hello", disabled: true }, { text: "" }]
        ) {
          const element = await button(settings);
          element.addEventListener("cf-copy-success", (e) => events.push(e));
          element.addEventListener("cf-copy-error", (e) => events.push(e));
          inner(element).click();
        }
        // An event would follow the clipboard write the handler awaits.
        await time.runMicrotasks();
      } finally {
        time.restore();
      }

      expect(clipboard.texts).toEqual([]);
      expect(clipboard.items).toEqual([]);
      expect(events).toEqual([]);
    });
  });

  describe("copied feedback", () => {
    let time: FakeTime;

    beforeEach(() => {
      time = new FakeTime();
      installClipboard();
    });

    afterEach(() => {
      time.restore();
      cleanUp();
    });

    /** What the button's label and title say. */
    function feedback(element: CFCopyButton) {
      return {
        title: inner(element).getAttribute("title"),
        label: inner(element).getAttribute("aria-label"),
        text: inner(element).textContent!.trim(),
      };
    }

    it("shows the copied state for `feedback-duration`, then the copy prompt again", async () => {
      const element = await button({ text: "Hello", feedbackDuration: 500 });
      expect(feedback(element)).toEqual({
        title: "Copy to clipboard",
        label: "Copy to clipboard",
        text: "📋 Copy",
      });

      await click(element);
      await element.updateComplete;
      expect(feedback(element)).toEqual({
        title: "Copied!",
        label: "Copied to clipboard",
        text: "✓ Copied!",
      });

      time.tick(499);
      await element.updateComplete;
      expect(feedback(element).title).toBe("Copied!");
      time.tick(1);
      await element.updateComplete;
      expect(feedback(element).title).toBe("Copy to clipboard");
    });

    it("shows only the icon when `icon-only` is set", async () => {
      const element = await button({ text: "Hello", iconOnly: true });
      expect(feedback(element).text).toBe("📋");

      await click(element);
      await element.updateComplete;

      expect(feedback(element).text).toBe("✓");
    });

    it("restarts the feedback duration on a second copy", async () => {
      const element = await button({ text: "Hello", feedbackDuration: 500 });
      await click(element);
      time.tick(400);

      await click(element);
      time.tick(400);
      await element.updateComplete;
      expect(feedback(element).title).toBe("Copied!");

      time.tick(100);
      await element.updateComplete;
      expect(feedback(element).title).toBe("Copy to clipboard");
    });

    it("leaves no reset pending once removed from the document", async () => {
      const element = await button({ text: "Hello" });
      await click(element);

      element.remove();

      expect(time.next()).toBe(false);
    });

    it("renders the idle label when added back during the feedback", async () => {
      const element = await button({ text: "Hello" });
      await click(element);
      expect(feedback(element).title).toBe("Copied!");

      element.remove();
      document.body.append(element);
      await element.updateComplete;

      expect(feedback(element).title).toBe("Copy to clipboard");
    });
  });
});
