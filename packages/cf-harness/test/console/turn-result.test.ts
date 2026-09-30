/**
 * The console's completed-turn projection from durable model-facing run
 * artifacts.
 */

import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { join } from "@std/path";

import { readConsoleTurnResult } from "../../console/turn-result.ts";
import type { HarnessTranscriptMessage } from "../../src/contracts/transcript.ts";

const writeTranscript = async (
  artifactRoot: string,
  turnId: string,
  transcript: readonly HarnessTranscriptMessage[],
  firstGeneratedIndex = 1,
): Promise<void> => {
  const runRoot = join(artifactRoot, turnId);
  await Deno.mkdir(runRoot, { recursive: true });
  await Deno.writeTextFile(
    join(runRoot, "transcript.json"),
    JSON.stringify(transcript),
  );
  await Deno.writeTextFile(
    join(runRoot, "run-report.json"),
    JSON.stringify({
      finalAssistantText: transcript.slice(firstGeneratedIndex).findLast(
        (message) => message.role === "assistant",
      )?.content ?? "",
      timeline: transcript.map((message, transcriptIndex) => ({
        kind: "transcript_message",
        transcriptIndex,
        role: message.role,
        ...(transcriptIndex >= firstGeneratedIndex ? { modelTurn: 1 } : {}),
      })),
    }),
  );
};

