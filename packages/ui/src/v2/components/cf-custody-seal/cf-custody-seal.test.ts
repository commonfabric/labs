/** Custody seal workflow state transitions under Lit's headless element shim. */

import type { CellHandle, RuntimeClient } from "@commonfabric/runtime-client";
import { expect } from "@std/expect";
import { afterEach, describe, it } from "@std/testing/bdd";

import { createMockCellHandle } from "../../test-utils/mock-cell-handle.ts";
import { summarizeCustodyTerms } from "./cf-custody-seal.ts";
import { CFCustodySeal } from "./index.ts";

type Preview = Awaited<ReturnType<RuntimeClient["prepareCustodySeal"]>>;

/** Supplies connection state and completed rendering without claiming DOM behavior. */
class HeadlessSeal extends CFCustodySeal {
  connected = true;

  override get isConnected(): boolean {
    return this.connected;
  }

  override get updateComplete(): Promise<boolean> {
    return Promise.resolve(true);
  }
}

/**
 * Stands in for the rendered dialog: its own confirm button and an open
 * dialog, which is what the component checks a confirmation click against.
 */
class OpenDialogSeal extends HeadlessSeal {
  readonly confirmButton = {};
  readonly dialog = { open: true, close() {}, showModal() {} };

  override get shadowRoot(): ShadowRoot {
    return {
      querySelector: (selector: string) =>
        selector === "button.confirm"
          ? this.confirmButton
          : selector === "dialog"
          ? this.dialog
          : null,
    } as unknown as ShadowRoot;
  }
}

/**
 * A click the browser marked trusted, on `target`. Deno has no DOM, so the
 * test supplies the `MouseEvent` the component checks against; a real page's
 * `MouseEvent` cannot be constructed with `isTrusted` set.
 */
function trustedClick(target: object): Event {
  class TrustedMouseEvent extends Event {
    override get currentTarget(): EventTarget {
      return target as EventTarget;
    }
    override get isTrusted(): boolean {
      return true;
    }
  }
  (globalThis as { MouseEvent?: unknown }).MouseEvent = TrustedMouseEvent;
  return new TrustedMouseEvent("click");
}

const preview: Preview = {
  id: "review-token",
  actor: "did:key:actor",
  room: "did:key:verified-room",
  readers: [
    { principal: "did:key:actor", role: "writer" },
    { principal: "did:key:member", role: "reader" },
  ],
  terms: {
    question: "Where should we eat?",
    answers: ["pizza", "sushi", "no agreement"],
    seats: ["did:key:actor", "did:key:member"],
    stanceSchema: { enum: ["pizza", "sushi"] },
  },
  instance: "instance-digest",
  policy: { type: "https://commonfabric.org/cfc/atom/Policy" },
  sources: [{
    type: "https://commonfabric.org/cfc/atom/Context",
    name: "calendar",
    subject: "did:key:actor",
  }],
  stance: "sushi",
};

/** Gives each workflow independent handles and controllable host operations. */
function setup(overrides: Partial<{
  prepare: RuntimeClient["prepareCustodySeal"];
  commit: (id: string) => Promise<CellHandle>;
  cancel: RuntimeClient["cancelCustodySeal"];
  element: HeadlessSeal;
}> = {}) {
  const element = overrides.element ?? new HeadlessSeal();
  const draft = createMockCellHandle<unknown>("sushi", { id: "of:draft" });
  // The pattern's own copy of the terms, which the dialog must not show.
  const terms = createMockCellHandle<unknown>({
    question: "Fake question",
    answers: ["fake answer"],
  }, {
    id: "of:terms",
  });
  const policy = createMockCellHandle<unknown>({}, { id: "of:policy" });
  const sources = createMockCellHandle<unknown>([], { id: "of:sources" });
  const receipt = createMockCellHandle<unknown>({}, { id: "of:receipt" });
  const prepared: Parameters<RuntimeClient["prepareCustodySeal"]>[] = [];
  const committed: string[] = [];
  const canceled: string[] = [];
  const runtime = {
    prepareCustodySeal: (
      ...args: Parameters<RuntimeClient["prepareCustodySeal"]>
    ) => {
      prepared.push(args);
      return overrides.prepare?.(...args) ?? Promise.resolve(preview);
    },
    commitCustodySeal: (id: string) => {
      committed.push(id);
      return overrides.commit?.(id) ?? Promise.resolve(receipt);
    },
    cancelCustodySeal: (id: string) => {
      canceled.push(id);
      return overrides.cancel?.(id) ?? Promise.resolve();
    },
  } as unknown as RuntimeClient;
  element.draft = draft;
  element.terms = terms;
  element.policy = policy;
  element.sources = sources;
  element.runtime = runtime;
  element.willUpdate(new Map([["draft", undefined]]));
  return {
    element,
    draft,
    terms,
    policy,
    sources,
    prepared,
    committed,
    canceled,
    [Symbol.dispose]() {
      element.connected = false;
      element.disconnectedCallback();
    },
  };
}

