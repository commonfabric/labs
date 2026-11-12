/** Custody answer display under Lit's headless element shim. */

import type {
  CellHandle,
  CellRef,
  CellValueResponse,
  CustodyAnswerState,
  RuntimeClient,
} from "@commonfabric/runtime-client";
import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";

import {
  createMockCellHandle,
  pushRefusal,
  refuseReads,
} from "../../test-utils/mock-cell-handle.ts";
import { CFCustodyAnswer } from "./index.ts";

/** Supplies connection state without claiming DOM behavior. */
class HeadlessAnswer extends CFCustodyAnswer {
  connected = false;

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
      for (const part of template.strings) parts.push(part);
      template.values.forEach(walk);
    }
  };
  walk(element.render());
  return parts.join("");
}

/** One watch the element asked the worker for. */
interface Watch {
  readonly cells: { terms: CellRef; policy: CellRef; output: CellRef };
  readonly send: (state: CustodyAnswerState) => void;
  ended: boolean;
}

/**
 * Makes a handle whose every read throws, so that a test fails on any value
 * the element reads through it: the worker reads the room's cells, and the
 * element never needs to.
 */
const unreadable = (id: CellRef["id"]): CellHandle<unknown> => {
  const handle = createMockCellHandle<unknown>(undefined, { id });
  // The ceiling refuses these to a member, as it refuses a room's policy
  // and projected answer.
  refuseReads(handle);
  pushRefusal(handle);
  const forbidden = (name: string) => () => {
    throw new Error(`cf-custody-answer read ${id} through ${name}()`);
  };
  for (const read of ["get", "pull", "subscribe", "sink", "lastRead"]) {
    Object.defineProperty(handle, read, { value: forbidden(read) });
  }
  return handle;
};

/** The answer the gate admits. */
const shown = (value: unknown): CellValueResponse =>
  ({ value }) as CellValueResponse;

/** The answer the gate refuses. */
const refused: CellValueResponse = {
  refused: { refusedBy: "display-ceiling" },
} as CellValueResponse;

/** Lets the watch's start settle. */
const settle = async () => {
  for (let turn = 0; turn < 5; turn++) await Promise.resolve();
};

const setup = (
  { start }: { start?: () => Promise<void> } = {},
) => {
  const element = new HeadlessAnswer();
  const watches: Watch[] = [];
  element.runtime = {
    watchCustodyAnswer: async (
      cells: Watch["cells"],
      send: Watch["send"],
    ) => {
      const watch: Watch = { cells, send, ended: false };
      watches.push(watch);
      await start?.();
      return () => {
        watch.ended = true;
      };
    },
  } as unknown as RuntimeClient;
  const terms = unreadable("of:terms");
  const policy = unreadable("of:policy");
  const output = unreadable("of:choice");
  element.terms = terms;
  element.policy = policy;
  element.output = output;
  const published: CustomEvent[] = [];
  element.addEventListener(
    "cf-published",
    (event) => published.push(event as CustomEvent),
  );
  const connect = async () => {
    element.connected = true;
    element.connectedCallback();
    element.willUpdate(new Map([["terms", undefined]]));
    await settle();
  };
  return { element, watches, published, terms, policy, output, connect };
};