describe("console/turn-result", () => {
  for (const source of ["total", "legacy", "absent", "malformed"] as const) {
    it(`projects ${source} usage without guessing missing counts`, async () => {
      const artifactRoot = await Deno.makeTempDir();
      try {
        const turnId = "usage";
        await writeTranscript(artifactRoot, turnId, [
          { role: "user", content: "Read the note." },
          { role: "assistant", content: "The note is ready." },
        ]);
        const reportPath = join(artifactRoot, turnId, "run-report.json");
        const report = JSON.parse(await Deno.readTextFile(reportPath));
        if (source !== "absent") report.usage = { inputTokens: 10 };
        if (source === "total") {
          report.totalUsage = {
            inputTokens: 40,
            outputTokens: 8,
            secret: "private",
          };
        } else if (source === "malformed") {
          report.totalUsage = "unavailable";
        }
        await Deno.writeTextFile(reportPath, JSON.stringify(report));
        const result = await readConsoleTurnResult({
          artifactRoot,
          turnId,
          sessionId: "conversation",
          continuable: true,
          spaceName: "usage-test",
          timing: {
            startedAt: "2026-09-21T00:00:00Z",
            endedAt: "2026-09-21T00:00:03.250Z",
          },
        });
        expect(result?.usage).toEqual(
          source === "total"
            ? { inputTokens: 40, outputTokens: 8 }
            : source === "legacy"
            ? { inputTokens: 10 }
            : undefined,
        );
        expect(result?.elapsedMs).toBe(3250);
      } finally {
        await Deno.remove(artifactRoot, { recursive: true });
      }
    });
  }

  it("reads an unfamiliar stored outcome as completed while preserving the result body", async () => {
    const artifactRoot = await Deno.makeTempDir();
    try {
      const turnId = "turn-from-newer-console";
      await writeTranscript(artifactRoot, turnId, [
        { role: "user", content: "Prepare the request" },
        { role: "assistant", content: "Your request is awaiting approval." },
      ]);
      const reportPath = join(artifactRoot, turnId, "run-report.json");
      const report = JSON.parse(await Deno.readTextFile(reportPath));
      report.taskOutcome = { outcome: "awaiting-approval", approvalId: "one" };
      await Deno.writeTextFile(reportPath, JSON.stringify(report));

      await expect(readConsoleTurnResult({
        sessionId: "session",
        continuable: true,
        artifactRoot,
        turnId,
        spaceName: "console-test",
      })).resolves.toEqual({
        outcome: "completed",
        sessionId: "session",
        continuable: true,
        looms: [],
        pieces: [],
        spaceName: "console-test",
        finalText: "Your request is awaiting approval.",
      });
    } finally {
      await Deno.remove(artifactRoot, { recursive: true });
    }
  });

  it("ties a named Pattern to its verified composition component without exposing its cell address", async () => {
    const artifactRoot = await Deno.makeTempDir();
    const call = (
      id: string,
      name: string,
      args: unknown,
    ): HarnessTranscriptMessage => ({
      role: "assistant",
      content: "",
      toolCalls: [{
        id,
        type: "function",
        function: { name, arguments: JSON.stringify(args) },
      }],
    });
    const output = (
      id: string,
      name: string,
      value: unknown,
    ): HarnessTranscriptMessage => ({
      role: "tool",
      toolName: name,
      toolCallId: id,
      content: JSON.stringify(value),
    });
    const transcript = [
      {
        role: "user",
        content: "Make a clock and collect it",
      } as HarnessTranscriptMessage,
      call("named", "assign_slug", { token: "@held-clock", slug: "clock" }),
      output("named", "assign_slug", {
        status: "ok",
        slug: "clock",
        url: "http://localhost:8000/space/clock",
      }),
      call("composed", "loom_compose", {
        request_id: "collect-clock",
        components: [
          { ref: "url:https://example.com/source" },
          { pattern_token: "@held-clock" },
        ],
      }),
      output("composed", "loom_compose", {
        status: "ok",
        kind: "loom-authored",
        replayed: false,
        current_version: 3,
        receipt: {
          loom_id: "loom-1111111111111111",
          request_id: "collect-clock",
          version: 3,
          created: true,
          component_ids: ["source-link", "opaque-clock-component"],
          operation_ids: ["create", "add-source", "add-clock"],
          displaced: [],
        },
      }),
    ];
    try {
      await writeTranscript(artifactRoot, "coverage", transcript);
      const result = await readConsoleTurnResult({
        sessionId: "session",
        continuable: true,
        artifactRoot,
        turnId: "coverage",
        spaceName: "space",
      });
      expect(result?.pieces).toEqual([{
        slug: "clock",
        url: "http://localhost:8000/space/clock",
        loomComponents: [{
          loomId: "loom-1111111111111111",
          componentId: "opaque-clock-component",
        }],
      }]);
      expect(JSON.stringify(result)).not.toContain("@held-clock");
      // A reused call id later in the transcript cannot retroactively make
      // the preceding successful call/result pair ambiguous.
      transcript.push(
        call("named", "other_tool", {}),
        call("composed", "other_tool", {}),
        call("composed", "loom_compose", {}),
      );
      await writeTranscript(artifactRoot, "later-duplicates", transcript);
      const laterDuplicates = await readConsoleTurnResult({
        sessionId: "session",
        continuable: true,
        artifactRoot,
        turnId: "later-duplicates",
        spaceName: "space",
      });
      expect(laterDuplicates?.pieces).toEqual(result?.pieces);
      transcript.splice(5);
      // A separate named Pattern is not covered by the source-link collection.
      transcript[1] = call("named", "assign_slug", {
        token: "@independent-clock",
        slug: "clock",
      });
      await writeTranscript(artifactRoot, "independent", transcript);
      const independent = await readConsoleTurnResult({
        sessionId: "session",
        continuable: true,
        artifactRoot,
        turnId: "independent",
        spaceName: "space",
      });
      expect(independent?.pieces).toEqual([{
        slug: "clock",
        url: "http://localhost:8000/space/clock",
      }]);
    } finally {
      await Deno.remove(artifactRoot, { recursive: true });
    }
  });

  it("does not infer coverage from ambiguous, historical, or malformed calls", async () => {
    const artifactRoot = await Deno.makeTempDir();
    const call = (
      id: string,
      name: string,
      args: unknown,
    ): HarnessTranscriptMessage => ({
      role: "assistant",
      content: "",
      toolCalls: [{
        id,
        type: "function",
        function: { name, arguments: JSON.stringify(args) },
      }],
    });
    const output = (
      id: string,
      name: string,
      value: unknown,
    ): HarnessTranscriptMessage => ({
      role: "tool",
      toolName: name,
      toolCallId: id,
      content: JSON.stringify(value),
    });
    const named = {
      status: "ok",
      slug: "clock",
      url: "http://localhost:8000/space/clock",
    };
    const args = {
      request_id: "collect",
      components: [{ pattern_token: "@clock" }],
    };
    const authored = {
      status: "ok",
      kind: "loom-authored",
      replayed: false,
      current_version: 2,
      receipt: {
        loom_id: "loom-1111111111111111",
        request_id: "collect",
        version: 2,
        created: true,
        component_ids: ["opaque-component"],
        operation_ids: ["create", "add"],
        displaced: [],
      },
    };
    const base = (): HarnessTranscriptMessage[] => [
      { role: "user", content: "Collect" },
      call("named", "assign_slug", { token: "@clock" }),
      output("named", "assign_slug", named),
      call("compose", "loom_compose", args),
      output("compose", "loom_compose", authored),
    ];
    const cases: [
      string,
      (messages: HarnessTranscriptMessage[]) => void,
      number?,
    ][] = [
      ...[null, {}, { id: 42 }].map((malformed, index): [
        string,
        (messages: HarnessTranscriptMessage[]) => void,
      ] => ["malformed-call-id-" + index, (m) => {
        m[3] = {
          role: "assistant",
          content: "",
          toolCalls: [malformed],
        } as unknown as HarnessTranscriptMessage;
      }]),
      ["duplicate-id-different-tool", (m) => {
        m.splice(3, 0, call("compose", "other_tool", args));
      }],
      ["duplicate-id", (m) => {
        m.splice(3, 0, call("compose", "loom_compose", args));
      }],
      ["wrong-tool", (m) => {
        m[3] = call("compose", "other_tool", args);
      }],
      ["missing-call", (m) => {
        m.splice(3, 1);
      }],
      ["call-after-result", (m) => {
        [m[3], m[4]] = [m[4], m[3]];
      }],
      ["historical-naming", () => {}, 2],
      ["bad-json", (m) => {
        const c = m[3];
        if (c.role === "assistant") c.toolCalls![0].function.arguments = "{";
      }],
      ["array-args", (m) => {
        m[3] = call("compose", "loom_compose", []);
      }],
      ["null-args", (m) => {
        m[3] = call("compose", "loom_compose", null);
      }],
      ["wrong-request", (m) => {
        m[3] = call("compose", "loom_compose", {
          ...args,
          request_id: "other",
        });
      }],
      ["wrong-cardinality", (m) => {
        m[3] = call("compose", "loom_compose", { ...args, components: [] });
      }],
      ["missing-components", (m) => {
        m[3] = call("compose", "loom_compose", { request_id: "collect" });
      }],
      ["empty-token", (m) => {
        m[3] = call("compose", "loom_compose", {
          ...args,
          components: [{ pattern_token: "" }],
        });
      }],
      ["missing-named-token", (m) => {
        m[1] = call("named", "assign_slug", {});
      }],
      ["null-component", (m) => {
        m[3] = call("compose", "loom_compose", { ...args, components: [null] });
      }],
    ];
    try {
      for (const [name, mutate, first = 1] of cases) {
        const transcript = base();
        mutate(transcript);
        await writeTranscript(artifactRoot, name, transcript, first);
        const result = await readConsoleTurnResult({
          sessionId: "session",
          continuable: true,
          artifactRoot,
          turnId: name,
          spaceName: "space",
        });
        expect(result?.pieces, name).toEqual([{
          slug: named.slug,
          url: named.url,
        }]);
        expect(result?.looms, name).toHaveLength(1);
      }
    } finally {
      await Deno.remove(artifactRoot, { recursive: true });
    }
  });

  it("returns only this turn's verified Loom receipts and preserves replay versions", async () => {
    const artifactRoot = await Deno.makeTempDir();
    const receipt = {
      loom_id: "loom-1111111111111111",
      request_id: "collection-one",
      version: 2,
      created: true,
      component_ids: ["c-1"],
      operation_ids: ["op-1", "op-2"],
      displaced: [],
    };
    const output = {
      status: "ok",
      kind: "loom-authored",
      receipt,
      replayed: true,
      current_version: 4,
    };
    const message = (
      toolName: string,
      value: unknown,
    ): HarnessTranscriptMessage => ({
      role: "tool",
      toolName,
      toolCallId: crypto.randomUUID(),
      content: JSON.stringify(value),
    });
    try {
      await writeTranscript(artifactRoot, "turn-looms", [
        message("loom_compose", {
          ...output,
          receipt: { ...receipt, request_id: "old" },
        }),
        { role: "user", content: "Continue" },
        message("loom_authoring_context", output),
        message("loom_inspect", output),
        { role: "assistant", content: JSON.stringify(output) },
        message("loom_compose", {
          ...output,
          receipt: { ...receipt, operation_ids: [] },
        }),
        message("loom_compose", output),
        {
          role: "tool",
          toolName: "loom_compose",
          toolCallId: "unreadable-receipt",
          content: "{broken",
        },
      ], 2);
      const result = await readConsoleTurnResult({
        sessionId: "session",
        continuable: true,
        artifactRoot,
        turnId: "turn-looms",
        spaceName: "test-space",
        originLoomId: "loom-2222222222222222",
      });
      expect(result?.looms).toEqual([{
        receipt,
        replayed: true,
        current_version: 4,
      }]);
      expect(result?.originLoomId).toBe("loom-2222222222222222");
      expect(result?.pieces).toEqual([]);
    } finally {
      await Deno.remove(artifactRoot, { recursive: true });
    }
  });

  it("returns successful `assign_slug` values exactly as the model received them", async () => {
    const artifactRoot = await Deno.makeTempDir({
      prefix: "cf-harness-console-result-",
    });
    try {
      await writeTranscript(artifactRoot, "turn-with-piece", [
        { role: "user", content: "build a reading list" },
        {
          role: "tool",
          toolCallId: "call-1",
          toolName: "assign_slug",
          content: JSON.stringify({
            outputId: "run:assign_slug:1",
            status: "ok",
            slug: "reading-list",
            url: "http://localhost:8000/console-test/reading-list",
          }),
        },
        { role: "assistant", content: "Your reading list is ready." },
      ]);

      await expect(readConsoleTurnResult({
        sessionId: "session",
        continuable: true,
        artifactRoot,
        turnId: "turn-with-piece",
        spaceName: "console-test",
      })).resolves.toEqual({
        outcome: "completed",
        sessionId: "session",
        continuable: true,
        looms: [],
        pieces: [{
          slug: "reading-list",
          url: "http://localhost:8000/console-test/reading-list",
        }],
        spaceName: "console-test",
        finalText: "Your reading list is ready.",
      });
    } finally {
      await Deno.remove(artifactRoot, { recursive: true });
    }
  });

  it("returns `pieces: []` when the run assigned no slug", async () => {
    const artifactRoot = await Deno.makeTempDir({
      prefix: "cf-harness-console-result-",
    });
    try {
      await writeTranscript(artifactRoot, "turn-without-piece", [
        { role: "user", content: "calculate the total" },
        {
          role: "tool",
          toolCallId: "call-1",
          toolName: "run_pattern",
          content: JSON.stringify({
            outputId: "run:run_pattern:1",
            status: "ok",
          }),
        },
        { role: "assistant", content: "The total is 42." },
      ]);

      await expect(readConsoleTurnResult({
        sessionId: "session",
        continuable: true,
        artifactRoot,
        turnId: "turn-without-piece",
        spaceName: "console-test",
      })).resolves.toEqual({
        outcome: "completed",
        sessionId: "session",
        continuable: true,
        looms: [],
        pieces: [],
        spaceName: "console-test",
        finalText: "The total is 42.",
      });
    } finally {
      await Deno.remove(artifactRoot, { recursive: true });
    }
  });

  it("excludes pieces and assistant text inherited from earlier turns", async () => {
    const artifactRoot = await Deno.makeTempDir({
      prefix: "cf-harness-console-result-",
    });
    try {
      await writeTranscript(artifactRoot, "follow-up-turn", [
        { role: "user", content: "build a reading list" },
        {
          role: "tool",
          toolCallId: "old-call",
          toolName: "assign_slug",
          content: JSON.stringify({
            status: "ok",
            slug: "old-piece",
            url: "http://localhost:8000/console-test/old-piece",
          }),
        },
        { role: "assistant", content: "The old piece is ready." },
        { role: "user", content: "calculate the total instead" },
        {
          role: "tool",
          toolCallId: "new-call",
          toolName: "run_pattern",
          content: JSON.stringify({ status: "ok" }),
        },
      ], 4);

      await expect(readConsoleTurnResult({
        sessionId: "session",
        continuable: true,
        artifactRoot,
        turnId: "follow-up-turn",
        spaceName: "console-test",
      })).resolves.toEqual({
        outcome: "completed",
        sessionId: "session",
        continuable: true,
        looms: [],
        pieces: [],
        spaceName: "console-test",
        finalText: "",
      });
    } finally {
      await Deno.remove(artifactRoot, { recursive: true });
    }
  });

  it("ignores run-report timeline entries that are not transcript messages", async () => {
    const artifactRoot = await Deno.makeTempDir({
      prefix: "cf-harness-console-result-",
    });
    try {
      const turnId = "turn-with-other-timeline-entries";
      await writeTranscript(artifactRoot, turnId, [
        { role: "user", content: "calculate the total" },
        { role: "assistant", content: "The total is 42." },
      ]);
      const reportPath = join(artifactRoot, turnId, "run-report.json");
      const report = JSON.parse(await Deno.readTextFile(reportPath));
      report.timeline.unshift({ kind: "tool_activity", status: "ok" });
      await Deno.writeTextFile(reportPath, JSON.stringify(report));

      await expect(readConsoleTurnResult({
        sessionId: "session",
        continuable: true,
        artifactRoot,
        turnId,
        spaceName: "console-test",
      })).resolves.toEqual({
        outcome: "completed",
        sessionId: "session",
        continuable: true,
        looms: [],
        pieces: [],
        spaceName: "console-test",
        finalText: "The total is 42.",
      });
    } finally {
      await Deno.remove(artifactRoot, { recursive: true });
    }
  });

  it("rejects a run report whose generated transcript index is out of bounds", async () => {
    const artifactRoot = await Deno.makeTempDir({
      prefix: "cf-harness-console-result-",
    });
    try {
      const turnId = "turn-with-invalid-index";
      await writeTranscript(artifactRoot, turnId, [
        { role: "user", content: "build a reading list" },
        { role: "assistant", content: "Your reading list is ready." },
      ]);
      await Deno.writeTextFile(
        join(artifactRoot, turnId, "run-report.json"),
        JSON.stringify({
          finalAssistantText: "Your reading list is ready.",
          timeline: [{
            kind: "transcript_message",
            transcriptIndex: 2,
            role: "assistant",
            modelTurn: 1,
          }],
        }),
      );

      await expect(readConsoleTurnResult({
        sessionId: "session",
        continuable: true,
        artifactRoot,
        turnId,
        spaceName: "console-test",
      })).resolves.toBeUndefined();
    } finally {
      await Deno.remove(artifactRoot, { recursive: true });
    }
  });

  it("rejects a run report whose generated transcript index is negative", async () => {
    const artifactRoot = await Deno.makeTempDir({
      prefix: "cf-harness-console-result-",
    });
    try {
      const turnId = "turn-with-negative-index";
      await writeTranscript(artifactRoot, turnId, [
        { role: "user", content: "build a reading list" },
        { role: "assistant", content: "Your reading list is ready." },
      ]);
      await Deno.writeTextFile(
        join(artifactRoot, turnId, "run-report.json"),
        JSON.stringify({
          finalAssistantText: "Your reading list is ready.",
          timeline: [{
            kind: "transcript_message",
            transcriptIndex: -1,
            role: "assistant",
            modelTurn: 1,
          }],
        }),
      );

      await expect(readConsoleTurnResult({
        sessionId: "session",
        continuable: true,
        artifactRoot,
        turnId,
        spaceName: "console-test",
      })).resolves.toBeUndefined();
    } finally {
      await Deno.remove(artifactRoot, { recursive: true });
    }
  });

  it("rejects unsafe run identifiers and malformed transcripts", async () => {
    const artifactRoot = await Deno.makeTempDir({
      prefix: "cf-harness-console-result-",
    });
    try {
      await expect(readConsoleTurnResult({
        sessionId: "session",
        continuable: true,
        artifactRoot,
        turnId: "../another-run",
        spaceName: "console-test",
      })).resolves.toBeUndefined();

      const turnId = "turn-with-malformed-transcript";
      await writeTranscript(artifactRoot, turnId, [
        { role: "user", content: "build a reading list" },
      ]);
      await Deno.writeTextFile(
        join(artifactRoot, turnId, "transcript.json"),
        JSON.stringify([null]),
      );

      await expect(readConsoleTurnResult({
        sessionId: "session",
        continuable: true,
        artifactRoot,
        turnId,
        spaceName: "console-test",
      })).resolves.toBeUndefined();
    } finally {
      await Deno.remove(artifactRoot, { recursive: true });
    }
  });

  it("ignores malformed and unsuccessful `assign_slug` outputs", async () => {
    const artifactRoot = await Deno.makeTempDir({
      prefix: "cf-harness-console-result-",
    });
    try {
      const turnId = "turn-with-invalid-piece-outputs";
      await writeTranscript(artifactRoot, turnId, [
        { role: "user", content: "build a reading list" },
        {
          role: "tool",
          toolCallId: "call-1",
          toolName: "assign_slug",
          content: "not JSON",
        },
        {
          role: "tool",
          toolCallId: "call-2",
          toolName: "assign_slug",
          content: JSON.stringify({ status: "error" }),
        },
        { role: "assistant", content: "I could not name it." },
      ]);

      await expect(readConsoleTurnResult({
        sessionId: "session",
        continuable: true,
        artifactRoot,
        turnId,
        spaceName: "console-test",
      })).resolves.toEqual({
        outcome: "completed",
        sessionId: "session",
        continuable: true,
        looms: [],
        pieces: [],
        spaceName: "console-test",
        finalText: "I could not name it.",
      });
    } finally {
      await Deno.remove(artifactRoot, { recursive: true });
    }
  });
});