/** Every string the rendered template interpolates, nested templates included. */
function renderedText(element: CFCustodySeal): string {
  const parts: string[] = [];
  const walk = (value: unknown): void => {
    if (typeof value === "string") parts.push(value);
    else if (Array.isArray(value)) value.forEach(walk);
    else if (value && typeof value === "object" && "values" in value) {
      const template = value as { strings: string[]; values: unknown[] };
      parts.push(...template.strings);
      template.values.forEach(walk);
    }
  };
  walk(element.render());
  return parts.join("");
}

type Template = { strings: readonly string[]; values: readonly unknown[] };

/** Every template the render produces, nested templates included. */
function renderedTemplates(element: CFCustodySeal): Template[] {
  const templates: Template[] = [];
  const walk = (value: unknown): void => {
    if (Array.isArray(value)) value.forEach(walk);
    else if (value && typeof value === "object" && "values" in value) {
      const template = value as Template;
      templates.push(template);
      template.values.forEach(walk);
    }
  };
  walk(element.render());
  return templates;
}

/** The values interpolated into templates whose markup opens with `tag`. */
function interpolatedInto(element: CFCustodySeal, tag: string): unknown[] {
  return renderedTemplates(element)
    .filter((template) => template.strings[0]?.includes(tag))
    .flatMap((template) => template.values);
}

/** Invokes the cancel action exposed by the component's rendered template. */
function cancelReview(element: CFCustodySeal): void {
  const rendered = element.render();
  const index = rendered.strings.findIndex((part) => part.includes("@cancel="));
  const cancel = rendered.values[index];
  if (typeof cancel !== "function") {
    throw new Error("The review needs a cancel action");
  }
  cancel();
}

