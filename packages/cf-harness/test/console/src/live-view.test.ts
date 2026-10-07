import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { join } from "@std/path";
import { spy } from "@std/testing/mock";
import { FakeTime } from "@std/testing/time";
import { nothing } from "lit";
import {
  ConsoleLive,
  consoleLiveAddress,
  consoleLiveAtTail,
  consoleLiveEntries,
  type ConsoleLiveEntry,
  consoleLivePieceHref,
  consoleLivePolicyMark,
  consoleLiveRunReads,
  consoleLiveState,
  consoleLiveToolLine,
  stepWithheldAnything,
} from "../../../console/src/live-view.ts";
import "../../../console/src/live.ts";
import { readConsoleRun } from "../../../console/run-store.ts";
import type { ConsoleRunDetail } from "../../../console/run-store.ts";
import type {
  ConsoleChatEventEnvelope,
  ConsoleChatStructuredEvent,
} from "../../../console/turn-result.ts";
import type { ConsoleStep } from "../../../console/steps.ts";
import type { BrowserToolAction } from "../../../src/tools/browser.ts";
import {
  HARNESS_CHAT_EVENT_TYPE,
  HARNESS_CHAT_PROTOCOL_VERSION,
} from "../../../src/contracts/interactive-chat.ts";
import { CfHarnessEngine } from "../../../src/engine.ts";
import { HarnessInteractiveChatService } from "../../../src/interactive-chat-service.ts";
import { CfHarnessPromptLoop } from "../../../src/prompt-loop.ts";
import { directPromptSlotBindingFor } from "../../support/prompt-slot-binding.ts";
import { templateText } from "./template-text.ts";

