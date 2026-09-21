import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { join } from "@std/path";
import {
  ConsoleLive,
  consoleLiveAddress,
  consoleLiveAtTail,
  consoleLiveEntries,
  type ConsoleLiveEntry,
  consoleLivePieceHref,
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
import {
  HARNESS_CHAT_EVENT_TYPE,
  HARNESS_CHAT_PROTOCOL_VERSION,
} from "../../../src/contracts/interactive-chat.ts";
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

    it("returns the piece links a completed turn handed back", () => {
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

      // The final text is the turn's last assistant message, which the feed
      // already carries, so the closing block is the links and nothing else.
      expect(entries[0]).toEqual({
        kind: "ended",
        key: "1",
        turnId: "turn-1",
        status: "completed",
        outcome: "completed",
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
      )))).toBe("run_pattern");
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
        "run_pattern",
      );
    });
  });

  describe("consoleLiveToolLine()", () => {
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

    const detail = (
      lens: Partial<ConsoleRunDetail["lens"]>,
    ): ConsoleRunDetail =>
      ({
        lens: {
          patternAttempts: [],
          searches: [],
          feedback: [],
          pieces: [],
          ...lens,
        },
      }) as ConsoleRunDetail;

    it("returns the numbered attempt and the compiler's word for `run_pattern`", () => {
      expect(consoleLiveToolLine(
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
      )).toBe("attempt 2 · error: Type mismatch");
    });

    it("returns the slug `assign_slug` registered", () => {
      expect(consoleLiveToolLine(
        entry("call-1", "assign_slug"),
        detail({
          pieces: [{
            toolCallId: "call-1",
            slug: "reading-list",
            url: "http://localhost:8000/s/reading-list",
          }],
        }),
        undefined,
      )).toBe("reading-list");
    });

    it("returns the slug from the result of a call the run has not been read for", () => {
      expect(consoleLiveToolLine(
        entry("call-1", "assign_slug", '{"slug":"reading-list"}'),
        undefined,
        undefined,
      )).toBe("reading-list");
    });

    it("returns `undefined` for a result the tool did not write as JSON", () => {
      expect(consoleLiveToolLine(
        entry("call-1", "assign_slug", "the slug is reading-list"),
        undefined,
        undefined,
      )).toBeUndefined();
    });

    it("returns the query `search_patterns` was given", () => {
      expect(consoleLiveToolLine(
        entry("call-1", "search_patterns"),
        detail({
          searches: [{ toolCallId: "call-1", query: "reading list", hits: [] }],
        }),
        undefined,
      )).toBe("reading list");
    });

    it("returns the question `query_docs` asked, from the step's own input", () => {
      const step: ConsoleStep = {
        index: 0,
        kind: "tool",
        toolName: "query_docs",
        toolCallId: "call-1",
        input: { question: "how does\na handler write?" },
        handlesIntroduced: [],
        handlesInScope: [],
        status: "ok",
        policyEvents: [],
        withheld: { status: "unrecorded", locations: [] },
      };

      expect(
        consoleLiveToolLine(entry("call-1", "query_docs"), undefined, step),
      )
        .toBe("how does a handler write?");
    });

    it("returns the Common Fabric task `research` investigated", () => {
      const step: ConsoleStep = {
        index: 0,
        kind: "tool",
        toolName: "research",
        toolCallId: "call-1",
        input: { task: "compose a checklist\nwith a cost total" },
        handlesIntroduced: [],
        handlesInScope: [],
        status: "ok",
        policyEvents: [],
        withheld: { status: "unrecorded", locations: [] },
      };

      expect(
        consoleLiveToolLine(entry("call-1", "research"), undefined, step),
      ).toBe("compose a checklist with a cost total");
    });

    it("returns `undefined` for a search whose run holds no record of it", () => {
      expect(consoleLiveToolLine(
        entry("call-1", "search_patterns"),
        detail({ searches: [] }),
        undefined,
      )).toBeUndefined();
    });

    it("returns `undefined` for a naming whose result never reached the pane", () => {
      expect(
        consoleLiveToolLine(
          entry("call-1", "assign_slug"),
          undefined,
          undefined,
        ),
      )
        .toBeUndefined();
    });

    it("returns a question elided to the width a line has for it", () => {
      const step: ConsoleStep = {
        index: 0,
        kind: "tool",
        toolName: "query_docs",
        toolCallId: "call-1",
        input: { question: "w".repeat(400) },
        handlesIntroduced: [],
        handlesInScope: [],
        status: "ok",
        policyEvents: [],
        withheld: { status: "unrecorded", locations: [] },
      };
      const line = consoleLiveToolLine(
        entry("call-1", "query_docs"),
        undefined,
        step,
      );

      expect(line).toHaveLength(140);
      expect(line?.endsWith("…")).toBe(true);
    });

    it("returns `undefined` for a call nothing has been read about yet", () => {
      expect(
        consoleLiveToolLine(entry("call-1", "read_file"), undefined, undefined),
      ).toBeUndefined();
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
        expect(view.state).toBe("run_pattern");
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
      expect(text).toContain("run_pattern");
      expect(text).toContain("attempt 1 · ok");
      // The release held values back and the call itself succeeded, so the
      // pane says withheld rather than denied — the same reading the console's
      // own timeline gives the step. The CFC line carries the reason code, and
      // the omission block beside it is the retrospective's own words.
      expect(text).toContain("cfc_release_withheld");
      expect(text).toContain("No omission record exists for this tool result");
      expect(text).not.toContain("denied");
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
      expect(text).toContain("pattern-author");
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
      expect(text).toContain("live-entry tool child");
      expect(text).toContain("live-entry said child");
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
      view.entries = consoleLiveEntries(log({
        kind: "turn_failed",
        turnId: "turn-1",
        error: { code: "internal_error", message: "the sandbox is down" },
      }));

      const text = templateText(view.view());
      expect(text).toContain("failed");
      expect(text).toContain("the sandbox is down");
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
      expect(text).toContain("pattern-author");
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
      expect(text).toContain("pattern-author");
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

    it("renders a tool line with no run read for it yet", () => {
      const view = new TestConsoleLive();
      view.entries = consoleLiveEntries(log(
        turnStarted,
        toolStarted("call-1", "run_pattern"),
      ));

      const text = templateText(view.view());
      expect(text).toContain("run_pattern");
      expect(text).not.toContain("withheld");
    });
  });
});