describe("cf-custody-answer", () => {
  it("shows the answer the watch sends, though every binding's read is refused", async () => {
    // Under the display ceiling a member is refused the room's policy and
    // its projected answer. The element hands the worker the references, and
    // shows what the worker sends.

    const state = setup();
    await state.connect();

    expect(state.watches).toHaveLength(1);
    expect(state.watches[0].cells).toEqual({
      terms: state.terms.ref(),
      policy: state.policy.ref(),
      output: state.output.ref(),
    });
    state.watches[0].send({ status: "pending" });
    expect(state.element.accessForTestingOnly.answer).toBeUndefined();
    state.watches[0].send({
      status: "published",
      instance: "instance-digest",
      publishedHere: true,
      answer: shown("sushi"),
    });
    expect(state.element.accessForTestingOnly.answer).toBe("sushi");
    expect(renderedText(state.element)).toContain("sushi");
    expect(renderedText(state.element)).not.toContain('role="alert"');
  });

  it("shows nothing, and says nothing, for an answer the gate refuses", async () => {
    const state = setup();
    await state.connect();

    state.watches[0].send({
      status: "published",
      instance: "instance-digest",
      publishedHere: false,
      answer: refused,
    });

    expect(state.element.accessForTestingOnly.answer).toBeUndefined();
    expect(state.element.accessForTestingOnly.error).toBe("");
    expect(renderedText(state.element)).not.toContain('part="answer"');
    expect(state.published).toHaveLength(0);
  });

  it("says why an attempt failed, until the answer is shown", async () => {
    const state = setup();
    await state.connect();

    state.watches[0].send({ status: "pending", error: "worker failed" });
    expect(renderedText(state.element)).toContain("worker failed");
    expect(renderedText(state.element)).toContain('role="alert"');
    state.watches[0].send({
      status: "published",
      instance: "instance-digest",
      publishedHere: false,
      answer: shown("tacos"),
    });

    expect(state.element.accessForTestingOnly.error).toBe("");
    expect(renderedText(state.element)).toContain("tacos");
  });

  it("shows an answer that is not a scalar as an alert, not as the answer", async () => {
    const state = setup();
    await state.connect();

    state.watches[0].send({
      status: "published",
      instance: "instance-digest",
      publishedHere: true,
      answer: shown({ choice: "tacos" }),
    });

    const text = renderedText(state.element);
    expect(text).not.toContain("[object Object]");
    expect(text).not.toContain('part="answer"');
    expect(text).toContain('role="alert"');
    expect(state.published).toHaveLength(0);
  });

  it("announces each instance's answer once, naming the instance only when its own watch published it", async () => {
    const state = setup();
    await state.connect();
    const send = (instance: string, publishedHere: boolean) =>
      state.watches[0].send({
        status: "published",
        instance,
        publishedHere,
        answer: shown("sushi"),
      });

    send("first", true);
    send("first", true);
    send("second", false);

    expect(state.published.map((event) => event.detail)).toEqual([
      { instance: "first" },
      {},
    ]);
  });

  it("watches afresh when rebound, ending the earlier watch and ignoring what it sends", async () => {
    const state = setup();
    await state.connect();
    state.watches[0].send({
      status: "published",
      instance: "first",
      publishedHere: true,
      answer: shown("sushi"),
    });

    const policy = unreadable("of:another-policy");
    state.element.policy = policy;
    state.element.willUpdate(new Map([["policy", state.policy]]));
    await settle();

    expect(state.watches).toHaveLength(2);
    expect(state.watches[0].ended).toBe(true);
    expect(state.watches[1].cells.policy).toEqual(policy.ref());
    // What the earlier room showed goes with it.
    expect(state.element.accessForTestingOnly.answer).toBeUndefined();
    state.watches[0].send({
      status: "published",
      instance: "first",
      publishedHere: true,
      answer: shown("stale"),
    });
    expect(state.element.accessForTestingOnly.answer).toBeUndefined();
  });

  it("watches once when connecting and the first update both ask", async () => {
    const state = setup();

    await state.connect();
    state.element.willUpdate(new Map([["runtime", undefined]]));
    await settle();

    expect(state.watches).toHaveLength(1);
    expect(state.watches[0].ended).toBe(false);
  });

  it("ends the watch when detached, and watches afresh when connected again", async () => {
    const state = setup();
    await state.connect();

    state.element.connected = false;
    state.element.disconnectedCallback();
    expect(state.watches[0].ended).toBe(true);
    await state.connect();

    expect(state.watches).toHaveLength(2);
    expect(state.watches[1].ended).toBe(false);
  });

  it("ends a watch that finishes starting after the element is detached", async () => {
    let started: (() => void) | undefined;
    const state = setup({
      start: () =>
        new Promise<void>((resolve) => {
          started = resolve;
        }),
    });
    state.element.connected = true;
    state.element.connectedCallback();
    await settle();

    state.element.connected = false;
    state.element.disconnectedCallback();
    started!();
    await settle();

    expect(state.watches).toHaveLength(1);
    expect(state.watches[0].ended).toBe(true);
  });

  it("says so when the watch cannot start", async () => {
    const state = setup({
      start: () => Promise.reject(new Error("worker connection lost")),
    });

    await state.connect();

    expect(state.element.accessForTestingOnly.error).toBe(
      "worker connection lost",
    );
  });

  it("asks nothing until every binding and the runtime are present", async () => {
    const element = new HeadlessAnswer();
    const asked: unknown[] = [];
    element.runtime = {
      watchCustodyAnswer: (cells: unknown) => {
        asked.push(cells);
        return Promise.resolve(() => {});
      },
    } as unknown as RuntimeClient;
    element.terms = unreadable("of:terms");
    element.policy = unreadable("of:policy");
    element.connected = true;
    element.connectedCallback();
    await settle();

    expect(asked).toEqual([]);
  });
});
