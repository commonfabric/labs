// First, so that the document it installs is there when Lit loads.
import { mount } from "../../test-utils/dom.ts";

import { expect } from "@std/expect";
import { afterEach, describe, it } from "@std/testing/bdd";

import { CFQuestion } from "./index.ts";

/**
 * A question about cooking mounted with `options`, with the details of the
 * `cf-answer` events it fires.
 */
async function asking(options: string[] = [], allowCustom = false) {
  const element = Object.assign(new CFQuestion(), {
    question: "How do you cook?",
    options,
    allowCustom,
  });
  const answers: unknown[] = [];
  element.addEventListener("cf-answer", (event) => {
    if (event instanceof CustomEvent) answers.push(event.detail);
  });
  return { element: await mount(element), answers };
}

const query = (element: CFQuestion, selector: string) =>
  element.shadowRoot!.querySelector<HTMLElement>(selector);

/** How many elements in the question's shadow root match `selector`. */
const count = (element: CFQuestion, selector: string) =>
  element.shadowRoot!.querySelectorAll(selector).length;

const optionButtons = (element: CFQuestion) => [
  ...element.shadowRoot!.querySelectorAll<HTMLButtonElement>(".option"),
];

const field = (element: CFQuestion) =>
  element.shadowRoot!.querySelector("input");

const submitButton = (element: CFQuestion) =>
  element.shadowRoot!.querySelector<HTMLButtonElement>(".submit-btn")!;

async function pick(element: CFQuestion, label: string): Promise<void> {
  optionButtons(element).find((button) => button.textContent!.trim() === label)!
    .click();
  await element.updateComplete;
}

async function type(element: CFQuestion, text: string): Promise<void> {
  const input = field(element)!;
  input.value = text;
  input.dispatchEvent(new InputEvent("input", { bubbles: true }));
  await element.updateComplete;
}

async function submit(element: CFQuestion): Promise<void> {
  submitButton(element).click();
  await element.updateComplete;
}

async function press(element: CFQuestion, key: string): Promise<void> {
  field(element)!.dispatchEvent(
    new KeyboardEvent("keydown", { key, bubbles: true }),
  );
  await element.updateComplete;
}

describe("CFQuestion", () => {
  afterEach(() => document.body.replaceChildren());

  it("is registered as `cf-question`", () => {
    expect(customElements.get("cf-question")).toBe(CFQuestion);
  });

  describe("render()", () => {
    it("shows the question and a button per option, without a text field", async () => {
      const { element } = await asking(["Quick", "Elaborate"]);

      expect(query(element, ".question-text")!.textContent).toBe(
        "How do you cook?",
      );
      expect(optionButtons(element).map((b) => b.textContent!.trim()))
        .toEqual(["Quick", "Elaborate"]);
      expect(count(element, "input")).toBe(0);
    });

    it("shows a text field alone when there are no options", async () => {
      const { element } = await asking();

      expect(field(element)!.placeholder).toBe("Type your answer...");
      expect(count(element, ".option")).toBe(0);
    });

    it("shows a text field beside the options when custom answers are allowed", async () => {
      const { element } = await asking(["Quick"], true);

      expect(optionButtons(element)).toHaveLength(1);
      expect(field(element)!.placeholder).toBe("Or type your own answer...");
    });

    it("disables Submit until there is an answer", async () => {
      const { element } = await asking(["Quick"]);
      expect(submitButton(element).disabled).toBe(true);

      await pick(element, "Quick");

      expect(submitButton(element).disabled).toBe(false);
    });
  });

  describe("options", () => {
    it("marks the option picked last as selected", async () => {
      const { element } = await asking(["Quick", "Elaborate"]);

      await pick(element, "Quick");
      await pick(element, "Elaborate");

      expect(
        optionButtons(element).map((b) => b.classList.contains("selected")),
      ).toEqual([false, true]);
    });

    it("submits the picked option, and then shows it as answered", async () => {
      const { element, answers } = await asking(["Quick", "Elaborate"]);

      await pick(element, "Elaborate");
      await submit(element);

      expect(answers).toEqual([{ answer: "Elaborate" }]);
      expect(query(element, ".answered-badge")!.textContent).toBe("Answered");
      expect(query(element, ".answered-text")!.textContent).toBe("Elaborate");
      expect(count(element, ".submit-btn")).toBe(0);
    });

    it("clears a typed answer when an option is picked", async () => {
      const { element, answers } = await asking(["Quick"], true);

      await type(element, "Slow");
      await pick(element, "Quick");
      expect(field(element)!.value).toBe("");
      await submit(element);

      expect(answers).toEqual([{ answer: "Quick" }]);
    });
  });

  describe("text field", () => {
    it("submits what was typed", async () => {
      const { element, answers } = await asking();

      await type(element, "Slowly");
      await submit(element);

      expect(answers).toEqual([{ answer: "Slowly" }]);
    });

    it("unselects a picked option when an answer is typed", async () => {
      const { element, answers } = await asking(["Quick"], true);

      await pick(element, "Quick");
      await type(element, "Slow");
      expect(optionButtons(element)[0].classList.contains("selected")).toBe(
        false,
      );
      await submit(element);

      expect(answers).toEqual([{ answer: "Slow" }]);
    });

    it("submits what was typed on Enter, and not on other keys", async () => {
      const { element, answers } = await asking();
      await type(element, "Slowly");

      await press(element, "a");
      expect(answers).toEqual([]);
      await press(element, "Enter");

      expect(answers).toEqual([{ answer: "Slowly" }]);
    });

    it("submits nothing on Enter while the field is empty", async () => {
      const { element, answers } = await asking(["Quick"], true);
      await pick(element, "Quick");

      await press(element, "Enter");

      expect(answers).toEqual([]);
      expect(count(element, ".answered")).toBe(0);
    });
  });

  it("submits nothing when the answer is cleared before Submit is disabled", async () => {
    // Submit takes no clicks once it renders disabled; until then, the
    // question's own state is what stops one.
    const { element, answers } = await asking();
    await type(element, "Slowly");

    const input = field(element)!;
    input.value = "";
    input.dispatchEvent(new InputEvent("input", { bubbles: true }));
    submitButton(element).click();
    await element.updateComplete;

    expect(answers).toEqual([]);
    expect(count(element, ".answered")).toBe(0);
    expect(submitButton(element).disabled).toBe(true);
  });
});