describe("console/src/live-view", () => {
  /** The log a page reads, numbered in the order the events were emitted. */
  const log = (
    ...events: readonly (
      | ConsoleChatStructuredEvent
      | { turnId: string; event: ConsoleChatStructuredEvent }
    )[]
  ): readonly ConsoleChatEventEnvelope[] =>
    events.map((entry, index) => {
      const tagged = "event" in entry
        ? entry
        : { turnId: "turn-1", event: entry };
      return {
        type: HARNESS_CHAT_EVENT_TYPE,
        protocolVersion: HARNESS_CHAT_PROTOCOL_VERSION,
        sessionId: "session-1",
        turnId: tagged.turnId,
        sequence: index + 1,
        emittedAt: "2026-01-01T00:00:00.000Z",
        event: tagged.event,
      };
    });

  /** A turn that ended having named one piece, in the space it built it in. */
  const COMPLETED_WITH_PIECE: ConsoleChatStructuredEvent = {
    kind: "turn_completed",
    turnId: "turn-1",
    result: {
      outcome: "completed" as const,
      sessionId: "session-1",
      continuable: true,
      looms: [],
      pieces: [{
        slug: "reading-list",
        url: "http://localhost:8000/my-space/reading-list",
      }],
      spaceName: "my-space",
      finalText: "built it",
    },
  };

  /** The result a completed turn carries when it named no piece. */
  const EMPTY_RESULT = {
    outcome: "completed" as const,
    sessionId: "session-1",
    continuable: true,
    looms: [],
    pieces: [],
    spaceName: "console-test",
    finalText: "",
  };

  const turnStarted: ConsoleChatStructuredEvent = {
    kind: "turn_started",
    turn: {
      turnId: "turn-1",
      status: "running",
      startedAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    },
  };

  const toolStarted = (
    toolCallId: string,
    toolId: string,
  ): ConsoleChatStructuredEvent => ({
    kind: "tool_started",
    tool: { toolCallId, toolId },
  });

  const toolCompleted = (
    toolCallId: string,
    toolId: string,
    resultSummary?: string,
  ): ConsoleChatStructuredEvent => ({
    kind: "tool_completed",
    tool: { toolCallId, toolId },
    status: "completed",
    ...(resultSummary === undefined ? {} : { resultSummary }),
  });

  const toolEntry = (
    entries: readonly ConsoleLiveEntry[],
    toolCallId: string,
  ): Extract<ConsoleLiveEntry, { kind: "tool" }> => {
    const entry = entries.find((candidate) =>
      candidate.kind === "tool" && candidate.toolCallId === toolCallId
    );
    if (entry === undefined || entry.kind !== "tool") {
      throw new Error(`no tool entry for ${toolCallId}`);
    }
    return entry;
  };

  describe("the page's entry point", () => {
    it("registers the element the live page's markup names", () => {
      // `live.ts` is what the built script runs, and registering the element
      // is the whole of what it does; an unregistered `<console-live>` is an
      // empty pane with no error anywhere.
      expect(customElements.get("console-live")).toBe(ConsoleLive);
    });
  });

  describe("consoleLiveAddress()", () => {
    it("returns the session the live address names", () => {
      expect(consoleLiveAddress("/live/session-1")).toEqual({
        sessionId: "session-1",
      });
    });

    it("returns the session behind the prefix a host fronts the console at", () => {
      // loom's daemon serves the console at /harness-console on its origin;
      // the session is still the last segment.
      expect(consoleLiveAddress("/harness-console/live/session-1")).toEqual({
        sessionId: "session-1",
      });
    });

    it("returns the session named with a trailing slash", () => {
      expect(consoleLiveAddress("/live/session-1/").sessionId).toBe(
        "session-1",
      );
    });

    it("returns the session id an address escaped, decoded", () => {
      expect(consoleLiveAddress("/live/session%2F1").sessionId).toBe(
        "session/1",
      );
    });

    it("returns no session for an escape the address got wrong", () => {
      expect(consoleLiveAddress("/live/session%E0%A4%A")).toEqual({});
    });

    it("returns no session for a path below the session segment", () => {
      expect(consoleLiveAddress("/live/session-1/turn-1")).toEqual({});
    });

    it("returns no session for the console's own page", () => {
      expect(consoleLiveAddress("/")).toEqual({});
    });

    it("returns no session for a live address naming none", () => {
      expect(consoleLiveAddress("/live/")).toEqual({});
    });

    it("returns the turn a focused address names", () => {
      expect(consoleLiveAddress("/live/session-1", "?turn=turn-1")).toEqual({
        sessionId: "session-1",
        turnId: "turn-1",
      });
    });

    it("returns the piece base a host renders pieces at", () => {
      expect(consoleLiveAddress(
        "/live/session-1",
        "?piecesBase=http%3A%2F%2Flocalhost%3A9901%2Fpattern-pane",
      )).toEqual({
        sessionId: "session-1",
        piecesBase: "http://localhost:9901/pattern-pane",
      });
    });

    it("returns a piece base without the trailing slash it was given", () => {
      // The composition adds its own separator, and two would name a path
      // segment that is not there.
      expect(
        consoleLiveAddress(
          "/live/session-1",
          "?piecesBase=https%3A%2F%2Fhost.test%2Fpieces%2F%2F",
        ).piecesBase,
      ).toBe("https://host.test/pieces");
    });

    it("refuses a piece base that could run as script", () => {
      const address = consoleLiveAddress(
        "/live/session-1",
        "?piecesBase=javascript%3Aalert(1)",
      );

      expect(address.piecesBase).toBeUndefined();
      expect(address.piecesBaseRefused).toBe(true);
    });

    it("refuses a piece base that names no host", () => {
      const address = consoleLiveAddress(
        "/live/session-1",
        "?piecesBase=%2Fpattern-pane",
      );

      expect(address.piecesBase).toBeUndefined();
      expect(address.piecesBaseRefused).toBe(true);
    });

    it("refuses a piece base on a scheme a link must not carry", () => {
      expect(
        consoleLiveAddress("/live/session-1", "?piecesBase=file%3A%2F%2F%2Fetc")
          .piecesBase,
      ).toBeUndefined();
    });

    it("returns no refusal for an address naming no piece base at all", () => {
      expect(consoleLiveAddress("/live/session-1").piecesBaseRefused)
        .toBeUndefined();
    });

    it("returns no turn for a `turn` the address left empty", () => {
      expect(consoleLiveAddress("/live/session-1", "?turn=")).toEqual({
        sessionId: "session-1",
      });
    });
  });

  describe("consoleLiveEntries()", () => {
    it("returns one line per tool call however many events it produced", () => {
      const entries = consoleLiveEntries(log(
        turnStarted,
        toolStarted("call-1", "run_pattern"),
        { kind: "tool_progress", toolCallId: "call-1", message: "compiling" },
        toolCompleted("call-1", "run_pattern", '{"status":"ok"}'),
      ));

      expect(entries.filter((entry) => entry.kind === "tool")).toHaveLength(1);
      expect(toolEntry(entries, "call-1").status).toBe("completed");
      expect(toolEntry(entries, "call-1").progress).toBe("compiling");
    });

    it("returns what a turn already under way did, from the replayed log", () => {
      // The whole of the backfill: a pane opened mid-turn reads the durable
      // log from sequence zero, and what it renders is every step that has
      // already happened rather than only the ones that follow.
      const entries = consoleLiveEntries(log(
        turnStarted,
        toolStarted("call-1", "search_patterns"),
        toolCompleted("call-1", "search_patterns"),
        { kind: "assistant_completed", text: "found one" },
        toolStarted("call-2", "run_pattern"),
      ));

      expect(entries.map((entry) => entry.kind)).toEqual([
        "turn",
        "tool",
        "assistant",
        "tool",
      ]);
      expect(toolEntry(entries, "call-2").status).toBe("running");
    });

    it("returns the events out of order in the order they were emitted", () => {
      const [started, tool] = log(turnStarted, toolStarted("call-1", "x"));

      expect(consoleLiveEntries([tool, started]).map((entry) => entry.kind))
        .toEqual(["turn", "tool"]);
    });

    it("returns a line for an event that belongs to no turn", () => {
      const [envelope] = log(toolStarted("call-1", "read_file"));
      const sessionWide = { ...envelope, turnId: undefined };

      expect(toolEntry(consoleLiveEntries([sessionWide]), "call-1").turnId)
        .toBeUndefined();
    });

    it("returns only the turn a focused feed names", () => {
      const entries = consoleLiveEntries(
        log(
          { turnId: "turn-1", event: toolStarted("call-1", "run_pattern") },
          { turnId: "turn-2", event: toolStarted("call-2", "assign_slug") },
        ),
        "turn-2",
      );

      expect(entries).toHaveLength(1);
      expect(toolEntry(entries, "call-2").toolName).toBe("assign_slug");
    });

    it("returns the whole assistant message the completed event settled", () => {
      const entries = consoleLiveEntries(log(
        { kind: "assistant_delta", text: "half a thought" },
        { kind: "assistant_completed", text: "half a thought" },
      ));

      expect(entries).toHaveLength(1);
      expect(entries[0].kind === "assistant" && entries[0].text).toBe(
        "half a thought",
      );
    });

    it("returns the deltas of a message no completed event settled", () => {
      const entries = consoleLiveEntries(log(
        { kind: "assistant_delta", text: "half " },
        { kind: "assistant_delta", text: "a thought" },
      ));

      expect(entries[0].kind === "assistant" && entries[0].text).toBe(
        "half a thought",
      );
    });

    it("returns a completed turn's answer in place of the block it streamed as, when the turn named no piece", () => {
      const entries = consoleLiveEntries(log(
        { kind: "assistant_completed", text: "Bought cfh:v:22222." },
        {
          kind: "turn_completed",
          turnId: "turn-1",
          finalText: "Bought cfh:v:22222.",
          result: {
            outcome: "completed" as const,
            sessionId: "session-1",
            continuable: true,
            looms: [],
            pieces: [],
            spaceName: "s",
            finalText: "Bought **cfh:v:22222**.",
            revealed: { "cfh:v:22222": "https://shop.example/item/7" },
          },
        },
      ));

      expect(entries).toEqual([{
        kind: "ended",
        key: "2",
        turnId: "turn-1",
        status: "completed",
        outcome: "completed",
        answer: "Bought **cfh:v:22222**.",
        revealed: { "cfh:v:22222": "https://shop.example/item/7" },
        pieces: [],
        spaceName: "s",
      }]);
    });

    it("keeps the block a turn streamed when its answer came from finish_task", () => {
      const entries = consoleLiveEntries(log(
        { kind: "assistant_completed", text: "Checking the forecast." },
        {
          kind: "turn_completed",
          turnId: "turn-1",
          finalText: "It is sunny.",
          outcome: "completed",
          answer: "It is sunny.",
          result: {
            ...EMPTY_RESULT,
            outcome: "completed" as const,
            answer: "It is sunny.",
            finalText: "It is sunny.",
          },
        },
      ));

      expect(entries.map((entry) => entry.kind)).toEqual([
        "assistant",
        "ended",
      ]);
      expect(entries[0].kind === "assistant" && entries[0].text).toBe(
        "Checking the forecast.",
      );
      expect(entries[1].kind === "ended" && entries[1].text).toBe(
        "It is sunny.",
      );
    });

    it("returns a model's reasoning as a thought under the subagent it came from", () => {
      const subagent = {
        parentToolCallId: "call-1",
        profile: "browser" as const,
        childRunId: "turn-1.subagent.1",
      };
      const entries = consoleLiveEntries(log(
        { kind: "assistant_reasoning", text: "**Planning** the search." },
        { kind: "assistant_reasoning", text: "Open the form first.", subagent },
      ));

      expect(entries).toEqual([{
        kind: "thought",
        key: "1",
        turnId: "turn-1",
        text: "**Planning** the search.",
      }, {
        kind: "thought",
        key: "2",
        turnId: "turn-1",
        text: "Open the form first.",
        subagent: { parentToolCallId: "call-1", profile: "browser" },
      }]);
    });

    it("returns the piece links a completed turn handed back, with its final text as the answer", () => {
      const entries = consoleLiveEntries(log({
        kind: "turn_completed",
        turnId: "turn-1",
        finalText: "built it",
        result: {
          outcome: "completed" as const,
          sessionId: "session-1",
          continuable: true,
          looms: [],
          pieces: [{ slug: "reading-list", url: "http://localhost:8000/s/r" }],
          spaceName: "s",
          finalText: "built it",
        },
      }));

      expect(entries[0]).toEqual({
        kind: "ended",
        key: "1",
        turnId: "turn-1",
        status: "completed",
        outcome: "completed",
        answer: "built it",
        pieces: [{ slug: "reading-list", url: "http://localhost:8000/s/r" }],
        spaceName: "s",
      });
    });

    it("returns the error a failed turn reported", () => {
      const entries = consoleLiveEntries(log({
        kind: "turn_failed",
        turnId: "turn-1",
        error: { code: "internal_error", message: "the sandbox is down" },
      }));

      expect(entries[0].kind === "ended" && entries[0].text).toBe(
        "the sandbox is down",
      );
    });

    it("returns a line for a call whose start the feed never carried", () => {
      // A pane that resumed mid-call is handed the completion without the
      // start, and the step still belongs in the feed.
      const entries = consoleLiveEntries(log(
        toolCompleted("call-1", "assign_slug", '{"slug":"reading-list"}'),
      ));

      expect(entries).toHaveLength(1);
      expect(toolEntry(entries, "call-1").status).toBe("completed");
      expect(toolEntry(entries, "call-1").resultSummary).toBe(
        '{"slug":"reading-list"}',
      );
    });

    it("returns the reason a canceled turn gave", () => {
      const entries = consoleLiveEntries(log({
        kind: "turn_canceled",
        turnId: "turn-1",
        reason: "the operator stopped it",
      }));

      expect(entries[0]).toEqual({
        kind: "ended",
        key: "1",
        turnId: "turn-1",
        status: "canceled",
        text: "the operator stopped it",
        pieces: [],
      });
    });

    it("returns a canceled turn that gave no reason", () => {
      const entries = consoleLiveEntries(log({
        kind: "turn_canceled",
        turnId: "turn-1",
      }));

      expect(entries[0].kind === "ended" && entries[0].text).toBeUndefined();
    });

    it("returns the child a delegated call belongs to on its lines", () => {
      const subagent = {
        parentToolCallId: "call-1",
        profile: "pattern-author" as const,
        childRunId: "turn-1.subagent.1",
      };
      const entries = consoleLiveEntries(log(
        {
          kind: "tool_started",
          tool: { toolCallId: "call-2", toolId: "x" },
          subagent,
        },
      ));

      expect(toolEntry(entries, "call-2").subagent).toEqual({
        parentToolCallId: "call-1",
        profile: "pattern-author",
      });
    });

    it("ignores an event kind the feed draws nothing for", () => {
      expect(consoleLiveEntries(log({
        kind: "file_changed",
        change: { kind: "create", path: "/workspace/a.tsx" },
      }))).toEqual([]);
    });

    it("returns a subagent line carrying its profile and its verdict", () => {
      const subagent = {
        parentToolCallId: "call-1",
        profile: "pattern-author" as const,
        goal: "write the card",
      };
      const entries = consoleLiveEntries(log(
        { kind: "subagent_started", subagent },
        { kind: "subagent_completed", subagent, status: "failed" },
      ));

      expect(entries).toEqual([{
        kind: "subagent",
        key: "1",
        turnId: "turn-1",
        parentToolCallId: "call-1",
        profile: "pattern-author",
        goal: "write the card",
        status: "failed",
      }]);
    });
  });

  describe("consoleLiveRunReads()", () => {
    it("returns the turn's own run for a call that completed", () => {
      expect(consoleLiveRunReads(
        log(toolCompleted("call-1", "run_pattern"))[0],
      )).toEqual(["turn-1"]);
    });

    it("returns the turn's own run for a turn that completed", () => {
      expect(consoleLiveRunReads(
        log({
          kind: "turn_completed",
          turnId: "turn-1",
          result: EMPTY_RESULT,
        })[0],
      )).toEqual(["turn-1"]);
    });

    it("returns the turn's own run for a turn that failed", () => {
      expect(consoleLiveRunReads(
        log({
          kind: "turn_failed",
          turnId: "turn-1",
          error: { code: "internal_error", message: "down" },
        })[0],
      )).toEqual(["turn-1"]);
    });

    it("returns the child's run beside the turn's for a delegated call", () => {
      // The parent's run does not record what a child called, so the child's
      // own run is what carries the step the feed is about to enrich.
      expect(consoleLiveRunReads(
        log({
          kind: "tool_completed",
          tool: { toolCallId: "call-2", toolId: "run_pattern" },
          status: "completed",
          subagent: {
            parentToolCallId: "call-1",
            profile: "pattern-author",
            childRunId: "turn-1.subagent.1",
          },
        })[0],
      )).toEqual(["turn-1", "turn-1.subagent.1"]);
    });

    it("returns the child's run when the child reported it on completing", () => {
      expect(consoleLiveRunReads(
        log({
          kind: "subagent_completed",
          status: "completed",
          subagent: {
            parentToolCallId: "call-1",
            profile: "pattern-author",
            childRunId: "turn-1.subagent.1",
          },
        })[0],
      )).toEqual(["turn-1.subagent.1"]);
    });

    it("returns no run for a call that only started", () => {
      expect(consoleLiveRunReads(log(toolStarted("call-1", "run_pattern"))[0]))
        .toEqual([]);
    });

    it("returns no run for a child whose delegation named none", () => {
      expect(consoleLiveRunReads(
        log({
          kind: "subagent_completed",
          status: "failed",
          subagent: { parentToolCallId: "call-1", profile: "pattern-author" },
        })[0],
      )).toEqual([]);
    });
  });

  describe("consoleLivePieceHref()", () => {
    const piece = { slug: "reading list", url: "http://localhost:8000/s/r" };

    it("returns the address the run recorded when no base is named", () => {
      expect(consoleLivePieceHref(piece, "my space", undefined)).toBe(
        "http://localhost:8000/s/r",
      );
    });

    it("returns an address under the base a host renders pieces at", () => {
      expect(consoleLivePieceHref(
        piece,
        "my space",
        "http://localhost:9901/pattern-pane",
      )).toBe("http://localhost:9901/pattern-pane/my%20space/reading%20list");
    });

    it("returns the recorded address for a result naming no space", () => {
      // Without the space there is nothing to compose against, and inventing
      // one would send the reader to a piece that is not theirs.
      expect(consoleLivePieceHref(piece, undefined, "http://host.test/p")).toBe(
        "http://localhost:8000/s/r",
      );
    });
  });

  describe("stepWithheldAnything()", () => {
    const step = (
      withheld: ConsoleStep["withheld"],
      policy?: ConsoleStep["policy"],
    ): ConsoleStep => ({
      index: 0,
      kind: "tool",
      toolName: "run_pattern",
      toolCallId: "call-1",
      handlesIntroduced: [],
      handlesInScope: [],
      status: "ok",
      policyEvents: [],
      withheld,
      ...(policy === undefined ? {} : { policy }),
    });

    it("returns `true` for a release the boundary withheld from", () => {
      expect(stepWithheldAnything(step({
        status: "unrecorded",
        locations: [],
      }, {
        decision: "withheld",
        reasonCodes: ["cfc_release_withheld"],
      }))).toBe(true);
    });

    it("returns `true` for a result whose record holds a withheld position", () => {
      expect(stepWithheldAnything(step({
        status: "recorded",
        locations: [{
          rule: "artifact-only",
          artifactPath: "/run/output.json",
          jsonPointer: "/rawValue",
          available: true,
        }],
      }))).toBe(true);
    });

    it("returns `true` for a record the console could not read", () => {
      expect(stepWithheldAnything(step({
        status: "record-unreadable",
        locations: [],
      }))).toBe(true);
    });

    it("returns `true` for a record holding no entry for this result", () => {
      expect(stepWithheldAnything(step({
        status: "record-entry-missing",
        locations: [],
      }))).toBe(true);
    });

    it("returns `false` for a result no omission rule applied to", () => {
      // A narrow pane marks what was held back, not every result that
      // recorded holding nothing back.
      expect(stepWithheldAnything(step({ status: "recorded", locations: [] })))
        .toBe(false);
    });
  });

  describe("consoleLiveAtTail()", () => {
    it("returns `true` for a feed scrolled to its bottom", () => {
      expect(consoleLiveAtTail({
        scrollHeight: 1000,
        scrollTop: 700,
        clientHeight: 300,
      })).toBe(true);
    });

    it("returns `true` for a feed a row's rounding short of its bottom", () => {
      expect(consoleLiveAtTail({
        scrollHeight: 1000,
        scrollTop: 693,
        clientHeight: 300,
      })).toBe(true);
    });

    it("returns `false` for a reader who scrolled up to an earlier step", () => {
      expect(consoleLiveAtTail({
        scrollHeight: 1000,
        scrollTop: 200,
        clientHeight: 300,
      })).toBe(false);
    });
  });

  describe("consoleLivePolicyMark()", () => {
    const step = (
      policy: ConsoleStep["policy"],
      withheld: ConsoleStep["withheld"] = {
        status: "recorded",
        locations: [],
      },
    ): ConsoleStep => ({
      index: 0,
      kind: "tool",
      toolName: "browser",
      toolCallId: "call-1",
      handlesIntroduced: [],
      handlesInScope: [],
      status: "ok",
      ...(policy === undefined ? {} : { policy }),
      policyEvents: [],
      withheld,
    });

    it("returns a quiet shield, and no word, for an allowance that held nothing back", () => {
      const text = templateText(consoleLivePolicyMark(step({
        decision: "allowed",
        effectClass: "side-effect",
        reasonCodes: ["cfc_enforce_strict_direct_command"],
      })));

      expect(text).toContain("live-policy ok");
      expect(text).toContain('<span class="live-spoken">Allowed</span>');
      expect(text).not.toContain('<span aria-hidden="true">');
    });

    it("returns a shield saying blocked for a denial", () => {
      const text = templateText(consoleLivePolicyMark(step({
        decision: "denied",
        reasonCodes: ["cfc_handle_destination_not_allowed"],
      })));

      expect(text).toContain("live-policy bad");
      expect(text).toContain('<span aria-hidden="true">blocked</span>');
    });

    it("returns a shield saying withheld for an allowance that held something back", () => {
      const text = templateText(consoleLivePolicyMark(step(
        { decision: "allowed", reasonCodes: [] },
        {
          status: "record-unreadable",
          locations: [],
        },
      )));

      expect(text).toContain("live-policy warn");
      expect(text).toContain('<span aria-hidden="true">withheld</span>');
      expect(text).toContain(
        '<span class="live-spoken">Partly withheld</span>',
      );
    });

    it("returns a shield saying flagged for a warning on an allowance", () => {
      const text = templateText(consoleLivePolicyMark({
        ...step({ decision: "allowed", reasonCodes: [] }),
        policyEvents: [{
          type: "cf-harness.policy-event",
          severity: "warning",
          mode: "observe",
          toolId: "browser",
          detail: "observed",
          at: "2026-01-01T00:00:00.000Z",
        }],
      }));

      expect(text).toContain("live-policy warn");
      expect(text).toContain('<span aria-hidden="true">warning</span>');
      expect(text).toContain(
        '<span class="live-spoken">Allowed with a warning</span>',
      );
      expect(text).not.toContain("withheld");
    });

    it("returns a shield saying the decision for one that is neither an allowance nor a denial", () => {
      const text = templateText(consoleLivePolicyMark(step({
        decision: "invalid",
        reasonCodes: [],
      })));

      expect(text).toContain("live-policy warn");
      expect(text).toContain('<span aria-hidden="true">invalid</span>');
      expect(text).toContain('<span class="live-spoken">Invalid</span>');
    });

    it("returns a quiet shield for a step CFC only labeled the inputs of", () => {
      const text = templateText(consoleLivePolicyMark({
        ...step(undefined),
        invocation: {
          type: "cf-harness.cfc-invocation-context",
          version: 1,
          sequence: 1,
          runId: "r",
          createdAt: "2026-01-01T00:00:00.000Z",
          toolId: "browser",
          operation: "shell",
          cfcEnforcementMode: "enforce-explicit",
          cwd: "/workspace",
          runManifest: { present: false },
          inputs: {},
          cfcInputLabels: {
            version: 1,
            entries: [{
              path: ["url"],
              label: {
                confidentiality: [{
                  type: "test.cfc/ObservedOutput",
                  subject: "did:key:observed",
                }],
              },
            }],
          },
        },
      }));

      expect(text).toContain("live-policy ok");
      expect(text).toContain('<span class="live-spoken">Recorded</span>');
    });

    it("returns nothing for a step CFC recorded nothing about", () => {
      expect(consoleLivePolicyMark(step(undefined))).toBe(nothing);
    });
  });

  describe("consoleLiveState()", () => {
    it("returns `connecting` for a feed with no events yet", () => {
      expect(consoleLiveState([])).toBe("connecting");
    });

    it("returns `working` for a turn that has started and called nothing", () => {
      expect(consoleLiveState(consoleLiveEntries(log(turnStarted)))).toBe(
        "working",
      );
    });

    it("returns the name of the tool a turn is running", () => {
      expect(consoleLiveState(consoleLiveEntries(log(
        turnStarted,
        toolStarted("call-1", "run_pattern"),
      )))).toBe("run pattern");
    });

    it("returns `working` between one call finishing and the next starting", () => {
      expect(consoleLiveState(consoleLiveEntries(log(
        turnStarted,
        toolStarted("call-1", "run_pattern"),
        toolCompleted("call-1", "run_pattern"),
      )))).toBe("working");
    });

    it("returns `done` for a turn that completed", () => {
      expect(consoleLiveState(consoleLiveEntries(log(
        turnStarted,
        { kind: "turn_completed", turnId: "turn-1", result: EMPTY_RESULT },
      )))).toBe("done");
    });

    it("returns `failed` for a turn that failed", () => {
      expect(consoleLiveState(consoleLiveEntries(log(
        turnStarted,
        {
          kind: "turn_failed",
          turnId: "turn-1",
          error: { code: "internal_error", message: "the sandbox is down" },
        },
      )))).toBe("failed");
    });

    it("returns the focused turn's state while a sibling turn runs", () => {
      // The header is read off the feed, which the address has already
      // narrowed, so a second turn's progress cannot be reported as this
      // pane's.
      const envelopes = log(
        { turnId: "turn-1", event: turnStarted },
        {
          turnId: "turn-1",
          event: {
            kind: "turn_completed",
            turnId: "turn-1",
            result: EMPTY_RESULT,
          },
        },
        { turnId: "turn-2", event: toolStarted("call-2", "run_pattern") },
      );

      expect(consoleLiveState(consoleLiveEntries(envelopes, "turn-1"))).toBe(
        "done",
      );
      expect(consoleLiveState(consoleLiveEntries(envelopes))).toBe(
        "run pattern",
      );
    });
  });

  describe("consoleLiveToolLine()", () => {
    /**
     * The text of the line `consoleLiveToolLine()` returns, the tool's name in
     * angle brackets and each reference bracketed with what it names:
     * `<Run pattern> attempt 1`, `Click [ref an element of the page]`, `Click [link “Buy”]`.
     */
    const lineText = (
      ...args: Parameters<typeof consoleLiveToolLine>
    ): string =>
      consoleLiveToolLine(...args).map((part) =>
        part.kind === "words"
          ? part.text
          : part.kind === "tool"
          ? `<${part.text}>`
          : part.kind === "element"
          ? `[“${part.text}” from ${part.source}]`
          : `[${part.kind} ${part.text}]`
      ).join("");

    const entry = (
      toolCallId: string,
      toolName: string,
      resultSummary?: string,
    ): Extract<ConsoleLiveEntry, { kind: "tool" }> => ({
      kind: "tool",
      key: "1",
      turnId: "turn-1",
      toolCallId,
      toolName,
      status: "completed",
      ...(resultSummary === undefined ? {} : { resultSummary }),
    });

    /** A run that has read nothing but `lens`, holding no steps or handles. */
    const detail = (
      lens: Partial<ConsoleRunDetail["lens"]>,
    ): ConsoleRunDetail => {
      const read: Partial<ConsoleRunDetail> = {
        lens: {
          patternAttempts: [],
          searches: [],
          feedback: [],
          pieces: [],
          ...lens,
        },
        steps: [],
        handles: [],
        revealed: {},
        sites: {},
        hidden: [],
      };
      return read as ConsoleRunDetail;
    };

    /** A step in which `toolName` was called with `input`. */
    const toolStep = (
      toolName: string,
      input: Record<string, unknown>,
    ): ConsoleStep => ({
      index: 0,
      kind: "tool",
      toolName,
      toolCallId: "call-1",
      input,
      handlesIntroduced: [],
      handlesInScope: [],
      status: "ok",
      policyEvents: [],
      withheld: { status: "unrecorded", locations: [] },
    });

    /** The line a `browser` call given `input` reads as. */
    const browserLineFor = (input: Record<string, unknown>) =>
      lineText(
        entry("call-1", "browser"),
        undefined,
        toolStep("browser", input),
      );

    it("returns the numbered attempt and the compiler's word for `run_pattern`", () => {
      expect(lineText(
        entry("call-2", "run_pattern"),
        detail({
          patternAttempts: [
            { toolCallId: "call-1", inputNames: [], status: "error" },
            {
              toolCallId: "call-2",
              inputNames: [],
              status: "error",
              message: "Type\n  mismatch",
            },
          ],
        }),
        undefined,
      )).toBe("<Run pattern> attempt 2 · error: Type mismatch");
    });

    it("returns the slug `assign_slug` registered", () => {
      expect(lineText(
        entry("call-1", "assign_slug"),
        detail({
          pieces: [{
            toolCallId: "call-1",
            slug: "reading-list",
            url: "http://localhost:8000/s/reading-list",
          }],
        }),
        undefined,
      )).toBe("<Assign slug> reading-list");
    });

    it("returns the slug from the result of a call the run has not been read for", () => {
      expect(lineText(
        entry("call-1", "assign_slug", '{"slug":"reading-list"}'),
        undefined,
        undefined,
      )).toBe("<Assign slug> reading-list");
    });

    it("returns only the tool's name for a result the tool did not write as JSON", () => {
      expect(lineText(
        entry("call-1", "assign_slug", "the slug is reading-list"),
        undefined,
        undefined,
      )).toBe("<Assign slug>");
    });

    it("returns the query `search_patterns` was given", () => {
      expect(lineText(
        entry("call-1", "search_patterns"),
        detail({
          searches: [{ toolCallId: "call-1", query: "reading list", hits: [] }],
        }),
        undefined,
      )).toBe("<Search patterns> reading list");
    });

    it("returns the question `query_docs` asked, from the step's own input", () => {
      const step = toolStep("query_docs", {
        question: "how does\na handler write?",
      });

      expect(
        lineText(entry("call-1", "query_docs"), undefined, step),
      )
        .toBe("<Query docs> how does a handler write?");
    });

    it("returns the Common Fabric task `research` investigated", () => {
      const step = toolStep("research", {
        task: "compose a checklist\nwith a cost total",
      });

      expect(
        lineText(entry("call-1", "research"), undefined, step),
      ).toBe("<Research> compose a checklist with a cost total");
    });

    it("returns what each `browser` action did and what it acted on", () => {
      const lines = {
        open: [{ url: "https://example.com/" }, "Open https://example.com/"],
        back: [{}, "Go back"],
        forward: [{}, "Go forward"],
        reload: [{}, "Reload the page"],
        scroll: [
          { direction: "up", ref: "@e4" },
          "Scroll up within [ref an element of the page]",
        ],
        snapshot: [
          { interactive: true },
          "Look over the page and the controls on it",
        ],
        get: [
          { kind: "text", target: "main" },
          "Read the text of the part of the page matching main",
        ],
        console: [{}, "Read the messages the page logged"],
        errors: [{}, "Read the errors the page reported"],
        screenshot: [{}, "Take a screenshot"],
        wait: [{ ms: 0 }, "Wait 0 ms"],
        click: [{ x: 0, y: 340 }, "Click at 0, 340 on the screenshot"],
        check: [{ ref: "@e6" }, "Check [ref an element of the page]"],
        fill: [
          { ref: "@e3", value: "Ada" },
          'Fill [ref an element of the page] with "Ada"',
        ],
        type: [
          { ref: "@e3", value: 'say "cat\nfood"' },
          'Type "say \\"cat food\\"" into [ref an element of the page]',
        ],
        select: [
          { ref: "@e7", value: "Large" },
          'Choose "Large" in [ref an element of the page]',
        ],
        press: [{ key: "Enter" }, "Press Enter"],
        handoff: [
          { reason: "sign-in" },
          "Hand the page to you to sign in",
        ],
      } satisfies Record<
        BrowserToolAction,
        readonly [Record<string, unknown>, string]
      >;

      for (const [action, [input, line]] of Object.entries(lines)) {
        expect(browserLineFor({ action, ...input })).toBe(line);
      }
    });

    it("returns a `browser` line naming only the arguments the call set", () => {
      expect(browserLineFor({ action: "scroll", direction: "down" }))
        .toBe("Scroll down");
      expect(browserLineFor({ action: "snapshot" })).toBe("Look over the page");
      expect(browserLineFor({ action: "get", kind: "title" })).toBe(
        "Read the page's title",
      );
      expect(browserLineFor({ action: "wait", loadState: "load" }))
        .toBe("Wait for the page to load");
      expect(browserLineFor({ action: "wait", urlPattern: "**/done" }))
        .toBe("Wait for the address to match **/done");
      expect(browserLineFor({ action: "wait", ref: "@e2" }))
        .toBe("Wait for [ref an element of the page]");
      expect(browserLineFor({ action: "click", ref: "@e5" })).toBe(
        "Click [ref an element of the page]",
      );
      expect(browserLineFor({ action: "handoff" }))
        .toBe("Hand the page to you");
    });

    it("returns an empty `browser` value quoted rather than left out", () => {
      expect(browserLineFor({ action: "fill", ref: "@e3", value: "" }))
        .toBe('Fill [ref an element of the page] with ""');
    });

    it("returns the handle a `browser` call bound in place of the value", () => {
      expect(
        browserLineFor({
          action: "type",
          ref: "@e3",
          valueHandle: "cfh:a:q2345",
        }),
      ).toBe("Type [address a stored item] into [ref an element of the page]");
      expect(browserLineFor({ action: "open", urlHandle: "cfh:v:p3n8w" }))
        .toBe("Open [unseen a value another agent found]");
    });

    it("returns the action of a `browser` call the tool does not define", () => {
      expect(browserLineFor({ action: "teleport", url: "https://a.test/" }))
        .toBe("teleport");
    });

    it("returns only the tool's name for a `browser` call that names no action", () => {
      expect(browserLineFor({ url: "https://example.com/" })).toBe("<Browser>");
    });

    it("returns a `browser` line elided to the width a line has for it", () => {
      const line = browserLineFor({ action: "type", value: "w".repeat(400) });

      expect(line).toHaveLength(140);
      expect(line.startsWith('Type "www')).toBe(true);
      expect(line.endsWith("…")).toBe(true);
    });

    it("returns only the tool's name for a `browser` call whose run has not been read", () => {
      expect(
        lineText(entry("call-1", "browser"), undefined, undefined),
      ).toBe("<Browser>");
    });

    it("returns the element a `browser` ref names, as the last snapshot before it described it", () => {
      const snapshot = (
        index: number,
        output: string,
        page?: { url: string; title: string },
      ): ConsoleStep => ({
        ...toolStep("browser", { action: "snapshot", interactive: true }),
        index,
        output: {
          status: "ok",
          outputId: `o${index}`,
          output,
          ...(page === undefined ? {} : { page }),
        },
      });
      const click = toolStep("browser", { action: "click", ref: "@e3" });
      const at = (steps: readonly ConsoleStep[], index: number) =>
        lineText(
          entry("call-1", "browser"),
          { ...detail({}), steps },
          { ...click, index },
        );
      const older = snapshot(0, '- button "Old" [@e3 at 0,0 10x10]');
      const newer = snapshot(
        1,
        [
          '- heading "Shop" [level 1]',
          '  - combobox "Search \\"cats\\"" [@e2 at 1,2 3x4] autocomplete=off',
          '  - button "Buy now" [@e3 at 5,6 7x8]',
        ].join("\n"),
      );

      expect(at([older, newer], 2)).toBe(
        "Click [“Buy now” from the page] button",
      );
      expect(at([older, newer], 1)).toBe("Click [“Old” from the page] button");
      expect(at([older, newer], 2)).toBe(
        "Click [“Buy now” from the page] button",
      );
      expect(at([snapshot(0, '- button "bad \\q escape" [@e3]')], 1))
        .toBe("Click [ref an element of the page]");
      expect(
        at([
          snapshot(0, '- button "Pay" [@e3]', {
            url: "not an address",
            title: "Cart",
          }),
        ], 1),
      ).toBe("Click [“Pay” from the page] button");
      expect(at([snapshot(0, '- textbox "Name" [ref=e3]')], 1)).toBe(
        "Click [“Name” from the page] text field",
      );
      expect(
        at([
          snapshot(0, '- link "Pay” button, then “Cancel" [@e3]', {
            url: "https://shop.test/cart",
            title: "Cart",
          }),
        ], 1),
      ).toBe("Click [“Pay” button, then “Cancel” from shop.test] link");
      expect(at([snapshot(0, '- button "Other" [@e9 at 0,0 1x1]')], 1))
        .toBe("Click [ref an element of the page]");
      expect(at([snapshot(0, '- textbox "Q" value="[ref=e3]" [@e9]')], 1))
        .toBe("Click [ref an element of the page]");
      expect(at([snapshot(0, '- button "Pay cfh:v:q2345" [@e3]')], 1))
        .toBe("Click [ref an element of the page]");
      expect(at([], 0)).toBe("Click [ref an element of the page]");
    });

    it("returns a handle as what it stands for, as far as the run that holds it says", () => {
      const holding: ConsoleRunDetail = {
        ...detail({}),
        revealed: { "cfh:v:q2345": "12 Main St" },
        hidden: ["cfh:v:m2345"],
        handles: [{
          token: "cfh:a:k2345",
          slug: "delivery-addresses",
          introducedAtStep: 0,
          uses: [],
          confidentiality: [],
        }],
      };

      expect(lineText(
        entry("call-1", "browser"),
        holding,
        toolStep("browser", {
          action: "type",
          ref: "@e3",
          valueHandle: "cfh:v:q2345",
        }),
      )).toBe("Type [unseen 12 Main St] into [ref an element of the page]");
      expect(lineText(
        entry("call-1", "research"),
        holding,
        toolStep("research", {
          task:
            "save cfh:v:q2345 and cfh:v:m2345 to cfh:a:k2345 and cfh:a:m2345",
        }),
      )).toBe(
        "<Research> save [unseen 12 Main St] and [unseen a value hidden from this view] to [address delivery-addresses] and [address a stored item]",
      );
    });

    it("returns a found value with its control and direction characters written as escapes", () => {
      expect(lineText(
        entry("call-1", "research"),
        { ...detail({}), revealed: { "cfh:v:q2345": "pay\u202Eedoc" } },
        toolStep("research", { task: "use cfh:v:q2345" }),
      )).toBe("<Research> use [unseen pay\\u{202E}edoc]");
    });

    it("returns a `browser` read's target as a reference when it is a ref", () => {
      expect(browserLineFor({ action: "get", kind: "text", target: "@e9" }))
        .toBe("Read the text of [ref an element of the page]");
      expect(browserLineFor({ action: "get", kind: "text", target: "main" }))
        .toBe("Read the text of the part of the page matching main");
    });

    it("returns a value a `browser` call wrote out as words, whatever it reads as", () => {
      expect(browserLineFor({ action: "type", value: "cfh:v:q2345" }))
        .toBe('Type "cfh:v:q2345"');
    });

    it("returns the handles in another tool's subject as references", () => {
      expect(lineText(
        entry("call-1", "research"),
        undefined,
        toolStep("research", {
          task: "summarize cfh:a:k2345 and (cfh:v:p3n8w).",
        }),
      )).toBe(
        "<Research> summarize [address a stored item] and ([unseen a value another agent found]).",
      );
    });

    it("returns a line cut before a reference that would not fit whole", () => {
      expect(lineText(
        entry("call-1", "research"),
        undefined,
        toolStep("research", { task: `${"w".repeat(120)} cfh:v:q2345` }),
      )).toBe(`<Research> ${"w".repeat(120)}…`);
    });

    it("returns a line whose reference ends at the width a line has", () => {
      expect(lineText(
        entry("call-1", "research"),
        undefined,
        toolStep("research", { task: `${"w".repeat(103)} cfh:v:q2345` }),
      )).toBe(
        `<Research> ${"w".repeat(103)} [unseen a value another agent found]`,
      );
    });

    it("returns only the tool's name for a search whose run holds no record of it", () => {
      expect(lineText(
        entry("call-1", "search_patterns"),
        detail({ searches: [] }),
        undefined,
      )).toBe("<Search patterns>");
    });

    it("returns only the tool's name for a naming whose result never reached the pane", () => {
      expect(
        lineText(
          entry("call-1", "assign_slug"),
          undefined,
          undefined,
        ),
      )
        .toBe("<Assign slug>");
    });

    it("returns a question elided to the width a line has for it", () => {
      const step = toolStep("query_docs", { question: "w".repeat(400) });
      const line = consoleLiveToolLine(
        entry("call-1", "query_docs"),
        undefined,
        step,
      ).map((part) => part.text).join("");

      expect(line).toHaveLength(140);
      expect(line.endsWith("…")).toBe(true);
    });

    it("returns only the tool's name for a call nothing has been read about yet", () => {
      expect(
        lineText(entry("call-1", "read_file"), undefined, undefined),
      ).toBe("<Read file>");
    });
  });

  describe("ConsoleLive", () => {
    // The pane reaches the page through three Web APIs — the address it was
    // opened at, the event stream, and the fetch its run reads go out on.
    // Each block below stands one of them up so the lifecycle can be driven
    // without a browser; what a browser is still needed for is the rendered
    // DOM, which `updated()` and the scroll handler touch.

    class TestConsoleLive extends ConsoleLive {
      #detailWrites = 0;
      #waiting: { target: number; resolve: () => void }[] = [];

      view() {
        return this.render();
      }

      /**
       * A connected pane schedules updates, and committing one needs a DOM to
       * write into. These tests render by calling `view()` themselves, so the
       * scheduled commit is dropped rather than run against nothing.
       */
      protected override performUpdate(): void {}

      /** Runs what Lit runs once a commit has landed. */
      commit() {
        this.updated();
      }

      /** Hands the reader's scrolling to the feed's own handler. */
      readerScrolled(feed: FakeFeed) {
        this.#scrollHandler()({ target: feed } as unknown as Event);
      }

      /**
       * The feed's `@scroll` binding, out of the template it is written in.
       * The handler is private and reachable only from the markup, which is
       * where the pane wires it, so the test takes the same route the browser
       * does rather than a seam opened for it.
       */
      #scrollHandler(): (event: Event) => void {
        const handlers = (this.view().values ?? []).filter((value) =>
          typeof value === "function"
        );
        expect(handlers).toHaveLength(1);
        return handlers[0] as (event: Event) => void;
      }

      /**
       * Resolves once `count` run reads have written their detail onto the
       * pane. A read is started by an event and finishes on its own, so the
       * test waits on the write itself rather than on a clock.
       */
      detailsWritten(count: number): Promise<void> {
        if (this.#detailWrites >= count) {
          return Promise.resolve();
        }
        return new Promise((resolve) => {
          this.#waiting.push({ target: count, resolve });
        });
      }

      override requestUpdate(
        name?: PropertyKey,
        oldValue?: unknown,
        options?: never,
      ): void {
        super.requestUpdate(name, oldValue, options);
        // The base constructor writes `details` before this subclass's own
        // fields are installed, and that write is not one a test waits on.
        if (name !== "details" || !(#detailWrites in this)) {
          return;
        }
        this.#detailWrites += 1;
        this.#waiting = this.#waiting.filter((waiter) => {
          if (this.#detailWrites < waiter.target) {
            return true;
          }
          waiter.resolve();
          return false;
        });
      }
    }

    /**
     * A run on disk, read back the way the live pane reads one. Going through
     * the store is what makes the join real: the transcript is what the steps
     * are built from, and the tool call id is what ties a step to the line the
     * stream already put in the feed.
     */
    const runDetail = async (): Promise<ConsoleRunDetail> => {
      const artifactRoot = await Deno.makeTempDir({
        prefix: "cf-harness-console-live-",
      });
      try {
        const root = join(artifactRoot, "turn-1");
        await Deno.mkdir(root, { recursive: true });
        await Deno.writeTextFile(
          join(root, "transcript.json"),
          JSON.stringify([
            {
              role: "assistant",
              content: "",
              toolCalls: [{
                id: "call-1",
                type: "function",
                function: {
                  name: "run_pattern",
                  arguments: JSON.stringify({ sourceText: "the pattern" }),
                },
              }],
            },
            {
              role: "tool",
              toolCallId: "call-1",
              toolName: "run_pattern",
              content: JSON.stringify({ status: "ok" }),
            },
          ]),
        );
        await Deno.writeTextFile(
          join(root, "run-state.json"),
          JSON.stringify({
            runId: "turn-1",
            status: "running",
            createdAt: "2026-01-01T00:00:00.000Z",
            updatedAt: "2026-01-01T00:00:01.000Z",
            cfcEnforcementMode: "enforce-explicit",
            currentDir: "/workspace",
            toolOutputs: [],
            policyEvents: [],
            policyDecisions: [{
              type: "cf-harness.policy-decision",
              sequence: 1,
              runId: "turn-1",
              at: "2026-01-01T00:00:01.000Z",
              toolActivitySequence: 1,
              toolCallId: "call-1",
              toolId: "run_pattern",
              cfcEnforcementMode: "enforce-explicit",
              decision: "denied",
              reasonCodes: ["cfc_release_withheld"],
              release: {
                reasonCode: "cfc_release_withheld",
                boundary: "release",
                sink: "run_pattern",
                ceiling: [],
              },
            }],
          }),
        );
        const detail = await readConsoleRun(artifactRoot, "turn-1");
        if (detail === undefined) {
          throw new Error("the written run was not readable");
        }
        return detail;
      } finally {
        await Deno.remove(artifactRoot, { recursive: true });
      }
    };

    /** One `EventSource` the test drives instead of a server. */
    class FakeEventSource {
      static readonly CLOSED = 2;
      static opened: FakeEventSource[] = [];
      readyState = 0;
      closed = false;
      readonly listeners = new Map<string, (event: unknown) => void>();

      constructor(readonly url: string) {
        FakeEventSource.opened.push(this);
      }

      addEventListener(kind: string, listener: (event: unknown) => void) {
        this.listeners.set(kind, listener);
      }

      close() {
        this.closed = true;
      }

      /** Delivers one envelope the way the server's `chat` frame does. */
      deliver(envelope: ConsoleChatEventEnvelope) {
        this.listeners.get("chat")?.({ data: JSON.stringify(envelope) });
      }

      fail(readyState: number) {
        this.readyState = readyState;
        this.listeners.get("error")?.({});
      }
    }

    /** Stands up the address, the stream and the fetch, and takes them down. */
    const paneAt = (
      pathname: string,
      search = "",
      runs: Record<string, unknown> = {},
    ): { view: TestConsoleLive; stop: () => void } => {
      const realEventSource = globalThis.EventSource;
      const realFetch = globalThis.fetch;
      const realLocation = Object.getOwnPropertyDescriptor(
        globalThis,
        "location",
      );
      FakeEventSource.opened = [];
      Object.defineProperty(globalThis, "location", {
        value: { pathname, search },
        configurable: true,
      });
      // deno-lint-ignore no-explicit-any
      globalThis.EventSource = FakeEventSource as any;
      globalThis.fetch = (input: string | URL | Request) => {
        const runId = String(input).replace("/api/runs/", "");
        const held = runs[runId];
        return Promise.resolve(
          held === undefined
            ? new Response("not found", { status: 404 })
            : Response.json(held),
        );
      };
      const view = new TestConsoleLive();
      view.connectedCallback();
      return {
        view,
        stop: () => {
          view.disconnectedCallback();
          globalThis.EventSource = realEventSource;
          globalThis.fetch = realFetch;
          if (realLocation === undefined) {
            Reflect.deleteProperty(globalThis, "location");
          } else {
            Object.defineProperty(globalThis, "location", realLocation);
          }
        },
      };
    };

    /** A scroller, as much of one as the pane reads and writes. */
    class FakeFeed {
      scrolledTo: number | undefined;

      constructor(
        readonly scrollHeight: number,
        public scrollTop: number,
        readonly clientHeight: number,
      ) {}

      scrollTo(options: { top: number }) {
        this.scrolledTo = options.top;
      }
    }

    /** A pane whose feed element is the one handed in. */
    const paneShowing = (feed: FakeFeed): TestConsoleLive => {
      const view = new TestConsoleLive();
      Object.defineProperty(view, "querySelector", { value: () => feed });
      return view;
    };

    for (
      const ending of [
        "completed",
        "failed",
        "canceled",
        "delivery_failed",
      ] as const
    ) {
      const description = ending === "delivery_failed"
        ? "preserves completed research when event delivery fails"
        : `shows opening research until it is ${ending}`;
      it(description, async () => {
        using time = new FakeTime("2026-01-01T00:00:00.000Z");
        const { view, stop } = paneAt("/live/session-1");
        using updates = spy(view, "requestUpdate");
        const researching = Promise.withResolvers<void>();
        const finishResearch = Promise.withResolvers<void>();
        const modelRuns: string[] = [];
        const deliveryFailure = new Error("live event delivery failed");
        const deliveryErrors: unknown[] = [];
        const engine = new CfHarnessEngine({
          runId: "turn-1",
          model: "gpt-test",
          sandboxRuntime: {
            describe: () => ({
              kind: "docker-runsc-cfc",
              defaultWorkingDirectory: "/workspace",
              cfc: {
                runtimeRequested: true,
                workspaceMountPath: "/workspace",
              },
            }),
            resolvePath: (path) => path,
            isPathWithinWorkspace: () => true,
            isPathWithinAllowedRoots: () => true,
            defaultWorkingDirectory: () => "/workspace",
            run: () => Promise.reject(new Error("unexpected sandbox command")),
            runShell: () =>
              Promise.reject(new Error("unexpected sandbox command")),
          },
        });
        const service = new HarnessInteractiveChatService({
          basePromptLoopOptions: {
            engine,
            modelClient: {
              providerId: "test",
              complete: async (request) => {
                modelRuns.push(request.runId);
                if (request.runId.includes(":research:")) {
                  researching.resolve();
                  await finishResearch.promise;
                  if (ending === "failed") {
                    throw new Error("research unavailable");
                  }
                  return {
                    assistant: {
                      role: "assistant",
                      content: JSON.stringify({
                        status: "incomplete",
                        summary: "More evidence is needed.",
                        inputs: [],
                        selectedPatternIds: [],
                        leads: [],
                        questions: [],
                        rules: [],
                        sourceIds: [],
                        missing: ["the counter contract"],
                      }),
                    },
                  };
                }
                return { assistant: { role: "assistant", content: "Done." } };
              },
            },
          },
          createPromptLoop: (options) => new CfHarnessPromptLoop(options),
          onEvent: (envelope) => {
            const event = envelope.event;
            if (event.kind !== "turn_completed") {
              FakeEventSource.opened.at(-1)!.deliver({ ...envelope, event });
            }
            if (
              ending === "delivery_failed" && event.kind === "tool_completed" &&
              event.status === "completed"
            ) throw deliveryFailure;
          },
          onEventDeliveryError: (_event, error) => {
            deliveryErrors.push(error);
          },
        });
        try {
          await service.startSession("start", {
            sessionId: "session-1",
            workspace: { hostPath: "/workspace" },
            policy: {
              type: "cf-harness.chat-policy",
              toolMode: "workspace-write",
              allowedToolIds: ["research"],
              allowedSubagentProfiles: [],
              promptSlot: directPromptSlotBindingFor("live-opening-research"),
            },
          });
          await service.startTurn("task", {
            sessionId: "session-1",
            turnId: "turn-1",
            input: { text: "Build a counter." },
          });
          await Promise.race([
            researching.promise,
            service.waitForTurn("session-1", "turn-1").then(() => {
              throw new Error(
                `turn ended before the research model ran: ${
                  JSON.stringify(service.events("session-1").at(-1)?.event)
                }`,
              );
            }),
          ]);
          expect(modelRuns).toHaveLength(1);
          expect(templateText(view.view())).toContain(
            "Orienting: working out what is already available",
          );
          expect(toolEntry(view.entries, "opening-research:turn-1").status)
            .toBe(
              "running",
            );
          view.readerScrolled(new FakeFeed(1000, 200, 300));
          view.commit();
          const pendingUpdates = updates.calls.length;
          time.tick(2000);
          expect(updates.calls.length).toBeGreaterThan(pendingUpdates);
          expect(templateText(view.view())).toContain("<span>2s</span>");

          view.disconnectedCallback();
          const disconnectedUpdates = updates.calls.length;
          time.tick(1000);
          expect(updates.calls).toHaveLength(disconnectedUpdates);
          // The headless pane skips DOM commits; a committed pane has no
          // pending render when it is attached again.
          view.isUpdatePending = false;
          view.connectedCallback();
          expect(view.isUpdatePending).toBe(true);
          view.commit();
          if (ending === "canceled") {
            await service.cancelTurn(
              "cancel",
              "session-1",
              "turn-1",
              "user_requested",
            );
          }
          finishResearch.resolve();
          await service.waitForTurn("session-1", "turn-1");
          if (ending === "delivery_failed") {
            expect(engine.getRunState().openingResearch).toMatchObject({
              status: "completed",
              outputId: expect.any(String),
              handoffMessage: expect.any(String),
            });
            expect(modelRuns).toHaveLength(1);
            expect(service.events("session-1").at(-1)?.event).toMatchObject({
              kind: "turn_failed",
              error: { message: deliveryFailure.message },
            });
          }
          expect(deliveryErrors).toEqual(
            ending === "delivery_failed" ? [deliveryFailure] : [],
          );
          expect(toolEntry(view.entries, "opening-research:turn-1").status)
            .toBe(
              ending === "delivery_failed" ? "completed" : ending,
            );
          view.commit();
          const completedUpdates = updates.calls.length;
          time.tick(3000);
          expect(updates.calls).toHaveLength(completedUpdates);
          expect(templateText(view.view())).toContain("<span>3s</span>");
          expect(
            view.entries.filter((entry) => entry.kind === "tool"),
          ).toHaveLength(1);
        } finally {
          finishResearch.resolve();
          await service.waitForTurn("session-1", "turn-1");
          stop();
        }
      });
    }

    it("scrolls a feed that is following the tail to the newest step", () => {
      const feed = new FakeFeed(1000, 700, 300);
      paneShowing(feed).commit();

      expect(feed.scrolledTo).toBe(1000);
    });

    it("leaves a feed alone once the reader has scrolled up from the tail", () => {
      // The whole point of the pin: a reader holding an earlier step in view
      // must not be dragged to the bottom by the next event that arrives.
      const feed = new FakeFeed(1000, 200, 300);
      const view = paneShowing(feed);
      view.readerScrolled(feed);
      view.commit();

      expect(feed.scrolledTo).toBeUndefined();
    });

    it("follows the tail again once the reader scrolls back to it", () => {
      const feed = new FakeFeed(1000, 200, 300);
      const view = paneShowing(feed);
      view.readerScrolled(feed);
      feed.scrollTop = 700;
      view.readerScrolled(feed);
      view.commit();

      expect(feed.scrolledTo).toBe(1000);
    });

    it("subscribes to the session its address names, from the first event", () => {
      const { view, stop } = paneAt("/live/session-1");
      try {
        expect(view.sessionId).toBe("session-1");
        expect(FakeEventSource.opened).toHaveLength(1);
        expect(FakeEventSource.opened[0].url).toBe(
          "/api/events?sessionId=session-1&afterSequence=0",
        );
      } finally {
        stop();
      }
    });

    it("narrows to the turn its address focuses", () => {
      const { view, stop } = paneAt("/live/session-1", "?turn=turn-9");
      try {
        expect(view.turnId).toBe("turn-9");
      } finally {
        stop();
      }
    });

    it("opens no stream for an address that names no session", () => {
      const { view, stop } = paneAt("/console");
      try {
        expect(FakeEventSource.opened).toHaveLength(0);
        expect(view.state).toBe("no session");
        expect(view.error).toBe("This address names no session.");
      } finally {
        stop();
      }
    });

    it("draws the feed and the header from the events the stream delivers", () => {
      const { view, stop } = paneAt("/live/session-1");
      try {
        const [started, tool] = log(
          turnStarted,
          toolStarted("call-1", "run_pattern"),
        );
        FakeEventSource.opened[0].deliver(started);
        FakeEventSource.opened[0].deliver(tool);

        expect(view.entries.map((entry) => entry.kind)).toEqual([
          "turn",
          "tool",
        ]);
        expect(view.state).toBe("run pattern");
      } finally {
        stop();
      }
    });

    it("draws an event delivered twice once", () => {
      // A resumed stream and the live callback both carry the envelopes
      // emitted while the backfill was in flight.
      const { view, stop } = paneAt("/live/session-1");
      try {
        const [started] = log(turnStarted);
        FakeEventSource.opened[0].deliver(started);
        FakeEventSource.opened[0].deliver(started);

        expect(view.entries).toHaveLength(1);
      } finally {
        stop();
      }
    });

    it("resumes a closed stream from the last event it drew", () => {
      const { stop } = paneAt("/live/session-1");
      try {
        const [started] = log(turnStarted);
        FakeEventSource.opened[0].deliver(started);
        FakeEventSource.opened[0].fail(FakeEventSource.CLOSED);

        expect(FakeEventSource.opened).toHaveLength(2);
        expect(FakeEventSource.opened[1].url).toBe(
          "/api/events?sessionId=session-1&afterSequence=1",
        );
      } finally {
        stop();
      }
    });

    it("holds a stream that reports an error it has not closed over", () => {
      const { stop } = paneAt("/live/session-1");
      try {
        FakeEventSource.opened[0].fail(0);

        expect(FakeEventSource.opened).toHaveLength(1);
      } finally {
        stop();
      }
    });

    it("closes the stream when the pane goes away", () => {
      const { stop } = paneAt("/live/session-1");
      const stream = FakeEventSource.opened[0];
      stop();

      expect(stream.closed).toBe(true);
    });

    it("reads the run of a turn whose call completed, and the child's", async () => {
      const detail = await runDetail();
      const { view, stop } = paneAt("/live/session-1", "", {
        "turn-1": detail,
        "turn-1.subagent.1": detail,
      });
      try {
        const [completed] = log({
          kind: "tool_completed",
          tool: { toolCallId: "call-1", toolId: "run_pattern" },
          status: "completed",
          subagent: {
            parentToolCallId: "call-0",
            profile: "pattern-author",
            childRunId: "turn-1.subagent.1",
          },
        });
        FakeEventSource.opened[0].deliver(completed);
        await view.detailsWritten(2);

        expect([...view.details.keys()].sort()).toEqual([
          "turn-1",
          "turn-1.subagent.1",
        ]);
      } finally {
        stop();
      }
    });

    it("keeps the feed when a run has written no artifacts yet", () => {
      const { view, stop } = paneAt("/live/session-1");
      try {
        const [completed] = log(toolCompleted("call-1", "run_pattern"));
        FakeEventSource.opened[0].deliver(completed);

        // A 404 is a run that has not written its artifacts yet, not a fault
        // to report; nothing can reach `details` for it, so there is no write
        // to wait on and the feed stands on what the stream said.
        expect(view.details.size).toBe(0);
        expect(view.error).toBeUndefined();
        expect(view.entries).toHaveLength(1);
      } finally {
        stop();
      }
    });

    it("renders a step's CFC line and its withheld marker beside the live line", async () => {
      const detail = await runDetail();
      const view = new TestConsoleLive();
      view.entries = consoleLiveEntries(log(
        turnStarted,
        toolStarted("call-1", "run_pattern"),
        toolCompleted("call-1", "run_pattern", '{"status":"ok"}'),
      ));
      view.details = new Map([["turn-1", detail]]);

      const text = templateText(view.view());
      expect(text).toContain("Run pattern");
      expect(text).toContain("attempt 1 · ok");
      // The release held values back and the call itself succeeded, so the
      // pane says withheld rather than denied — the same reading the console's
      // own timeline gives the step. The CFC line carries the reason code, and
      // the omission block beside it is the retrospective's own words.
      expect(text).toContain("cfc_release_withheld");
      expect(text).toContain("No omission record exists for this tool result");
      expect(text).not.toContain("denied");
    });

    it("renders the refs and handles a line names set apart from its words", async () => {
      const step: ConsoleStep = {
        index: 0,
        kind: "tool",
        toolName: "browser",
        toolCallId: "call-2",
        input: { action: "fill", ref: "@e4", valueHandle: "cfh:v:k7m2q" },
        handlesIntroduced: [],
        handlesInScope: [],
        status: "ok",
        policyEvents: [],
        withheld: { status: "unrecorded", locations: [] },
      };
      const view = new TestConsoleLive();
      view.entries = consoleLiveEntries(log(
        {
          kind: "subagent_started",
          subagent: {
            parentToolCallId: "call-1",
            profile: "browser",
            goal: "enter cfh:v:k7m2q, then pay",
          },
        },
        toolStarted("call-2", "browser"),
        toolCompleted("call-2", "browser", "{}"),
      ));
      view.details = new Map([["turn-1", {
        ...await runDetail(),
        steps: [{ ...step, toolCallId: "call-1", toolName: "delegate_task" }, {
          ...step,
          index: 1,
        }],
        revealed: { "cfh:v:k7m2q": "12 Main St" },
        sites: { "cfh:v:k7m2q": ["shop.test"] },
      }]]);

      const text = templateText(view.view());
      expect(text).toContain(
        'enter <bdi class=live-reference quoted title=Another agent found this value on shop.test: 12 Main St. This agent never saw it. It passed the value on as the placeholder cfh:v:k7m2q.><span>12 Main St</span><span class="live-reference-source">from shop.test</span></bdi>, then pay',
      );
      expect(text).toContain(
        'Fill <bdi class=live-reference vague title=The agent referred to an element of the page as @e4. No copy of the page that this view can read describes that element.><span>an element of the page</span></bdi> with <bdi class=live-reference quoted title=Another agent found this value on shop.test: 12 Main St. This agent never saw it. It used the placeholder cfh:v:k7m2q. The system put the value in its place.><span>12 Main St</span><span class="live-reference-source">from shop.test</span></bdi>',
      );
    });

    for (const outcome of ["question", "gave-up"] as const) {
      it(`renders a ${outcome} as a normal terminal with the user-facing sentence`, () => {
        const text = outcome === "question"
          ? "Which mailbox should I use?"
          : "This source is unavailable under the current permissions.";
        const disposition = outcome === "question"
          ? { outcome, question: { text } }
          : { outcome, reason: text };
        const view = new TestConsoleLive();
        view.entries = consoleLiveEntries(log({
          kind: "turn_completed",
          turnId: "turn-1",
          ...disposition,
          result: { ...EMPTY_RESULT, ...disposition, finalText: text },
        }));
        const rendered = templateText(view.view());
        expect(rendered).toContain(text);
        expect(rendered).toContain(
          outcome === "question" ? "question" : "stopped",
        );
        expect(rendered).not.toContain("badge denied");
        expect(consoleLiveState(view.entries)).toBe(
          outcome === "question" ? "waiting for your answer" : "stopped",
        );
      });
    }

    it("renders a finish_task answer as a completed terminal", () => {
      const answer = "It is 24°C and sunny in Brisbane.";
      const disposition = { outcome: "completed" as const, answer };
      const view = new TestConsoleLive();
      view.entries = consoleLiveEntries(log({
        kind: "turn_completed",
        turnId: "turn-1",
        ...disposition,
        result: { ...EMPTY_RESULT, ...disposition, finalText: answer },
      }));
      expect(templateText(view.view())).toContain(answer);
      expect(consoleLiveState(view.entries)).toBe("done");
    });

    it("renders a completed turn's answer as Markdown, each revealed referent as its string", () => {
      const view = new TestConsoleLive();
      view.entries = consoleLiveEntries(log({
        kind: "turn_completed",
        turnId: "turn-1",
        result: {
          ...EMPTY_RESULT,
          outcome: "completed" as const,
          finalText: "Bought **cfh:v:22222**.",
          revealed: { "cfh:v:22222": "the blue one" },
        },
      }));

      const rendered = templateText(view.view());
      expect(rendered).toContain('class="live-final live-answer"');
      expect(rendered).toContain(
        '<strong><bdi class="live-found" title=the blue one><span class="live-found-badge">found</span>the blue one</bdi></strong>',
      );
    });

    it("renders a thought as plain text set apart from what the model said", () => {
      const view = new TestConsoleLive();
      view.entries = consoleLiveEntries(log({
        kind: "assistant_reasoning",
        text: "**Planning** [the search](https://elsewhere.example/).",
      }));

      const rendered = templateText(view.view());
      expect(rendered).toContain("class=live-entry thought");
      expect(rendered).toContain(
        "**Planning** [the search](https://elsewhere.example/).",
      );
      expect(rendered).not.toContain("<strong>");
      expect(rendered).not.toContain("<a");
    });

    it("renders a question naming a return referent with the string it stands for", () => {
      const view = new TestConsoleLive();
      view.entries = consoleLiveEntries(log({
        kind: "turn_completed",
        turnId: "turn-1",
        outcome: "question",
        question: { text: "Buy cfh:v:22222?" },
        result: {
          ...EMPTY_RESULT,
          outcome: "question" as const,
          question: { text: "Buy cfh:v:22222?" },
          finalText: "Buy cfh:v:22222?",
          revealed: { "cfh:v:22222": "the blue one" },
        },
      }));

      const rendered = templateText(view.view());
      expect(rendered).toContain(
        'Buy <bdi class="live-found" title=the blue one><span class="live-found-badge">found</span>the blue one</bdi>?',
      );
      expect(rendered).not.toContain("cfh:v:22222");
    });

    it("renders a turn line, prose, a subagent and the piece link it ended with", () => {
      const view = new TestConsoleLive();
      view.entries = consoleLiveEntries(log(
        turnStarted,
        {
          kind: "subagent_started",
          subagent: {
            parentToolCallId: "call-1",
            profile: "pattern-author",
            goal: "write   the\ncard",
          },
        },
        { kind: "assistant_completed", text: "here is what I did" },
        {
          kind: "turn_completed",
          turnId: "turn-1",
          result: {
            outcome: "completed" as const,
            sessionId: "session-1",
            continuable: true,
            looms: [],
            pieces: [{
              slug: "reading-list",
              url: "http://localhost:8000/s/reading-list",
            }],
            spaceName: "s",
            finalText: "here is what I did",
          },
        },
      ));

      const text = templateText(view.view());
      expect(text).toContain("task started");
      expect(text).toContain("Pattern author agent");
      // The goal is a model's own wording, so the line it goes on flattens it.
      expect(text).toContain("write the card");
      expect(text).toContain("here is what I did");
      expect(text).toContain("Open");
      expect(text).toContain("reading-list");
      expect(text).toContain("completed");
    });

    it("renders a delegated call and its prose set in from the parent's", () => {
      const subagent = {
        parentToolCallId: "call-1",
        profile: "pattern-author" as const,
      };
      const view = new TestConsoleLive();
      view.entries = consoleLiveEntries(log(
        {
          kind: "tool_started",
          tool: { toolCallId: "call-2", toolId: "run_pattern" },
          subagent,
        },
        { kind: "assistant_completed", text: "the child said this", subagent },
      ));

      // The rule down the left is what says whose work a line is; without it
      // a child's calls read as the turn's own.
      const text = templateText(view.view());
      expect(text).toContain("live-entry call child");
      expect(text).toContain("live-entry said child>the child said this<");
    });

    it("renders a call that failed as its own outcome", () => {
      const view = new TestConsoleLive();
      view.entries = consoleLiveEntries(log(
        toolStarted("call-1", "run_pattern"),
        {
          kind: "tool_completed",
          tool: { toolCallId: "call-1", toolId: "run_pattern" },
          status: "failed",
        },
      ));

      const text = templateText(view.view());
      expect(text).toContain("failed");
      expect(text).toContain("live-dot failed");
    });

    it("renders the piece link at the address the run recorded", () => {
      const view = new TestConsoleLive();
      view.entries = consoleLiveEntries(log(COMPLETED_WITH_PIECE));

      expect(templateText(view.view())).toContain(
        "http://localhost:8000/my-space/reading-list",
      );
    });

    it("renders the piece link under the base the address named", () => {
      // The whole point of the parameter: a host that renders pieces in its
      // own pane cannot send a reader to the Fabric API, which answers a pane
      // with its login gate rather than the piece.
      const view = new TestConsoleLive();
      view.piecesBase = "http://localhost:9901/pattern-pane";
      view.entries = consoleLiveEntries(log(COMPLETED_WITH_PIECE));

      const text = templateText(view.view());
      expect(text).toContain(
        "http://localhost:9901/pattern-pane/my-space/reading-list",
      );
      expect(text).not.toContain("http://localhost:8000/my-space/reading-list");
    });

    it("renders why a refused piece base is not being used", () => {
      const view = new TestConsoleLive();
      view.piecesBaseRefused = true;

      expect(templateText(view.view())).toContain(
        "Piece links go to the address the run recorded.",
      );
    });

    it("renders the error a failed turn ended with", () => {
      const view = new TestConsoleLive();
      view.entries = consoleLiveEntries(log(
        {
          kind: "tool_started",
          tool: {
            toolCallId: "opening-research:turn-1",
            toolId: "research",
            title: "Orienting: working out what is already available",
          },
        },
        {
          kind: "turn_failed",
          turnId: "turn-1",
          error: { code: "internal_error", message: "the sandbox is down" },
        },
      ));

      const text = templateText(view.view());
      expect(text).toContain("failed");
      expect(text).toContain("the sandbox is down");
      expect(text).toContain("<span>0s</span>");
      expect(toolEntry(view.entries, "opening-research:turn-1").status).toBe(
        "failed",
      );
    });

    it("renders the verdict a subagent finished on", () => {
      const subagent = {
        parentToolCallId: "call-1",
        profile: "pattern-author" as const,
      };
      const view = new TestConsoleLive();
      view.entries = consoleLiveEntries(log(
        { kind: "subagent_started", subagent },
        { kind: "subagent_completed", subagent, status: "failed" },
      ));

      const text = templateText(view.view());
      expect(text).toContain("Pattern author agent");
      expect(text).toContain("failed");
    });

    it("renders a subagent that finished its work", () => {
      const subagent = {
        parentToolCallId: "call-1",
        profile: "pattern-author" as const,
      };
      const view = new TestConsoleLive();
      view.entries = consoleLiveEntries(log(
        { kind: "subagent_started", subagent },
        { kind: "subagent_completed", subagent, status: "completed" },
      ));

      expect(templateText(view.view())).toContain("completed");
    });

    it("renders a running subagent without a verdict", () => {
      const view = new TestConsoleLive();
      view.entries = consoleLiveEntries(log({
        kind: "subagent_started",
        subagent: { parentToolCallId: "call-1", profile: "pattern-author" },
      }));

      const text = templateText(view.view());
      expect(text).toContain("Pattern author agent");
      expect(text).not.toContain("completed");
    });

    it("renders the progress a running call reported", () => {
      const view = new TestConsoleLive();
      view.entries = consoleLiveEntries(log(
        toolStarted("call-1", "bash"),
        { kind: "tool_progress", toolCallId: "call-1", message: "compiling" },
      ));

      expect(templateText(view.view())).toContain("compiling");
    });

    it("renders an address that names no session as the reason it shows nothing", () => {
      const view = new TestConsoleLive();
      view.error = "This address names no session.";

      const text = templateText(view.view());
      expect(text).toContain("This address names no session.");
      expect(text).not.toContain("Waiting for the first step");
    });

    it("renders a session whose first step has not arrived", () => {
      expect(templateText(new TestConsoleLive().view())).toContain(
        "Waiting for the first step",
      );
    });

    it("renders the chip that says the pane is narrowed to one turn", () => {
      const view = new TestConsoleLive();
      view.turnId = "turn-1";

      expect(templateText(view.view())).toContain("one turn");
    });

    it("renders a call that started a subagent as the subagent's row alone", () => {
      const view = new TestConsoleLive();
      view.entries = consoleLiveEntries(log(
        toolStarted("call-1", "delegate_task"),
        {
          kind: "subagent_started",
          subagent: {
            parentToolCallId: "call-1",
            profile: "browser",
            goal: "find the shop",
          },
        },
      ));

      const text = templateText(view.view());
      expect(text).toContain("Browser agent");
      expect(text).toContain("find the shop");
      expect(text).not.toContain("Delegate task");
    });

    it("renders a row that opens only when there is more to say about it", async () => {
      const view = new TestConsoleLive();
      view.entries = consoleLiveEntries(log(
        toolStarted("call-1", "run_pattern"),
        toolCompleted("call-1", "run_pattern", '{"status":"ok"}'),
      ));

      expect(templateText(view.view())).toContain('<div class="live-row">');
      expect(templateText(view.view())).not.toContain("<details");

      view.details = new Map([["turn-1", await runDetail()]]);

      expect(templateText(view.view())).toContain(
        '<details class="live-row">',
      );
    });

    it("renders a denial with no CFC record read for it as a denial", () => {
      const view = new TestConsoleLive();
      view.entries = consoleLiveEntries(log(
        toolStarted("call-1", "browser"),
        {
          kind: "tool_completed",
          tool: { toolCallId: "call-1", toolId: "browser" },
          status: "denied",
        },
      ));

      expect(templateText(view.view())).toContain(
        '<span class="badge denied">denied</span>',
      );
    });

    it("renders a subagent its turn was canceled under as canceled", () => {
      const view = new TestConsoleLive();
      view.entries = consoleLiveEntries(log(
        turnStarted,
        {
          kind: "subagent_started",
          subagent: { parentToolCallId: "call-1", profile: "browser" },
        },
        { kind: "turn_canceled", turnId: "turn-1" },
      ));

      const text = templateText(view.view());
      expect(text).toContain("live-dot canceled");
      expect(text).not.toContain("live-dot running");
    });

    it("renders why CFC decided what it did in an owner's words, with its codes on hover", async () => {
      const step = (
        toolCallId: string,
        policy: ConsoleStep["policy"],
      ): ConsoleStep => ({
        index: 0,
        kind: "tool",
        toolName: "browser",
        toolCallId,
        input: { action: "back" },
        handlesIntroduced: [],
        handlesInScope: [],
        status: "ok",
        policy,
        policyEvents: [],
        withheld: { status: "recorded", locations: [] },
      });
      const view = new TestConsoleLive();
      view.entries = consoleLiveEntries(log(
        toolStarted("call-1", "browser"),
        toolStarted("call-2", "browser"),
      ));
      view.details = new Map([["turn-1", {
        ...await runDetail(),
        steps: [
          step("call-1", {
            decision: "denied",
            effectClass: "side-effect",
            reasonCodes: ["cfc_enforce_strict_requires_direct_command"],
          }),
          step("call-2", {
            decision: "allowed",
            reasonCodes: ["cfc_reason_this_view_does_not_know"],
          }),
        ],
      }]]);

      const text = templateText(view.view());
      expect(text).toContain(
        "title=side-effect · cfc_enforce_strict_requires_direct_command>",
      );
      expect(text).toContain(
        "Blocked</span> Nothing records who asked for this work, so the check could not trace it back to a request from you. Agents act only on your own requests, never on instructions they read along the way. In this run, that holds even for a step that only looks at information.</p>",
      );
      expect(text).toContain(
        "Allowed</span> cfc_reason_this_view_does_not_know</p>",
      );
    });

    it("renders where a step's work came from, as the prompt slot its decision read says", async () => {
      const step = (
        toolCallId: string,
        decision: string,
        reasonCode: string,
        promptSlot?: {
          role: "direct-command" | "context" | "quote";
          surface: string;
        },
      ): ConsoleStep => ({
        index: 0,
        kind: "tool",
        toolName: "browser",
        toolCallId,
        input: { action: "back" },
        handlesIntroduced: [],
        handlesInScope: [],
        status: "ok",
        policy: {
          decision,
          reasonCodes: [reasonCode],
          ...(promptSlot === undefined ? {} : { promptSlot }),
        },
        policyEvents: [],
        withheld: { status: "recorded", locations: [] },
      });
      const view = new TestConsoleLive();
      view.entries = consoleLiveEntries(log(
        toolStarted("call-1", "browser"),
        toolStarted("call-2", "browser"),
        toolStarted("call-3", "browser"),
        toolStarted("call-4", "browser"),
      ));
      view.details = new Map([["turn-1", {
        ...await runDetail(),
        steps: [
          step("call-1", "allowed", "cfc_enforce_strict_direct_command", {
            role: "direct-command",
            surface: "console-web",
          }),
          step(
            "call-2",
            "denied",
            "cfc_enforce_explicit_requires_direct_command",
            { role: "context", surface: "cli" },
          ),
          step(
            "call-3",
            "denied",
            "cfc_enforce_explicit_requires_direct_command",
            { role: "quote", surface: "somewhere-new" },
          ),
          step(
            "call-4",
            "denied",
            "cfc_enforce_strict_requires_direct_command",
          ),
        ],
      }]]);

      const text = templateText(view.view());
      expect(text).toContain(
        "Allowed</span> This work traces back to a request you made yourself in the console.",
      );
      expect(text).toContain(
        "Blocked</span> This work traces back to text given to the agent as background on the command line, not as a request from you.",
      );
      expect(text).toContain(
        "Blocked</span> This work traces back to text given to the agent as a quotation, not as a request from you.",
      );
      expect(text).toContain(
        "Blocked</span> Nothing records who asked for this work, so the check could not trace it back to a request from you.",
      );
    });

    it("renders each kind of reference as what it stands for", async () => {
      const step = (
        toolCallId: string,
        index: number,
        input: Record<string, unknown>,
        output?: Record<string, unknown>,
      ): ConsoleStep => ({
        index,
        kind: "tool",
        toolName: "browser",
        toolCallId,
        input,
        ...(output === undefined ? {} : { output }),
        handlesIntroduced: [],
        handlesInScope: [],
        status: "ok",
        policyEvents: [],
        withheld: { status: "recorded", locations: [] },
      });
      const view = new TestConsoleLive();
      view.entries = consoleLiveEntries(log(
        toolStarted("call-1", "browser"),
        toolStarted("call-2", "browser"),
        toolStarted("call-3", "research"),
      ));
      view.details = new Map([["turn-1", {
        ...await runDetail(),
        steps: [
          step("call-1", 0, { action: "snapshot", interactive: true }, {
            status: "ok",
            output: '- textbox "Name" [@e3 at 0,0 10x10]',
            page: { url: "https://shop.test/cart", title: "Cart" },
          }),
          step("call-2", 1, {
            action: "fill",
            ref: "@e3",
            valueHandle: "cfh:v:k7m2q",
          }),
          {
            ...step("call-3", 2, { task: "file it under cfh:a:k2345" }),
            toolName: "research",
          },
        ],
        handles: [{
          token: "cfh:a:k2345",
          slug: "delivery-addresses",
          introducedAtStep: 0,
          uses: [],
          confidentiality: [],
        }],
        hidden: ["cfh:v:k7m2q"],
      }]]);

      const text = templateText(view.view());
      expect(text).toContain(
        "Fill <bdi class=live-reference quoted title=These words come from shop.test. The page gives this name to the element the agent chose. The agent referred to it as @e3.><span>Name</span></bdi> text field with <bdi class=live-reference vague sealed",
      );
      expect(text).toContain(
        "This view does not show the value, because the rules on where it may go do not include this view.><span>a value hidden from this view</span></bdi>",
      );
      expect(text).toContain(
        "file it under <bdi class=live-reference title=This is an item stored in your space. The agent referred to it as cfh:a:k2345.><span>delivery-addresses</span></bdi>",
      );
    });

    it("renders why for a release CFC withheld, a commit it refused, and a task given in a way it does not know", async () => {
      const step: (toolCallId: string, policy: unknown) => ConsoleStep = (
        toolCallId,
        policy,
      ) =>
        JSON.parse(JSON.stringify({
          index: 0,
          kind: "tool",
          toolName: "browser",
          toolCallId,
          input: { action: "back" },
          handlesIntroduced: [],
          handlesInScope: [],
          status: "ok",
          policy,
          policyEvents: [],
          withheld: { status: "recorded", locations: [] },
        }));
      const view = new TestConsoleLive();
      view.entries = consoleLiveEntries(log(
        toolStarted("call-1", "browser"),
        toolStarted("call-2", "browser"),
        toolStarted("call-3", "browser"),
      ));
      view.details = new Map([["turn-1", {
        ...await runDetail(),
        steps: [
          step("call-1", {
            decision: "withheld",
            reasonCodes: ["cfc_release_withheld"],
          }),
          step("call-2", {
            decision: "denied",
            reasonCodes: ["cfc_commit_refused"],
          }),
          step("call-3", {
            decision: "denied",
            reasonCodes: ["cfc_enforce_strict_requires_direct_command"],
            promptSlot: { role: "dictated", surface: "phone" },
          }),
        ],
      }]]);

      const text = templateText(view.view());
      expect(text).toContain(
        "Part of the step's result was held back from the agent. It held information the agent may not read.</p>",
      );
      expect(text).toContain(
        "The step's result was not saved. It held information that may not be stored where it was going.</p>",
      );
      expect(text).toContain(
        "Blocked</span> The record of who asked for this work does not say it was you.",
      );
    });

    it("renders why for a step CFC raised an event about or only tracked, with no reason given", async () => {
      const step = (toolCallId: string, extra: Partial<ConsoleStep>) => ({
        index: 0,
        kind: "tool" as const,
        toolName: "browser",
        toolCallId,
        input: { action: "back" },
        handlesIntroduced: [],
        handlesInScope: [],
        status: "ok" as const,
        policyEvents: [],
        withheld: { status: "recorded" as const, locations: [] },
        ...extra,
      });
      const view = new TestConsoleLive();
      view.entries = consoleLiveEntries(log(
        toolStarted("call-1", "browser"),
        toolStarted("call-2", "browser"),
      ));
      const detail = await runDetail();
      view.details = new Map([["turn-1", {
        ...detail,
        steps: [
          step("call-1", {
            policyEvents: [{
              type: "cf-harness.policy-event",
              severity: "warning",
              mode: "observe",
              toolId: "browser",
              detail: "observed a flow",
              at: "2026-01-01T00:00:00.000Z",
            }],
          }),
          step("call-2", {
            policy: { decision: "allowed", reasonCodes: [] },
            withheld: { status: "record-unreadable", locations: [] },
          }),
        ],
      }]]);

      const text = templateText(view.view());
      expect(text).toContain(
        'title=observed a flow><span class="live-why-heading warn">',
      );
      expect(text).toContain(
        "Allowed with a warning</span> The run raised a warning about this step. It did not stop the step.</p>",
      );
      expect(text).toContain(
        "Partly withheld</span> Part of the step's result was held back from the agent.</p>",
      );
      expect(text).toContain(
        "<summary>What was held back from the agent</summary>",
      );
    });

    it("renders a tool line with no run read for it yet", () => {
      const view = new TestConsoleLive();
      view.entries = consoleLiveEntries(log(
        turnStarted,
        toolStarted("call-1", "run_pattern"),
      ));

      const text = templateText(view.view());
      expect(text).toContain("Run pattern");
      expect(text).not.toContain("withheld");
    });
  });
});
