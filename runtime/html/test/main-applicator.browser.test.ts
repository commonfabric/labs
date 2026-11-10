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
import { expect } from "@std/expect";

import { DomApplicator } from "../src/main/applicator.ts";
import { CONTAINER_NODE_ID, type VDomOp } from "../src/vdom-ops.ts";

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

for (const authoredInert of [false, true]) {
  Deno.test(`removing pending state restores authored inert=${authoredInert} and busy attributes and focus behavior`, () => {
    const applicator = new DomApplicator({
      onEvent: () => {},
      onError: (error) => {
        throw error;
      },
    });
    applicator.applyBatch({
      batchId: 1,
      ops: [{ op: "create-element", nodeId: 1, tagName: "button" }],
    });
    const button = applicator.getNode(1) as HTMLButtonElement;
    document.body.appendChild(button);
    try {
      button.inert = authoredInert;
      button.setAttribute("aria-busy", "false");
      applicator.applyBatch({
        batchId: 2,
        ops: [{
          op: "set-prop",
          nodeId: 1,
          key: "data-cf-pending",
          value: true,
        }],
      });
      assertStrictEquals(button.inert, true);
      assertStrictEquals(button.getAttribute("aria-busy"), "true");
      button.focus();
      assertStrictEquals(document.activeElement === button, false);

      applicator.applyBatch({
        batchId: 3,
        ops: [{ op: "remove-prop", nodeId: 1, key: "data-cf-pending" }],
      });
      assertStrictEquals(button.hasAttribute("data-cf-pending"), false);
      assertStrictEquals(button.inert, authoredInert);
      assertStrictEquals(button.getAttribute("aria-busy"), "false");
      button.focus();
      assertStrictEquals(document.activeElement === button, !authoredInert);
    } finally {
      button.remove();
      applicator.dispose();
    }
  });
}

Deno.test("pending state retains authored attribute updates until recovery", () => {
  const applicator = new DomApplicator({
    onEvent: () => {},
    onError: (error) => {
      throw error;
    },
  });
  applicator.applyBatch({
    batchId: 1,
    ops: [{ op: "create-element", nodeId: 1, tagName: "button" }],
  });
  const button = applicator.getNode(1) as HTMLButtonElement;
  document.body.appendChild(button);
  try {
    button.inert = true;
    button.setAttribute("aria-busy", "true");
    applicator.applyBatch({
      batchId: 2,
      ops: [{
        op: "set-prop",
        nodeId: 1,
        key: "data-cf-pending",
        value: true,
      }, {
        op: "set-prop",
        nodeId: 1,
        key: "inert",
        value: false,
      }, {
        op: "set-prop",
        nodeId: 1,
        key: "aria-busy",
        value: "false",
      }],
    });
    assertStrictEquals(button.inert, true);
    assertStrictEquals(button.getAttribute("aria-busy"), "true");
    button.focus();
    assertStrictEquals(document.activeElement === button, false);

    applicator.applyBatch({
      batchId: 3,
      ops: [{ op: "remove-prop", nodeId: 1, key: "data-cf-pending" }],
    });
    assertStrictEquals(button.inert, false);
    assertStrictEquals(button.getAttribute("aria-busy"), "false");
    button.focus();
    assertStrictEquals(document.activeElement, button);
  } finally {
    button.remove();
    applicator.dispose();
  }
});

/** Applies one DOM operation through the real applicator. */
function apply(applicator: DomApplicator, op: VDomOp): void {
  applicator.applyBatch({ batchId: 1, ops: [op] });
}

/** Changes one source node's pending ownership. */
function markPending(
  applicator: DomApplicator,
  nodeId: number,
  value: boolean,
) {
  apply(applicator, { op: "set-prop", nodeId, key: "data-cf-pending", value });
}

