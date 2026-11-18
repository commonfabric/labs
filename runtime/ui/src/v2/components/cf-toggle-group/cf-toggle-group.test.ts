// First, so that the document it installs is there when Lit loads.
import { settle } from "../../test-utils/dom.ts";

import { expect } from "@std/expect";
import { afterEach, describe, it } from "@std/testing/bdd";

import { CFToggle } from "../cf-toggle/index.ts";
import { CFToggleGroup } from "./index.ts";

/**
 * Mounts `html`, a group of toggles, and resolves with the group, its
 * toggles, and the `value` in the detail of every `cf-change` a listener on
 * the group hears.
 */
async function groupOf(html: string) {
  const host = document.createElement("div");
  host.innerHTML = html;
  document.body.append(host);
  const group = host.firstElementChild;
  if (!(group instanceof CFToggleGroup)) throw new Error(`no group: ${html}`);
  const changes: unknown[] = [];
  group.addEventListener("cf-change", (event) => {
    if (event instanceof CustomEvent) changes.push(event.detail.value);
  });
  await group.updateComplete;
  await settle();
  const toggles = Array.from(group.querySelectorAll("cf-toggle")).filter(
    (toggle) => toggle instanceof CFToggle,
  );
  return { group, toggles, changes };
}

/** Which of `toggles` are pressed. */
const pressed = (toggles: CFToggle[]) =>
  toggles.map((toggle) => toggle.pressed);

/** Which of `toggles` are disabled. */
const disabled = (toggles: CFToggle[]) =>
  toggles.map((toggle) => toggle.disabled);

/** Clicks `toggle` and lets the group update. */
async function click(group: CFToggleGroup, toggle: CFToggle) {
  toggle.click();
  await group.updateComplete;
}

const formatting = `
  <cf-toggle value="bold"></cf-toggle>
  <cf-toggle value="italic"></cf-toggle>
  <cf-toggle>underline</cf-toggle>`;

