// First, so that the document it installs is there when Lit loads.
import { mount } from "../../test-utils/dom.ts";

import { afterEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import type {
  BuiltInLLMToolCallPart,
  BuiltInLLMToolResultPart,
} from "@commonfabric/api";
import { CFChatMessage } from "./index.ts";
import { createMockCellHandle } from "../../test-utils/mock-cell-handle.ts";
import { defaultTheme } from "../theme-context.ts";
import type { CFMarkdown } from "../cf-markdown/index.ts";
import type { CFToolCall } from "../cf-tool-call/index.ts";

/** A message with `properties` set, mounted in the document. */
function message(
  properties: Partial<
    Pick<
      CFChatMessage,
      "role" | "content" | "avatar" | "name" | "streaming" | "compact" | "theme"
    >
  >,
): Promise<CFChatMessage> {
  return mount(Object.assign(new CFChatMessage(), properties));
}

/** The elements in `element`'s shadow root matching `selector`. */
function parts<T extends Element = HTMLElement>(
  element: CFChatMessage,
  selector: string,
): T[] {
  return [...element.shadowRoot!.querySelectorAll<T>(selector)];
}

/** The markdown element `element` renders its text with. */
function markdownOf(element: CFChatMessage): CFMarkdown {
  return element.shadowRoot!.querySelector<CFMarkdown>("cf-markdown")!;
}

const call = (id: string): BuiltInLLMToolCallPart => ({
  type: "tool-call",
  toolCallId: id,
  toolName: "search",
  input: { query: id },
});

const result = (id: string): BuiltInLLMToolResultPart => ({
  type: "tool-result",
  toolCallId: id,
  toolName: "search",
  output: { type: "text", value: `found ${id}` },
});

describe("cf-chat-message", () => {
  afterEach(() => document.body.replaceChildren());

  it("should be defined", () => {
    expect(CFChatMessage).toBeDefined();
  });

  it("should create element instance", () => {
    const element = new CFChatMessage();
    expect(element).toBeInstanceOf(CFChatMessage);
  });

  it("should have default role of user", () => {
    const element = new CFChatMessage();
    expect(element.role).toBe("user");
  });

  it("should have streaming disabled by default", () => {
    const element = new CFChatMessage();
    expect(element.streaming).toBe(false);
  });

  it("should extract text content from string", () => {
    const el = new CFChatMessage();
    el.content = "Hello world";

    const text = (el as any)._extractTextContent();

    expect(text).toBe("Hello world");
  });

  it("should extract text content from array with text parts", () => {
    const el = new CFChatMessage();
    el.content = [
      { type: "text", text: "Hello" },
      { type: "text", text: "world" },
    ] as any;

    const text = (el as any)._extractTextContent();

    expect(text).toBe("Hello world");
  });

  it("should return empty string for empty content", () => {
    const el = new CFChatMessage();
    el.content = "";

    const text = (el as any)._extractTextContent();

    expect(text).toBe("");
  });

  it("should extract text content from a cell-backed string", () => {
    const el = new CFChatMessage();
    el.content = createMockCellHandle("Hello from cell") as any;

    const text = (el as any)._extractTextContent();

    expect(text).toBe("Hello from cell");
  });

  describe("message text", () => {
    it("shows string content in an inverse markdown bubble for the user", async () => {
      const element = await message({ content: "Hello" });

      const markdown = markdownOf(element);
      expect(markdown.content).toBe("Hello");
      expect(markdown.variant).toBe("inverse");
      expect(parts(element, ".message")[0].className).toBe(
        "message message-user",
      );
      expect(element.getAttribute("role")).toBe("user");
    });

    it("shows the text parts of array content, joined, in a default bubble for the assistant", async () => {
      const element = await message({
        role: "assistant",
        content: [
          { type: "text", text: "Hello" },
          call("a"),
          { type: "text", text: "world" },
        ],
      });

      const markdown = markdownOf(element);
      expect(markdown.content).toBe("Hello world");
      expect(markdown.variant).toBe("default");
      expect(parts(element, ".message")[0].className).toBe(
        "message message-assistant",
      );
    });

    it("hands a cell-backed content to the markdown as the cell", async () => {
      const cell = createMockCellHandle("Hello from cell");
      const element = await message({ role: "assistant", content: cell });

      expect(markdownOf(element).content).toBe(cell);
    });

    it("marks the markdown streaming and compact as the message is", async () => {
      const plain = await message({ content: "Hi" });
      expect(markdownOf(plain).hasAttribute("streaming")).toBe(false);
      expect(markdownOf(plain).hasAttribute("compact")).toBe(false);

      const marked = await message({
        content: "Hi",
        streaming: true,
        compact: true,
      });
      expect(markdownOf(marked).hasAttribute("streaming")).toBe(true);
      expect(markdownOf(marked).hasAttribute("compact")).toBe(true);
    });
  });

  describe("avatar", () => {
    it("renders no avatar without an image or a name", async () => {
      const element = await message({ content: "Hi" });

      expect(parts(element, ".message-avatar")).toEqual([]);
    });

    it("shows the image, described by the name", async () => {
      const element = await message({
        content: "Hi",
        avatar: "https://example.com/ada.png",
        name: "Ada Lovelace",
      });

      const [image] = parts(element, ".message-avatar img");
      expect(image.getAttribute("src")).toBe("https://example.com/ada.png");
      expect(image.getAttribute("alt")).toBe("Ada Lovelace");
      expect(parts(element, ".avatar-fallback")).toEqual([]);
    });

    it("describes an image without a name as `Avatar`", async () => {
      const element = await message({
        content: "Hi",
        avatar: "https://example.com/someone.png",
      });

      expect(parts(element, ".message-avatar img")[0].getAttribute("alt"))
        .toBe("Avatar");
    });

    it("shows up to two initials of the name without an image", async () => {
      const element = await message({
        content: "Hi",
        name: "ada byron lovelace",
      });

      expect(parts(element, ".message-avatar img")).toEqual([]);
      expect(parts(element, ".avatar-fallback")[0].textContent).toBe("AB");
    });
  });

  describe("tool attachments", () => {
    it("renders each tool call with the result of the same id", async () => {
      const element = await message({
        role: "assistant",
        content: [call("a"), call("b"), result("b")],
      });

      const calls = parts<CFToolCall>(
        element,
        ".tool-attachments cf-tool-call",
      );
      expect(calls.map((part) => part.call)).toEqual([call("a"), call("b")]);
      expect(calls.map((part) => part.result)).toEqual([
        undefined,
        result("b"),
      ]);
    });

    it("renders no attachments for content without tool calls", async () => {
      const element = await message({
        role: "assistant",
        content: [{ type: "text", text: "Hi" }, result("a")],
      });

      expect(parts(element, ".tool-attachments")).toEqual([]);
    });
  });

  describe("actions", () => {
    it("offers to copy the text of an assistant message", async () => {
      const element = await message({
        role: "assistant",
        content: [{ type: "text", text: "Copy" }, {
          type: "text",
          text: "me",
        }],
      });

      const [copy] = parts(element, ".message-actions cf-copy-button");
      expect(copy.getAttribute("text")).toBe("Copy me");
    });

    it("offers no copy for a user message", async () => {
      const element = await message({ content: "Hi" });

      expect(parts(element, ".message-actions")).toHaveLength(1);
      expect(parts(element, "cf-copy-button")).toEqual([]);
    });

    it("renders no actions for a message without text", async () => {
      const element = await message({
        role: "assistant",
        content: [call("a")],
      });

      expect(parts(element, ".message-actions")).toEqual([]);
    });
  });

  describe("theme", () => {
    it("writes a given theme onto the message and takes it off when withdrawn", async () => {
      const element = await message({
        content: "Hi",
        theme: { ...defaultTheme, fontFamily: "Comic Neue" },
      });

      expect(element.style.getPropertyValue("--cf-theme-font-family")).toBe(
        "Comic Neue",
      );

      element.theme = undefined;
      await element.updateComplete;

      expect(element.style.getPropertyValue("--cf-theme-font-family")).toBe(
        "",
      );
    });
  });
});
