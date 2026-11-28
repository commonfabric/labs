import { expect } from "@std/expect";

import { CFC_ATOM_TYPE } from "@commonfabric/api/cfc";
import { describe, it } from "@commonfabric/test-support/test";

import {
  appendHarnessCfcModelContextObservations,
  cloneIfcLabel,
  createHarnessCfcModelContextInputLabels,
  HARNESS_CFC_MODEL_CONTEXT_READS_LIMIT,
  HARNESS_CFC_MODEL_CONTEXT_REPORT_READS_LIMIT,
  type HarnessCfcModelContext,
  type HarnessCfcModelContextObservationInput,
  type HarnessCfcModelContextRead,
  harnessCfcModelContextReads,
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

/** A read of `ref` at `revision`, under `confidentiality`. */
const readOf = (
  ref: string,
  revision: string | null,
  confidentiality: NonNullable<
    HarnessCfcModelContextRead["ifc"]["confidentiality"]
  > = [],
): HarnessCfcModelContextRead => ({
  ref,
  revision,
  coverage: revision === null
    ? { kind: "body", revisionScope: "none" }
    : { kind: "body" },
  ifc: { confidentiality },
});

/** A command output's observation input, declaring `reads` when given. */
const commandOutput = (
  n: number,
  confidentiality: NonNullable<
    HarnessCfcModelContext["label"]["confidentiality"]
  >,
  reads?: HarnessCfcModelContextRead[],
): HarnessCfcModelContextObservationInput => ({
  toolCallId: `call-${n}`,
  toolId: "run_command",
  outputId: createToolOutputId("run", "run_command", n),
  channels: ["output"],
  label: { confidentiality },
  ...(reads !== undefined ? { reads } : {}),
});

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

    it("records an output that declares a read whatever its label, and a public one that declares none not at all", () => {
      const publicRead = readOf("web:https://example.com/", null);
      const context = appendHarnessCfcModelContextObservations(
        undefined,
        [
          commandOutput(1, [], [publicRead]),
          commandOutput(2, []),
          commandOutput(3, [], []),
        ],
        "2026-09-21T10:00:00.000Z",
      );

      expect(context?.label).toEqual({ confidentiality: [] });
      expect(context?.observations).toEqual([{
        type: "cf-harness.cfc-model-context-observation",
        sequence: 1,
        at: "2026-09-21T10:00:00.000Z",
        toolCallId: "call-1",
        toolId: "run_command",
        outputId: createToolOutputId("run", "run_command", 1),
        channels: ["output"],
        policy: "observed",
        label: { confidentiality: [] },
        reads: [publicRead],
      }]);
      expect(appendHarnessCfcModelContextObservations(
        undefined,
        [commandOutput(2, []), commandOutput(3, [], [])],
        "2026-09-21T10:00:00.000Z",
      )).toBeUndefined();
    });

    it("keeps a labeled output's declaration that it read nothing, and the label it joins", () => {
      const context = appendHarnessCfcModelContextObservations(
        undefined,
        [commandOutput(1, [observedSecret], [])],
        "2026-09-21T10:00:00.000Z",
      );

      expect(context?.label).toEqual({ confidentiality: [observedSecret] });
      expect(context?.observations[0].reads).toEqual([]);
    });

    it("refuses an observation that declares more reads than one records", () => {
      const reads = Array.from(
        { length: HARNESS_CFC_MODEL_CONTEXT_READS_LIMIT + 1 },
        (_, n) => readOf(`ref-${n}`, "r"),
      );

      expect(() =>
        appendHarnessCfcModelContextObservations(
          undefined,
          [commandOutput(1, [observedSecret], reads)],
          "2026-09-21T10:00:00.000Z",
        )
      ).toThrow(RangeError);
      expect(
        appendHarnessCfcModelContextObservations(
          undefined,
          [commandOutput(1, [observedSecret], reads.slice(1))],
          "2026-09-21T10:00:00.000Z",
        )?.observations[0].reads,
      ).toHaveLength(HARNESS_CFC_MODEL_CONTEXT_READS_LIMIT);
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

  describe("harnessCfcModelContextReads()", () => {
    /** The outputs `commandOutput` made, numbered as given. */
    const outputsOf = (...numbers: number[]) =>
      numbers.map((n) => ({
        outputId: createToolOutputId("run", "run_command", n),
      }));

    it("returns the run's own observations that declare a read, in sequence order, with their label and reads", () => {
      const a = readOf("gmail:thread-a", "rev-a", [observedSecret]);
      const b = readOf("gmail:thread-b", "rev-b", [otherReader]);
      const c = readOf("web:https://example.com/", null);
      const saved = appendHarnessCfcModelContextObservations(
        undefined,
        [commandOutput(1, [observedSecret, otherReader], [a, b])],
        "2026-09-21T10:00:00.000Z",
      );
      const context = appendHarnessCfcModelContextObservations(
        saved,
        [
          commandOutput(2, [observedSecret]),
          commandOutput(3, [], [c]),
          commandOutput(4, [observedSecret], []),
        ],
        "2026-09-22T10:00:00.000Z",
      );

      expect(harnessCfcModelContextReads(context, outputsOf(1, 2, 3, 4)))
        .toEqual({
          reads: [{
            sequence: 1,
            toolCallId: "call-1",
            outputId: createToolOutputId("run", "run_command", 1),
            label: { confidentiality: [observedSecret, otherReader] },
            reads: [a, b],
          }, {
            sequence: 3,
            toolCallId: "call-3",
            outputId: createToolOutputId("run", "run_command", 3),
            label: { confidentiality: [] },
            reads: [c],
          }],
        });
    });

    it("leaves out observations of outputs that are not the run's own, as a continued run's inherited ones are", () => {
      const context = appendHarnessCfcModelContextObservations(
        undefined,
        [
          commandOutput(1, [observedSecret], [readOf("prior", "r")]),
          commandOutput(2, [observedSecret], [readOf("current", "r")]),
        ],
        "2026-09-21T10:00:00.000Z",
      );

      expect(
        harnessCfcModelContextReads(context, outputsOf(2)).reads.map((entry) =>
          entry.reads.map((read) => read.ref)
        ),
      ).toEqual([["current"]]);
      expect(harnessCfcModelContextReads(context, [])).toEqual({ reads: [] });
    });

    it("carries whole observations up to the report's bound and counts the reads past it", () => {
      const many = (prefix: string, count: number) =>
        Array.from({ length: count }, (_, n) => readOf(`${prefix}-${n}`, "r"));
      const half = HARNESS_CFC_MODEL_CONTEXT_REPORT_READS_LIMIT / 2;
      const context = appendHarnessCfcModelContextObservations(
        undefined,
        [
          commandOutput(1, [observedSecret], many("a", half)),
          commandOutput(2, [observedSecret], many("b", half)),
          commandOutput(3, [observedSecret], many("c", 1)),
          commandOutput(4, [observedSecret], many("d", 2)),
        ],
        "2026-09-21T10:00:00.000Z",
      );

      const report = harnessCfcModelContextReads(
        context,
        outputsOf(1, 2, 3, 4),
      );
      expect(report.reads.map((entry) => entry.sequence)).toEqual([1, 2]);
      expect(report.readsOmitted).toBe(3);
      expect(
        harnessCfcModelContextReads(context, outputsOf(1, 3)),
      ).not.toHaveProperty("readsOmitted");
    });

    it("returns no entries for a run without a model context or whose outputs declared none", () => {
      expect(harnessCfcModelContextReads(undefined, [])).toEqual({ reads: [] });
      expect(
        harnessCfcModelContextReads(savedContext([observedSecret]), []),
      ).toEqual({ reads: [] });
    });
  });
});
