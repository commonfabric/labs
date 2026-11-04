import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { CFCFCLabel, filterCfcLabelView, formatCfcLabelAtom } from "./index.ts";

// Flattens a lit template to its static text interleaved with its bound
// values, so a test can read what a render produces without a DOM.
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

describe("CFCFCLabel", () => {
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
    const element = new CFCFCLabel();
    element.value = {
      getCfcLabel: () => Promise.resolve(cfcLabel),
    };

    (element as unknown as {
      firstUpdated(changedProperties: Map<PropertyKey, unknown>): void;
    }).firstUpdated(new Map());
    await Promise.resolve();

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
});

describe("cf-cfc-label badge variant", () => {
  const integrityLabel = {
    version: 1 as const,
    entries: [{
      path: ["value"],
      label: { integrity: ["loom-verified-external-identity"] },
    }],
  };

  it("renders a present badge naming the matched atom", () => {
    const element = new CFCFCLabel();
    element.variant = "badge";
    element.atom = "loom-verified-external-identity";
    element.text = "Verified by Loom";
    element.cfcLabel = integrityLabel;

    const text = templateText(element.render());

    expect(text).toContain('data-state="present"');
    expect(text).toContain('title="loom-verified-external-identity"');
    expect(text).toContain("Verified by Loom");
  });

  it("renders an absent badge when no entry carries the atom", () => {
    const element = new CFCFCLabel();
    element.variant = "badge";
    element.atom = "some-other-atom";
    element.cfcLabel = integrityLabel;

    const text = templateText(element.render());

    expect(text).toContain('data-state="absent"');
    expect(text).not.toContain("Verified");
  });

  it("renders an absent badge when the atom is only a confidentiality atom", () => {
    const element = new CFCFCLabel();
    element.variant = "badge";
    element.atom = "loom-verified-external-identity";
    element.cfcLabel = {
      version: 1,
      entries: [{
        path: [],
        label: { confidentiality: ["loom-verified-external-identity"] },
      }],
    };

    const text = templateText(element.render());

    expect(text).toContain('data-state="absent"');
    expect(text).not.toContain("Verified<");
  });

  it("renders an absent badge before any label arrives", () => {
    const element = new CFCFCLabel();
    element.variant = "badge";

    expect(templateText(element.render())).toContain('data-state="absent"');
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
