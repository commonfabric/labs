/**
 * Test utility: a `document` stand-in for code that builds detached elements.
 *
 * The unit test environment has no DOM. This provides the small surface that
 * element-building code touches — creating an element, setting its inline
 * style, appending children — so such code can be exercised directly rather
 * than only from a browser suite.
 */

/** An element created by {@link installMockDocument}. */
export interface MockElement {
  tagName: string;
  style: { cssText: string };
  textContent: string;
  children: MockElement[];
  parentNode: MockElement | null;
  appendChild(child: MockElement): MockElement;
  removeChild(child: MockElement): MockElement;
  replaceChildren(...replacements: MockElement[]): void;
  // Components assign their own properties, `cell` and `isStatic` among them.
  [key: string]: unknown;
}

export interface MockDocument {
  body: MockElement;
  createElement(tagName: string): MockElement;
}

export function createMockElement(tagName: string): MockElement {
  const children: MockElement[] = [];
  const element: MockElement = {
    tagName,
    style: { cssText: "" },
    textContent: "",
    children,
    parentNode: null,
    appendChild(child: MockElement) {
      child.parentNode = element;
      children.push(child);
      return child;
    },
    removeChild(child: MockElement) {
      const index = children.indexOf(child);
      if (index >= 0) children.splice(index, 1);
      child.parentNode = null;
      return child;
    },
    replaceChildren(...replacements: MockElement[]) {
      for (const child of children) child.parentNode = null;
      children.length = 0;
      for (const child of replacements) element.appendChild(child);
    },
  };
  return element;
}

/**
 * Install a mock `document` on the global object and return it along with a
 * restore function. Call the restore in a `finally` or `afterEach` so the
 * global does not leak into other test files.
 */
export function installMockDocument(): {
  document: MockDocument;
  restore(): void;
} {
  const document: MockDocument = {
    body: createMockElement("body"),
    createElement: (tagName: string) => createMockElement(tagName),
  };
  const globals = globalThis as { document?: unknown };
  const had = Object.hasOwn(globals, "document");
  const previous = globals.document;
  globals.document = document;
  return {
    document,
    restore() {
      if (had) globals.document = previous;
      else delete globals.document;
    },
  };
}
