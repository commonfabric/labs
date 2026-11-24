import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";

import { NULL_LIVE_ENVIRONMENT } from "@/codec-common";
import { newProbeEngine, ProbeEncodeAct } from "./probe-engine.ts";

/** Returns a fresh encode act in the probe format, which has entered nothing. */
function newAct(): ProbeEncodeAct {
  return new ProbeEncodeAct(newProbeEngine().engine, NULL_LIVE_ENVIRONMENT);
}

describe("BaseCodecAct", () => {
  describe("instance members", () => {
    describe("abandon()", () => {
      // Whether a value is still entered shows as whether entering it again
      // is refused as a cycle.

      const CYCLE = "Circular reference detected during encoding";

      it("returns without effect on an act that has entered nothing", () => {
        const act = newAct();
        const value = {};

        expect(() => act.abandon(value)).not.toThrow();
        expect(() => act.enter(value)).not.toThrow();
        expect(() => act.enter(value)).toThrow(CYCLE);
      });

      it("leaves the given value and every value entered after it", () => {
        const act = newAct();
        const outer = {};
        const middle = {};
        const inner = {};
        act.enter(outer);
        act.enter(middle);
        act.enter(inner);

        act.abandon(middle);

        expect(() => act.enter(outer)).toThrow(CYCLE);
        expect(() => act.enter(middle)).not.toThrow();
        expect(() => act.enter(inner)).not.toThrow();
      });

      it("leaves nothing given a value that was never entered", () => {
        const act = newAct();
        const entered = {};
        act.enter(entered);

        act.abandon({});

        expect(() => act.enter(entered)).toThrow(CYCLE);
      });
    });
  });
});
