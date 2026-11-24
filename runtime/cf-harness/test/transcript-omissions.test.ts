/** Unit tests for the durable transcript omission record. */

import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { join } from "@std/path";

import { createFileSystemHarnessArtifactStore } from "../src/artifacts.ts";
import {
  annotateHarnessToolResultOmissions,
  createHarnessTranscriptOmissionRuleRecord,
  createHarnessTranscriptOmissions,
  HARNESS_TRANSCRIPT_OMISSION_RULES,
  type HarnessTranscriptOmissionRule,
  restoreHarnessTranscriptOmissions,
} from "../src/contracts/transcript-omissions.ts";
import {
  createToolOutputId,
  createToolResultRef,
} from "../src/contracts/tool-result.ts";
import type {
  HarnessToolTranscriptMessage,
  HarnessTranscriptMessage,
} from "../src/contracts/transcript.ts";

describe("transcript omissions", () => {
  const runId = "omission-run";
  const outputId = createToolOutputId(runId, "run_pattern", 1);
  const artifactPath = "/artifacts/omission-run/tool-outputs/result.json";
  const resultRef = createToolResultRef(
    outputId,
    "run_pattern",
    runId,
    artifactPath,
  );

  const message = (
    rules: readonly HarnessTranscriptOmissionRule[],
  ): HarnessToolTranscriptMessage =>
    annotateHarnessToolResultOmissions(
      {
        role: "tool",
        toolCallId: "call-1",
        toolName: "run_pattern",
        content: JSON.stringify({ status: "ok", value: "model-facing" }),
        resultRef,
      },
      rules.flatMap((rule, index) => {
        const record = createHarnessTranscriptOmissionRuleRecord(
          rule,
          resultRef,
          [`/field-${index}`],
        );
        return record === undefined ? [] : [record];
      }),
    );

  it("records every model-boundary omission rule for its tool result", () => {
    const record = createHarnessTranscriptOmissions([
      { role: "user", content: "Run it." },
      message(HARNESS_TRANSCRIPT_OMISSION_RULES),
    ]);
    expect(record.results).toHaveLength(1);
    expect(record.results[0].transcriptIndex).toBe(1);
    expect(record.results[0].rules.map((entry) => entry.rule)).toEqual(
      HARNESS_TRANSCRIPT_OMISSION_RULES,
    );
    expect(record.results[0].rules[0].locations).toEqual([{
      artifactPath,
      jsonPointer: "/field-0",
    }]);
  });

  it("keeps omission metadata out of serialized provider history", () => {
    const annotated = message(["artifact-only"]);
    expect(JSON.parse(JSON.stringify(annotated))).toEqual({
      role: "tool",
      toolCallId: "call-1",
      toolName: "run_pattern",
      content: JSON.stringify({ status: "ok", value: "model-facing" }),
      resultRef,
    });
  });

  it("records a current tool result with no omissions as known empty", () => {
    const record = createHarnessTranscriptOmissions([message([])]);

    expect(record.results).toHaveLength(1);
    expect(record.results[0].rules).toEqual([]);
  });

  it("does not invent a record for an unannotated legacy result", () => {
    const record = createHarnessTranscriptOmissions([{
      role: "tool",
      toolCallId: "legacy-call",
      toolName: "run_pattern",
      content: "legacy model-facing result",
      resultRef,
    }]);

    expect(record.results).toEqual([]);
  });

  for (
    const invalid of [
      "duplicate-index",
      "duplicate-output",
      "wrong-identity",
      "unmatched",
    ] as const
  ) {
    it(`rejects a ${invalid} checkpoint before restoring any omission annotations`, () => {
      const first = message(["artifact-only"]);
      const record = createHarnessTranscriptOmissions([first]);
      const transcript: HarnessTranscriptMessage[] = JSON.parse(JSON.stringify([
        first,
        { ...first, toolCallId: "call-2" },
      ]));
      const result = record.results[0];
      const invalidResult = invalid === "duplicate-index"
        ? { ...result, outputId: "another-output" }
        : invalid === "duplicate-output"
        ? { ...result, transcriptIndex: 1, toolCallId: "call-2" }
        : {
          ...result,
          transcriptIndex: invalid === "unmatched" ? 2 : 1,
          outputId: "another-output",
        };
      expect(() =>
        restoreHarnessTranscriptOmissions(transcript, {
          ...record,
          results: [result, invalidResult],
        })
      ).toThrow(
        invalid.startsWith("duplicate")
          ? "Stored transcript omissions repeat a result"
          : "Stored transcript omissions do not match their result",
      );
      expect(createHarnessTranscriptOmissions(transcript).results).toEqual([]);
    });
  }

  it("restores known omissions alongside unrecorded legacy results without claiming they were empty", () => {
    const original: HarnessTranscriptMessage[] = [
      message(["artifact-only"]),
      {
        role: "tool",
        toolCallId: "legacy-call",
        toolName: "run_pattern",
        content: "legacy result",
        resultRef: createToolResultRef(
          createToolOutputId(runId, "run_pattern", 2),
          "run_pattern",
          runId,
        ),
      },
    ];
    const record = createHarnessTranscriptOmissions(original);
    const restored: HarnessTranscriptMessage[] = JSON.parse(
      JSON.stringify(original),
    );
    restoreHarnessTranscriptOmissions(restored, record);
    expect(createHarnessTranscriptOmissions(restored)).toEqual(record);
    expect(record.results.map((result) => result.transcriptIndex)).toEqual([0]);
  });

  it("carries an earlier omission across a replacement tool message", () => {
    const earlier = message(["bare-fabric-identifier-scrub"]);
    const collapse = createHarnessTranscriptOmissionRuleRecord(
      "superseded-run-pattern-diagnostic-collapse",
      resultRef,
      ["/message"],
    )!;
    const replacement = annotateHarnessToolResultOmissions(
      { ...earlier, content: JSON.stringify({ messageCollapsed: true }) },
      [collapse],
      earlier,
    );

    expect(
      createHarnessTranscriptOmissions([replacement]).results[0].rules.map(
        (entry) => entry.rule,
      ),
    ).toEqual([
      "bare-fabric-identifier-scrub",
      "superseded-run-pattern-diagnostic-collapse",
    ]);
  });

  it("writes locations without copying withheld content", async () => {
    const root = await Deno.makeTempDir();
    try {
      const store = createFileSystemHarnessArtifactStore({
        artifactRoot: root,
        runId,
      });
      const raw = {
        outputId,
        status: "ok",
        rawValue: "WITHHELD-SENTINEL",
      };
      const path = await store.persistToolOutput(
        "run_pattern",
        outputId,
        raw,
      );
      const ref = createToolResultRef(
        outputId,
        "run_pattern",
        runId,
        path,
      );
      const omission = createHarnessTranscriptOmissionRuleRecord(
        "artifact-only",
        ref,
        ["/rawValue"],
      )!;
      await store.persistTranscript([
        annotateHarnessToolResultOmissions({
          role: "tool",
          toolCallId: "call-1",
          toolName: "run_pattern",
          content: JSON.stringify({ outputId, status: "ok" }),
          resultRef: ref,
        }, [omission]),
      ]);

      const recordText = await Deno.readTextFile(
        join(store.runRoot, "transcript-omissions.json"),
      );
      expect(recordText).not.toContain("WITHHELD-SENTINEL");
      expect(JSON.parse(recordText).results[0].rules).toEqual([{
        rule: "artifact-only",
        locations: [{ artifactPath: path, jsonPointer: "/rawValue" }],
      }]);
    } finally {
      await Deno.remove(root, { recursive: true });
    }
  });

  it("retains prior-process rules when a later write adds another rule", () => {
    const firstMessage = message(["artifact-only"]);
    const first = createHarnessTranscriptOmissions([firstMessage]);
    const secondMessage = message(["model-context-truncation"]);
    const second = createHarnessTranscriptOmissions([secondMessage], first);
    expect(second.results[0].rules.map((entry) => entry.rule)).toEqual([
      "artifact-only",
      "model-context-truncation",
    ]);
  });

  it("retains prior-process rules for a restored user handoff", () => {
    const researchOutputId = createToolOutputId(runId, "research", 1);
    const researchRef = createToolResultRef(
      researchOutputId,
      "research",
      runId,
      artifactPath,
    );
    const omission = createHarnessTranscriptOmissionRuleRecord(
      "artifact-only",
      researchRef,
      ["/researchRecord"],
    )!;
    const previous = createHarnessTranscriptOmissions([
      annotateHarnessToolResultOmissions({
        role: "tool",
        toolCallId: "opening-research:omission-run",
        toolName: "research",
        content: "sanitized kit",
        resultRef: researchRef,
      }, [omission]),
    ]);
    const restored = JSON.parse(JSON.stringify({
      role: "user",
      content: "Host opening research handoff",
      toolResultProvenance: {
        type: "cf-harness.tool-result-provenance",
        toolCallId: "opening-research:omission-run",
        toolId: "research",
        outputId: researchOutputId,
      },
    })) as HarnessTranscriptMessage;

    expect(createHarnessTranscriptOmissions([restored], previous).results)
      .toEqual([{
        transcriptIndex: 0,
        toolCallId: "opening-research:omission-run",
        toolId: "research",
        outputId: researchOutputId,
        rules: [{
          rule: "artifact-only",
          locations: [{
            artifactPath,
            jsonPointer: "/researchRecord",
          }],
        }],
      }]);
  });

  it("does not overwrite an unsupported prior omission record", async () => {
    const root = await Deno.makeTempDir();
    try {
      const store = createFileSystemHarnessArtifactStore({
        artifactRoot: root,
        runId,
      });
      await Deno.mkdir(store.runRoot, { recursive: true });
      const path = join(store.runRoot, "transcript-omissions.json");
      await Deno.writeTextFile(path, '{"version":999}');

      await expect(store.persistTranscript([message([])])).rejects.toThrow(
        "unsupported transcript omission artifact",
      );
      expect(await Deno.readTextFile(path)).toBe('{"version":999}');
    } finally {
      await Deno.remove(root, { recursive: true });
    }
  });
});
