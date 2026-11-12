// First, so that the document it installs is there when Lit loads.
import { mount, settle } from "../../test-utils/dom.ts";

import { expect } from "@std/expect";
import { afterEach, describe, it } from "@std/testing/bdd";

import { CFTags } from "./index.ts";

/** Tags mounted with `properties`, and the tags each `cf-change` carries. */
async function tagsWith(properties: Partial<CFTags> = {}) {
  const element = Object.assign(new CFTags(), properties);
  const changes: string[][] = [];
  element.addEventListener("cf-change", (event) => {
    if (event instanceof CustomEvent) changes.push(event.detail.tags);
  });
  return { element: await mount(element), changes };
}

const shadow = (element: CFTags) => element.shadowRoot!;

/** The text of each tag shown, in order. */
const shown = (element: CFTags) =>
  [...shadow(element).querySelectorAll(".tag-text")].map((node) =>
    node.textContent!.trim()
  );

function button(element: CFTags, label: string): HTMLButtonElement {
  const found = shadow(element).querySelector<HTMLButtonElement>(
    `button[aria-label="${label}"]`,
  );
  if (!found) throw new Error(`No button labeled ${label}`);
  return found;
}

function input(element: CFTags, selector: string): HTMLInputElement {
  const found = shadow(element).querySelector<HTMLInputElement>(selector);
  if (!found) throw new Error(`No input matching ${selector}`);
  return found;
}

/** Types `value` into `field` as a user does, firing `input`. */
function type(field: HTMLInputElement, value: string) {
  field.value = value;
  field.dispatchEvent(new InputEvent("input"));
}

/** Presses `key` in `field`, and returns whether the default was prevented. */
function press(field: HTMLInputElement, key: string): boolean {
  const event = new KeyboardEvent("keydown", { key, cancelable: true });
  field.dispatchEvent(event);
  return event.defaultPrevented;
}

/** Starts editing the tag `tag`, and returns its input once it has focus. */
async function edit(element: CFTags, tag: string, index: number) {
  button(element, `Edit ${tag}`).click();
  await element.updateComplete;
  await settle();
  return input(element, `#tag-input-${index}`);
}

/** Opens the field for a new tag, and returns it once it has focus. */
async function openNew(element: CFTags) {
  shadow(element).querySelector<HTMLButtonElement>(".add-tag")!.click();
  await element.updateComplete;
  await settle();
  return input(element, "#new-tag-input");
}

