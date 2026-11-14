import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { EventEmitter } from "@/client/emitter.ts";

type Events = {
  data: [string, number];
  close: [];
};

describe("EventEmitter", () => {
  describe("instance members", () => {
    describe("on()", () => {
      it("delivers every emitted event to the listener, with its arguments", () => {
        const emitter = new EventEmitter<Events>();
        const seen: [string, number][] = [];
        emitter.on("data", (s, n) => seen.push([s, n]));
        emitter.emit("data", "a", 1);
        emitter.emit("data", "b", 2);
        expect(seen).toEqual([["a", 1], ["b", 2]]);
      });

      it("returns the emitter", () => {
        const emitter = new EventEmitter<Events>();
        expect(emitter.on("close", () => {})).toBe(emitter);
      });

      it("does not deliver events of another name", () => {
        const emitter = new EventEmitter<Events>();
        let calls = 0;
        emitter.on("data", () => calls++);
        emitter.emit("close");
        expect(calls).toBe(0);
      });
    });

    describe("off()", () => {
      it("stops delivery to the removed listener only", () => {
        const emitter = new EventEmitter<Events>();
        const seen: string[] = [];
        const first = () => seen.push("first");
        emitter.on("close", first);
        emitter.on("close", () => seen.push("second"));
        expect(emitter.off("close", first)).toBe(emitter);
        emitter.emit("close");
        expect(seen).toEqual(["second"]);
      });

      it("returns the emitter for an event that has no listeners", () => {
        const emitter = new EventEmitter<Events>();
        expect(emitter.off("close", () => {})).toBe(emitter);
      });
    });

    describe("once()", () => {
      it("delivers only the first event to the listener", () => {
        const emitter = new EventEmitter<Events>();
        const seen: number[] = [];
        expect(emitter.once("data", (_, n) => seen.push(n))).toBe(emitter);
        emitter.emit("data", "a", 1);
        emitter.emit("data", "b", 2);
        expect(seen).toEqual([1]);
        expect(emitter.listenerCount("data")).toBe(0);
      });
    });

    describe("emit()", () => {
      it("returns true when a listener received the event", () => {
        const emitter = new EventEmitter<Events>();
        emitter.on("close", () => {});
        expect(emitter.emit("close")).toBe(true);
      });

      it("returns false when the event never had a listener", () => {
        expect(new EventEmitter<Events>().emit("close")).toBe(false);
      });

      it("returns false when every listener was removed", () => {
        const emitter = new EventEmitter<Events>();
        const listener = () => {};
        emitter.on("close", listener).off("close", listener);
        expect(emitter.emit("close")).toBe(false);
      });
    });

    describe("removeAllListeners()", () => {
      it("removes the listeners of the named event only", () => {
        const emitter = new EventEmitter<Events>();
        emitter.on("close", () => {});
        emitter.on("data", () => {});
        expect(emitter.removeAllListeners("close")).toBe(emitter);
        expect(emitter.listenerCount("close")).toBe(0);
        expect(emitter.listenerCount("data")).toBe(1);
      });

      it("removes the listeners of every event when given no name", () => {
        const emitter = new EventEmitter<Events>();
        emitter.on("close", () => {});
        emitter.on("data", () => {});
        expect(emitter.removeAllListeners()).toBe(emitter);
        expect(emitter.listenerCount("close")).toBe(0);
        expect(emitter.listenerCount("data")).toBe(0);
      });
    });

    describe("listenerCount()", () => {
      it("returns the number of listeners registered for the event", () => {
        const emitter = new EventEmitter<Events>();
        expect(emitter.listenerCount("data")).toBe(0);
        emitter.on("data", () => {});
        emitter.on("data", () => {});
        expect(emitter.listenerCount("data")).toBe(2);
      });
    });
  });
});
