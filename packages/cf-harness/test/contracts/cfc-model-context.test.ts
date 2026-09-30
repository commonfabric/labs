import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";

import { CFC_ATOM_TYPE } from "@commonfabric/api/cfc";

import {
  appendHarnessCfcModelContextObservations,
  createHarnessCfcModelContextInputLabels,
  type HarnessCfcModelContext,
} from "../../src/contracts/cfc-model-context.ts";
import { createToolOutputId } from "../../src/contracts/tool-result.ts";

const influence = {
  type: CFC_ATOM_TYPE.PromptSlotInfluence,
  version: 1,
  role: "direct-command",
  kernelName: "cf-harness",
  surface: "cli",
};

const observedSecret = {
  type: "test.cfc/ObservedOutput",
  subject: "did:key:observed-secret",
};

const otherReader = {
  type: "test.cfc/User",
  subject: "did:key:other-reader",
};

/** A model context whose saved label holds `confidentiality` as given. */
const savedContext = (
  confidentiality: NonNullable<
    HarnessCfcModelContext["label"]["confidentiality"]
  >,
): HarnessCfcModelContext => ({
  type: "cf-harness.cfc-model-context",
  version: 1,
  updatedAt: "2026-09-20T10:00:00.000Z",
  label: { confidentiality },
  observations: [],
});

describe("cfc-model-context", () => {
  describe("createHarnessCfcModelContextInputLabels()", () => {
    it("stamps no prompt-slot influence held as a bare confidentiality clause", () => {
      const labels = createHarnessCfcModelContextInputLabels({
        modelContext: savedContext([influence, observedSecret]),
        paths: [["command"]],
      });

      expect(labels?.entries).toEqual([{
        path: ["command"],
        label: { confidentiality: [observedSecret] },
      }]);
    });

    it("stamps no prompt-slot influence held as an alternative of an OR-clause", () => {
      const labels = createHarnessCfcModelContextInputLabels({
        modelContext: savedContext([
          { anyOf: [influence, otherReader] },
          { anyOf: [influence] },
          observedSecret,
        ]),
        paths: [["command"]],
      });

      // The remaining alternative still gates the reader; a clause left with
      // none was only ever the influence atom.
      expect(labels?.entries).toEqual([{
        path: ["command"],
        label: { confidentiality: [otherReader, observedSecret] },
      }]);
    });

    it("stamps nothing when prompt-slot influence was all the saved label held", () => {
      expect(createHarnessCfcModelContextInputLabels({
        modelContext: savedContext([influence]),
        paths: [["command"]],
      })).toBeUndefined();
    });
  });

  describe("appendHarnessCfcModelContextObservations()", () => {
    it("drops prompt-slot influence from the saved label when it merges a new observation", () => {
      const context = appendHarnessCfcModelContextObservations(
        savedContext([influence, observedSecret]),
        [{
          toolCallId: "call-1",
          toolId: "bash",
          outputId: createToolOutputId("run", "bash", 1),
          channels: ["stdout"],
          label: { confidentiality: [otherReader] },
        }],
        "2026-09-21T10:00:00.000Z",
      );

      expect(context?.label).toEqual({
        confidentiality: [observedSecret, otherReader],
      });
    });
  });
});