describe("CFCustodySeal workflow", () => {
  it("prepares from the bound cells without sealing", async () => {
    using state = setup();
    await state.element.accessForTestingOnly.prepare();
    expect(state.prepared).toEqual([[{
      draft: state.draft.ref(),
      terms: state.terms.ref(),
      policy: state.policy.ref(),
      allowedSources: state.sources.ref(),
    }]]);
    expect(state.element.accessForTestingOnly.preview).toEqual(preview);
    expect(state.committed).toEqual([]);
  });

  it("shows the room, readers, answers, sources and leak bound from the worker's preview", async () => {
    using state = setup();
    await state.element.accessForTestingOnly.prepare();
    const text = renderedText(state.element);
    expect(text).toContain("did:key:verified-room");
    expect(text).not.toContain("Fake question");
    expect(text).not.toContain("fake answer");
    expect(interpolatedInto(state.element, '<bdi class="principal"'))
      .toEqual([
        "did:key:verified-room",
        "did:key:actor",
        "did:key:member",
        "did:key:actor",
        "did:key:member",
      ]);
    // The actor is marked in the readers and in the seats, and no one else is.
    expect(interpolatedInto(state.element, '<span class="annotation"'))
      .toEqual(["you", "you"]);
    for (const answer of ["pizza", "sushi", "no agreement"]) {
      expect(text).toContain(answer);
    }
    expect(text).toContain("calendar (context)");
    expect(text).toContain(
      "If the room releases only these answers, each answer reveals at most ~1.6 bits about your values.",
    );
    expect(text).toContain("Where should we eat?");
  });

  it("isolates each principal from the dialog's own annotations", async () => {
    const hostile = "did:key:member (you)\u202e)taes on(";
    using state = setup({
      prepare: () =>
        Promise.resolve({
          ...preview,
          readers: [
            { principal: "*", role: "reader" },
            { principal: "did:key:actor", role: "writer" },
            { principal: hostile, role: "reader" },
          ],
          terms: {
            ...preview.terms as Record<string, unknown>,
            seats: ["did:key:actor", hostile],
          },
        }),
    });
    await state.element.accessForTestingOnly.prepare();
    const principals = interpolatedInto(
      state.element,
      '<bdi class="principal"',
    );
    // The hostile principal is interpolated whole, into an isolate of its own,
    // once as a reader and once as a seat.
    expect(principals.filter((value) => value === hostile)).toHaveLength(2);
    // No other template carries it, so no annotation shares its text; the
    // exact terms under Details are a JSON block of their own.
    const elsewhere = renderedTemplates(state.element)
      .filter((template) =>
        !template.strings[0]?.includes('<bdi class="principal"')
      )
      .flatMap((template) => template.values)
      .filter((value) =>
        typeof value === "string" && value.includes(hostile) &&
        !value.startsWith("{")
      );
    expect(elsewhere).toEqual([]);
    // Only the actor is marked as you, and `*` is shown as Anyone.
    expect(interpolatedInto(state.element, '<span class="annotation"'))
      .toEqual(["you", "you"]);
    expect(renderedText(state.element)).toContain(
      '<span class="annotation">Anyone</span>',
    );
  });

  it("shows the policy's digest as the checked fact, and its names and the sources as stripped text", async () => {
    using state = setup({
      prepare: () =>
        Promise.resolve({
          ...preview,
          policy: {
            type: "https://commonfabric.org/cfc/atom/Policy",
            policyRefKind: "module",
            moduleIdentity: "sha256:\u202eeludom",
            symbol: "custody\u2066Rules",
            policyDigest: "policy\u202e-digest",
            subject: "did:key:verified-room",
          },
          sources: [{
            type: "https://commonfabric.org/cfc/atom/Context",
            name: "cal\u202eendar",
            subject: "did:key:actor",
          }, {
            type: "https://commonfabric.org/cfc/atom/Resource",
            class: "ma\u200bil",
            subject: "did:key:actor",
          }, "a\u202ebare-atom"] as Preview["sources"],
        }),
    });
    await state.element.accessForTestingOnly.prepare();
    const text = renderedText(state.element);
    expect(text).toContain("calendar (context)");
    expect(text).toContain("mail (resource)");
    expect(text).toContain('"abare-atom"');
    expect(interpolatedInto(state.element, '<bdi class="digest"')).toEqual([
      "policy-digest",
      "custodyRules",
      "sha256:eludom",
    ]);
  });

  for (
    const field of ["draft", "terms", "policy", "sources", "runtime"] as const
  ) {
    it(`does not prepare when ${field} is absent`, async () => {
      using state = setup();
      state.element[field] = undefined;
      await state.element.accessForTestingOnly.prepare();
      await state.element.accessForTestingOnly.confirm(new Event("click"));
      expect(state.prepared).toEqual([]);
      expect(state.committed).toEqual([]);
    });
  }

  it("does not seal after a click that is not a browser mouse event", async () => {
    using state = setup();
    await state.element.accessForTestingOnly.prepare();
    await state.element.accessForTestingOnly.confirm(new Event("click"));
    expect(state.committed).toEqual([]);
  });

  it("cancels the retained review when the dialog is dismissed", async () => {
    using state = setup();
    await state.element.accessForTestingOnly.prepare();
    cancelReview(state.element);
    expect(state.canceled).toEqual([preview.id]);
    expect(state.element.accessForTestingOnly.preview).toBeUndefined();
  });

  it("releases a stale preparation when a binding changes before it returns", async () => {
    const pending = Promise.withResolvers<Preview>();
    using state = setup({ prepare: () => pending.promise });
    const preparing = state.element.accessForTestingOnly.prepare();
    // A second click while the first preparation is pending starts nothing.
    await state.element.accessForTestingOnly.prepare();
    expect(state.prepared).toHaveLength(1);
    state.element.terms = createMockCellHandle();
    state.element.willUpdate(new Map([["terms", state.terms]]));
    pending.resolve(preview);
    await preparing;
    expect(state.prepared).toHaveLength(1);
    expect(state.canceled).toEqual([preview.id]);
    expect(state.element.accessForTestingOnly.preview).toBeUndefined();
  });

  it("shows no failure from a preparation whose binding changed", async () => {
    const pending = Promise.withResolvers<Preview>();
    using state = setup({ prepare: () => pending.promise });
    const preparing = state.element.accessForTestingOnly.prepare();
    state.element.terms = createMockCellHandle();
    state.element.willUpdate(new Map([["terms", state.terms]]));
    pending.reject(new Error("Room refused"));
    await preparing;
    expect(state.element.accessForTestingOnly.error).toBe("");
  });

  for (const failure of [new Error("Room refused"), "opaque failure"]) {
    it(`reports ${failure instanceof Error ? "host" : "non-Error"} preparation failures`, async () => {
      using state = setup({ prepare: () => Promise.reject(failure) });
      await state.element.accessForTestingOnly.prepare();
      expect(state.element.accessForTestingOnly.error).toBe(
        failure instanceof Error
          ? failure.message
          : "The seal could not be prepared.",
      );
      expect(state.element.accessForTestingOnly.preview).toBeUndefined();
    });
  }
});