Deno.test("pending text siblings and their parent independently retain inert state", () => {
  const applicator = new DomApplicator({ onEvent: () => {} });
  applicator.applyBatch({
    batchId: 1,
    ops: [
      { op: "create-element", nodeId: 1, tagName: "button" },
      { op: "create-text", nodeId: 2, text: "Retained " },
      { op: "create-text", nodeId: 3, text: "action" },
      { op: "insert-child", parentId: 1, childId: 2, beforeId: null },
      { op: "insert-child", parentId: 1, childId: 3, beforeId: null },
    ],
  });
  const button = applicator.getNode(1) as HTMLButtonElement;
  document.body.append(button);
  try {
    button.setAttribute("aria-busy", "false");
    markPending(applicator, 2, true);
    markPending(applicator, 2, true);
    markPending(applicator, 3, true);
    expect(button.textContent).toBe("Retained action");
    expect(button.inert).toBe(true);
    expect(button.getAttribute("aria-busy")).toBe("true");
    button.focus();
    expect(document.activeElement).not.toBe(button);
    apply(applicator, { op: "remove-prop", nodeId: 2, key: "data-cf-pending" });
    expect(button.inert).toBe(true);
    markPending(applicator, 1, true);
    markPending(applicator, 3, false);
    expect(button.inert).toBe(true);
    apply(applicator, {
      op: "set-prop",
      nodeId: 1,
      key: "inert",
      value: false,
    });
    apply(applicator, {
      op: "set-prop",
      nodeId: 1,
      key: "aria-busy",
      value: "false",
    });
    expect(button.inert).toBe(true);
    markPending(applicator, 1, false);
    expect(button.inert).toBe(false);
    expect(button.getAttribute("aria-busy")).toBe("false");
    button.focus();
    expect(document.activeElement).toBe(button);
  } finally {
    applicator.dispose();
    button.remove();
  }
});

Deno.test("pending text ownership follows insertion, reparenting, removal, and disposal", () => {
  const applicator = new DomApplicator({ onEvent: () => {} });
  applicator.applyBatch({
    batchId: 1,
    ops: [
      { op: "create-element", nodeId: 1, tagName: "button" },
      { op: "create-element", nodeId: 4, tagName: "button" },
      { op: "create-text", nodeId: 2, text: "First" },
      { op: "create-text", nodeId: 3, text: "Second" },
    ],
  });
  const first = applicator.getNode(1) as HTMLButtonElement;
  const second = applicator.getNode(4) as HTMLButtonElement;
  document.body.append(first, second);
  try {
    markPending(applicator, 2, true);
    expect(first.inert).toBe(false);
    apply(applicator, {
      op: "insert-child",
      parentId: 1,
      childId: 2,
      beforeId: null,
    });
    expect(first.inert).toBe(true);
    apply(applicator, {
      op: "insert-child",
      parentId: 1,
      childId: 3,
      beforeId: null,
    });
    markPending(applicator, 3, true);
    apply(applicator, {
      op: "insert-child",
      parentId: 4,
      childId: 2,
      beforeId: null,
    });
    expect(first.inert).toBe(true);
    expect(second.inert).toBe(true);
    apply(applicator, { op: "remove-node", nodeId: 3 });
    expect(first.inert).toBe(false);
    apply(applicator, { op: "remove-node", nodeId: 2 });
    expect(second.inert).toBe(false);
    apply(applicator, {
      op: "create-text",
      nodeId: 5,
      text: "Removed subtree",
    });
    apply(applicator, {
      op: "insert-child",
      parentId: 1,
      childId: 5,
      beforeId: null,
    });
    markPending(applicator, 5, true);
    expect(first.inert).toBe(true);
    apply(applicator, { op: "remove-node", nodeId: 1 });
    expect(first.inert).toBe(false);
    markPending(applicator, 4, true);
    expect(second.inert).toBe(true);
    applicator.dispose();
    expect(second.inert).toBe(false);
  } finally {
    applicator.dispose();
    first.remove();
    second.remove();
  }
});

Deno.test("pure root text does not make an unrelated host surface inert", () => {
  const container = document.createElement("div");
  const external = document.createElement("button");
  container.append(external);
  document.body.append(container);
  const applicator = new DomApplicator({ onEvent: () => {} });
  applicator.setContainer(container);
  try {
    apply(applicator, { op: "create-text", nodeId: 1, text: "Retained text" });
    apply(applicator, {
      op: "insert-child",
      parentId: CONTAINER_NODE_ID,
      childId: 1,
      beforeId: null,
    });
    markPending(applicator, 1, true);
    expect(container.inert).toBe(false);
    expect(container.hasAttribute("data-cf-pending")).toBe(false);
    external.focus();
    expect(document.activeElement).toBe(external);
  } finally {
    applicator.dispose();
    container.remove();
  }
});
