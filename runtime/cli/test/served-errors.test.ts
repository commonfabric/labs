import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import type { EventIntentOutcome, Runtime } from "@commonfabric/runner";
import {
  collectServedErrors,
  servedRuntimeErrors,
} from "../lib/served-errors.ts";

/**
 * A stand-in runtime whose event outcomes the test delivers, through the
 * returned `deliver()`.
 */
function outcomeSource(): {
  runtime: Runtime;
  deliver: (outcome: EventIntentOutcome) => void;
} {
  const subscribers: ((outcome: EventIntentOutcome) => void)[] = [];
  const runtime: Partial<Runtime> = {
    subscribeEventIntentOutcomes: (subscriber) => {
      subscribers.push(subscriber);
      return () => {};
    },
  };
  return {
    runtime: runtime as Runtime,
    deliver: (outcome) => {
      for (const subscriber of subscribers) subscriber(outcome);
    },
  };
}

/** An outcome of `kind` for `event-1`, in a space of no consequence. */
function outcome(
  kind: EventIntentOutcome["kind"],
  reason: string,
): EventIntentOutcome {
  return { space: "did:key:z6MkTest", eventId: "event-1", kind, reason };
}

describe("served-errors", () => {
  describe("collectServedErrors()", () => {
    it("returns a list holding the event and reason of each `errored` outcome", () => {
      // The outcome is synthetic: a served run that throws where the test's
      // own speculative run did not is not one a pattern can bring about on
      // demand.
      const { runtime, deliver } = outcomeSource();
      const errors = collectServedErrors(runtime);
      deliver(outcome("errored", "the served run threw"));
      expect(errors).toStrictEqual([
        { eventId: "event-1", message: "the served run threw" },
      ]);
    });

    it("returns a list holding nothing for outcomes of other kinds", () => {
      const { runtime, deliver } = outcomeSource();
      const errors = collectServedErrors(runtime);
      deliver(outcome("dropped", "dropped"));
      deliver(outcome("refused", "refused"));
      deliver(outcome("needs-attention", "needs attention"));
      expect(errors).toStrictEqual([]);
    });
  });

  describe("servedRuntimeErrors()", () => {
    it("returns each served error marked as served when no local error matches it", () => {
      expect(
        servedRuntimeErrors([
          { eventId: "event-1", message: "the served run threw" },
        ], []),
      ).toStrictEqual(["[served] the served run threw"]);
    });

    it("returns nothing for a served error that a local error of the same event has the text of", () => {
      expect(
        servedRuntimeErrors(
          [{ eventId: "event-1", message: "the handler threw" }],
          [{ eventId: "event-1", message: "the handler threw" }],
        ),
      ).toStrictEqual([]);
    });

    it("returns a served error that a local error of another event has the text of", () => {
      // The same text from another event's handler is another throw, so it
      // says nothing about whether this event's speculative run saw this one.
      expect(
        servedRuntimeErrors(
          [{ eventId: "event-1", message: "the handler threw" }],
          [{ eventId: "event-2", message: "the handler threw" }],
        ),
      ).toStrictEqual(["[served] the handler threw"]);
    });

    it("returns a served error that a local error of no event has the text of", () => {
      expect(
        servedRuntimeErrors(
          [{ eventId: "event-1", message: "the handler threw" }],
          [{ message: "the handler threw" }],
        ),
      ).toStrictEqual(["[served] the handler threw"]);
    });

    it("returns a served error of an event whose local error has other text", () => {
      // The speculative run and the served one threw differently, so both
      // are reported.
      expect(
        servedRuntimeErrors(
          [{ eventId: "event-1", message: "the served run threw" }],
          [{ eventId: "event-1", message: "the speculative run threw" }],
        ),
      ).toStrictEqual(["[served] the served run threw"]);
    });

    it("returns a served error that a local error has already answered for", () => {
      // Two served throws of one event and one speculative one: one is
      // reported as the local error, and the other only as served.
      expect(
        servedRuntimeErrors(
          [
            { eventId: "event-1", message: "the handler threw" },
            { eventId: "event-1", message: "the handler threw" },
          ],
          [{ eventId: "event-1", message: "the handler threw" }],
        ),
      ).toStrictEqual(["[served] the handler threw"]);
    });
  });
});
