import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";

import { CFCFCAuthorship } from "./index.ts";

/** A label whose root says its value was written by `sender`. */
const authoredByLabel = (sender: string) => ({
  version: 1 as const,
  entries: [{
    path: [],
    label: { integrity: [{ kind: "authored-by", subject: sender }] },
  }],
});

/**
 * Lets every read the element's observation has started finish: the fakes
 * here answer through settled promises, so one zero-delay turn runs them all.
 */
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

/**
 * A resolved cell whose document has not loaded: its label reads as missing
 * until `load()` delivers one to its subscribers, as the runtime does with an
 * update when the document arrives.
 */
const unloadedCell = () => {
  let label: unknown;
  const subscribers = new Set<
    (value: unknown, cfcLabel?: unknown) => void
  >();
  return {
    getCfcLabel: () => Promise.resolve(label),
    subscribe(callback: (value: unknown, cfcLabel?: unknown) => void) {
      subscribers.add(callback);
      callback(undefined, label);
      return () => {
        subscribers.delete(callback);
      };
    },
    subscriberCount: () => subscribers.size,

    /** Delivers `next` as the label, and settles the reads it starts. */
    async load(next: unknown) {
      label = next;
      for (const callback of [...subscribers]) {
        callback({ loaded: true }, label);
      }
      await settle();
    },
  };
};

/** The markup `render()` returns, with each value written in place. */
const templateText = (node: unknown): string => {
  const template = node as { strings?: unknown; values?: unknown[] };
  if (!Array.isArray(template?.strings)) {
    return node === null || node === undefined ? "" : String(node);
  }
  return template.strings.map((part, index) =>
    part +
    (index < (template.values?.length ?? 0)
      ? templateText(template.values![index])
      : "")
  ).join("");
};

/** An element that reports itself connected, as one in a document does. */
const connectedElement = () => {
  const element = new CFCFCAuthorship();
  Object.defineProperty(element, "isConnected", {
    value: true,
    configurable: true,
  });
  return element;
};

describe("CFCFCAuthorship", () => {
  it("registers the custom element", () => {
    expect(customElements.get("cf-cfc-authorship")).toBe(CFCFCAuthorship);
  });

  it("declares reflected badge placement for mirrored chat rows", () => {
    const element = new CFCFCAuthorship();
    const property = CFCFCAuthorship.properties.badgePlacement;

    expect(element.badgePlacement).toBe("start");
    expect(property.attribute).toBe("badge-placement");
    expect(property.reflect).toBe(true);
  });

  it("reads `loading` before it has observed anything", () => {
    expect(new CFCFCAuthorship().authorshipState).toBe("loading");
  });

  it("reads no label while it is not connected", async () => {
    let reads = 0;
    const element = new CFCFCAuthorship();
    element.author = "alice";
    element.value = {
      getCfcLabel: () => {
        reads++;
        return Promise.resolve(authoredByLabel("alice"));
      },
    };
    await settle();

    expect(reads).toBe(0);
    expect(element.authorshipState).toBe("loading");
  });

  it("reads the verdict its observation reports", async () => {
    const element = connectedElement();

    try {
      element.author = { id: "alice", name: "Alice Nguyen" };
      element.value = {
        getCfcLabel: () => Promise.resolve(authoredByLabel("alice")),
      };
      await settle();

      expect(element.authorshipState).toBe("verified");
      const text = templateText(element.render());
      expect(text).toContain('data-cfc-authorship-state="verified"');
      expect(text).toContain("Verified author");
      expect(text).toContain("Alice Nguyen");
    } finally {
      element.disconnectedCallback();
    }
  });

  it("renders `loading` with no warning while the value's resolved cell has not loaded", async () => {
    const resolved = unloadedCell();
    const element = connectedElement();

    try {
      element.author = "alice";
      element.value = {
        getCfcLabel: () => Promise.resolve(undefined),
        resolveAsCell: () => Promise.resolve(resolved),
      };
      await settle();

      expect(element.authorshipState).toBe("loading");
      const text = templateText(element.render());
      expect(text).toContain('data-cfc-authorship-state="loading"');
      expect(text).toContain("Checking author");
      expect(text).not.toContain("Unknown author");
      expect(text).not.toContain(">!<");

      await resolved.load(authoredByLabel("alice"));

      expect(element.authorshipState).toBe("verified");
    } finally {
      element.disconnectedCallback();
    }
  });

  it("reads `unverified` for a verified value when strict descendant text was blocked", async () => {
    const element = connectedElement();

    try {
      element.author = "alice";
      element.verifyTextIntegrity = true;
      element.textIntegrityState = "blocked";
      element.value = {
        getCfcLabel: () => Promise.resolve(authoredByLabel("alice")),
      };
      await settle();

      expect(element.authorshipState).toBe("unverified");
    } finally {
      element.disconnectedCallback();
    }
  });

  it("keeps its verdict when it disconnects", async () => {
    const element = connectedElement();
    element.author = "alice";
    element.value = {
      getCfcLabel: () => Promise.resolve(authoredByLabel("alice")),
    };
    await settle();

    element.disconnectedCallback();

    expect(element.authorshipState).toBe("verified");
  });

  it("forgets its verdict when its value changes", async () => {
    const resolved = unloadedCell();
    const element = connectedElement();

    try {
      element.author = "alice";
      element.value = {
        getCfcLabel: () => Promise.resolve(authoredByLabel("alice")),
      };
      await settle();
      expect(element.authorshipState).toBe("verified");

      element.value = {
        getCfcLabel: () => Promise.resolve(undefined),
        resolveAsCell: () => Promise.resolve(resolved),
      };
      await settle();

      expect(element.authorshipState).toBe("loading");
    } finally {
      element.disconnectedCallback();
    }
  });

  it("ends its observation when it disconnects", async () => {
    const resolved = unloadedCell();
    const element = connectedElement();
    element.author = "alice";
    element.value = {
      getCfcLabel: () => Promise.resolve(undefined),
      resolveAsCell: () => Promise.resolve(resolved),
    };
    await settle();
    expect(resolved.subscriberCount()).toBe(1);

    element.disconnectedCallback();

    expect(resolved.subscriberCount()).toBe(0);
  });
});
