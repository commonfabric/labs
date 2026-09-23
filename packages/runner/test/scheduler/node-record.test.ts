import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { NodeRegistry } from "../../src/scheduler/node-record.ts";
import type { Action } from "../../src/scheduler/types.ts";

describe("NodeRegistry", () => {
  describe("instance members", () => {
    describe("remove()", () => {
      it("retires the owed retry before the action is registered again", () => {
        const nodes = new NodeRegistry();
        const action: Action = function retiredRetry() {};
        const record = nodes.register(action, "computation");
        record.gate.retryOwed = true;
        nodes.remove(action);
        expect(nodes.register(action, "computation").gate.retryOwed)
          .toBeUndefined();
      });

      it("returns the removed record", () => {
        const nodes = new NodeRegistry();
        const action: Action = function removed() {};
        const record = nodes.register(action, "computation");

        expect(nodes.remove(action)).toBe(record);
      });

      it("returns the record from `get()` after removal", () => {
        // The record is deliberately kept so a re-registration recovers the
        // ordinal and parent. `get()` therefore returns a record for a node
        // that is no longer scheduled, and cannot stand in for a registration
        // check.
        const nodes = new NodeRegistry();
        const action: Action = function removed() {};
        nodes.register(action, "computation");
        nodes.remove(action);

        expect(nodes.get(action)).toBeDefined();
      });

      it("returns `false` from `isComputation()` after removal", () => {
        const nodes = new NodeRegistry();
        const action: Action = function removed() {};
        nodes.register(action, "computation");
        expect(nodes.isComputation(action)).toBe(true);

        nodes.remove(action);

        expect(nodes.isComputation(action)).toBe(false);
      });

      it("returns `false` from `isEffect()` after removal", () => {
        const nodes = new NodeRegistry();
        const action: Action = function removedEffect() {};
        nodes.register(action, "effect");
        expect(nodes.isEffect(action)).toBe(true);

        nodes.remove(action);

        expect(nodes.isEffect(action)).toBe(false);
      });

      it("omits the removed action from `nodes()`", () => {
        const nodes = new NodeRegistry();
        const kept: Action = function kept() {};
        const dropped: Action = function dropped() {};
        nodes.register(kept, "computation");
        nodes.register(dropped, "computation");

        nodes.remove(dropped);

        expect([...nodes.nodes()].map((record) => record.action)).toEqual([
          kept,
        ]);
      });
    });

    describe("register()", () => {
      it("keeps the first registration ordinal across a removal", () => {
        const nodes = new NodeRegistry();
        const first: Action = function first() {};
        const second: Action = function second() {};
        nodes.register(first, "computation");
        nodes.register(second, "computation");
        const ordinal = nodes.getRegistrationOrdinal(first);

        nodes.remove(first);
        nodes.register(first, "computation");

        expect(nodes.getRegistrationOrdinal(first)).toBe(ordinal);
      });
    });
  });
});
