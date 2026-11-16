// First, so that the document it installs is there when Lit loads.
import { mount } from "../../test-utils/dom.ts";

import { afterEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import type {
  BuiltInLLMMessage,
  BuiltInLLMToolCallPart,
  BuiltInLLMToolResultPart,
} from "@commonfabric/api";
import { CFChat } from "./index.ts";
import type { CFChatMessage } from "../cf-chat-message/index.ts";
import type { CFToolCall } from "../cf-tool-call/index.ts";
import { defaultTheme } from "../theme-context.ts";
import {
  createMockCellHandle,
  pushUpdate,
} from "../../test-utils/mock-cell-handle.ts";

/** A chat with `properties` set, mounted in the document. */
function chat(
  properties: Partial<Pick<CFChat, "messages" | "pending" | "theme">> = {},
): Promise<CFChat> {
  return mount(Object.assign(new CFChat(), properties));
}

/** The elements in `element`'s shadow root matching `selector`. */
function parts<T extends Element = HTMLElement>(
  element: CFChat,
  selector: string,
): T[] {
  return [...element.shadowRoot!.querySelectorAll<T>(selector)];
}

/** The role and content of each chat message `element` renders. */
const shown = (element: CFChat) =>
  parts<CFChatMessage>(element, "cf-chat-message").map((
    { role, content },
  ) => ({ role, content }));

/** How many `cf-chat-updated` events `element` emits from now on. */
function updates(element: CFChat): { count: number } {
  const seen = { count: 0 };
  element.addEventListener("cf-chat-updated", () => seen.count++);
  return seen;
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

const user = (content: string): BuiltInLLMMessage => ({
  role: "user",
  content,
});

const assistant = (
  content: BuiltInLLMMessage["content"],
): BuiltInLLMMessage => ({
  role: "assistant",
  content,
});

const tool = (...results: BuiltInLLMToolResultPart[]): BuiltInLLMMessage => ({
  role: "tool",
  content: results,
});

describe("CFChat", () => {
  afterEach(() => document.body.replaceChildren());

  describe("messages", () => {
    it("renders each user and assistant message with its role and content", async () => {
      const element = await chat({
        messages: [user("Hi"), assistant("Hello")],
      });

      expect(shown(element)).toEqual([
        { role: "user", content: "Hi" },
        { role: "assistant", content: "Hello" },
      ]);
    });

    it("hands an assistant message the results of its tool calls after its own content", async () => {
      const content = [{ type: "text" as const, text: "Looking" }, call("a")];
      const element = await chat({
        messages: [user("Find a"), assistant(content), tool(result("a"))],
      });

      expect(shown(element)).toEqual([
        { role: "user", content: "Find a" },
        { role: "assistant", content: [...content, result("a")] },
      ]);
    });

    it("renders an assistant message of tool calls alone as tool calls with their results", async () => {
      const element = await chat({
        messages: [assistant([call("a"), call("b")]), tool(result("a"))],
      });

      expect(shown(element)).toEqual([]);
      const calls = parts<CFToolCall>(
        element,
        ".tool-attachments-only cf-tool-call",
      );
      expect(calls.map((part) => part.call)).toEqual([call("a"), call("b")]);
      expect(calls.map((part) => part.result)).toEqual([
        result("a"),
        undefined,
      ]);
    });

    it("hands an assistant message without tool calls its content as it is", async () => {
      const content = [{ type: "text" as const, text: "Plain" }];
      const element = await chat({ messages: [assistant(content)] });

      expect(shown(element)).toEqual([{ role: "assistant", content }]);
    });

    it("shows a newly given messages array", async () => {
      const element = await chat({ messages: [user("Before")] });

      element.messages = [user("After")];
      await element.updateComplete;

      expect(shown(element)).toEqual([{ role: "user", content: "After" }]);
    });

    it("shows the messages of a bound cell as they change, and emits `cf-chat-updated`", async () => {
      const cell = createMockCellHandle([user("First")]);
      const element = await chat({ messages: cell });
      expect(shown(element)).toEqual([{ role: "user", content: "First" }]);
      const seen = updates(element);

      pushUpdate(cell, [user("First"), assistant("Second")]);
      await element.updateComplete;

      expect(seen.count).toBe(1);
      expect(shown(element)).toEqual([
        { role: "user", content: "First" },
        { role: "assistant", content: "Second" },
      ]);
    });
  });

  describe("grouping", () => {
    it("groups consecutive user messages, and assistant messages with tool messages", async () => {
      const element = await chat({
        messages: [
          user("One"),
          user("Two"),
          assistant([{ type: "text", text: "Three" }, call("a")]),
          tool(result("a")),
          assistant("Four"),
          user("Five"),
        ],
      });

      expect(parts(element, ".message-item").map((item) => item.className))
        .toEqual([
          "message-item grouped",
          "message-item grouped last-in-group",
          "message-item grouped",
          "message-item grouped last-in-group",
          "message-item last-in-group",
        ]);
    });

    it("groups a message of another role with nothing", async () => {
      const element = await chat({
        messages: [
          assistant("One"),
          { role: "system", content: "Two" } as unknown as BuiltInLLMMessage,
          assistant("Three"),
        ],
      });

      expect(parts(element, ".message-item").map((item) => item.className))
        .toEqual([
          "message-item last-in-group",
          "message-item last-in-group",
          "message-item last-in-group",
        ]);
    });
  });

  describe("pending", () => {
    it("shows typing dots only while pending, and emits `cf-chat-updated` on each change", async () => {
      const element = await chat({ messages: [user("Hi")] });
      const seen = updates(element);
      expect(parts(element, ".typing-dot")).toEqual([]);

      element.pending = true;
      await element.updateComplete;
      expect(parts(element, ".pending-message .typing-dot")).toHaveLength(3);
      expect(element.hasAttribute("pending")).toBe(true);
      expect(seen.count).toBe(1);

      element.pending = false;
      await element.updateComplete;
      expect(parts(element, ".typing-dot")).toEqual([]);
      expect(seen.count).toBe(2);
    });
  });

  describe("theme", () => {
    const spacing = (element: CFChat, name: string) =>
      element.style.getPropertyValue(`--cf-theme-spacing-${name}`);

    it("spaces its messages by the density of the ambient theme", async () => {
      const element = await chat();
      expect(spacing(element, "message-bottom")).toBe(
        "var(--cf-spacing-1, 0.25rem)",
      );
      const comfortable = spacing(element, "padding-bubble");

      element.parentTheme = { ...defaultTheme, density: "spacious" };
      await element.updateComplete;

      expect(spacing(element, "message-bottom")).toBe(
        "var(--cf-spacing-1, 0.3125rem)",
      );
      expect(spacing(element, "padding-bubble")).not.toBe(comfortable);
      expect(spacing(element, "padding-bubble-horizontal")).not.toBe("");
      expect(element.style.getPropertyValue("--cf-theme-font-family")).toBe(
        "",
      );
    });

    it("leaves a spacing token to a host that sets it by CSS", async () => {
      const host = document.createElement("div");
      host.style.setProperty("--cf-theme-spacing-message-bottom", "9px");
      document.body.append(host);
      const element = new CFChat();
      host.append(element);
      await element.updateComplete;

      expect(spacing(element, "message-bottom")).toBe("");
      expect(spacing(element, "padding-bubble")).not.toBe("");
    });

    it("writes a given theme, spaced by its density, and takes it off when withdrawn", async () => {
      const element = await chat({
        theme: { fontFamily: "Comic Neue", density: "compact" },
      });

      expect(element.style.getPropertyValue("--cf-theme-font-family")).toBe(
        "Comic Neue",
      );
      expect(spacing(element, "message-bottom")).toBe(
        "var(--cf-spacing-1, 0.1875rem)",
      );

      element.theme = {};
      await element.updateComplete;

      expect(element.style.getPropertyValue("--cf-theme-font-family")).toBe(
        "",
      );
      expect(spacing(element, "message-bottom")).toBe(
        "var(--cf-spacing-1, 0.25rem)",
      );
    });
  });
});
