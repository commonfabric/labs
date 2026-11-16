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

      it("promotes a computation registered again as an effect", () => {
        const nodes = new NodeRegistry();
        const action: Action = function promoted() {};
        nodes.register(action, "computation");

        expect(nodes.register(action, "effect").kind).toBe("effect");
        expect(nodes.isEffect(action)).toBe(true);
        expect(nodes.isComputation(action)).toBe(false);
      });

      it("throws for an effect registered again as a computation", () => {
        const nodes = new NodeRegistry();
        const action: Action = function demoted() {};
        nodes.register(action, "effect");

        expect(() => nodes.register(action, "computation")).toThrow(
          "Scheduler action re-registered as computation; was effect",
        );
        expect(nodes.isEffect(action)).toBe(true);
      });
    });

    describe("setStatus()", () => {
      it("indexes a registered node that becomes invalid", () => {
        const nodes = new NodeRegistry();
        const action: Action = function known() {};
        nodes.register(action, "computation");
        nodes.setStatus(action, "clean");

        nodes.setStatus(action, "invalid");

        expect(nodes.get(action)?.status).toBe("invalid");
        expect(nodes.getInvalidNodes().has(action)).toBe(true);
      });

      it("records nothing for an action that was never registered", () => {
        const nodes = new NodeRegistry();
        const action: Action = function unknown() {};

        nodes.setStatus(action, "invalid");

        expect(nodes.get(action)).toBeUndefined();
        expect(nodes.getInvalidNodes().has(action)).toBe(false);
      });
    });

    describe("linkParent()", () => {
      it("returns the parent's record and indexes the child under it", () => {
        const nodes = new NodeRegistry();
        const parent: Action = function parent() {};
        const child: Action = function child() {};
        const parentRecord = nodes.register(parent, "computation");
        const childRecord = nodes.register(child, "computation");

        expect(nodes.linkParent(child, parent)).toBe(parentRecord);
        expect(nodes.childrenOf(parent)).toEqual(new Set([childRecord]));
      });

      it("returns `undefined` and links nothing for a child that was never registered", () => {
        const nodes = new NodeRegistry();
        const parent: Action = function parent() {};
        const child: Action = function child() {};
        nodes.register(parent, "computation");

        expect(nodes.linkParent(child, parent)).toBeUndefined();
        expect(nodes.parentActionOf(child)).toBeUndefined();
        expect(nodes.childrenOf(parent)).toBeUndefined();
      });
    });

    describe("membership", () => {
      it("advances when a node joins the active set and when it leaves", () => {
        const nodes = new NodeRegistry();
        const action: Action = function member() {};
        const before = nodes.membership;

        nodes.register(action, "computation");
        const joined = nodes.membership;
        nodes.remove(action);
        const left = nodes.membership;
        nodes.register(action, "computation");

        expect([joined, left, nodes.membership]).toEqual([
          before + 1,
          before + 2,
          before + 3,
        ]);
      });

      it("stays put for a registration of an active node and a removal of an unknown one", () => {
        const nodes = new NodeRegistry();
        const action: Action = function active() {};
        nodes.register(action, "computation");
        const membership = nodes.membership;

        nodes.register(action, "effect");
        nodes.remove(function unknown() {});

        expect(nodes.membership).toBe(membership);
      });
    });
  });
});
