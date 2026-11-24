// First, so that the document it installs is there when Lit loads.
import { mount } from "../../test-utils/dom.ts";

import type {
  BuiltInLLMToolCallPart,
  BuiltInLLMToolResultPart,
} from "@commonfabric/api";
import { expect } from "@std/expect";
import { afterEach, describe, it } from "@std/testing/bdd";

import { defaultTheme, themeProperties } from "../theme-context.ts";
import { CFToolCall } from "./index.ts";

const call: BuiltInLLMToolCallPart = {
  type: "tool-call",
  toolCallId: "call-1",
  toolName: "get_weather",
  input: { city: "Oslo" },
};

/** A result of `call` carrying `output`. */
function resultWith(
  output: BuiltInLLMToolResultPart["output"],
): BuiltInLLMToolResultPart {
  return {
    type: "tool-result",
    toolCallId: "call-1",
    toolName: "get_weather",
    output,
  };
}

/** A tool call element mounted with `properties`. */
function toolCallWith(properties: Partial<CFToolCall> = {}) {
  return mount(Object.assign(new CFToolCall(), { call }, properties));
}

const text = (element: CFToolCall, selector: string) =>
  [...element.shadowRoot!.querySelectorAll(selector)].map((node) =>
    node.textContent?.trim()
  );

describe("CFToolCall", () => {
  afterEach(() => document.body.replaceChildren());

  it("is registered as `cf-tool-call`", () => {
    expect(customElements.get("cf-tool-call")).toBe(CFToolCall);
  });

  describe("render()", () => {
    it("shows the tool's name and a running status before a result arrives", async () => {
      const element = await toolCallWith();
      expect(text(element, ".tool-call-name")).toEqual(["get_weather"]);
      expect(text(element, ".tool-call-icon")).toEqual(["🔧"]);
      const status = element.shadowRoot!.querySelector(".tool-call-status")!;
      expect(status.textContent?.trim()).toBe("Running");
      expect(status.classList.contains("status-pending")).toBe(true);
    });

    it("shows a complete status once a result arrives", async () => {
      const element = await toolCallWith({
        result: resultWith({ type: "text", value: "Sunny" }),
      });
      expect(text(element, ".tool-call-icon")).toEqual(["✅"]);
      const status = element.shadowRoot!.querySelector(".tool-call-status")!;
      expect(status.textContent?.trim()).toBe("Complete");
      expect(status.classList.contains("status-success")).toBe(true);
    });

    it("shows a running status, and no output section, for a `null` result", async () => {
      const element = await toolCallWith({
        // @ts-expect-error A page's JSX can hand the element `null`.
        result: null,
        expanded: true,
      });
      expect(text(element, ".tool-call-icon")).toEqual(["🔧"]);
      expect(text(element, ".tool-call-status")).toEqual(["Running"]);
      expect(text(element, ".tool-section-title")).toEqual(["Input"]);
    });

    it("hides the details while collapsed", async () => {
      const element = await toolCallWith({
        result: resultWith({ type: "text", value: "Sunny" }),
      });
      expect(element.shadowRoot!.querySelector(".tool-call-content")).toBe(
        null,
      );
    });

    it("shows the input as JSON, and no output section, while running", async () => {
      const element = await toolCallWith({ expanded: true });
      expect(text(element, ".tool-section-title")).toEqual(["Input"]);
      expect(text(element, ".tool-section-content")).toEqual([
        JSON.stringify(call.input, null, 2),
      ]);
    });

    it("shows a text output as the text itself", async () => {
      const element = await toolCallWith({
        expanded: true,
        result: resultWith({ type: "text", value: "Sunny" }),
      });
      expect(text(element, ".tool-section-title")).toEqual([
        "Input",
        "Output",
      ]);
      expect(text(element, ".tool-section-content")[1]).toBe("Sunny");
    });

    it("shows a JSON output as indented JSON of its value", async () => {
      const element = await toolCallWith({
        expanded: true,
        result: resultWith({ type: "json", value: { temperature: 21 } }),
      });
      expect(text(element, ".tool-section-content")[1]).toBe(
        JSON.stringify({ temperature: 21 }, null, 2),
      );
    });

    it("shows an `error-text` output as the text itself", async () => {
      const element = await toolCallWith({
        expanded: true,
        // @ts-expect-error The runner reports a failed tool as `error-text`,
        // which the declared output type omits.
        result: resultWith({ type: "error-text", value: "City not found" }),
      });
      expect(text(element, ".tool-section-content")[1]).toBe(
        "City not found",
      );
    });

    it("shows a `content` output as indented JSON of its parts", async () => {
      const parts = [{ type: "text", text: "Sunny" }];
      const element = await toolCallWith({
        expanded: true,
        // @ts-expect-error The AI SDK's `content` output, which the declared
        // output type omits.
        result: resultWith({ type: "content", value: parts }),
      });
      expect(text(element, ".tool-section-content")[1]).toBe(
        JSON.stringify(parts, null, 2),
      );
    });

    it("shows an output that is not a `{ type, value }` wrapper as indented JSON of itself", async () => {
      const output = { type: "forecast", temperature: 21 };
      const element = await toolCallWith({
        expanded: true,
        // @ts-expect-error A pattern can write a tool's raw result as output.
        result: resultWith(output),
      });
      expect(text(element, ".tool-section-content")[1]).toBe(
        JSON.stringify(output, null, 2),
      );
    });

    it("shows an input that JSON cannot represent as its string form", async () => {
      const input: Record<string, unknown> = {};
      input.self = input;
      const element = await toolCallWith({
        call: { ...call, input },
        expanded: true,
      });
      expect(text(element, ".tool-section-content")).toEqual([
        "[object Object]",
      ]);
    });

    it("shows each `bigint` in the input and a JSON output as a string of its digits and `n`", async () => {
      const element = await toolCallWith({
        call: { ...call, input: { count: 1n } },
        expanded: true,
        result: resultWith({ type: "json", value: [2n] }),
      });
      expect(text(element, ".tool-section-content")).toEqual([
        '{\n  "count": "1n"\n}',
        '[\n  "2n"\n]',
      ]);
    });
  });

  describe("theme", () => {
    it("writes a theme given to it onto its own style", async () => {
      const theme = { ...defaultTheme, fontFamily: "Georgia, serif" };
      const element = await toolCallWith({ theme });
      expect(element.style.getPropertyValue("--cf-theme-font-family")).toBe(
        themeProperties(theme)["--cf-theme-font-family"],
      );
    });

    it("writes nothing onto its style without a theme", async () => {
      const element = await toolCallWith();
      expect(element.style.getPropertyValue("--cf-theme-font-family")).toBe(
        "",
      );
    });
  });

  describe("header", () => {
    it("expands and collapses the details on each click", async () => {
      const element = await toolCallWith();
      const header = element.shadowRoot!.querySelector("button")!;
      const chevron = () => element.shadowRoot!.querySelector(".chevron")!;

      header.click();
      await element.updateComplete;
      expect(element.expanded).toBe(true);
      expect(element.hasAttribute("expanded")).toBe(true);
      expect(chevron().classList.contains("expanded")).toBe(true);
      expect(element.shadowRoot!.querySelector(".tool-call-content")).not
        .toBe(null);

      header.click();
      await element.updateComplete;
      expect(element.expanded).toBe(false);
      expect(element.hasAttribute("expanded")).toBe(false);
      expect(chevron().classList.contains("expanded")).toBe(false);
      expect(element.shadowRoot!.querySelector(".tool-call-content")).toBe(
        null,
      );
    });
  });
});