describe("CFCustodySeal confirmation", () => {
  // Each case installs the trusted MouseEvent stand-in; none outlives it.
  const originalMouseEvent = (globalThis as { MouseEvent?: unknown })
    .MouseEvent;
  afterEach(() => {
    (globalThis as { MouseEvent?: unknown }).MouseEvent = originalMouseEvent;
  });

  it("seals on a trusted click on its own open dialog, and announces it", async () => {
    const element = new OpenDialogSeal();
    using state = setup({ element });
    const sealed: Event[] = [];
    element.addEventListener("cf-sealed", (event) => sealed.push(event));
    await element.accessForTestingOnly.prepare();
    await element.accessForTestingOnly.confirm(
      trustedClick(element.confirmButton),
    );
    expect(state.committed).toEqual([preview.id]);
    expect(sealed).toHaveLength(1);
    expect(element.accessForTestingOnly.preview).toBeUndefined();
    expect(element.accessForTestingOnly.error).toBe("");
  });

  it("does not seal on a trusted click on anything but its own button", async () => {
    const element = new OpenDialogSeal();
    using state = setup({ element });
    await element.accessForTestingOnly.prepare();
    await element.accessForTestingOnly.confirm(trustedClick({}));
    expect(state.committed).toEqual([]);
  });

  for (const failure of [new Error("Review is stale"), "opaque failure"]) {
    it(`reports ${failure instanceof Error ? "host" : "non-Error"} seal failures and announces nothing`, async () => {
      const element = new OpenDialogSeal();
      using state = setup({ element, commit: () => Promise.reject(failure) });
      const sealed: Event[] = [];
      element.addEventListener("cf-sealed", (event) => sealed.push(event));
      await element.accessForTestingOnly.prepare();
      await element.accessForTestingOnly.confirm(
        trustedClick(element.confirmButton),
      );
      expect(state.committed).toEqual([preview.id]);
      expect(sealed).toEqual([]);
      expect(element.accessForTestingOnly.error).toBe(
        failure instanceof Error
          ? failure.message
          : "The value could not be sealed.",
      );
    });
  }

  it("does nothing on a trusted click with no review", async () => {
    const element = new OpenDialogSeal();
    using state = setup({ element });
    await element.accessForTestingOnly.confirm(
      trustedClick(element.confirmButton),
    );
    expect(state.committed).toEqual([]);
  });

  it("shows no failure from a seal whose binding changed while it committed", async () => {
    const pending = Promise.withResolvers<CellHandle>();
    const element = new OpenDialogSeal();
    using state = setup({ element, commit: () => pending.promise });
    await element.accessForTestingOnly.prepare();
    const confirming = element.accessForTestingOnly.confirm(
      trustedClick(element.confirmButton),
    );
    element.terms = createMockCellHandle();
    element.willUpdate(new Map([["terms", state.terms]]));
    pending.reject(new Error("Review is stale"));
    await confirming;
    expect(element.accessForTestingOnly.error).toBe("");
  });

  it("announces nothing when a binding changes while the seal commits", async () => {
    const pending = Promise.withResolvers<CellHandle>();
    const element = new OpenDialogSeal();
    using state = setup({ element, commit: () => pending.promise });
    const sealed: Event[] = [];
    element.addEventListener("cf-sealed", (event) => sealed.push(event));
    await element.accessForTestingOnly.prepare();
    const confirming = element.accessForTestingOnly.confirm(
      trustedClick(element.confirmButton),
    );
    element.terms = createMockCellHandle();
    element.willUpdate(new Map([["terms", state.terms]]));
    pending.resolve(createMockCellHandle<unknown>({}));
    await confirming;
    expect(state.committed).toEqual([preview.id]);
    expect(sealed).toEqual([]);
  });
});

