import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { resolveScopeKey, type ScopeKey } from "@commonfabric/memory/v2";
import {
  dirtyFanOutForCause,
  fanOutInstances,
  newFanOutNodeState,
} from "../../src/scheduler/fan-out.ts";

const alice = { principal: "did:key:alice", sessionId: "alice-1" };
const bob = { principal: "did:key:bob", sessionId: "bob-1" };

describe("fan-out", () => {
  describe("fanOutInstances()", () => {
    it("returns one session instance for a session-deep principal named twice by one session", () => {
      const state = newFanOutNodeState();
      state.narrowed = true;
      state.sessionPrincipals.add(alice.principal);

      expect(fanOutInstances(state, [alice, { ...alice }])).toEqual([
        { identity: alice, key: resolveScopeKey("session", alice) },
      ]);
    });
  });

  describe("dirtyFanOutForCause()", () => {
    // Every instance starts clean, so the instances a cause dirtied are the
    // ones missing from `clean` afterwards.

    /** A node holding a probe instance and a user instance each for Alice
     * (known by principal alone) and Bob, all clean. */
    const cleanNode = () => {
      const state = newFanOutNodeState();
      const sessionless = { principal: alice.principal };
      const instances: [ScopeKey, typeof alice | typeof sessionless][] = [
        ["space", alice],
        [resolveScopeKey("user", sessionless), sessionless],
        [resolveScopeKey("user", bob), bob],
      ];
      for (const [key, identity] of instances) {
        state.instances.set(key, { identity });
        state.clean.add(key);
      }
      return state;
    };

    it("dirties the instance a keyed cause names, for an identity with no session", () => {
      const state = cleanNode();

      dirtyFanOutForCause(state, {
        scope: "user",
        scopeKey: resolveScopeKey("user", alice),
      });

      expect([...state.clean]).toEqual([
        "space",
        resolveScopeKey("user", bob),
      ]);
    });

    it("leaves the probe instance clean for a keyed cause", () => {
      const state = cleanNode();

      dirtyFanOutForCause(state, {
        scope: "user",
        scopeKey: resolveScopeKey("user", bob),
      });

      expect(state.clean.has("space")).toBe(true);
      expect(state.clean.has(resolveScopeKey("user", bob))).toBe(false);
    });

    it("dirties every instance for a cause that names no instance", () => {
      const state = cleanNode();

      dirtyFanOutForCause(state, { scope: "space" });

      expect([...state.clean]).toEqual([]);
    });
  });
});
