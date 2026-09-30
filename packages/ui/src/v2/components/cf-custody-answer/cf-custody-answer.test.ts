/** Custody answer publication and display under Lit's headless element shim. */

import type { RuntimeClient } from "@commonfabric/runtime-client";
import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";

import { createMockCellHandle } from "../../test-utils/mock-cell-handle.ts";
import { CFCustodyAnswer } from "./index.ts";

type Publish = RuntimeClient["publishCustodyAnswer"];

/** Supplies connection state without claiming DOM behavior. */
class HeadlessAnswer extends CFCustodyAnswer {
  connected = true;

  override get isConnected(): boolean {
    return this.connected;
  }

  // Connecting makes Lit schedule an update, which wants a DOM. These tests
  // read `render()` directly instead.
  protected override performUpdate(): void {}
}

/** Every string the rendered template interpolates, nested templates included. */
function renderedText(element: CFCustodyAnswer): string {
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

/** Lets queued publications settle. */
const settle = async () => {
  for (let turn = 0; turn < 10; turn++) await Promise.resolve();
  await new Promise((resolve) => setTimeout(resolve, 0));
};

const setup = (
  publishes: Array<() => ReturnType<Publish>>,
  slot: { answer?: unknown; refuse?: string; hold?: Promise<void> } = {},
  termsValue: unknown = {},
) => {
  const element = new HeadlessAnswer();
  const requests: Parameters<Publish>[0][] = [];
  const reads: unknown[] = [];
  element.runtime = {
    publishCustodyAnswer: (cells: Parameters<Publish>[0]) => {
      requests.push(cells);
      const next = publishes.shift();
      return next ? next() : Promise.reject(new Error("unexpected request"));
    },
    readCustodyAnswer: (cells: unknown) => {
      reads.push(cells);
      const read = () =>
        slot.refuse === undefined
          ? Promise.resolve(slot.answer)
          : Promise.reject(new Error(slot.refuse));
      return slot.hold ? slot.hold.then(read) : read();
    },
  } as unknown as RuntimeClient;
  const terms = createMockCellHandle<unknown>(termsValue, { id: "of:terms" });
  const policy = createMockCellHandle<unknown>({}, { id: "of:policy" });
  const output = createMockCellHandle<unknown>("sushi", { id: "of:choice" });
  element.terms = terms;
  element.policy = policy;
  element.output = output;
  const published: CustomEvent[] = [];
  element.addEventListener(
    "cf-published",
    (event) => published.push(event as CustomEvent),
  );
  return { element, requests, reads, published, terms, policy, output };
};

describe("cf-custody-answer", () => {
  it("names the room's cells, and shows the slot's answer once published", async () => {
    const slot: { answer?: string } = {};
    const state = setup([() => {
      slot.answer = "sushi";
      return Promise.resolve({ instance: "instance-digest", answer: "sushi" });
    }], slot);
    await state.element.accessForTestingOnly.publish();
    expect(state.requests).toEqual([{
      terms: state.terms.ref(),
      policy: state.policy.ref(),
      output: state.output.ref(),
    }]);
    expect(state.reads).toEqual([{
      terms: state.terms.ref(),
      policy: state.policy.ref(),
    }]);
    expect(state.element.accessForTestingOnly.answer).toBe("sushi");
    expect(state.published.map((event) => event.detail)).toEqual([
      { instance: "instance-digest" },
    ]);
    // Published: no further requests.
    await state.element.accessForTestingOnly.publish();
    expect(state.requests).toHaveLength(1);
  });

  it("asks again after a refusal, and shows an answer another member published", async () => {
    const slot: { answer?: string } = {};
    const state = setup([
      () =>
        Promise.reject(
          new Error("Custody answer requires every seat to have sealed"),
        ),
      () =>
        Promise.reject(
          new Error("Custody answer is already published for this instance"),
        ),
    ], slot);
    slot.answer = undefined;
    await state.element.accessForTestingOnly.publish();
    expect(state.element.accessForTestingOnly.published).toBe(false);
    expect(state.element.accessForTestingOnly.answer).toBeUndefined();
    slot.answer = "tacos";
    await state.element.accessForTestingOnly.publish();
    expect(state.element.accessForTestingOnly.published).toBe(true);
    expect(state.element.accessForTestingOnly.answer).toBe("tacos");
    await state.element.accessForTestingOnly.publish();
    expect(state.requests).toHaveLength(2);
  });

  it("says so when the request fails for a reason other than a refusal", async () => {
    const slot: { answer?: string; refuse?: string } = {};
    const state = setup([
      () => Promise.reject(new Error("worker connection lost")),
      () =>
        Promise.reject(
          new Error("Custody answer requires every seat to have sealed"),
        ),
      () =>
        Promise.reject(
          new Error("Custody answer is already published for this instance"),
        ),
    ], slot);
    await state.element.accessForTestingOnly.publish();
    expect(state.element.accessForTestingOnly.error).toBe(
      "worker connection lost",
    );
    expect(state.element.accessForTestingOnly.published).toBe(false);
    // An expected refusal is quiet, and clears what an earlier failure said.
    await state.element.accessForTestingOnly.publish();
    expect(state.element.accessForTestingOnly.error).toBe("");
    // A slot the seal did not write is said, not shown.
    slot.refuse = "Custody answer refuses a slot the seal did not write";
    await state.element.accessForTestingOnly.publish();
    expect(state.element.accessForTestingOnly.error).toBe(slot.refuse);
    expect(state.element.accessForTestingOnly.answer).toBeUndefined();
  });

  it("stays quiet, asking nothing, while the room has no terms", async () => {
    const state = setup([], {}, null);
    await state.element.accessForTestingOnly.publish();
    expect(state.requests).toHaveLength(0);
    expect(state.reads).toHaveLength(0);
    expect(state.element.accessForTestingOnly.error).toBe("");
    expect(state.element.accessForTestingOnly.published).toBe(false);
  });

  it("shows the published answer, and an unexpected failure as an alert", async () => {
    const slot: { answer?: string; refuse?: string } = {};
    const state = setup([
      () => Promise.reject(new Error("worker connection lost")),
      () => {
        slot.answer = "sushi";
        return Promise.resolve({ instance: "instance", answer: "sushi" });
      },
    ], slot);
    expect(renderedText(state.element)).not.toContain('part="answer"');
    await state.element.accessForTestingOnly.publish();
    expect(renderedText(state.element)).toContain("worker connection lost");
    expect(renderedText(state.element)).toContain('role="alert"');
    await state.element.accessForTestingOnly.publish();
    const shown = renderedText(state.element);
    expect(shown).toContain("sushi");
    expect(shown).not.toContain('role="alert"');
  });

  it("asks on each change once bound, and starts over for new terms", async () => {
    const slot: { answer?: string } = {};
    const state = setup([
      () =>
        Promise.reject(
          new Error("Custody answer requires every seat to have sealed"),
        ),
      () => {
        slot.answer = "sushi";
        return Promise.resolve({ instance: "first", answer: "sushi" });
      },
      () => {
        slot.answer = "tacos";
        return Promise.resolve({ instance: "second", answer: "tacos" });
      },
    ], slot);
    // Binding subscribes: the terms and the answer are each read at once.
    state.element.willUpdate(new Map([["terms", undefined]]));
    await settle();
    expect(state.requests.length).toBeGreaterThanOrEqual(1);
    // A change to the projected answer asks again, and it publishes.
    state.output.set("sushi");
    await settle();
    expect(state.element.accessForTestingOnly.answer).toBe("sushi");
    // New terms are a new instance: what was shown is dropped, and the new
    // instance's answer is asked for and shown.
    slot.answer = undefined;
    state.terms.set({ question: "tomorrow" });
    await settle();
    expect(state.element.accessForTestingOnly.answer).toBe("tacos");
    expect(state.published.map((event) => event.detail)).toEqual([
      { instance: "first" },
      { instance: "second" },
    ]);
    // Unbinding stops the requests.
    state.element.connected = false;
    state.element.disconnectedCallback();
    const asked = state.requests.length;
    state.output.set("pizza");
    await settle();
    expect(state.requests).toHaveLength(asked);
  });

  it("starts over for a new policy, as for new terms", async () => {
    const slot: { answer?: string } = {};
    const state = setup([
      () => {
        slot.answer = "sushi";
        return Promise.resolve({ instance: "first", answer: "sushi" });
      },
      () => {
        slot.answer = "tacos";
        return Promise.resolve({ instance: "second", answer: "tacos" });
      },
    ], slot);
    state.element.willUpdate(new Map([["policy", undefined]]));
    await settle();
    expect(state.element.accessForTestingOnly.answer).toBe("sushi");
    // The policy cell now names another policy: the slot shown is another
    // instance's, so what was shown is dropped and that slot is asked for.
    slot.answer = undefined;
    state.policy.set({ policyDigest: "another" });
    await settle();
    expect(state.element.accessForTestingOnly.answer).toBe("tacos");
    expect(state.published.map((event) => event.detail)).toEqual([
      { instance: "first" },
      { instance: "second" },
    ]);
  });

  it("drops what an in-flight request returns once detached", async () => {
    let release: (() => void) | undefined;
    const slot: { answer?: string } = {};
    const state = setup([
      () =>
        new Promise((resolve) => {
          release = () => {
            slot.answer = "sushi";
            resolve({ instance: "instance", answer: "sushi" });
          };
        }),
    ], slot);
    const pending = state.element.accessForTestingOnly.publish();
    await settle();
    state.element.connected = false;
    state.element.disconnectedCallback();
    release!();
    await pending;
    expect(state.element.accessForTestingOnly.published).toBe(false);
    expect(state.element.accessForTestingOnly.answer).toBeUndefined();
    expect(state.published).toHaveLength(0);
    expect(state.reads).toHaveLength(0);
  });

  it("drops what a slot read returns once detached mid-read", async () => {
    let release: (() => void) | undefined;
    const slot: { answer?: string; hold?: Promise<void> } = {
      hold: new Promise((resolve) => {
        release = resolve;
      }),
    };
    const state = setup([() => {
      slot.answer = "sushi";
      return Promise.resolve({ instance: "instance", answer: "sushi" });
    }], slot);
    const pending = state.element.accessForTestingOnly.publish();
    await settle();
    expect(state.reads).toHaveLength(1);
    state.element.connected = false;
    state.element.disconnectedCallback();
    release!();
    await pending;
    expect(state.element.accessForTestingOnly.published).toBe(false);
    expect(state.element.accessForTestingOnly.answer).toBeUndefined();
    expect(state.published).toHaveLength(0);
  });

  it("subscribes once connected, and starts over when connected again", async () => {
    const slot: { answer?: string } = {};
    const state = setup([
      () => {
        slot.answer = "sushi";
        return Promise.resolve({ instance: "instance", answer: "sushi" });
      },
      () =>
        Promise.reject(
          new Error("Custody answer is already published for this instance"),
        ),
    ], slot);
    state.element.connectedCallback();
    await settle();
    expect(state.element.accessForTestingOnly.answer).toBe("sushi");
    state.element.connected = false;
    state.element.disconnectedCallback();
    // Connected again, it reads the slot afresh: already published, so the
    // request is refused and the slot's answer shown.
    state.element.connected = true;
    state.element.connectedCallback();
    await settle();
    expect(state.requests).toHaveLength(2);
    expect(state.reads).toHaveLength(2);
    expect(state.element.accessForTestingOnly.answer).toBe("sushi");
    expect(state.published.map((event) => event.detail)).toEqual([
      { instance: "instance" },
      {},
    ]);
    state.element.connected = false;
    state.element.disconnectedCallback();
  });

  it("keeps no request queued once the one it waited on publishes", async () => {
    let release: (() => void) | undefined;
    const slot: { answer?: string } = {};
    const state = setup([
      () =>
        new Promise((resolve) => {
          release = () => {
            slot.answer = "sushi";
            resolve({ instance: "first", answer: "sushi" });
          };
        }),
      () =>
        Promise.reject(
          new Error("Custody answer requires every seat to have sealed"),
        ),
    ], slot);
    // A request made while another is out waits on it, and that one
    // publishes, so there is nothing left to ask.
    const first = state.element.accessForTestingOnly.publish();
    const second = state.element.accessForTestingOnly.publish();
    await settle();
    release!();
    await first;
    await second;
    expect(state.element.accessForTestingOnly.published).toBe(true);
    expect(state.requests).toHaveLength(1);
    // Rebound, with nothing subscribed: one request asks once, and nothing
    // queued before the rebinding runs after it.
    state.element.connected = false;
    state.element.willUpdate(new Map([["policy", undefined]]));
    slot.answer = undefined;
    await state.element.accessForTestingOnly.publish();
    expect(state.requests).toHaveLength(2);
  });

  it("does not run a queued request once detached", async () => {
    let release: (() => void) | undefined;
    const state = setup([
      () =>
        new Promise((_, reject) => {
          release = () =>
            reject(
              new Error("Custody answer requires every seat to have sealed"),
            );
        }),
      () => Promise.resolve({ instance: "instance", answer: "sushi" }),
    ]);
    const first = state.element.accessForTestingOnly.publish();
    const second = state.element.accessForTestingOnly.publish();
    await settle();
    state.element.connected = false;
    state.element.disconnectedCallback();
    release!();
    await first;
    await second;
    expect(state.requests).toHaveLength(1);
  });

  it("shows only a scalar answer, as the seal publishes only scalars", async () => {
    const slot: { answer?: unknown } = {};
    const state = setup([() => {
      slot.answer = { choice: "tacos" };
      return Promise.resolve({
        instance: "instance",
        answer: { choice: "tacos" },
      });
    }], slot);
    await state.element.accessForTestingOnly.publish();
    const shown = renderedText(state.element);
    expect(shown).not.toContain("[object Object]");
    expect(shown).not.toContain('part="answer"');
    expect(shown).toContain('role="alert"');
    expect(state.element.accessForTestingOnly.published).toBe(false);
  });

  it("runs a request made during another once it ends, across a rebinding", async () => {
    let release: (() => void) | undefined;
    const slot: { answer?: string } = {};
    const state = setup([
      () =>
        new Promise((_, reject) => {
          release = () =>
            reject(
              new Error("Custody answer requires every seat to have sealed"),
            );
        }),
      () => {
        slot.answer = "sushi";
        return Promise.resolve({ instance: "instance", answer: "sushi" });
      },
    ], slot);
    const first = state.element.accessForTestingOnly.publish();
    const second = state.element.accessForTestingOnly.publish();
    await settle();
    // The terms change while the first request is out: its result belongs to
    // the instance before.
    state.element.willUpdate(new Map([["policy", undefined]]));
    release!();
    await first;
    await second;
    expect(state.requests).toHaveLength(2);
    expect(state.element.accessForTestingOnly.answer).toBe("sushi");
  });

  it("clears what a failure said once the room has no terms, and asks nothing unbound", async () => {
    const state = setup([
      () => Promise.reject(new Error("worker connection lost")),
    ]);
    await state.element.accessForTestingOnly.publish();
    expect(state.element.accessForTestingOnly.error).toBe(
      "worker connection lost",
    );
    state.terms.set(null);
    await state.element.accessForTestingOnly.publish();
    expect(state.element.accessForTestingOnly.error).toBe("");
    // With no projected answer bound there is nothing to subscribe to.
    const unbound = new HeadlessAnswer();
    unbound.terms = state.terms;
    unbound.willUpdate(new Map([["terms", undefined]]));
    await settle();
    expect(state.requests).toHaveLength(1);
  });
});
