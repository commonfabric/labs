import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import {
  Console,
  ConsoleEvent,
  ConsoleMethod,
} from "../../src/harness/console.ts";

const ALL_METHODS = Object.values(ConsoleMethod);

/** Every `console` event `emitter` dispatches, in order, as they arrive. */
function recordEvents(emitter: EventTarget): ConsoleEvent[] {
  const seen: ConsoleEvent[] = [];
  emitter.addEventListener("console", (event) => {
    seen.push(event as ConsoleEvent);
  });
  return seen;
}

/**
 * Calls `method` on `subject`. The enum's values are the method names, which
 * the last test in this file pins; the cast is what carries that fact into the
 * type system.
 */
function callMethod(
  subject: Console,
  method: ConsoleMethod,
  ...args: unknown[]
): void {
  const fn = subject[method as keyof Console] as (...a: unknown[]) => void;
  fn.apply(subject, args);
}

describe("console", () => {
  describe("ConsoleEvent", () => {
    describe("constructor()", () => {
      it("names the event type `console`", () => {
        expect(new ConsoleEvent(ConsoleMethod.Log, []).type).toBe("console");
      });

      it("carries the method it was given", () => {
        expect(new ConsoleEvent(ConsoleMethod.Warn, []).method)
          .toBe(ConsoleMethod.Warn);
      });

      it("carries the argument list it was given", () => {
        const args = [1, "two", null];
        expect(new ConsoleEvent(ConsoleMethod.Log, args).args).toEqual(args);
      });
    });
  });

  describe("Console", () => {
    describe("instance members", () => {
      it("dispatches one event per call, naming the method called", () => {
        for (const method of ALL_METHODS) {
          const emitter = new EventTarget();
          const seen = recordEvents(emitter);
          callMethod(new Console(emitter), method);
          expect(seen.length, method).toBe(1);
          expect(seen[0].method, method).toBe(method);
        }
      });

      it("passes each call's arguments through unchanged", () => {
        for (const method of ALL_METHODS) {
          const emitter = new EventTarget();
          const seen = recordEvents(emitter);
          const marker = { nested: [1, 2] };
          callMethod(new Console(emitter), method, "a", 2, null, marker);
          expect(seen[0].args, method).toEqual(["a", 2, null, marker]);
          // The event holds the caller's own object, not a copy of it: a
          // handler that inspects a logged value sees what was logged.
          expect(seen[0].args[3], method).toBe(marker);
        }
      });

      it("dispatches an event for a call with no arguments", () => {
        for (const method of ALL_METHODS) {
          const emitter = new EventTarget();
          const seen = recordEvents(emitter);
          callMethod(new Console(emitter), method);
          expect(seen[0].args, method).toEqual([]);
        }
      });

      it("dispatches once per call rather than coalescing repeats", () => {
        const emitter = new EventTarget();
        const seen = recordEvents(emitter);
        const subject = new Console(emitter);
        subject.log("first");
        subject.log("first");
        subject.warn("second");
        expect(seen.map((event) => event.method)).toEqual([
          ConsoleMethod.Log,
          ConsoleMethod.Log,
          ConsoleMethod.Warn,
        ]);
        expect(seen.map((event) => event.args)).toEqual([
          ["first"],
          ["first"],
          ["second"],
        ]);
      });

      it("dispatches nothing when constructed without an emitter", () => {
        for (const method of ALL_METHODS) {
          expect(() => callMethod(new Console(), method, "a"), method)
            .not.toThrow();
        }
      });

      it("reaches only its own emitter", () => {
        const mine = new EventTarget();
        const other = new EventTarget();
        const seenByMine = recordEvents(mine);
        const seenByOther = recordEvents(other);
        new Console(mine).log("a");
        expect(seenByMine.length).toBe(1);
        expect(seenByOther.length).toBe(0);
      });
    });
  });

  describe("ConsoleMethod", () => {
    it("gives every member the name of the `Console` method it stands for", () => {
      // The enum value is what a handler switches on, and the method body is
      // what supplies it. A member whose value drifted from its method name
      // would route a call under another method's name.

      for (const method of ALL_METHODS) {
        expect(typeof new Console()[method as keyof Console], method)
          .toBe("function");
      }
    });

    it("covers every method `Console` exposes", () => {
      const exposed = Object.getOwnPropertyNames(Console.prototype)
        .filter((name) => name !== "constructor")
        .toSorted();
      expect(exposed).toEqual([...ALL_METHODS].toSorted());
    });
  });
});