describe("CFTags", () => {
  afterEach(() => document.body.replaceChildren());

  it("is registered as `cf-tags`", () => {
    expect(customElements.get("cf-tags")).toBe(CFTags);
  });

  describe("render()", () => {
    it("shows a placeholder and an add button when there are no tags", async () => {
      const { element } = await tagsWith();
      expect(shadow(element).querySelector(".placeholder")?.textContent).toBe(
        "No tags",
      );
      expect(shadow(element).querySelector(".add-tag")?.textContent?.trim())
        .toBe("+ Add tag");
    });

    it("shows a placeholder for tags that are not an array", async () => {
      // @ts-expect-error: a page can bind anything to `tags`.
      const { element } = await tagsWith({ tags: null });
      expect(shadow(element).querySelector(".placeholder")).not.toBeNull();
      expect(shown(element)).toEqual([]);
    });

    it("shows each tag with controls to edit and remove it", async () => {
      const { element } = await tagsWith({ tags: ["red", "blue"] });
      expect(shown(element)).toEqual(["red", "blue"]);
      expect(shadow(element).querySelector(".placeholder")).toBeNull();
      button(element, "Edit red");
      button(element, "Remove blue");
    });

    it("shows read-only tags as text, with no controls", async () => {
      const { element } = await tagsWith({ tags: ["red"], readonly: true });
      expect(shown(element)).toEqual(["red"]);
      expect(shadow(element).querySelectorAll("button")).toHaveLength(0);
    });
  });

  describe("removing a tag", () => {
    it("drops the tag and fires `cf-change` with the rest", async () => {
      const { element, changes } = await tagsWith({ tags: ["a", "b", "c"] });
      button(element, "Remove b").click();
      await element.updateComplete;
      expect(shown(element)).toEqual(["a", "c"]);
      expect(changes).toEqual([["a", "c"]]);
    });
  });

  describe("editing a tag", () => {
    it("replaces the tag with an input holding it, focused", async () => {
      const { element } = await tagsWith({ tags: ["red"] });
      const field = await edit(element, "red", 0);
      expect(field.value).toBe("red");
      expect(shadow(element).activeElement).toBe(field);
      expect(shadow(element).querySelector(".tag.editing")).not.toBeNull();
    });

    it("commits the trimmed text on Enter and fires `cf-change`", async () => {
      const { element, changes } = await tagsWith({ tags: ["red", "blue"] });
      const field = await edit(element, "red", 0);
      type(field, "  crimson ");
      expect(press(field, "Enter")).toBe(true);
      await element.updateComplete;
      expect(element.tags).toEqual(["crimson", "blue"]);
      expect(shown(element)).toEqual(["crimson", "blue"]);
      expect(changes).toEqual([["crimson", "blue"]]);
    });

    it("commits the text when the input loses focus", async () => {
      const { element, changes } = await tagsWith({ tags: ["red"] });
      const field = await edit(element, "red", 0);
      type(field, "green");
      field.dispatchEvent(new FocusEvent("blur"));
      await element.updateComplete;
      expect(shown(element)).toEqual(["green"]);
      expect(changes).toEqual([["green"]]);
    });

    it("removes a tag committed empty", async () => {
      const { element, changes } = await tagsWith({ tags: ["red", "blue"] });
      const field = await edit(element, "red", 0);
      type(field, "   ");
      press(field, "Enter");
      await element.updateComplete;
      expect(shown(element)).toEqual(["blue"]);
      expect(changes).toEqual([["blue"]]);
    });

    it("restores the original text on Escape, without firing `cf-change`", async () => {
      const { element, changes } = await tagsWith({ tags: ["red"] });
      const field = await edit(element, "red", 0);
      type(field, "green");
      expect(press(field, "Escape")).toBe(true);
      await element.updateComplete;
      expect(shown(element)).toEqual(["red"]);
      expect(changes).toEqual([]);
    });

    it("removes the tag on Backspace in an empty input", async () => {
      const { element, changes } = await tagsWith({ tags: ["red", "blue"] });
      const field = await edit(element, "blue", 1);
      type(field, "");
      expect(press(field, "Backspace")).toBe(true);
      await element.updateComplete;
      expect(element.tags).toEqual(["red"]);
      expect(changes).toEqual([["red"]]);
    });

    it("leaves Backspace to the input while it holds text, and other keys alone", async () => {
      const { element, changes } = await tagsWith({ tags: ["red"] });
      const field = await edit(element, "red", 0);
      expect(press(field, "Backspace")).toBe(false);
      expect(press(field, "a")).toBe(false);
      expect(element.tags).toEqual(["red"]);
      expect(changes).toEqual([]);
    });
  });

  describe("adding a tag", () => {
    it("opens a focused, empty field in place of the add button", async () => {
      const { element } = await tagsWith();
      const field = await openNew(element);
      expect(field.value).toBe("");
      expect(shadow(element).activeElement).toBe(field);
      expect(shadow(element).querySelector(".placeholder")).toBeNull();
      expect(shadow(element).querySelector("button.add-tag")).toBeNull();
    });

    it("appends the trimmed text on Enter and fires `cf-change`", async () => {
      const { element, changes } = await tagsWith({ tags: ["red"] });
      const field = await openNew(element);
      type(field, " blue ");
      expect(press(field, "Enter")).toBe(true);
      await element.updateComplete;
      expect(shown(element)).toEqual(["red", "blue"]);
      expect(changes).toEqual([["red", "blue"]]);
      expect(shadow(element).querySelector("button.add-tag")).not.toBeNull();
    });

    it("adds nothing for a tag already present", async () => {
      const { element, changes } = await tagsWith({ tags: ["red"] });
      const field = await openNew(element);
      type(field, "red");
      press(field, "Enter");
      await element.updateComplete;
      expect(element.tags).toEqual(["red"]);
      expect(changes).toEqual([]);
    });

    it("discards the text on Escape", async () => {
      const { element, changes } = await tagsWith();
      const field = await openNew(element);
      type(field, "blue");
      expect(press(field, "Escape")).toBe(true);
      await element.updateComplete;
      expect(element.tags).toEqual([]);
      expect(changes).toEqual([]);
      expect(shadow(element).querySelector("button.add-tag")).not.toBeNull();
    });

    it("ignores other keys", async () => {
      const { element } = await tagsWith();
      const field = await openNew(element);
      expect(press(field, "a")).toBe(false);
      expect(shadow(element).querySelector("#new-tag-input")).toBe(field);
    });

    it("adds the text when the field loses focus", async () => {
      const { element, changes } = await tagsWith();
      const field = await openNew(element);
      type(field, "blue");
      field.dispatchEvent(new FocusEvent("blur"));
      await element.updateComplete;
      expect(element.tags).toEqual(["blue"]);
      expect(changes).toEqual([["blue"]]);
    });

    it("closes an empty field when it loses focus, adding nothing", async () => {
      const { element, changes } = await tagsWith();
      const field = await openNew(element);
      type(field, "  ");
      field.dispatchEvent(new FocusEvent("blur"));
      await element.updateComplete;
      expect(element.tags).toEqual([]);
      expect(changes).toEqual([]);
      expect(shadow(element).querySelector(".placeholder")).not.toBeNull();
    });
  });

  describe("read-only", () => {
    it("ignores the handlers a page reaches through the template", async () => {
      // The read-only template binds none of them, so this drives an editable
      // template and then makes it read-only before the click arrives.

      const { element, changes } = await tagsWith({ tags: ["red"] });
      const edit = button(element, "Edit red");
      const remove = button(element, "Remove red");
      const add = shadow(element).querySelector<HTMLButtonElement>(
        ".add-tag",
      )!;
      element.readonly = true;
      edit.click();
      remove.click();
      add.click();
      await element.updateComplete;
      expect(element.tags).toEqual(["red"]);
      expect(shadow(element).querySelector("input")).toBeNull();
      expect(changes).toEqual([]);
    });
  });
});
