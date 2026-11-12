// First, so that the document it installs is there when Lit loads.
import { mount } from "../../test-utils/dom.ts";

import { afterEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import type { CfcLabelView } from "@commonfabric/runtime-client";
import { CFCFCLabel, filterCfcLabelView, formatCfcLabelAtom } from "./index.ts";

/** A mounted label element with `properties` set. */
const mountLabel = (properties: Partial<CFCFCLabel>): Promise<CFCFCLabel> =>
  mount(Object.assign(new CFCFCLabel(), properties));

/** The entries `element` renders, each as its path and its rows' text. */
const renderedEntries = (element: CFCFCLabel) =>
  [...element.shadowRoot!.querySelectorAll(".entry")].map((entry) => ({
    path: entry.querySelector(".path")!.textContent,
    rows: [...entry.querySelectorAll(".row")].map((row) => ({
      kind: row.querySelector(".kind")!.textContent,
      atoms: [...row.querySelectorAll(".atom")].map((atom) =>
        atom.textContent!.trim()
      ),
    })),
  }));

/** The badge `element` renders. */
const badgeOf = (element: CFCFCLabel): HTMLElement =>
  element.shadowRoot!.querySelector<HTMLElement>(".badge")!;

/**
 * A subscribable value that delivers `label` on subscribing, and records the
 * options it was subscribed with and whether it has been unsubscribed.
 */
const subscribableValue = (label: CfcLabelView | undefined) => {
  const state = {
    options: undefined as { onRefused?: () => void } | undefined,
    unsubscribed: false,
  };
  return {
    state,
    value: {
      subscribe: (
        callback: (value: unknown, label?: unknown) => void,
        options: { onRefused?: () => void },
      ) => {
        state.options = options;
        callback(undefined, label);
        return () => {
          state.unsubscribed = true;
        };
      },
    },
  };
};

describe("CFCFCLabel", () => {
  afterEach(() => document.body.replaceChildren());

  it("registers the custom element", () => {
    expect(customElements.get("cf-cfc-label")).toBe(CFCFCLabel);
  });

  it("creates an element instance", () => {
    const element = new CFCFCLabel();
    expect(element).toBeInstanceOf(CFCFCLabel);
  });

  it("loads the label view through the bound value", async () => {
    const cfcLabel = {
      version: 1 as const,
      entries: [{
        path: [],
        label: { confidentiality: ["prompt-risk"] },
      }],
    };
    const element = new CFCFCLabel();
    element.value = {
      getCfcLabel: () => Promise.resolve(cfcLabel),
    };

    await element.refreshLabel();

    expect(element.cfcLabel).toEqual(cfcLabel);
  });

  it("refreshes when the bound value property is assigned", async () => {
    const cfcLabel = {
      version: 1 as const,
      entries: [{
        path: [],
        label: { confidentiality: ["prompt-influence"] },
      }],
    };
    const element = new CFCFCLabel();

    element.value = {
      getCfcLabel: () => Promise.resolve(cfcLabel),
    };
    await Promise.resolve();

    expect(element.cfcLabel).toEqual(cfcLabel);
  });

  it("loads a prebound label view on first update", async () => {
    const cfcLabel = {
      version: 1 as const,
      entries: [{
        path: [],
        label: { confidentiality: ["prompt-influence"] },
      }],
    };
    const element = await mountLabel({
      value: { getCfcLabel: () => Promise.resolve(cfcLabel) },
    });

    expect(element.cfcLabel).toEqual(cfcLabel);
  });

  it("delivers the initial label from a subscribable bound value", async () => {
    const cfcLabel = {
      version: 1 as const,
      entries: [{
        path: [],
        label: { confidentiality: ["prompt-influence"] },
      }],
    };
    const element = new CFCFCLabel();
    element.value = {
      subscribe: (
        callback: (value: unknown, label?: unknown) => void,
      ) => {
        callback(undefined, cfcLabel);
        return () => {};
      },
    };
    await Promise.resolve();

    expect(element.cfcLabel).toEqual(cfcLabel);
  });

  it("reacts to a later label change delivered over the subscription", async () => {
    const labelA = {
      version: 1 as const,
      entries: [{ path: [], label: { integrity: ["authored-by-alice"] } }],
    };
    const labelB = {
      version: 1 as const,
      entries: [{ path: [], label: { integrity: ["authored-by-bob"] } }],
    };
    let emit: ((label: unknown) => void) | undefined;
    const element = new CFCFCLabel();
    element.value = {
      subscribe: (callback: (value: unknown, label?: unknown) => void) => {
        emit = (label) => callback(undefined, label);
        callback(undefined, labelA);
        return () => {};
      },
    };
    await Promise.resolve();
    expect(element.cfcLabel).toEqual(labelA);

    // A label-only change (same value) arrives over the same subscription.
    emit!(labelB);
    await Promise.resolve();
    expect(element.cfcLabel).toEqual(labelB);
  });

  it("uses subscription delivery, not getCfcLabel, for subscribable values", async () => {
    const cfcLabel = {
      version: 1 as const,
      entries: [{
        path: [],
        label: { confidentiality: ["prompt-influence"] },
      }],
    };
    let getCfcLabelCalls = 0;
    let requestedIncludeCfcLabel: boolean | undefined;
    const element = new CFCFCLabel();
    element.value = {
      getCfcLabel: () => {
        getCfcLabelCalls += 1;
        return Promise.resolve(cfcLabel);
      },
      subscribe: (
        callback: (value: unknown, label?: unknown) => void,
        options?: { includeCfcLabel?: boolean },
      ) => {
        requestedIncludeCfcLabel = options?.includeCfcLabel;
        callback(undefined, cfcLabel);
        return () => {};
      },
    };
    await Promise.resolve();

    expect(requestedIncludeCfcLabel).toBe(true);
    expect(element.cfcLabel).toEqual(cfcLabel);
    // The label rides the subscription; no separate getCfcLabel round-trip.
    expect(getCfcLabelCalls).toBe(0);
  });

  it("unsubscribes from its value when it is disconnected", async () => {
    const { state, value } = subscribableValue(undefined);
    const element = await mountLabel({ value });
    expect(state.unsubscribed).toBe(false);

    element.remove();

    expect(state.unsubscribed).toBe(true);
  });

  it("subscribes to its value again when it is reconnected", async () => {
    const label = {
      version: 1 as const,
      entries: [{ path: [], label: { integrity: ["a"] } }],
    };
    const { value } = subscribableValue(label);
    const element = await mountLabel({ value });
    element.remove();
    element.cfcLabel = undefined;

    document.body.append(element);

    expect(element.cfcLabel).toEqual(label);
  });

  it("clears its label when its value's read is refused", async () => {
    const { state, value } = subscribableValue({
      version: 1,
      entries: [{ path: [], label: { integrity: ["a"] } }],
    });
    const element = await mountLabel({ value });
    expect(element.cfcLabel).toBeDefined();

    state.options!.onRefused!();

    expect(element.cfcLabel).toBeUndefined();
  });

  it("clears its label when its value exposes none", async () => {
    const element = new CFCFCLabel();
    element.value = subscribableValue({
      version: 1,
      entries: [{ path: [], label: { integrity: ["a"] } }],
    }).value;
    expect(element.cfcLabel).toBeDefined();

    element.value = { plain: true };
    await Promise.resolve();

    expect(element.cfcLabel).toBeUndefined();
  });

  it("keeps only the latest label when an earlier read finishes last", async () => {
    const early = Promise.withResolvers<CfcLabelView | undefined>();
    const element = new CFCFCLabel();
    element.value = { getCfcLabel: () => early.promise };
    const latest = {
      version: 1 as const,
      entries: [{ path: [], label: { integrity: ["latest"] } }],
    };
    element.value = { getCfcLabel: () => Promise.resolve(latest) };
    await Promise.resolve();

    early.resolve({
      version: 1,
      entries: [{ path: [], label: { integrity: ["stale"] } }],
    });
    await early.promise;

    expect(element.cfcLabel).toEqual(latest);
  });

  it("renders `No CFC label` without a label", async () => {
    const element = await mountLabel({});
    expect(element.shadowRoot!.querySelector(".empty")?.textContent).toBe(
      "No CFC label",
    );
    expect(renderedEntries(element)).toEqual([]);
  });

  it("renders each entry's path and its atoms by kind", async () => {
    const element = await mountLabel({
      value: subscribableValue({
        version: 1,
        entries: [
          {
            path: [],
            label: {
              confidentiality: ["secret", { kind: "k", a: 1 }],
              integrity: [],
            },
          },
          { path: ["items", "0"], label: { integrity: ["trusted"] } },
        ],
      }).value,
    });

    expect(element.shadowRoot!.querySelector(".empty")).toBeNull();
    expect(renderedEntries(element)).toEqual([
      {
        path: "/",
        rows: [{
          kind: "confidentiality",
          atoms: ["secret", '{"a":1,"kind":"k"}'],
        }],
      },
      { path: "/items/0", rows: [{ kind: "integrity", atoms: ["trusted"] }] },
    ]);
  });

  it("renders only the entries and atoms that pass its filter", async () => {
    const element = await mountLabel({
      atom: "trusted",
      cfcLabel: {
        version: 1,
        entries: [
          { path: [], label: { confidentiality: ["secret"] } },
          { path: ["a"], label: { integrity: ["trusted", "other"] } },
        ],
      },
    });

    expect(renderedEntries(element)).toEqual([
      { path: "/a", rows: [{ kind: "integrity", atoms: ["trusted"] }] },
    ]);
  });
});

describe("cf-cfc-label badge variant", () => {
  afterEach(() => document.body.replaceChildren());

  const integrityLabel = {
    version: 1 as const,
    entries: [{
      path: ["value"],
      label: { integrity: ["loom-verified-external-identity"] },
    }],
  };

  it("renders a present badge naming the matched atom", async () => {
    const element = await mountLabel({
      variant: "badge",
      atom: "loom-verified-external-identity",
      text: "Verified by Loom",
      cfcLabel: integrityLabel,
    });

    const badge = badgeOf(element);
    expect(element.getAttribute("variant")).toBe("badge");
    expect(badge.dataset.state).toBe("present");
    expect(badge.title).toBe("loom-verified-external-identity");
    expect(badge.textContent!.trim()).toBe("✓Verified by Loom");
  });

  it("renders a present badge reading `Verified`, titled with each distinct atom, without text", async () => {
    const element = await mountLabel({
      variant: "badge",
      cfcLabel: {
        version: 1,
        entries: [
          { path: [], label: { integrity: ["a", { kind: "k" }] } },
          { path: ["x"], label: { integrity: ["a"] } },
        ],
      },
    });

    const badge = badgeOf(element);
    expect(badge.dataset.state).toBe("present");
    expect(badge.title).toBe('a, {"kind":"k"}');
    expect(badge.textContent!.trim()).toBe("✓Verified");
  });

  it("renders an absent badge when no entry carries the atom", async () => {
    const element = await mountLabel({
      variant: "badge",
      atom: "some-other-atom",
      cfcLabel: integrityLabel,
    });

    expect(badgeOf(element).dataset.state).toBe("absent");
    expect(badgeOf(element).textContent!.trim()).toBe("Unverified");
  });

  it("renders an absent badge when the atom is only a confidentiality atom", async () => {
    const element = await mountLabel({
      variant: "badge",
      atom: "loom-verified-external-identity",
      cfcLabel: {
        version: 1,
        entries: [{
          path: [],
          label: { confidentiality: ["loom-verified-external-identity"] },
        }],
      },
    });

    expect(badgeOf(element).dataset.state).toBe("absent");
    expect(badgeOf(element).textContent!.trim()).toBe("Unverified");
  });

  it("renders an absent badge before any label arrives", async () => {
    const element = await mountLabel({ variant: "badge" });

    expect(badgeOf(element).dataset.state).toBe("absent");
  });
});

describe("cf-cfc-label formatting", () => {
  it("formats string and object atoms without losing kind fields", () => {
    expect(formatCfcLabelAtom("prompt-risk")).toBe("prompt-risk");
    expect(formatCfcLabelAtom({
      kind: "prompt-influence",
      source: "gmail",
    })).toBe('{"kind":"prompt-influence","source":"gmail"}');
  });

  it("formats number, boolean, array, and null atoms as text", () => {
    expect(formatCfcLabelAtom(42)).toBe("42");
    expect(formatCfcLabelAtom(false)).toBe("false");
    expect(formatCfcLabelAtom(["a", 1])).toBe('["a",1]');
    expect(formatCfcLabelAtom(null)).toBe("null");
  });

  it("keeps every atom given no filter", () => {
    const view = {
      version: 1 as const,
      entries: [{
        path: ["a"],
        label: { confidentiality: ["x", { kind: "k" }], integrity: ["y"] },
      }],
    };
    expect(filterCfcLabelView(view, {})).toEqual(view);
    expect(filterCfcLabelView(undefined, {})).toBeUndefined();
  });

  it("matches an object atom by its `atom`, `id`, `type`, or `name` field", () => {
    const atoms: NonNullable<
      CfcLabelView["entries"][number]["label"]["integrity"]
    > = [
      { atom: "x" },
      { id: "x" },
      { type: "x" },
      { name: "x" },
      { id: "y" },
      { kind: "x" },
      "y",
    ];
    const view: CfcLabelView = {
      version: 1,
      entries: [{ path: [], label: { integrity: atoms } }],
    };
    expect(filterCfcLabelView(view, { atom: "x" })?.entries[0].label)
      .toEqual({ integrity: atoms.slice(0, 4) });
    expect(filterCfcLabelView(view, { atom: "x", kind: "k" })).toBeUndefined();
    expect(filterCfcLabelView(view, { atom: "z" })).toBeUndefined();
  });

  it("filters label entries by atom and kind", () => {
    const view = {
      version: 1 as const,
      entries: [{
        path: [],
        label: {
          confidentiality: [
            "prompt-risk",
            { kind: "prompt-influence", source: "gmail" },
          ],
          integrity: ["trusted-disclaimer"],
        },
      }],
    };

    expect(filterCfcLabelView(view, { atom: "prompt-risk" })).toEqual({
      version: 1,
      entries: [{
        path: [],
        label: { confidentiality: ["prompt-risk"] },
      }],
    });
    expect(filterCfcLabelView(view, { kind: "prompt-influence" })).toEqual({
      version: 1,
      entries: [{
        path: [],
        label: {
          confidentiality: [{ kind: "prompt-influence", source: "gmail" }],
        },
      }],
    });
  });
});
