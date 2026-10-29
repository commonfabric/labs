/**
 * Unit tests for the handle-skill scrub helpers. The end-to-end
 * `prompt-loop-skill-handle` tests cover the scrub through the real return
 * pipeline, where the subagent-return validator strips object keys not named
 * in the schema before the deep scrub runs — so a decoded payload cannot
 * actually reach a KEY position there. These tests pin the deep scrub's own
 * contract directly, key position included, so the helper stays a complete
 * "scrub every string in this structure" rather than one with a silent gap
 * that a future validator change could expose.
 */

import { describe, it } from "@std/testing/bdd";

import { expect } from "@std/expect";
import {
  scrubHandleSkillText,
  scrubHandleSkillTextDeep,
} from "../src/prompt-loop.ts";

const PAYLOAD = 'CANARY-SKILL-9f4e2: the "whole"\nskill body';
const MARKER = "[handle-delivered skill text withheld]";

describe("skill-text scrub", () => {
  describe("scrubHandleSkillText", () => {
    it("replaces the payload and its JSON-escaped spelling with the marker", () => {
      const escaped = JSON.stringify(PAYLOAD).slice(1, -1);
      // The payload carries a quote and a newline, so its JSON-escaped
      // spelling genuinely differs from the raw form — the escaped branch is
      // exercised rather than run against a byte-identical string.
      expect(escaped).not.toBe(PAYLOAD);
      expect(scrubHandleSkillText(`before ${PAYLOAD} after`, PAYLOAD))
        .toBe(`before ${MARKER} after`);
      expect(scrubHandleSkillText(`before ${escaped} after`, PAYLOAD))
        .toBe(`before ${MARKER} after`);
    });

    it("leaves text that does not contain the payload unchanged", () => {
      expect(scrubHandleSkillText("nothing to see", PAYLOAD))
        .toBe("nothing to see");
    });
  });

  describe("scrubHandleSkillTextDeep", () => {
    it("scrubs a bare string", () => {
      expect(scrubHandleSkillTextDeep(PAYLOAD, PAYLOAD)).toBe(MARKER);
    });

    it("scrubs every string in an array", () => {
      expect(scrubHandleSkillTextDeep([PAYLOAD, "ok", PAYLOAD], PAYLOAD))
        .toEqual([MARKER, "ok", MARKER]);
    });

    it("scrubs a nested object value", () => {
      expect(
        scrubHandleSkillTextDeep({ note: { deep: PAYLOAD } }, PAYLOAD),
      ).toEqual({ note: { deep: MARKER } });
    });

    it("scrubs the payload in KEY position", () => {
      const result = scrubHandleSkillTextDeep(
        { [PAYLOAD]: true },
        PAYLOAD,
      ) as Record<string, unknown>;
      expect(Object.keys(result)).toEqual([MARKER]);
      expect(result[MARKER]).toBe(true);
    });

    it("leaves non-string primitives untouched", () => {
      expect(scrubHandleSkillTextDeep({ n: 2, ok: true, z: null }, PAYLOAD))
        .toEqual({ n: 2, ok: true, z: null });
    });
  });
});