describe("CFToggleGroup", () => {
  afterEach(() => document.body.replaceChildren());

  it("is registered as `cf-toggle-group`", () => {
    expect(customElements.get("cf-toggle-group")).toBe(CFToggleGroup);
  });

  describe("a single group", () => {
    it("presses the toggle matching its value by value or by text, and no other", async () => {
      const { group, toggles } = await groupOf(
        `<cf-toggle-group value="underline">${formatting}</cf-toggle-group>`,
      );
      expect(group.getAttribute("role")).toBe("group");
      expect(pressed(toggles)).toEqual([false, false, true]);
      expect(group.getValue()).toBe("underline");
    });

    it("moves to a clicked toggle, releasing the others, and announces it", async () => {
      const { group, toggles, changes } = await groupOf(
        `<cf-toggle-group value="bold">${formatting}</cf-toggle-group>`,
      );
      await click(group, toggles[1]);
      expect(pressed(toggles)).toEqual([false, true, false]);
      expect(group.getAttribute("value")).toBe("italic");
      expect(changes).toEqual(["italic"]);
    });

    it("reflects its new value before it announces it", async () => {
      const { group, toggles } = await groupOf(
        `<cf-toggle-group value="bold">${formatting}</cf-toggle-group>`,
      );
      const reflected: (string | null)[] = [];
      group.addEventListener("cf-change", () => {
        reflected.push(group.getAttribute("value"));
      });
      await click(group, toggles[1]);
      expect(reflected).toEqual(["italic"]);
    });

    it("leaves its value attribute off, and presses nothing, once the page removes it", async () => {
      const { group, toggles } = await groupOf(
        `<cf-toggle-group value="bold">${formatting}</cf-toggle-group>`,
      );
      group.removeAttribute("value");
      await group.updateComplete;
      expect(group.hasAttribute("value")).toBe(false);
      expect(pressed(toggles)).toEqual([false, false, false]);
    });

    it("lets listeners on it hear only its own `cf-change`, not its toggles'", async () => {
      const { group, toggles } = await groupOf(
        `<cf-toggle-group>${formatting}</cf-toggle-group>`,
      );
      const heard: unknown[] = [];
      group.addEventListener("cf-change", (event) => {
        if (event instanceof CustomEvent) heard.push(event.detail);
      });
      const pressedByToggle: unknown[] = [];
      toggles[0].addEventListener("cf-change", (event) => {
        if (event instanceof CustomEvent) pressedByToggle.push(event.detail);
      });
      await click(group, toggles[0]);
      expect(heard).toEqual([{ value: "bold" }]);
      expect(pressedByToggle).toEqual([{ pressed: true }]);
    });

    it("empties when its pressed toggle is clicked", async () => {
      const { group, toggles, changes } = await groupOf(
        `<cf-toggle-group value="bold">${formatting}</cf-toggle-group>`,
      );
      await click(group, toggles[0]);
      expect(pressed(toggles)).toEqual([false, false, false]);
      expect(changes).toEqual([""]);
    });

    it("ignores `cf-change` from anything but a toggle", async () => {
      const { group, changes } = await groupOf(
        `<cf-toggle-group value="bold">${formatting}<div></div></cf-toggle-group>`,
      );
      group.querySelector("div")!.dispatchEvent(
        new CustomEvent("cf-change", {
          bubbles: true,
          detail: { pressed: false },
        }),
      );
      await group.updateComplete;
      expect(group.value).toBe("bold");
      expect(changes).toEqual([]);
    });

    it("presses a matching toggle added later", async () => {
      const { group } = await groupOf(
        `<cf-toggle-group value="strike">${formatting}</cf-toggle-group>`,
      );
      const strike = Object.assign(new CFToggle(), { textContent: "strike" });
      group.append(strike);
      await settle();
      expect(strike.pressed).toBe(true);
    });
  });

  describe("a multiple group", () => {
    const multiple =
      `<cf-toggle-group type="multiple" value="bold,underline">${formatting}</cf-toggle-group>`;

    it("presses every toggle its comma-separated value names", async () => {
      const { group, toggles } = await groupOf(multiple);
      expect(group.value).toEqual(["bold", "underline"]);
      expect(pressed(toggles)).toEqual([true, false, true]);
    });

    it("adds and removes clicked toggles, and announces each change", async () => {
      const { group, toggles, changes } = await groupOf(multiple);
      await click(group, toggles[1]);
      expect(group.value).toEqual(["bold", "underline", "italic"]);
      expect(group.getAttribute("value")).toBe("bold,underline,italic");

      await click(group, toggles[0]);
      expect(group.value).toEqual(["underline", "italic"]);
      expect(pressed(toggles)).toEqual([false, true, true]);
      expect(changes).toEqual([
        ["bold", "underline", "italic"],
        ["underline", "italic"],
      ]);
    });

    it("takes a comma-separated string set as its value", async () => {
      const { group, toggles } = await groupOf(multiple);
      group.value = "italic,";
      await group.updateComplete;
      expect(group.value).toEqual(["italic"]);
      expect(pressed(toggles)).toEqual([false, true, false]);
      expect(group.getAttribute("value")).toBe("italic");
    });

    it("leaves its value attribute off, and presses nothing, once the page removes it", async () => {
      const { group, toggles } = await groupOf(multiple);
      group.removeAttribute("value");
      await group.updateComplete;
      expect(group.hasAttribute("value")).toBe(false);
      expect(pressed(toggles)).toEqual([false, false, false]);
    });

    it("selects every toggle with a value on selectAll()", async () => {
      const { group } = await groupOf(
        `<cf-toggle-group type="multiple">${formatting}<cf-toggle></cf-toggle></cf-toggle-group>`,
      );
      group.selectAll();
      expect(group.getValue()).toEqual(["bold", "italic", "underline"]);
    });

    it("empties on clear()", async () => {
      const { group, toggles, changes } = await groupOf(multiple);
      group.clear();
      await group.updateComplete;
      expect(group.value).toEqual([]);
      expect(pressed(toggles)).toEqual([false, false, false]);
      expect(changes).toEqual([[]]);
    });
  });

  describe("setValue(), clear(), and selectAll() on a single group", () => {
    it("set and clear the value, and ignore selectAll()", async () => {
      const { group, toggles, changes } = await groupOf(
        `<cf-toggle-group>${formatting}</cf-toggle-group>`,
      );
      group.selectAll();
      expect(group.value).toBe("");
      group.setValue("italic");
      await group.updateComplete;
      expect(pressed(toggles)).toEqual([false, true, false]);
      group.clear();
      await group.updateComplete;
      expect(pressed(toggles)).toEqual([false, false, false]);
      expect(changes).toEqual(["italic", ""]);
    });
  });

  it("starts over when its type changes", async () => {
    const { group, toggles } = await groupOf(
      `<cf-toggle-group value="bold">${formatting}</cf-toggle-group>`,
    );
    group.type = "multiple";
    await group.updateComplete;
    expect(group.value).toEqual([]);
    expect(pressed(toggles)).toEqual([false, false, false]);
  });

  describe("disabled", () => {
    it("disables every toggle, and enables them again when enabled", async () => {
      const { group, toggles } = await groupOf(
        `<cf-toggle-group disabled>${formatting}</cf-toggle-group>`,
      );
      expect(disabled(toggles)).toEqual([true, true, true]);
      group.disabled = false;
      await group.updateComplete;
      expect(disabled(toggles)).toEqual([false, false, false]);
    });

    it("disables a toggle added while it is disabled", async () => {
      const { group } = await groupOf(
        `<cf-toggle-group disabled>${formatting}</cf-toggle-group>`,
      );
      const strike = new CFToggle();
      group.append(strike);
      await settle();
      expect(strike.disabled).toBe(true);
    });

    it("keeps disabled, once enabled again, only the toggles the page disabled", async () => {
      const { group, toggles } = await groupOf(`
        <cf-toggle-group>
          <cf-toggle value="a" disabled></cf-toggle>
          <cf-toggle value="b"></cf-toggle>
        </cf-toggle-group>`);
      group.disabled = true;
      await group.updateComplete;
      expect(disabled(toggles)).toEqual([true, true]);
      group.disabled = false;
      await group.updateComplete;
      expect(disabled(toggles)).toEqual([true, false]);
    });

    it("leaves a toggle's own disabled state on an enabled group", async () => {
      const { toggles } = await groupOf(`
        <cf-toggle-group>
          <cf-toggle value="a" disabled></cf-toggle>
          <cf-toggle value="b"></cf-toggle>
        </cf-toggle-group>`);
      expect(disabled(toggles)).toEqual([true, false]);
    });
  });
});
