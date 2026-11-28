import { expect } from "@std/expect";

import {
  CFC_PROMPT_SLOT_BOUND_ATOM_TYPE,
  normalizePromptSlotBinding,
  type PromptSlotBinding,
  promptSlotBindingAtMost,
} from "../../src/contracts/prompt-slot.ts";
import { describe, it } from "@commonfabric/test-support/test";

/** A binding that passes every check, with every optional field present. */
const complete: PromptSlotBinding = {
  type: CFC_PROMPT_SLOT_BOUND_ATOM_TYPE,
  source: { type: "test.prompt-slot", subject: "complete" },
  role: "direct-command",
  kernelName: "cf-harness",
  surface: "cli",
  subject: "did:key:user",
  renderRef: { seq: 3, rootRef: "root" },
  eventId: "evt-1",
  valueDigest: "sha256:value",
  slotDigest: "sha256:slot",
  snapshotDigest: "sha256:snapshot",
  targetPath: "/workspace/request.md",
};

describe("prompt-slot", () => {
  describe("normalizePromptSlotBinding()", () => {
    it("returns a complete binding field for field, and drops a field the contract does not name", () => {
      expect(normalizePromptSlotBinding({ ...complete, extra: "dropped" }))
        .toEqual(complete);
    });

    it("returns a binding with no optional field when none is given", () => {
      expect(normalizePromptSlotBinding({
        type: CFC_PROMPT_SLOT_BOUND_ATOM_TYPE,
        source: "typed",
        role: "quote",
        kernelName: "cf-harness",
        surface: "cli",
      })).toEqual({
        type: CFC_PROMPT_SLOT_BOUND_ATOM_TYPE,
        source: "typed",
        role: "quote",
        kernelName: "cf-harness",
        surface: "cli",
      });
    });

    const refusals: readonly [string, unknown, string][] = [
      ["a value that is not an object", ["binding"], "must be a JSON object"],
      [
        "another atom type",
        { ...complete, type: "test.other" },
        "unsupported prompt slot binding type: test.other",
      ],
      [
        "an empty source",
        { ...complete, source: {} },
        "source must be a reference",
      ],
      [
        "a role outside the three",
        { ...complete, role: "system" },
        "role must be one of direct-command, context, quote",
      ],
      [
        "a blank kernel name",
        { ...complete, kernelName: " " },
        "kernelName must be a non-empty string",
      ],
      [
        "a blank surface",
        { ...complete, surface: "" },
        "surface must be a non-empty string",
      ],
      [
        "a render reference that is not an object",
        { ...complete, renderRef: "root" },
        "renderRef must be an object",
      ],
      [
        "a render sequence that is not an integer",
        { ...complete, renderRef: { seq: 1.5, rootRef: "root" } },
        "renderRef.seq must be a safe integer",
      ],
      [
        "a render root that is not a reference",
        { ...complete, renderRef: { seq: 1, rootRef: "" } },
        "renderRef.rootRef must be a reference",
      ],
      [
        "an optional field that is not a string",
        { ...complete, eventId: 7 },
        "prompt slot eventId must be a string",
      ],
    ];
    for (const [what, input, message] of refusals) {
      it(`throws for ${what}`, () => {
        expect(() => normalizePromptSlotBinding(input)).toThrow(message);
      });
    }
  });

  describe("promptSlotBindingAtMost()", () => {
    it("lowers a direct-command binding to quote and keeps every other field", () => {
      expect(promptSlotBindingAtMost(complete, "quote")).toEqual({
        ...complete,
        role: "quote",
      });
    });

    it("lowers a context binding to quote", () => {
      expect(
        promptSlotBindingAtMost({ ...complete, role: "context" }, "quote").role,
      ).toBe("quote");
    });

    it("returns a binding already at or below the ceiling unchanged", () => {
      const quoted: PromptSlotBinding = { ...complete, role: "quote" };
      expect(promptSlotBindingAtMost(quoted, "quote")).toBe(quoted);
      expect(promptSlotBindingAtMost(quoted, "direct-command")).toBe(quoted);
    });
  });
});
