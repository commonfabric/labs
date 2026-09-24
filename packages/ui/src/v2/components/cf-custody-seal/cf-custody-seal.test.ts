/** Custody seal workflow state transitions under Lit's headless element shim. */

import type { CellHandle, RuntimeClient } from "@commonfabric/runtime-client";
import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";

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
}> = {}) {
  const element = new HeadlessSeal();
  const draft = createMockCellHandle<unknown>("sushi", { id: "of:draft" });
  // The pattern's own copy of the terms, which the dialog must not show.
  const terms = createMockCellHandle<unknown>({ room: "Fake room" }, {
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
    expect(text).not.toContain("Fake room");
    expect(text).toContain("did:key:member");
    expect(text).toContain("did:key:actor (you)");
    for (const answer of ["pizza", "sushi", "no agreement"]) {
      expect(text).toContain(answer);
    }
    expect(text).toContain("calendar (context)");
    expect(text).toContain(
      "Each answer reveals at most ~1.6 bits about any one input.",
    );
    expect(text).toContain("Where should we eat?");
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

  it("does not seal after an untrusted confirmation event", async () => {
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
    await state.element.accessForTestingOnly.prepare();
    state.element.terms = createMockCellHandle();
    state.element.willUpdate(new Map([["terms", state.terms]]));
    pending.resolve(preview);
    await preparing;
    expect(state.prepared).toHaveLength(1);
    expect(state.canceled).toEqual([preview.id]);
    expect(state.element.accessForTestingOnly.preview).toBeUndefined();
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

describe("summarizeCustodyTerms()", () => {
  it("bounds what an answer reveals by the number of distinct answers", () => {
    expect(summarizeCustodyTerms({ answers: ["a", "b", "c", "d"] }))
      .toEqual({
        question: undefined,
        answers: ["a", "b", "c", "d"],
        leakBits: "2",
      });
    expect(summarizeCustodyTerms({ answers: ["a", "a", "b"] }).leakBits)
      .toBe("1");
    expect(summarizeCustodyTerms({ answers: [1, true, null] }).answers)
      .toEqual(["1", "true", "null"]);
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
