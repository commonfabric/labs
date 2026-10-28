import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";

import { MemberWaits } from "../integration/fabrichat-room-fixture.ts";

/** A scheduler that reports the errors a test hands it. */
class FakeScheduler {
  #handlers: ((error: Error) => void)[] = [];

  /** Adds `handler` to the handlers a failed action is reported to. */
  onError(handler: (error: Error) => void): void {
    this.#handlers.push(handler);
  }

  /** Reports `error` to every handler, as a failed action does. */
  fail(error: Error): void {
    for (const handler of this.#handlers) handler(error);
  }
}

/** A cell whose values a test sets, recording whether its reader stopped. */
class FakeCell<T> {
  #readers: ((value: T | undefined) => void)[] = [];
  #cancelled = 0;
  #value: T | undefined;

  /** Constructs an instance which holds `value` until a test sets another. */
  constructor(value?: T) {
    this.#value = value;
  }

  /** How many readers stopped reading. */
  get cancelled(): number {
    return this.#cancelled;
  }

  /**
   * Hands `callback` the cell's value now and each value it takes later, and
   * returns the function that stops it reading.
   */
  sink(callback: (value: T | undefined) => void): () => void {
    this.#readers.push(callback);
    callback(this.#value);
    return () => {
      this.#cancelled++;
    };
  }

  /** Gives the cell `value`, which every reader reads. */
  set(value: T): void {
    this.#value = value;
    for (const reader of this.#readers) reader(value);
  }
}

describe("MemberWaits", () => {
  describe("instance members", () => {
    describe("until()", () => {
      it("resolves with the first value `holds` accepts", async () => {
        const waits = new MemberWaits(new FakeScheduler());
        const count = new FakeCell(0);

        const waited = waits.until("a send", count, (value) => value! >= 2);
        count.set(1);
        count.set(2);

        expect(await waited).toBe(2);
      });

      it("rejects with an error naming the wait and the action's error when an action fails first", async () => {
        const scheduler = new FakeScheduler();
        const waits = new MemberWaits(scheduler);
        const refusal = new Error("Your profile hasn't loaded yet.");

        const waited = waits.until(
          "Member 2's reaction to message 1",
          new FakeCell(0),
          (value) => value! > 0,
        );
        scheduler.fail(refusal);

        const error = await waited.then(() => undefined, (error) => error);
        expect(error).toBeInstanceOf(Error);
        expect(error.message).toBe(
          "Member 2's reaction to message 1 did not happen: an action " +
            "failed with: Your profile hasn't loaded yet.",
        );
        expect(error.cause).toBe(refusal);
      });

      it("rejects every wait pending when an action fails", async () => {
        const scheduler = new FakeScheduler();
        const waits = new MemberWaits(scheduler);

        const first = waits.until("a send", new FakeCell(0), () => false);
        const second = waits.until("a reaction", new FakeCell(0), () => false);
        scheduler.fail(new Error("refused"));

        await expect(first).rejects.toThrow("a send did not happen");
        await expect(second).rejects.toThrow("a reaction did not happen");
      });

      it("resolves a wait begun after an action failed while nothing waited", async () => {
        const scheduler = new FakeScheduler();
        const waits = new MemberWaits(scheduler);
        scheduler.fail(new Error("refused"));
        const count = new FakeCell(0);

        const waited = waits.until("a send", count, (value) => value! > 0);
        count.set(1);

        expect(await waited).toBe(1);
      });

      it("resolves a wait whose value arrived before an action failed", async () => {
        const scheduler = new FakeScheduler();
        const waits = new MemberWaits(scheduler);
        const count = new FakeCell(0);

        const waited = waits.until("a send", count, (value) => value! > 0);
        count.set(1);
        scheduler.fail(new Error("refused"));

        expect(await waited).toBe(1);
      });

      it("stops reading the cell once the wait resolves or rejects", async () => {
        const scheduler = new FakeScheduler();
        const waits = new MemberWaits(scheduler);
        const resolved = new FakeCell(0);
        const rejected = new FakeCell(0);

        const resolving = waits.until("a send", resolved, (v) => v! > 0);
        resolved.set(1);
        await resolving;
        const rejecting = waits.until("a reaction", rejected, () => false);
        scheduler.fail(new Error("refused"));
        await rejecting.catch(() => {});

        expect(resolved.cancelled).toBe(1);
        expect(rejected.cancelled).toBe(1);
      });
    });
  });
});
