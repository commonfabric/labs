import { expect } from "@std/expect";

import { CFC_ATOM_TYPE } from "@commonfabric/api/cfc";
import { describe, it } from "@commonfabric/test-support/test";

import {
  appendHarnessCfcModelContextObservations,
  cloneIfcLabel,
  createHarnessCfcModelContextInputLabels,
  type HarnessCfcModelContext,
  type HarnessCfcModelContextObservationInput,
  mergeConfidentialityOnlyLabels,
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

const trustedSource = {
  type: "test.cfc/TrustedSource",
  subject: "did:key:trusted-source",
};

describe("cfc-model-context", () => {
  describe("cloneIfcLabel()", () => {
    it("copies non-empty confidentiality and integrity without sharing them", () => {
      const label = {
        confidentiality: [observedSecret],
        integrity: [trustedSource],
      };

      const cloned = cloneIfcLabel(label);

      expect(cloned).toEqual(label);
      expect(cloned.confidentiality).not.toBe(label.confidentiality);
      expect(cloned.integrity).not.toBe(label.integrity);
    });

    it("omits empty confidentiality and integrity", () => {
      expect(cloneIfcLabel({ confidentiality: [], integrity: [] })).toEqual({});
    });
  });

  describe("mergeConfidentialityOnlyLabels()", () => {
    it("keeps each structurally distinct clause once, in first-seen order", () => {
      expect(mergeConfidentialityOnlyLabels([
        { confidentiality: [observedSecret], integrity: [trustedSource] },
        undefined,
        { confidentiality: [{ ...otherReader }, { ...observedSecret }] },
        { confidentiality: [{ anyOf: [otherReader] }, otherReader] },
      ])).toEqual({
        confidentiality: [observedSecret, otherReader, {
          anyOf: [otherReader],
        }],
      });
    });

    it("returns no label when no input holds confidentiality", () => {
      expect(mergeConfidentialityOnlyLabels([
        undefined,
        { integrity: [trustedSource] },
        { confidentiality: [] },
      ])).toBeUndefined();
    });
  });

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

    it("stamps nothing without a model context or without paths", () => {
      const modelContext = savedContext([observedSecret]);

      expect(createHarnessCfcModelContextInputLabels({ modelContext }))
        .toBeUndefined();
      expect(
        createHarnessCfcModelContextInputLabels({ modelContext, paths: [] }),
      )
        .toBeUndefined();
      expect(createHarnessCfcModelContextInputLabels({ paths: [["command"]] }))
        .toBeUndefined();
      expect(
        createHarnessCfcModelContextInputLabels({
          modelContext,
          paths: [["command"]],
        })?.entries,
      ).toEqual([{
        path: ["command"],
        label: { confidentiality: [observedSecret] },
      }]);
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

    it("returns the saved context itself when given no observations", () => {
      const saved = savedContext([observedSecret]);

      expect(appendHarnessCfcModelContextObservations(saved, [], "later"))
        .toBe(saved);
      expect(appendHarnessCfcModelContextObservations(undefined, [], "later"))
        .toBeUndefined();
    });

    it("records only observations with channels and confidentiality, numbering them after the saved ones", () => {
      const saved = appendHarnessCfcModelContextObservations(
        undefined,
        [{
          toolCallId: "call-1",
          toolId: "bash",
          outputId: createToolOutputId("run", "bash", 1),
          channels: ["stdout"],
          label: { confidentiality: [observedSecret] },
        }],
        "2026-09-21T10:00:00.000Z",
      );
      const unobserved: HarnessCfcModelContextObservationInput[] = [{
        toolCallId: "call-2",
        toolId: "bash",
        outputId: createToolOutputId("run", "bash", 2),
        channels: [],
        label: { confidentiality: [otherReader] },
      }, {
        toolCallId: "call-3",
        toolId: "bash",
        outputId: createToolOutputId("run", "bash", 3),
        channels: ["stderr"],
        label: { integrity: [trustedSource] },
      }];

      expect(
        appendHarnessCfcModelContextObservations(saved, unobserved, "later"),
      ).toBe(saved);

      const next = appendHarnessCfcModelContextObservations(
        saved,
        [...unobserved, {
          toolCallId: "call-4",
          toolId: "bash",
          outputId: createToolOutputId("run", "bash", 4),
          channels: ["exitCode"],
          label: { confidentiality: [otherReader], integrity: [trustedSource] },
          truncated: true,
        }],
        "2026-09-22T10:00:00.000Z",
      );

      expect(next?.updatedAt).toBe("2026-09-22T10:00:00.000Z");
      expect(next?.label).toEqual({
        confidentiality: [observedSecret, otherReader],
      });
      expect(
        next?.observations.map((observation) => ({
          sequence: observation.sequence,
          toolCallId: observation.toolCallId,
          label: observation.label,
          truncated: observation.truncated,
        })),
      ).toEqual([{
        sequence: 1,
        toolCallId: "call-1",
        label: { confidentiality: [observedSecret] },
        truncated: undefined,
      }, {
        sequence: 2,
        toolCallId: "call-4",
        label: { confidentiality: [otherReader] },
        truncated: true,
      }]);
    });

    it("returns no model context when prompt-slot influence is all an observation's confidentiality holds", () => {
      const observation = (
        confidentiality: HarnessCfcModelContext["label"]["confidentiality"],
      ): HarnessCfcModelContextObservationInput => ({
        toolCallId: "call-1",
        toolId: "delegate_task",
        outputId: createToolOutputId("run", "delegate_task", 1),
        channels: ["output"],
        label: { confidentiality },
      });

      expect(appendHarnessCfcModelContextObservations(
        undefined,
        [observation([influence])],
        "2026-09-21T10:00:00.000Z",
      )).toBeUndefined();
      expect(
        appendHarnessCfcModelContextObservations(
          undefined,
          [observation([influence, observedSecret])],
          "2026-09-21T10:00:00.000Z",
        )?.label,
      ).toEqual({ confidentiality: [observedSecret] });
    });
  });
});
