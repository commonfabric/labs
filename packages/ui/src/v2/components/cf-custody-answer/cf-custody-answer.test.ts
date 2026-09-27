/** Custody answer publication and display under Lit's headless element shim. */

import type { RuntimeClient } from "@commonfabric/runtime-client";
import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";

import { createMockCellHandle } from "../../test-utils/mock-cell-handle.ts";
import { CFCustodyAnswer } from "./index.ts";

type Publish = RuntimeClient["publishCustodyAnswer"];

/** Supplies connection state without claiming DOM behavior. */
class HeadlessAnswer extends CFCustodyAnswer {
  override get isConnected(): boolean {
    return true;
  }
}

const setup = (
  publishes: Array<() => ReturnType<Publish>>,
  slot: { answer?: string; refuse?: string } = {},
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
      return slot.refuse === undefined
        ? Promise.resolve(slot.answer)
        : Promise.reject(new Error(slot.refuse));
    },
  } as unknown as RuntimeClient;
  const terms = createMockCellHandle<unknown>({}, { id: "of:terms" });
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
});