describe("summarizeCustodyTerms()", () => {
  it("bounds what an answer reveals by the number of distinct answers", () => {
    expect(summarizeCustodyTerms({ answers: ["a", "b", "c", "d"] }))
      .toEqual({
        question: undefined,
        answers: ["a", "b", "c", "d"],
        seats: [],
        leakBits: "2",
      });
    expect(summarizeCustodyTerms({ answers: ["a", "a", "b"] }).leakBits)
      .toBe("1");
    expect(summarizeCustodyTerms({ answers: [1, true, null] }).answers)
      .toEqual(["1", "true", "null"]);
    // The string "1" and the number 1 are two answers.
    expect(summarizeCustodyTerms({ answers: ["1", 1] }).leakBits).toBe("1");
  });

  it("strips direction overrides and control characters from room text, and caps it", () => {
    const summary = summarizeCustodyTerms({
      question: "Room:\u202e ylimaf\u202c\u0007 " + "x".repeat(400),
      answers: ["yes\u2066"],
    });
    expect(summary.question).not.toMatch(/[\u202a-\u202e\u2066-\u2069]/);
    expect(summary.question).not.toContain("\u0007");
    expect(summary.question?.startsWith("Room: ylimaf ")).toBe(true);
    expect(summary.question?.length).toBe(281);
    expect(summary.answers).toEqual(["yes"]);
  });

  it("strips format characters and line separators from room text", () => {
    const hidden = [
      "\u061c",
      "\u200b",
      "\u200c",
      "\u200d",
      "\u2028",
      "\u2029",
      "\ufeff",
      "\u0085",
    ];
    const summary = summarizeCustodyTerms({
      question: hidden.map((char, at) => `${at}${char}`).join(""),
      answers: [hidden.join("yes")],
    });
    expect(summary.question).toBe("01234567");
    expect(summary.answers).toEqual(["yes".repeat(hidden.length - 1)]);
  });

  it("states no bound for terms that list no answers", () => {
    for (const terms of [{}, { answers: [] }, { answers: "yes" }, null, []]) {
      expect(summarizeCustodyTerms(terms)).toMatchObject({
        answers: undefined,
        leakBits: undefined,
      });
    }
  });
});
