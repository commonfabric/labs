// Minimal DOM surface needed while component modules register their elements.
/** Element base class used only while registering constructors. */
class HTMLElementStub extends EventTarget {
  style = {};

  /** Shadow placeholder for initialization paths. */
  attachShadow() {
    return { appendChild() {} };
  }
}

interface RegistrationElement {
  tagName: string;
  style: object;
  children: never[];
  childNodes: never[];
  appendChild(): void;
  removeChild(): void;
  setAttribute(): void;
  removeAttribute(): void;
  getAttribute(): null;
  cloneNode(): RegistrationElement;
  getContext(): null;
  content: { cloneNode(): RegistrationElement };
}

/** A detached element sufficient for module initialization. */
function makeElement(tag = "div"): RegistrationElement {
  return {
    tagName: tag.toUpperCase(),
    style: {},
    children: [],
    childNodes: [],
    appendChild() {},
    removeChild() {},
    setAttribute() {},
    removeAttribute() {},
    getAttribute() {
      return null;
    },
    cloneNode() {
      return makeElement(tag);
    },
    getContext() {
      return null;
    },
    content: {
      cloneNode() {
        return makeElement("fragment");
      },
    },
  };
}

const documentStub = {
  documentElement: makeElement("html"),
  createElement: makeElement,
  createElementNS(_namespace: string, tag: string) {
    return makeElement(tag);
  },
  createTreeWalker(root: RegistrationElement) {
    return {
      currentNode: root,
      nextNode() {
        return null;
      },
    };
  },
  createComment() {
    return makeElement("comment");
  },
  createTextNode() {
    return makeElement("text");
  },
  body: makeElement("body"),
  head: makeElement("head"),
  addEventListener() {},
  removeEventListener() {},
  hidden: false,
};
const navigatorStub = { userAgent: "", platform: "" };
const windowStub = {
  document: documentStub,
  navigator: navigatorStub,
  screen: {},
  requestAnimationFrame() {
    throw new Error("Registration must not schedule animation frames");
  },
  cancelAnimationFrame() {},
  addEventListener() {},
  removeEventListener() {},
  devicePixelRatio: 1,
};

Object.assign(windowStub, {
  HTMLElement: HTMLElementStub,
  SVGElement: HTMLElementStub,
  Element: HTMLElementStub,
});

/** Constructors registered by modules loaded in this test isolate. */
const registry = new Map<string, CustomElementConstructor>();
const customElementsStub = {
  define(tag: string, constructor: CustomElementConstructor) {
    if (registry.has(tag)) {
      throw new Error(`Duplicate custom element registration: ${tag}`);
    }
    registry.set(tag, constructor);
  },
  get(tag: string) {
    return registry.get(tag);
  },
  whenDefined(tag: string) {
    const constructor = registry.get(tag);
    return constructor
      ? Promise.resolve(constructor)
      : Promise.reject(new Error(`Custom element is not defined: ${tag}`));
  },
};

for (
  const [key, value] of Object.entries({
    HTMLElement: HTMLElementStub,
    Element: HTMLElementStub,
    SVGElement: HTMLElementStub,
    window: windowStub,
    document: documentStub,
    navigator: navigatorStub,
    customElements: customElementsStub,
    NodeFilter: { SHOW_ELEMENT: 1, SHOW_COMMENT: 128, SHOW_TEXT: 4 },
  })
) {
  Object.defineProperty(globalThis, key, { value, configurable: true });
}

export { registry };
