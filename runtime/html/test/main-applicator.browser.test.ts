/**
 * Tests of how `DomApplicator` removes a property from an element, run on
 * elements that a real browser creates. The unit tests in
 * `main-applicator.test.ts` run the same code against a mock document. These
 * tests check it against the browser's own rules for which properties set
 * which attributes. They run under deno-web-test, which registers tests
 * through `Deno.test`. The functions from `@std/testing/bdd` are therefore not
 * available here.
 */

import { assertEquals, assertStrictEquals } from "@std/assert";

import { DomApplicator } from "../src/main/applicator.ts";
import type { VDomOp } from "../src/vdom-ops.ts";

/**
 * A custom element class that defines one property, `label`, with a getter and
 * a setter on the class, in the way a Lit component defines its properties.
 */
class LabeledBox extends HTMLElement {
  /** Number of instances constructed so far, in any document. */
  static constructed = 0;

  #label?: string;

  /** Constructs an instance, counting it. */
  constructor() {
    super();
    LabeledBox.constructed++;
  }

  /** Text the box shows. */
  get label(): string | undefined {
    return this.#label;
  }

  set label(value: string | undefined) {
    this.#label = value;
  }
}
customElements.define("x-labeled-box", LabeledBox);

/**
 * Creates a `tagName` element through a new `DomApplicator`, and gives it
 * `attributes` and the child markup `children`. Then sets `props` on it through
 * the applicator, removes the property `removedKey` through the applicator, and
 * returns the element.
 */
function removeAfterSetting(
  tagName: string,
  attributes: Record<string, string>,
  props: Record<string, string | number | boolean>,
  removedKey: string,
  children = "",
): HTMLElement {
  const applicator = new DomApplicator({
    onEvent: () => {},
    onError: (error) => {
      throw error;
    },
  });
  applicator.applyBatch({
    batchId: 1,
    ops: [{ op: "create-element", nodeId: 1, tagName }],
  });
  const element = applicator.getNode(1) as HTMLElement;
  for (const [name, value] of Object.entries(attributes)) {
    element.setAttribute(name, value);
  }
  element.innerHTML = children;
  applicator.applyBatch({
    batchId: 2,
    ops: Object.entries(props).map(([key, value]): VDomOp => ({
      op: "set-prop",
      nodeId: 1,
      key,
      value,
    })),
  });
  applicator.applyBatch({
    batchId: 3,
    ops: [{ op: "remove-prop", nodeId: 1, key: removedKey }],
  });
  return element;
}

/**
 * Asserts that `element` has the same markup, and the same value for the
 * property `key`, as a newly created element with the same tag, `attributes`,
 * and child markup `children`.
 */
function assertPristine(
  element: HTMLElement,
  attributes: Record<string, string>,
  key: string,
  children: string,
): void {
  const pristine = document.createElement(element.localName);
  for (const [name, value] of Object.entries(attributes)) {
    pristine.setAttribute(name, value);
  }
  pristine.innerHTML = children;
  assertEquals(element.outerHTML, pristine.outerHTML);
  assertStrictEquals(Reflect.get(element, key), Reflect.get(pristine, key));
}

/**
 * Built-in properties to remove, each as the tag, the attributes the element
 * starts with, the property, the value it is set to first, and optionally the
 * child markup the element starts with.
 */
const selectOptions =
  '<option>a</option><option selected="">b</option><option>c</option>';
const builtInCases: [
  string,
  Record<string, string>,
  string,
  string | number | boolean,
  string?,
][] = [
  ["input", {}, "title", "Hint"],
  ["input", {}, "placeholder", "Name"],
  ["div", {}, "className", "wide"],
  ["label", {}, "htmlFor", "name"],
  ["a", {}, "href", "https://example.com/"],
  ["a", {}, "href", ""],
  ["img", {}, "alt", ""],
  ["div", {}, "tabIndex", 3],
  ["div", {}, "tabIndex", -1],
  ["div", {}, "hidden", true],
  ["input", {}, "maxLength", 4],
  ["div", {}, "contentEditable", "true"],
  ["input", { type: "text" }, "value", "typed"],
  ["input", { type: "text", value: "default" }, "value", "typed"],
  ["textarea", {}, "value", "typed"],
  ["textarea", {}, "value", "typed", "default"],
  ["select", {}, "value", "c", selectOptions],
  ["select", {}, "selectedIndex", 2, selectOptions],
  ["input", { type: "checkbox" }, "value", "yes"],
  ["input", { type: "checkbox" }, "checked", true],
  ["input", { type: "checkbox", checked: "" }, "checked", false],
  ["input", { type: "number" }, "valueAsNumber", 5],
  ["div", {}, "textContent", "text"],
];

