// First, so that the document it installs is there when Lit loads.
import { mount } from "../../test-utils/dom.ts";

import { expect } from "@std/expect";
import { afterEach, describe, it } from "@std/testing/bdd";

import {
  authorshipStateForLabel as runtimeAuthorshipStateForLabel,
  integrityAtomMatchesAuthor as runtimeIntegrityAtomMatchesAuthor,
} from "@commonfabric/runtime-client";

import {
  authorshipStateForLabel,
  CFCFCAuthorship,
  integrityAtomMatchesAuthor,
} from "./index.ts";

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

/** A mounted element with `properties` set. */
const mountAuthorship = (
  properties: Partial<CFCFCAuthorship>,
): Promise<CFCFCAuthorship> =>
  mount(Object.assign(new CFCFCAuthorship(), properties));

/** What `element`'s badge shows. */
const badgeOf = (element: CFCFCAuthorship) => {
  const root = element.shadowRoot!;
  return {
    state: root.querySelector("section")!.dataset.cfcAuthorshipState,
    hostState: element.dataset.state,
    stateLabel: root.querySelector(".state")!.textContent,
    author: root.querySelector(".author")!.textContent,
    dot: root.querySelector(".status-dot")?.textContent?.trim() ?? null,
    avatar: root.querySelector(".avatar")?.textContent?.trim() ?? null,
    image: root.querySelector(".avatar img")?.getAttribute("src") ?? null,
  };
};

describe("CFCFCAuthorship", () => {
  afterEach(() => document.body.replaceChildren());

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

  it("exports the verdict rules `observeAuthorship()` decides by", () => {
    expect(authorshipStateForLabel).toBe(runtimeAuthorshipStateForLabel);
    expect(integrityAtomMatchesAuthor).toBe(
      runtimeIntegrityAtomMatchesAuthor,
    );
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
    const element = await mountAuthorship({
      author: { id: "alice", name: "Alice Nguyen" },
      value: { getCfcLabel: () => Promise.resolve(authoredByLabel("alice")) },
    });
    await settle();
    await element.updateComplete;

    expect(element.authorshipState).toBe("verified");
    expect(badgeOf(element)).toEqual({
      state: "verified",
      hostState: "verified",
      stateLabel: "Verified author",
      author: "Alice Nguyen",
      dot: null,
      avatar: "AN",
      image: null,
    });
  });

  it("renders `loading` with no warning while the value's resolved cell has not loaded", async () => {
    const resolved = unloadedCell();
    const element = await mountAuthorship({
      author: "alice",
      authorName: "Alice?",
      value: {
        getCfcLabel: () => Promise.resolve(undefined),
        resolveAsCell: () => Promise.resolve(resolved),
      },
    });
    await settle();
    await element.updateComplete;

    expect(element.authorshipState).toBe("loading");
    expect(badgeOf(element)).toEqual({
      state: "loading",
      hostState: "loading",
      stateLabel: "Checking author",
      author: "Alice?",
      dot: "",
      avatar: null,
      image: null,
    });

    await resolved.load(authoredByLabel("alice"));

    expect(element.authorshipState).toBe("verified");
  });

  it("reads `unverified` for a verified value when strict descendant text was blocked", async () => {
    const element = await mountAuthorship({
      author: "alice",
      verifyTextIntegrity: true,
      textIntegrityState: "blocked",
      value: { getCfcLabel: () => Promise.resolve(authoredByLabel("alice")) },
    });
    await settle();
    await element.updateComplete;

    expect(element.authorshipState).toBe("unverified");
    expect(badgeOf(element)).toMatchObject({
      state: "unverified",
      stateLabel: "Unverified author",
      dot: "!",
      avatar: null,
    });
  });

  it("renders `unknown` with a warning and the untrusted name when the claim names no author", async () => {
    const element = await mountAuthorship({
      author: {},
      authorName: 42,
      value: {
        getCfcLabel: () =>
          Promise.resolve({
            version: 1 as const,
            entries: [{ path: [], label: { integrity: ["reviewed"] } }],
          }),
      },
    });
    await settle();
    await element.updateComplete;

    expect(badgeOf(element)).toEqual({
      state: "unknown",
      hostState: "unknown",
      stateLabel: "Unknown author",
      author: "42",
      dot: "!",
      avatar: null,
      image: null,
    });
  });

  it("renders `unknown author` when neither the claim nor an untrusted name names one", async () => {
    const element = await mountAuthorship({
      author: {},
      value: { getCfcLabel: () => Promise.resolve(authoredByLabel("bob")) },
    });
    await settle();
    await element.updateComplete;

    expect(badgeOf(element)).toMatchObject({
      state: "unknown",
      author: "unknown author",
    });
  });

  it("renders `unverified` with a warning when the label names another author", async () => {
    const element = await mountAuthorship({
      author: "alice",
      value: { getCfcLabel: () => Promise.resolve(authoredByLabel("bob")) },
    });
    await settle();
    await element.updateComplete;

    expect(badgeOf(element)).toMatchObject({
      state: "unverified",
      stateLabel: "Unverified author",
      author: "alice",
      dot: "!",
      avatar: null,
    });
  });

  it("renders the avatar image only once verified", async () => {
    const element = await mountAuthorship({
      author: "alice",
      avatar: "data:image/png;base64,AAAA",
      value: { getCfcLabel: () => Promise.resolve(authoredByLabel("alice")) },
    });
    expect(badgeOf(element).image).toBeNull();
    await settle();
    await element.updateComplete;

    expect(badgeOf(element).image).toBe("data:image/png;base64,AAAA");
  });

  it("observes again when its kind or untrusted name changes", async () => {
    const element = await mountAuthorship({
      author: "alice",
      value: { getCfcLabel: () => Promise.resolve(authoredByLabel("alice")) },
    });
    await settle();
    await element.updateComplete;
    expect(element.authorshipState).toBe("verified");

    element.kind = "represents-principal";
    await element.updateComplete;
    expect(element.authorshipState).toBe("loading");
    await settle();
    expect(element.authorshipState).not.toBe("verified");

    element.kind = undefined;
    element.authorName = true;
    await element.updateComplete;
    await settle();
    expect(element.authorshipState).toBe("verified");
  });

  it("keeps its verdict when it disconnects", async () => {
    const element = await mountAuthorship({
      author: "alice",
      value: { getCfcLabel: () => Promise.resolve(authoredByLabel("alice")) },
    });
    await settle();

    element.remove();

    expect(element.authorshipState).toBe("verified");
  });

  it("forgets its verdict when its value changes", async () => {
    const resolved = unloadedCell();
    const element = await mountAuthorship({
      author: "alice",
      value: { getCfcLabel: () => Promise.resolve(authoredByLabel("alice")) },
    });
    await settle();
    expect(element.authorshipState).toBe("verified");

    element.value = {
      getCfcLabel: () => Promise.resolve(undefined),
      resolveAsCell: () => Promise.resolve(resolved),
    };
    await settle();

    expect(element.authorshipState).toBe("loading");
  });

  it("ends its observation when it disconnects", async () => {
    const resolved = unloadedCell();
    const element = await mountAuthorship({
      author: "alice",
      value: {
        getCfcLabel: () => Promise.resolve(undefined),
        resolveAsCell: () => Promise.resolve(resolved),
      },
    });
    await settle();
    expect(resolved.subscriberCount()).toBe(1);

    element.remove();

    expect(resolved.subscriberCount()).toBe(0);
  });
});