for (const [tagName, attributes, key, value, children = ""] of builtInCases) {
  const markup = `<${tagName}${
    Object.entries(attributes).map(([name, v]) => ` ${name}="${v}"`).join("")
  }>${children && `${children}</${tagName}>`}`;
  Deno.test(`removing ${key}, set to ${JSON.stringify(value)}, from ${markup} leaves it as though never set`, () => {
    const element = removeAfterSetting(
      tagName,
      attributes,
      {
        [key]: value,
      },
      key,
      children,
    );
    assertPristine(element, attributes, key, children);
  });
}

Deno.test("removing one property leaves the others in place", () => {
  const element = removeAfterSetting("input", {}, {
    title: "Hint",
    placeholder: "Name",
  }, "title");
  assertEquals(element.outerHTML, '<input placeholder="Name">');
});

Deno.test("removing an inherited property from a custom element removes its attribute", () => {
  const element = removeAfterSetting("x-labeled-box", {}, {
    title: "Hint",
    label: "Box",
  }, "title");
  assertEquals(element.outerHTML, "<x-labeled-box></x-labeled-box>");
  assertStrictEquals((element as LabeledBox).label, "Box");
});

Deno.test("removing a property from a custom element constructs no other instance", () => {
  const before = LabeledBox.constructed;
  removeAfterSetting("x-labeled-box", {}, { title: "Hint" }, "title");
  assertStrictEquals(LabeledBox.constructed, before + 1);
});

Deno.test("removing a property a custom element defines sets it to undefined", () => {
  const element = removeAfterSetting("x-labeled-box", {}, {
    title: "Hint",
    label: "Box",
  }, "label");
  assertStrictEquals((element as LabeledBox).label, undefined);
  assertEquals(
    element.outerHTML,
    '<x-labeled-box title="Hint"></x-labeled-box>',
  );
});

/**
 * A custom element that declares hyphenated attributes for camel-case
 * properties, as a Lit component does with `attribute: "default-size"`.
 */
class SizedPanel extends HTMLElement {
  static observedAttributes = ["default-size", "hide-when-stacked"];
  defaultSize = 50;
  hideWhenStacked = false;

  attributeChangedCallback(
    name: string,
    _old: string | null,
    value: string | null,
  ): void {
    if (name === "default-size") {
      this.defaultSize = value === null ? 50 : Number(value);
    } else this.hideWhenStacked = value !== null;
  }
}
customElements.define("x-sized-panel", SizedPanel);

/** A new `x-sized-panel` made through `applicator`, as node 1. */
function sizedPanel(applicator: DomApplicator): SizedPanel {
  applicator.applyBatch({
    batchId: 1,
    ops: [{ op: "create-element", nodeId: 1, tagName: "x-sized-panel" }],
  });
  return applicator.getNode(1) as SizedPanel;
}

/** A `DomApplicator` that throws whatever it reports. */
function throwingApplicator(): DomApplicator {
  return new DomApplicator({
    onEvent: () => {},
    onError: (error) => {
      throw error;
    },
  });
}

Deno.test("a hyphenated prop is set as the attribute, which the custom element reads into its property", () => {
  const applicator = throwingApplicator();
  const panel = sizedPanel(applicator);
  applicator.applyBatch({
    batchId: 2,
    ops: [{ op: "set-prop", nodeId: 1, key: "default-size", value: 28 }],
  });
  assertStrictEquals(panel.getAttribute("default-size"), "28");
  assertStrictEquals(panel.defaultSize, 28);
  assertStrictEquals(Object.hasOwn(panel, "default-size"), false);

  applicator.applyBatch({
    batchId: 3,
    ops: [{ op: "remove-prop", nodeId: 1, key: "default-size" }],
  });
  assertStrictEquals(panel.hasAttribute("default-size"), false);
  assertStrictEquals(panel.defaultSize, 50);
});

Deno.test("a hyphenated boolean prop is present while true and absent while false", () => {
  const applicator = throwingApplicator();
  const panel = sizedPanel(applicator);
  applicator.applyBatch({
    batchId: 2,
    ops: [{ op: "set-prop", nodeId: 1, key: "hide-when-stacked", value: true }],
  });
  assertStrictEquals(panel.getAttribute("hide-when-stacked"), "");
  assertStrictEquals(panel.hideWhenStacked, true);

  applicator.applyBatch({
    batchId: 3,
    ops: [{
      op: "set-prop",
      nodeId: 1,
      key: "hide-when-stacked",
      value: false,
    }],
  });
  assertStrictEquals(panel.hasAttribute("hide-when-stacked"), false);
  assertStrictEquals(panel.hideWhenStacked, false);
});

Deno.test("an ARIA prop set to false keeps the text false", () => {
  const applicator = throwingApplicator();
  const panel = sizedPanel(applicator);
  applicator.applyBatch({
    batchId: 2,
    ops: [{ op: "set-prop", nodeId: 1, key: "aria-hidden", value: false }],
  });
  assertStrictEquals(panel.getAttribute("aria-hidden"), "false");
});
