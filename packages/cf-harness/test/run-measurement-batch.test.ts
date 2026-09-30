import { afterEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { copy } from "@std/fs";
import { fromFileUrl } from "@std/path";

import {
  type BatchResult,
  classifyImportedPattern,
  ConsoleClient,
  indexChangeOf,
  type IndexPreflight,
  type IndexSnapshot,
  main,
  parseMeasurementSuite,
  preflightCellSpec,
  preflightPosture,
  readAncestry,
  readServerMeta,
  readSseFrames,
  readSupersededVisibility,
  renderBatchReport as renderBatchReportImpl,
  resolveImportedPatternOrigins,
  runTask,
} from "../scripts/run-measurement-batch.ts";
import { emptyTotals as emptyMeasurementTotals } from "../scripts/measure-runs.ts";
import observedStatus from "./support/measurement-console-status.json" with {
  type: "json",
};

const FIXTURE_ROOT = fromFileUrl(
  new URL("./support/measure-runs/runs", import.meta.url),
);

const RUN_TASK_OPTIONS = {
  batchStartedAt: "2026-08-28T21:00:00.000Z",
  artifactRoot: FIXTURE_ROOT,
};

const CONSOLE_PREFLIGHT = {
  kind: "ready" as const,
  artifactRoot: FIXTURE_ROOT,
};

const renderBatchReport = (
  batch: Omit<BatchResult, "consolePreflight" | "cellSpec">,
): string =>
  renderBatchReportImpl({
    ...batch,
    consolePreflight: CONSOLE_PREFLIGHT,
    cellSpec: { kind: "unasked" },
  });

/**
 * One event stream, delivered a chunk at a time.
 *
 * `pull` rather than `start` because a stream that enqueues everything and
 * then calls `error()` discards the queue, which is not what a socket does: a
 * client receives the bytes already sent and then sees the break. The
 * difference decides whether a fault counts as progress, which is what bounds
 * the client's reconnection.
 */
const sseBody = (
  frames: readonly string[],
  keepOpen: boolean,
  fault = false,
): BodyInit => {
  const encoder = new TextEncoder();
  let index = -1;
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      index += 1;
      if (index === 0) {
        controller.enqueue(encoder.encode(": connected\n\n"));
        return;
      }
      const frame = frames[index - 1];
      if (frame !== undefined) {
        controller.enqueue(encoder.encode(frame));
        return;
      }
      if (fault) {
        controller.error(new Error("the socket went away"));
        return;
      }
      if (!keepOpen) {
        controller.close();
        return;
      }
      // Held open with nothing more to say, which is a live but quiet turn.
      return new Promise<void>(() => {});
    },
  });
};

const chatFrame = (
  sequence: number,
  sessionId: string,
  event: Record<string, unknown>,
): string =>
  `event: chat\nid: ${sequence}\ndata: ${
    JSON.stringify({
      type: "cf-harness.chat.event",
      protocolVersion: 1,
      sessionId,
      sequence,
      emittedAt: "2026-08-28T21:00:00.000Z",
      event,
    })
  }\n\n`;

interface FakeConsoleOptions {
  /**
   * The event streams the server hands out, in the order they are asked for.
   * Once the list runs out the server hands out an empty, closed stream — a
   * server with nothing more to say closes, and that is what lets a caller
   * tell "still working" from "gone".
   */
  streams: readonly {
    frames: readonly string[];
    keepOpen: boolean;
    fault?: boolean;
  }[];

  runId?: string;
  artifactRoot?: string;
  touchRunState?: boolean;
  statusArtifactRoot?: unknown;
  statusSessions?: unknown;
  patterns?: readonly Record<string, unknown>[];

  /** What `/api/index/call` answers, and with what status. */
  indexAnswer?: { status: number; body: unknown };

  /** What `/api/meta` answers, standing in for the fabric server. */
  meta?: unknown;

  /**
   * What `/api/policy` answers, or `null` for a console that does not serve
   * the route at all.
   */
  policy?: unknown;

  /** What `getPattern` reports each pattern depends on. */
  dependencies?: Readonly<Record<string, readonly string[]>>;

  /** What `getPattern` reports about each pattern's discoverability. */
  discoverable?: Readonly<Record<string, boolean>>;

  /** A status for `/api/events` to refuse the stream with. */
  eventStatus?: number;

  /** Break the index response body mid-read, as a dropped connection does. */
  indexFault?: boolean;
}

interface FakeConsole {
  url: string;
  taskTexts: readonly string[];
  eventRequests: readonly string[];
  close: () => Promise<void>;
}

const startFakeConsole = (options: FakeConsoleOptions): FakeConsole => {
  const taskTexts: string[] = [];
  const eventRequests: string[] = [];
  let streamIndex = 0;
  const server = Deno.serve({
    port: 0,
    onListen: () => {},
  }, async (request) => {
    const url = new URL(request.url);
    if (url.pathname === "/") {
      return new Response("<!doctype html>");
    }
    if (url.pathname === "/api/meta") {
      return Response.json(options.meta ?? META);
    }
    if (url.pathname === "/api/health") {
      return Response.json({ ok: true });
    }
    if (url.pathname === "/api/task") {
      const body = await request.json() as { text: string };
      taskTexts.push(body.text);
      if (
        options.touchRunState && options.runId !== undefined &&
        options.artifactRoot !== undefined
      ) {
        const path = `${options.artifactRoot}/${options.runId}/run-state.json`;
        const state = JSON.parse(await Deno.readTextFile(path));
        await Deno.writeTextFile(
          path,
          JSON.stringify({ ...state, createdAt: new Date().toISOString() }),
        );
      }
      return Response.json({
        sessionId: "session-1",
        turnId: options.runId ?? "turn-1",
      });
    }
    if (url.pathname === "/api/events") {
      eventRequests.push(url.searchParams.get("afterSequence") ?? "");
      if (options.eventStatus !== undefined) {
        return new Response("no stream for you", {
          status: options.eventStatus,
        });
      }
      // A server with nothing more to say closes rather than repeating
      // itself, which is what lets a caller tell "still working" from "gone".
      const stream = options.streams[streamIndex++] ??
        { frames: [], keepOpen: false };
      return new Response(
        sseBody(
          stream.frames.map((frame) =>
            frame.replaceAll(
              '"turn-1"',
              JSON.stringify(options.runId ?? "turn-1"),
            )
          ),
          stream.keepOpen,
          stream.fault ?? false,
        ),
        {
          headers: { "content-type": "text/event-stream" },
        },
      );
    }
    if (url.pathname === "/api/status") {
      const observedSession = observedStatus.sessions[0];
      const requestedSessionId = url.searchParams.get("sessionId");
      return Response.json({
        ...(options.statusArtifactRoot === null ? {} : {
          artifactRoot: options.statusArtifactRoot ??
            options.artifactRoot ?? FIXTURE_ROOT,
        }),
        sessions: options.statusSessions ?? [{
          ...observedSession,
          ...(requestedSessionId === null
            ? {}
            : { sessionId: requestedSessionId }),
          ...(options.artifactRoot !== undefined
            ? { artifactRoot: options.artifactRoot }
            : {}),
        }],
      });
    }
    if (url.pathname === "/api/policy") {
      return options.policy === null
        ? new Response("not found", { status: 404 })
        : Response.json(options.policy ?? POLICY);
    }
    if (url.pathname === "/api/index/call") {
      if (options.indexFault) {
        return new Response(
          new ReadableStream<Uint8Array>({
            pull(controller) {
              controller.error(new Error("the socket went away"));
            },
          }),
          { headers: { "content-type": "application/json" } },
        );
      }
      const answer = options.indexAnswer;
      if (answer !== undefined) {
        return Response.json(answer.body, { status: answer.status });
      }
      const body = await request.json() as {
        fn: string;
        body?: { patternId?: string };
      };
      if (body.fn === "searchPatterns") {
        return Response.json({ results: [], candidates: 30 });
      }
      if (body.fn === "getPattern") {
        const patternId = body.body?.patternId ?? "";
        const discoverable = options.discoverable?.[patternId];
        return Response.json({
          patternId,
          dependencies: options.dependencies?.[patternId] ?? [],
          ...(discoverable === undefined ? {} : { discoverable }),
        });
      }
      return Response.json({ patterns: options.patterns ?? [] });
    }
    return new Response("not found", { status: 404 });
  });
  return {
    url: `http://127.0.0.1:${(server.addr as Deno.NetAddr).port}`,
    taskTexts,
    eventRequests,
    close: () => server.shutdown(),
  };
};

const completedStream = (sequence = 7) => ({
  frames: [
    chatFrame(sequence - 1, "session-1", {
      kind: "turn_started",
      turn: { turnId: "turn-1" },
    }),
    chatFrame(sequence, "session-1", {
      kind: "turn_completed",
      turnId: "turn-1",
      finalText: "Your reading list is at /reading-list.",
    }),
  ],
  keepOpen: true,
});

const patternOf = (
  patternId: string,
  score: number,
): Record<string, unknown> => ({
  patternId,
  description: `${patternId} does a thing.`,
  score,
  events: { published: 1 },
});

/** What the stand-in console says a session started there would run under. */
const POLICY = {
  systemPromptSha256:
    "9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08",
  allowedToolIds: ["shell", "run_pattern", "search_patterns"],
  allowedSubagentProfiles: ["default", "pattern-author"],
  fabricSpace: "measurement",
  artifactRoot: "/console/runs",
  sessionDbPath: "/console/sessions.sqlite",
};

const META = {
  gitSha: "7baa03f462e5a1e4b5e477bd2162c880c5e5bc4a",
  cfc: { enforcementMode: "enforce-explicit", flowLabels: "off" },
  experimentalFlags: { serverExecution: true },
};

const POSTURE = {
  kind: "read" as const,
  meta: META,
  ancestry: { kind: "ancestor" as const, base: "main" },
};

const metaFetch = (
  body: unknown,
  status = 200,
): typeof globalThis.fetch =>
  ((_input, _init) =>
    Promise.resolve(
      Response.json(body, { status }),
    )) as typeof globalThis.fetch;

/** A stand-in `git`, keyed by the subcommand the reading issues. */
const gitRun = (
  known: boolean,
  ancestor: boolean,
) =>
(args: readonly string[]) =>
  Promise.resolve(
    args[0] === "cat-file"
      ? { success: known, code: known ? 0 : 1 }
      : { success: ancestor, code: ancestor ? 0 : 1 },
  );

/** Writes a root run's identity and transcript artifacts. */
const writeRunCandidate = async (
  artifactRoot: string,
  runId: string,
  createdAt: string,
  firstUserMessage: string,
): Promise<void> => {
  const root = `${artifactRoot}/${runId}`;
  await Deno.mkdir(root, { recursive: true });
  await Deno.writeTextFile(
    `${root}/run-state.json`,
    JSON.stringify({ runId, createdAt }),
  );
  await Deno.writeTextFile(
    `${root}/transcript.json`,
    JSON.stringify([{ role: "user", content: firstUserMessage }]),
  );
};

describe("run-measurement-batch", () => {
  describe("captured console status", () => {
    it("records the live route without an invented harness run identifier", () => {
      expect(Array.isArray(observedStatus.sessions)).toBe(true);
      const session = observedStatus.sessions[0] as Record<string, unknown>;
      expect("harnessRunId" in session).toBe(false);
      expect(typeof session.artifactRoot).toBe("string");
      expect(typeof session.createdAt).toBe("string");
    });
  });

  describe("parseMeasurementSuite()", () => {
    it("returns the suite for a well-formed file", () => {
      expect(parseMeasurementSuite({
        label: "tonight",
        notes: "against the seeded index",
        tasks: [{ id: "books", text: "Track the books I am reading." }],
      })).toEqual({
        label: "tonight",
        notes: "against the seeded index",
        tasks: [{ id: "books", text: "Track the books I am reading." }],
      });
    });

    it("throws for a suite that is not a JSON object", () => {
      expect(() => parseMeasurementSuite("a string")).toThrow(
        "must be a JSON object",
      );
    });

    it("throws for a suite whose notes are not a string", () => {
      expect(() =>
        parseMeasurementSuite({
          label: "l",
          notes: 7,
          tasks: [{ id: "a", text: "one" }],
        })
      ).toThrow("notes must be a string");
    });

    it("throws for a task that is not a JSON object", () => {
      expect(() => parseMeasurementSuite({ label: "l", tasks: ["nope"] }))
        .toThrow("task 0 is not a JSON object");
    });

    it("throws for a task carrying no id", () => {
      expect(() =>
        parseMeasurementSuite({ label: "l", tasks: [{ text: "one" }] })
      ).toThrow("task 0 carries no id");
    });

    it("throws for a suite carrying no tasks", () => {
      expect(() => parseMeasurementSuite({ label: "empty", tasks: [] }))
        .toThrow("at least one task");
    });

    it("throws for a suite carrying no label", () => {
      expect(() => parseMeasurementSuite({ tasks: [{ id: "a", text: "b" }] }))
        .toThrow("non-empty label");
    });

    it("throws for a task carrying no text", () => {
      expect(() => parseMeasurementSuite({ label: "l", tasks: [{ id: "a" }] }))
        .toThrow("task a carries no text");
    });

    it("returns the seeded pattern identifiers a suite names", () => {
      expect(
        parseMeasurementSuite({
          label: "l",
          tasks: [{ id: "a", text: "one" }],
          seededPatternIds: ["seed-1", "seed-2"],
        }).seededPatternIds,
      ).toEqual(["seed-1", "seed-2"]);
    });

    it("returns the supersession reasons a suite gives for identifiers it names", () => {
      expect(parseMeasurementSuite({
        label: "l",
        tasks: [{ id: "a", text: "one" }],
        supersededPatternIds: ["old", "older"],
        supersededReasons: { old: "a defect in it was fixed" },
      })).toEqual({
        label: "l",
        tasks: [{ id: "a", text: "one" }],
        supersededPatternIds: ["old", "older"],
        supersededReasons: { old: "a defect in it was fixed" },
      });
    });

    it("throws for a supersession reason naming an identifier the suite does not call superseded", () => {
      expect(() =>
        parseMeasurementSuite({
          label: "l",
          tasks: [{ id: "a", text: "one" }],
          supersededPatternIds: ["old"],
          supersededReasons: { other: "a reason for nothing" },
        })
      ).toThrow("which it does not name as superseded");
    });

    it("throws for a supersession reason that is not a string", () => {
      expect(() =>
        parseMeasurementSuite({
          label: "l",
          tasks: [{ id: "a", text: "one" }],
          supersededPatternIds: ["old"],
          supersededReasons: { old: 7 },
        })
      ).toThrow("reason for old must be a string");
    });

    it("throws for supersession reasons given as an array, which `typeof` calls an object", () => {
      expect(() =>
        parseMeasurementSuite({
          label: "l",
          tasks: [{ id: "a", text: "one" }],
          supersededPatternIds: ["old"],
          supersededReasons: ["a reason"],
        })
      ).toThrow("supersededReasons must be a JSON object");
    });

    it("throws for supersession reasons that are not an object", () => {
      expect(() =>
        parseMeasurementSuite({
          label: "l",
          tasks: [{ id: "a", text: "one" }],
          supersededReasons: "nope",
        })
      ).toThrow("supersededReasons must be a JSON object");
    });

    it("throws for an identifier named as both seeded and superseded", () => {
      // Provenance would otherwise depend on which branch the classifier tests
      // first, and the seeded branch runs first, so the superseded reading
      // would vanish silently.
      expect(() =>
        parseMeasurementSuite({
          label: "l",
          tasks: [{ id: "a", text: "one" }],
          seededPatternIds: ["both", "fine"],
          supersededPatternIds: ["both"],
        })
      ).toThrow("as both seeded and superseded");
    });

    it("throws for superseded pattern identifiers that are not strings", () => {
      expect(() =>
        parseMeasurementSuite({
          label: "l",
          tasks: [{ id: "a", text: "one" }],
          supersededPatternIds: [{}],
        })
      ).toThrow("supersededPatternIds must be a list of strings");
    });

    it("throws for seeded pattern identifiers that are not strings", () => {
      expect(() =>
        parseMeasurementSuite({
          label: "l",
          tasks: [{ id: "a", text: "one" }],
          seededPatternIds: [1],
        })
      ).toThrow("must be a list of strings");
    });

    it("throws for two tasks sharing an id", () => {
      expect(() =>
        parseMeasurementSuite({
          label: "l",
          tasks: [{ id: "a", text: "one" }, { id: "a", text: "two" }],
        })
      ).toThrow("two tasks share the id a");
    });
  });

  describe("readSseFrames()", () => {
    const streamOf = (text: string): ReadableStream<Uint8Array> => {
      const encoder = new TextEncoder();
      return new ReadableStream<Uint8Array>({
        start(controller) {
          // One byte at a time, so a frame split across reads is exercised.
          for (const byte of encoder.encode(text)) {
            controller.enqueue(new Uint8Array([byte]));
          }
          controller.close();
        },
      });
    };

    it("returns each frame's event name, data and sequence", async () => {
      const frames = [];
      for await (
        const frame of readSseFrames(
          streamOf(': connected\n\nevent: chat\nid: 4\ndata: {"a":1}\n\n'),
        )
      ) {
        frames.push(frame);
      }
      expect(frames).toEqual([{ event: "chat", data: '{"a":1}', id: 4 }]);
    });

    it("returns no frame for a comment-only stream", async () => {
      const frames = [];
      for await (const frame of readSseFrames(streamOf(": connected\n\n"))) {
        frames.push(frame);
      }
      expect(frames).toEqual([]);
    });
  });

  describe("indexChangeOf()", () => {
    const before: IndexSnapshot = {
      kind: "read",
      patterns: [patternOf("kept", 1), patternOf("gone", 2)] as never,
    };
    const after: IndexSnapshot = {
      kind: "read",
      patterns: [patternOf("kept", 5), patternOf("fresh", 0)] as never,
    };

    it("returns the patterns added, removed and rescored between two readings", () => {
      const change = indexChangeOf(before, after);
      expect(change?.added.map((pattern) => pattern.patternId)).toEqual([
        "fresh",
      ]);
      expect(change?.removed.map((pattern) => pattern.patternId)).toEqual([
        "gone",
      ]);
      expect(change?.rescored).toEqual([
        { patternId: "kept", before: 1, after: 5 },
      ]);
    });

    it("returns `undefined` when either reading was not taken", () => {
      const unread: IndexSnapshot = { kind: "unread", reason: "no index" };
      expect(indexChangeOf(unread, after)).toBeUndefined();
      expect(indexChangeOf(before, unread)).toBeUndefined();
    });
  });

  describe("ConsoleClient", () => {
    describe("open()", () => {
      it("throws naming the status for a server whose health does not answer", async () => {
        const server = Deno.serve(
          { port: 0, onListen: () => {} },
          () => new Response("not a console", { status: 404 }),
        );
        try {
          await expect(
            ConsoleClient.open(
              `http://127.0.0.1:${(server.addr as Deno.NetAddr).port}`,
            ),
          ).rejects.toThrow("/api/health answered 404");
        } finally {
          await server.shutdown();
        }
      });
    });

    describe("awaitTurn()", () => {
      it("returns the terminal event the console published for the turn", async () => {
        const console_ = startFakeConsole({ streams: [completedStream()] });
        try {
          const client = await ConsoleClient.open(console_.url);
          const started = await client.startTask("Track my books.");
          expect(await client.awaitTurn(started)).toEqual({
            kind: "turn_completed",
            detail: "Your reading list is at /reading-list.",
          });
        } finally {
          await console_.close();
        }
      });

      it("resumes from the newest sequence it read when the stream is reopened", async () => {
        const console_ = startFakeConsole({
          streams: [
            // A stream the server closes having advanced the sequence: real
            // progress, so the client reconnects rather than giving up. A
            // liveness tick alone would not be — frames are not progress.
            {
              frames: [
                chatFrame(4, "session-1", {
                  kind: "assistant_completed",
                  text: "working",
                }),
              ],
              keepOpen: false,
            },
            completedStream(11),
          ],
        });
        try {
          const client = await ConsoleClient.open(console_.url);
          const started = await client.startTask("Track my books.");
          expect((await client.awaitTurn(started)).kind).toBe("turn_completed");
          // The reconnect resumes from the sequence the first stream reached,
          // which is both the resume contract and the progress measure.
          expect(console_.eventRequests).toEqual(["0", "4"]);
          const second = await client.startTask("Track my films.");
          await client.awaitTurn(second);
          expect(console_.eventRequests[2]).toBe("11");
        } finally {
          await console_.close();
        }
      });

      it("returns the failure the console reported for a turn that failed", async () => {
        const console_ = startFakeConsole({
          streams: [{
            frames: [
              chatFrame(5, "session-1", {
                kind: "turn_failed",
                turnId: "turn-1",
                error: { message: "the model refused the request" },
              }),
            ],
            keepOpen: true,
          }],
        });
        try {
          const client = await ConsoleClient.open(console_.url);
          const started = await client.startTask("Track my books.");
          expect(await client.awaitTurn(started)).toEqual({
            kind: "turn_failed",
            detail: "the model refused the request",
          });
        } finally {
          await console_.close();
        }
      });

      it("keeps reading past `turn_canceled` until the console reports the session idle", async () => {
        const console_ = startFakeConsole({
          streams: [{
            frames: [
              chatFrame(5, "session-1", {
                kind: "turn_canceled",
                turnId: "turn-1",
                reason: "canceled from the console page",
              }),
              // The service emits the cancel while the prompt loop is still
              // unwinding, so the run is not on disk until this arrives.
              chatFrame(6, "session-1", {
                kind: "status_changed",
                session: { sessionId: "session-1", status: "idle" },
              }),
            ],
            keepOpen: true,
          }],
        });
        try {
          const client = await ConsoleClient.open(console_.url);
          const started = await client.startTask("Track my books.");
          expect(await client.awaitTurn(started)).toEqual({
            kind: "turn_canceled",
            detail: "canceled from the console page",
          });
        } finally {
          await console_.close();
        }
      });

      it("reports a canceled turn as unwitnessed when the console never says the session went idle", async () => {
        const console_ = startFakeConsole({
          streams: [{
            frames: [
              chatFrame(5, "session-1", {
                kind: "turn_canceled",
                turnId: "turn-1",
              }),
            ],
            keepOpen: false,
          }],
        });
        try {
          const client = await ConsoleClient.open(console_.url);
          const started = await client.startTask("Track my books.");
          const outcome = await client.awaitTurn(started);
          expect(outcome.kind).toBe("unwitnessed");
          expect(outcome.kind === "unwitnessed" ? outcome.reason : "")
            .toContain("may be half written");
        } finally {
          await console_.close();
        }
      });

      it("stops rather than reopening forever when a reconnect replays what it already read", async () => {
        // Frames arriving is not progress. Two identical streams deliver
        // frames and advance nothing; counting those as progress reopens the
        // stream for as long as the console repeats itself.
        const replay = {
          frames: [
            chatFrame(1, "session-1", {
              kind: "assistant_completed",
              text: "thinking",
            }),
          ],
          keepOpen: false,
        };
        const replaying = startFakeConsole({ streams: [replay, replay] });
        try {
          const client = await ConsoleClient.open(replaying.url);
          const started = await client.startTask("Track my books.");
          const outcome = await client.awaitTurn(started);
          expect(outcome.kind).toBe("unwitnessed");
          expect(outcome.kind === "unwitnessed" ? outcome.reason : "")
            .toContain("without advancing past 1");
          expect(replaying.eventRequests).toHaveLength(2);
        } finally {
          await replaying.close();
        }
      });

      it("stops when a held cancel is followed by a replay that advances nothing", async () => {
        const canceled = {
          frames: [
            chatFrame(5, "session-1", {
              kind: "turn_canceled",
              turnId: "turn-1",
            }),
          ],
          keepOpen: false,
        };
        const console_ = startFakeConsole({ streams: [canceled, canceled] });
        try {
          const client = await ConsoleClient.open(console_.url);
          const started = await client.startTask("Track my books.");
          const outcome = await client.awaitTurn(started);
          expect(outcome.kind).toBe("unwitnessed");
          expect(outcome.kind === "unwitnessed" ? outcome.reason : "")
            .toContain("may be half written");
        } finally {
          await console_.close();
        }
      });

      it("reopens a stream that faulted part way and reads the turn from the next one", async () => {
        const console_ = startFakeConsole({
          streams: [
            {
              frames: [
                chatFrame(3, "session-1", {
                  kind: "assistant_completed",
                  text: "working",
                }),
              ],
              keepOpen: false,
              fault: true,
            },
            completedStream(12),
          ],
        });
        try {
          const client = await ConsoleClient.open(console_.url);
          const started = await client.startTask("Track my books.");
          expect((await client.awaitTurn(started)).kind).toBe("turn_completed");
        } finally {
          await console_.close();
        }
      });

      it("reports a stream that faulted having read nothing as unwitnessed", async () => {
        const console_ = startFakeConsole({
          streams: [{ frames: [], keepOpen: false, fault: true }],
        });
        try {
          const client = await ConsoleClient.open(console_.url);
          const started = await client.startTask("Track my books.");
          const outcome = await client.awaitTurn(started);
          expect(outcome.kind).toBe("unwitnessed");
          expect(outcome.kind === "unwitnessed" ? outcome.reason : "")
            .toContain("faulted without advancing past");
        } finally {
          await console_.close();
        }
      });

      it("describes a completed turn that carried no final text", async () => {
        const console_ = startFakeConsole({
          streams: [{
            frames: [
              chatFrame(5, "session-1", {
                kind: "turn_completed",
                turnId: "turn-1",
              }),
            ],
            keepOpen: true,
          }],
        });
        try {
          const client = await ConsoleClient.open(console_.url);
          const started = await client.startTask("Track my books.");
          expect((await client.awaitTurn(started)).kind).toBe("turn_completed");
        } finally {
          await console_.close();
        }
      });

      it("returns an unwitnessed outcome naming the status when the console refuses the stream", async () => {
        const console_ = startFakeConsole({
          streams: [completedStream()],
          eventStatus: 503,
        });
        try {
          const client = await ConsoleClient.open(console_.url);
          const started = await client.startTask("Track my books.");
          expect(await client.awaitTurn(started)).toEqual({
            kind: "unwitnessed",
            reason: "/api/events answered 503",
          });
        } finally {
          await console_.close();
        }
      });

      it("reads past a liveness tick, which is not a chat envelope", async () => {
        const console_ = startFakeConsole({
          streams: [{
            frames: [
              "event: ping\ndata: 1\n\n",
              ...completedStream(6).frames,
            ],
            keepOpen: true,
          }],
        });
        try {
          const client = await ConsoleClient.open(console_.url);
          const started = await client.startTask("Track my books.");
          expect((await client.awaitTurn(started)).kind).toBe("turn_completed");
        } finally {
          await console_.close();
        }
      });

      it("reads past a terminal event belonging to another turn of the same session", async () => {
        const console_ = startFakeConsole({
          streams: [{
            frames: [
              chatFrame(4, "session-1", {
                kind: "turn_completed",
                turnId: "turn-earlier",
                finalText: "an older turn",
              }),
              ...completedStream(9).frames,
            ],
            keepOpen: true,
          }],
        });
        try {
          const client = await ConsoleClient.open(console_.url);
          const started = await client.startTask("Track my books.");
          expect(await client.awaitTurn(started)).toEqual({
            kind: "turn_completed",
            detail: "Your reading list is at /reading-list.",
          });
        } finally {
          await console_.close();
        }
      });

      it("returns an unwitnessed outcome for a stream the console closes having said nothing", async () => {
        const console_ = startFakeConsole({
          streams: [{ frames: [], keepOpen: false }],
        });
        try {
          const client = await ConsoleClient.open(console_.url);
          const started = await client.startTask("Track my books.");
          expect(await client.awaitTurn(started)).toEqual({
            kind: "unwitnessed",
            reason:
              "the console closed the event stream without advancing past 0",
          });
        } finally {
          await console_.close();
        }
      });

      it("reads past an event belonging to another session", async () => {
        const console_ = startFakeConsole({
          streams: [{
            frames: [
              chatFrame(3, "someone-else", {
                kind: "turn_completed",
                turnId: "turn-9",
              }),
              ...completedStream(9).frames,
            ],
            keepOpen: true,
          }],
        });
        try {
          const client = await ConsoleClient.open(console_.url);
          const started = await client.startTask("Track my books.");
          expect((await client.awaitTurn(started)).kind).toBe("turn_completed");
        } finally {
          await console_.close();
        }
      });
    });
  });

  describe("readServerMeta()", () => {
    it("returns the commit, the CFC block and the experimental flags the server reported", async () => {
      expect(await readServerMeta("http://server", metaFetch(META)))
        .toEqual(META);
    });

    it("returns an error naming the status for a server that refused the read", async () => {
      expect(await readServerMeta("http://server", metaFetch({}, 503)))
        .toEqual({ error: "/api/meta answered 503" });
    });

    it("returns an error for a server that could not be reached", async () => {
      const failing = (() =>
        Promise.reject(
          new Error("connection refused"),
        )) as typeof globalThis.fetch;
      const meta = await readServerMeta("http://server", failing);
      expect("error" in meta && meta.error).toContain("connection refused");
    });
  });

  describe("readAncestry()", () => {
    it("returns `ancestor` for a commit on the branch", async () => {
      expect(await readAncestry("abc", "main", gitRun(true, true)))
        .toEqual({ kind: "ancestor", base: "main" });
    });

    it("returns `diverged` for a commit the branch does not contain", async () => {
      expect(await readAncestry("abc", "main", gitRun(true, false)))
        .toEqual({ kind: "diverged", base: "main" });
    });

    it("returns `unchecked` when git fails to answer, rather than reporting the commit as off the branch", async () => {
      // `merge-base --is-ancestor` exits 1 for "not an ancestor" and other
      // codes for failing to answer at all — an unknown base, a broken repo.
      const reading = await readAncestry(
        "abc",
        "main",
        (args) =>
          Promise.resolve(
            args[0] === "cat-file"
              ? { success: true, code: 0 }
              : { success: false, code: 128 },
          ),
      );
      expect(reading.kind).toBe("unchecked");
      expect(reading.kind === "unchecked" ? reading.reason : "").toContain(
        "exited 128",
      );
    });

    it("returns `unchecked` for a commit this clone does not hold, which is not the same as one off the branch", async () => {
      const reading = await readAncestry("abc", "main", gitRun(false, false));
      expect(reading.kind).toBe("unchecked");
      expect(reading.kind === "unchecked" ? reading.reason : "").toContain(
        "does not hold abc",
      );
    });

    it("asks git itself when given no runner", async () => {
      // No repository holds the all-zero commit, and a checkout that does not
      // hold a commit reads as unchecked wherever this runs.
      const reading = await readAncestry("0".repeat(40), "main");
      expect(reading.kind).toBe("unchecked");
      expect(reading.kind === "unchecked" ? reading.reason : "").toContain(
        `does not hold ${"0".repeat(40)}`,
      );
    });

    it("returns `unchecked` for a server that reported no commit", async () => {
      expect(await readAncestry(undefined, "main", gitRun(true, true)))
        .toEqual({
          kind: "unchecked",
          reason: "the server reported no gitSha",
        });
    });
  });

  describe("preflightPosture()", () => {
    it("returns a refusal for a server on a commit off the branch", async () => {
      const posture = await preflightPosture(
        "http://server",
        "main",
        undefined,
        metaFetch(META),
        gitRun(true, false),
      );
      expect(posture.kind).toBe("refused");
      expect(posture.kind === "refused" ? posture.reason : "").toContain(
        "off main",
      );
      expect(posture.kind === "refused" ? posture.ancestry : undefined)
        .toEqual({ kind: "diverged", base: "main" });
    });

    it("returns the reading for an explicitly allowed divergent server", async () => {
      const posture = await preflightPosture(
        "http://server",
        "main",
        undefined,
        metaFetch(META),
        gitRun(true, false),
        true,
      );
      expect(posture.kind).toBe("read");
      expect(posture.kind === "read" ? posture.ancestry.kind : undefined).toBe(
        "diverged",
      );
    });

    it("returns a reading for a server whose CFC dials are off, which is the production-server preset rather than a fault", async () => {
      const posture = await preflightPosture(
        "http://server",
        "main",
        undefined,
        metaFetch(META),
        gitRun(true, true),
      );
      expect(posture.kind).toBe("read");
      expect(posture.kind === "read" ? posture.meta.cfc : undefined).toEqual(
        META.cfc,
      );
    });

    it("returns a refusal for a commit the batch was told to expect and did not find", async () => {
      const posture = await preflightPosture(
        "http://server",
        "main",
        "0000000",
        metaFetch(META),
        gitRun(true, true),
      );
      expect(posture.kind).toBe("refused");
      expect(posture.kind === "refused" ? posture.reason : "").toContain(
        "told to expect the fabric server on 0000000",
      );
    });

    it("returns the reading for a commit the batch expected and found", async () => {
      expect(
        (await preflightPosture(
          "http://server",
          "main",
          META.gitSha,
          metaFetch(META),
          gitRun(true, true),
        )).kind,
      ).toBe("read");
    });

    it("returns a refusal for a server that could not be read", async () => {
      const posture = await preflightPosture(
        "http://server",
        "main",
        undefined,
        metaFetch({}, 500),
        gitRun(true, true),
      );
      expect(posture.kind).toBe("refused");
    });
  });

  describe("classifyImportedPattern()", () => {
    const seeded = new Set(["seed-a", "seed-b"]);
    const EMPTY: ReadonlySet<string> = new Set();

    it("returns `seeded` for a pattern the suite named", () => {
      expect(classifyImportedPattern("seed-a", seeded, EMPTY, [])).toEqual({
        kind: "seeded",
      });
    });

    it("returns `seeded-via-alias` for a pattern that depends on a seeded one", () => {
      expect(classifyImportedPattern("alias", seeded, EMPTY, ["seed-b"]))
        .toEqual({
          kind: "seeded-via-alias",
          through: ["seed-b"],
          throughSuperseded: [],
        });
    });

    it("returns `seeded-superseded` for a seed a later publication replaced", () => {
      expect(
        classifyImportedPattern("old", seeded, new Set(["old"]), []),
      ).toEqual({ kind: "seeded-superseded" });
    });

    it("keeps the superseded fact for an alias of a superseded seed", () => {
      // Folded into `through`, this would report the alias as reaching a live
      // seed and drop that the committed source cannot rebuild what it
      // actually reaches.
      expect(
        classifyImportedPattern("alias", seeded, new Set(["old"]), ["old"]),
      ).toEqual({
        kind: "seeded-via-alias",
        through: [],
        throughSuperseded: ["old"],
      });
    });

    it("returns `pre-existing` for a pattern depending on nothing seeded", () => {
      expect(classifyImportedPattern("other", seeded, EMPTY, ["unrelated"]))
        .toEqual({
          kind: "pre-existing",
        });
    });

    it("returns `unresolved` rather than `pre-existing` when the index would not say", () => {
      expect(classifyImportedPattern("other", seeded, EMPTY, undefined).kind)
        .toBe("unresolved");
    });
  });

  describe("resolveImportedPatternOrigins()", () => {
    it("resolves each identifier once, one dependency hop deep", async () => {
      const console_ = startFakeConsole({
        streams: [completedStream()],
        dependencies: { alias: ["pub-rating"], other: ["unrelated"] },
      });
      try {
        const client = await ConsoleClient.open(console_.url);
        expect(
          await resolveImportedPatternOrigins(
            client,
            ["pub-rating", "alias", "other"],
            ["pub-rating"],
          ),
        ).toEqual({
          "pub-rating": { kind: "seeded" },
          alias: {
            kind: "seeded-via-alias",
            through: ["pub-rating"],
            throughSuperseded: [],
          },
          other: { kind: "pre-existing" },
        });
      } finally {
        await console_.close();
      }
    });
  });

  describe("readServerMeta()/readAncestry() edges", () => {
    it("returns only what the server reported, omitting fields it did not send", async () => {
      expect(
        await readServerMeta("http://server", metaFetch({ gitSha: "abc" })),
      ).toEqual({ gitSha: "abc" });
    });

    it("returns `unchecked` when git itself cannot be run", async () => {
      const reading = await readAncestry("abc", "main", () => {
        throw new Error("git is not on the path");
      });
      expect(reading.kind).toBe("unchecked");
      // Distinct from "this clone does not hold that commit", which is what a
      // git that ran and answered would have said.
      expect(reading.kind === "unchecked" ? reading.reason : "").toContain(
        "git could not be run here",
      );
    });
  });

  describe("index reads against a console that has gone away", () => {
    /**
     * Opens a client and then stops the server under it, so the next request
     * fails at the socket rather than with a status. That is the shape of a
     * console an unattended batch outlives, and it is the only way to reach
     * these paths: an HTTP error is an answer, and this is the absence of one.
     */
    const clientWithNoServer = async (): Promise<ConsoleClient> => {
      const console_ = startFakeConsole({ streams: [completedStream()] });
      const client = await ConsoleClient.open(console_.url);
      await console_.close();
      return client;
    };

    it("returns a refusal naming the fault for a pre-flight that could not reach the console", async () => {
      const preflight = await (await clientWithNoServer()).preflightIndex(
        "pattern",
      );
      expect(preflight.kind).toBe("refused");
      expect(preflight.kind === "refused" ? preflight.reason : "").not.toBe("");
    });

    it("returns an unread snapshot for a listing that could not reach the console", async () => {
      const snapshot = await (await clientWithNoServer()).indexSnapshot();
      expect(snapshot.kind).toBe("unread");
      expect(snapshot.kind === "unread" ? snapshot.reason : "").not.toBe("");
    });

    it("refuses the status pre-flight when the console has gone away", async () => {
      const preflight = await (await clientWithNoServer()).preflightStatus();
      expect(preflight.kind).toBe("refused");
      expect(preflight.kind === "refused" ? preflight.reason : "").toContain(
        "/api/status could not be read",
      );
    });
  });

  describe("status pre-flight response shapes", () => {
    it("refuses a status answer that is not an object", async () => {
      const server = Deno.serve({ port: 0, onListen: () => {} }, (request) => {
        const url = new URL(request.url);
        if (url.pathname === "/api/health") {
          return Response.json({ ok: true });
        }
        return Response.json("not an object");
      });
      try {
        const client = await ConsoleClient.open(
          `http://127.0.0.1:${(server.addr as Deno.NetAddr).port}`,
        );
        expect(await client.preflightStatus()).toEqual({
          kind: "refused",
          reason: "/api/status did not return a JSON object",
        });
      } finally {
        await server.shutdown();
      }
    });
  });

  describe("indexSnapshot() shapes", () => {
    it("returns an unread snapshot for an answer that is not an object", async () => {
      const console_ = startFakeConsole({
        streams: [completedStream()],
        indexAnswer: { status: 200, body: "not an object" },
      });
      try {
        const client = await ConsoleClient.open(console_.url);
        expect(await client.indexSnapshot()).toEqual({
          kind: "unread",
          reason: "the index answered with no object",
        });
      } finally {
        await console_.close();
      }
    });

    it("reads each listed pattern and the count the index left out of the listing", async () => {
      const console_ = startFakeConsole({
        streams: [completedStream()],
        indexAnswer: {
          status: 200,
          body: {
            patterns: [
              { ...patternOf("shown", 3), discoverable: true },
              { patternId: "bare" },
            ],
            nonDiscoverableCount: 17,
          },
        },
      });
      try {
        const client = await ConsoleClient.open(console_.url);
        const snapshot = await client.indexSnapshot();
        expect(snapshot.kind).toBe("read");
        if (snapshot.kind !== "read") return;
        expect(snapshot.nonDiscoverableCount).toBe(17);
        expect(snapshot.patterns[0]).toEqual({
          patternId: "shown",
          description: "shown does a thing.",
          score: 3,
          events: { published: 1 },
          discoverable: true,
        });
        // A row with nothing on it still reads, with the absences visible.
        expect(snapshot.patterns[1].description).toBe("");
        expect(Number.isNaN(snapshot.patterns[1].score)).toBe(true);
        expect(snapshot.patterns[1].discoverable).toBeUndefined();
      } finally {
        await console_.close();
      }
    });
  });

  describe("startTask()", () => {
    it("throws for a console that answered without a session and turn", async () => {
      const server = Deno.serve({ port: 0, onListen: () => {} }, (request) => {
        const url = new URL(request.url);
        if (url.pathname === "/api/health") {
          return Response.json({ ok: true });
        }
        return Response.json({ nothing: true });
      });
      try {
        const client = await ConsoleClient.open(
          `http://127.0.0.1:${(server.addr as Deno.NetAddr).port}`,
        );
        await expect(client.startTask("do a thing")).rejects.toThrow(
          "answered without a session and turn",
        );
      } finally {
        await server.shutdown();
      }
    });
  });

  describe("readSupersededVisibility()", () => {
    it("returns whether each named pattern is still offered in search", async () => {
      const console_ = startFakeConsole({
        streams: [completedStream()],
        discoverable: { archived: false, live: true },
      });
      try {
        const client = await ConsoleClient.open(console_.url);
        expect(
          await readSupersededVisibility(client, ["archived", "live", "quiet"]),
        ).toEqual({ archived: false, live: true, quiet: undefined });
      } finally {
        await console_.close();
      }
    });
  });

  describe("preflightCellSpec()", () => {
    const withClient = async (
      options: FakeConsoleOptions,
      body: (client: ConsoleClient) => Promise<void>,
    ): Promise<void> => {
      const console_ = startFakeConsole(options);
      try {
        await body(await ConsoleClient.open(console_.url));
      } finally {
        await console_.close();
      }
    };

    it("returns `unasked` for a batch that named no spec", async () => {
      await withClient({ streams: [] }, async (client) => {
        expect(await preflightCellSpec(client, undefined)).toEqual({
          kind: "unasked",
        });
      });
    });

    it("returns a match for a spec every field of which the console satisfies", async () => {
      await withClient({ streams: [] }, async (client) => {
        const spec = {
          requiredToolIds: ["run_pattern", "search_patterns"],
          requiredSubagentProfiles: ["pattern-author"],
          fabricSpace: "measurement",
        };
        const preflight = await preflightCellSpec(client, spec);
        expect(preflight.kind).toBe("matched");
      });
    });

    it("returns a refusal naming each mismatched field with expected against actual", async () => {
      await withClient({ streams: [] }, async (client) => {
        const preflight = await preflightCellSpec(client, {
          fabricSpace: "other-space",
          requiredToolIds: ["record_feedback"],
          forbiddenToolIds: ["shell"],
        });
        expect(preflight.kind).toBe("refused");
        const mismatches = preflight.kind === "refused"
          ? preflight.mismatches ?? []
          : [];
        expect(mismatches.map((mismatch) => mismatch.field)).toEqual([
          "fabricSpace",
          "allowedToolIds (must include)",
          "allowedToolIds (must exclude)",
        ]);
        expect(preflight.kind === "refused" ? preflight.reason : "").toContain(
          "expected other-space; this console reports measurement",
        );
      });
    });

    it("returns a refusal for a console that does not serve the policy route", async () => {
      await withClient({ streams: [], policy: null }, async (client) => {
        const preflight = await preflightCellSpec(client, {
          fabricSpace: "measurement",
        });
        expect(preflight.kind).toBe("refused");
        expect(preflight.kind === "refused" ? preflight.reason : "").toContain(
          "/api/policy could not be read",
        );
      });
    });

    it("returns a refusal for a policy answer carrying no tool list", async () => {
      await withClient({
        streams: [],
        policy: { fabricSpace: "measurement", artifactRoot: "/console/runs" },
      }, async (client) => {
        const preflight = await preflightCellSpec(client, {
          fabricSpace: "measurement",
        });
        expect(preflight.kind).toBe("refused");
        expect(preflight.kind === "refused" ? preflight.reason : "").toContain(
          "did not report allowedToolIds as a list of strings",
        );
      });
    });

    it("returns a refusal for a policy answer that is not a JSON object", async () => {
      await withClient(
        { streams: [], policy: "measurement" },
        async (client) => {
          const preflight = await preflightCellSpec(client, {
            fabricSpace: "measurement",
          });
          expect(preflight.kind).toBe("refused");
          expect(preflight.kind === "refused" ? preflight.reason : "")
            .toContain(
              "did not return a JSON object",
            );
        },
      );
    });

    it("returns a refusal for a tool list holding something other than strings", async () => {
      await withClient({
        streams: [],
        policy: { ...POLICY, allowedToolIds: ["shell", 7] },
      }, async (client) => {
        const preflight = await preflightCellSpec(client, {
          fabricSpace: "measurement",
        });
        expect(preflight.kind).toBe("refused");
        expect(preflight.kind === "refused" ? preflight.reason : "").toContain(
          "did not report allowedToolIds as a list of strings",
        );
      });
    });

    it("returns a refusal for a policy answer naming no space", async () => {
      await withClient({
        streams: [],
        policy: { ...POLICY, fabricSpace: undefined },
      }, async (client) => {
        const preflight = await preflightCellSpec(client, {
          fabricSpace: "measurement",
        });
        expect(preflight.kind).toBe("refused");
        expect(preflight.kind === "refused" ? preflight.reason : "").toContain(
          "did not report fabricSpace as a string",
        );
      });
    });

    it("refuses a spec asserting no prompt against a console that left the field out, rather than reading it as none", async () => {
      // Absent and `null` are the same value to a reader that coerces, and
      // they are different facts: one console says it seeds no prompt, the
      // other says nothing at all.

      await withClient({
        streams: [],
        policy: { ...POLICY, systemPromptSha256: undefined },
      }, async (client) => {
        const preflight = await preflightCellSpec(client, {
          systemPromptSha256: null,
        });
        expect(preflight.kind).toBe("refused");
        expect(preflight.kind === "refused" ? preflight.reason : "").toContain(
          "this console said nothing about it",
        );
      });
    });

    it("returns a match for a console that reported an explicit `null` prompt and store", async () => {
      await withClient({
        streams: [],
        policy: { ...POLICY, systemPromptSha256: null, sessionDbPath: null },
      }, async (client) => {
        expect(
          (await preflightCellSpec(client, {
            systemPromptSha256: null,
            sessionDbPath: null,
          })).kind,
        ).toBe("matched");
      });
    });
  });

  describe("preflightIndex()", () => {
    it("returns the result and candidate counts for an index that answered", async () => {
      const console_ = startFakeConsole({ streams: [completedStream()] });
      try {
        const client = await ConsoleClient.open(console_.url);
        expect(await client.preflightIndex("pattern")).toEqual({
          kind: "answered",
          results: 0,
          candidates: 30,
        });
      } finally {
        await console_.close();
      }
    });

    it("returns a refusal naming the status for an index that refused the identity", async () => {
      const console_ = startFakeConsole({
        streams: [completedStream()],
        indexAnswer: {
          status: 403,
          body: { error: "DID is not allowlisted" },
        },
      });
      try {
        const client = await ConsoleClient.open(console_.url);
        const preflight = await client.preflightIndex("pattern");
        expect(preflight.kind).toBe("refused");
        expect(
          preflight.kind === "refused" ? preflight.reason : "",
        ).toContain("403");
        expect(
          preflight.kind === "refused" ? preflight.reason : "",
        ).toContain("DID is not allowlisted");
      } finally {
        await console_.close();
      }
    });

    it("returns a refusal for an answer carrying no results array, which is not a count of nothing", async () => {
      const console_ = startFakeConsole({
        streams: [completedStream()],
        indexAnswer: { status: 200, body: { ok: true } },
      });
      try {
        const client = await ConsoleClient.open(console_.url);
        const preflight = await client.preflightIndex("pattern");
        expect(preflight.kind).toBe("refused");
        expect(preflight.kind === "refused" ? preflight.reason : "").toContain(
          "no results array",
        );
      } finally {
        await console_.close();
      }
    });

    it("returns an answer for an index that answered with nothing, which is a state to measure", async () => {
      const console_ = startFakeConsole({
        streams: [completedStream()],
        indexAnswer: { status: 200, body: { results: [] } },
      });
      try {
        const client = await ConsoleClient.open(console_.url);
        expect(await client.preflightIndex("pattern")).toEqual({
          kind: "answered",
          results: 0,
        });
      } finally {
        await console_.close();
      }
    });
  });

  describe("indexSnapshot()", () => {
    it("returns an unread snapshot naming the status for an index the console refused", async () => {
      const console_ = startFakeConsole({
        streams: [completedStream()],
        indexAnswer: { status: 404, body: { error: "no index configured" } },
      });
      try {
        const client = await ConsoleClient.open(console_.url);
        const snapshot = await client.indexSnapshot();
        expect(snapshot.kind).toBe("unread");
        expect(snapshot.kind === "unread" ? snapshot.reason : "").toContain(
          "404",
        );
      } finally {
        await console_.close();
      }
    });

    it("returns an unread snapshot for an answer carrying no pattern list", async () => {
      const console_ = startFakeConsole({
        streams: [completedStream()],
        indexAnswer: { status: 200, body: { ok: true } },
      });
      try {
        const client = await ConsoleClient.open(console_.url);
        expect(await client.indexSnapshot()).toEqual({
          kind: "unread",
          reason: "the index answered with no pattern list",
        });
      } finally {
        await console_.close();
      }
    });
  });

  describe("dependenciesOf()", () => {
    it("returns `undefined` for a pattern the index would not answer for, which classifies as unresolved", async () => {
      const console_ = startFakeConsole({
        streams: [completedStream()],
        indexAnswer: { status: 500, body: { error: "boom" } },
      });
      try {
        const client = await ConsoleClient.open(console_.url);
        expect(await client.dependenciesOf("anything")).toBeUndefined();
        expect(
          (await resolveImportedPatternOrigins(client, ["anything"], ["seed"]))
            .anything.kind,
        ).toBe("unresolved");
      } finally {
        await console_.close();
      }
    });
  });

  describe("runTask()", () => {
    it("measures the run family identified by the console turn", async () => {
      const console_ = startFakeConsole({
        streams: [completedStream()],
        runId: "fixture-run",
        artifactRoot: FIXTURE_ROOT,
      });
      try {
        const client = await ConsoleClient.open(console_.url);
        const result = await runTask(
          client,
          { id: "books", text: "Track the books I am reading." },
          () => {},
          RUN_TASK_OPTIONS,
        );
        expect(console_.taskTexts).toEqual(["Track the books I am reading."]);
        expect(result.runId).toBe("fixture-run");
        expect(result.measurement?.runs.map((run) => run.runId)).toEqual([
          "fixture-run",
          "fixture-run.subagent.1",
        ]);
        expect(result.measurement?.totals.searches).toBe(5);
        expect(result.measurement?.totals.searchesRefused).toBe(1);
        expect(result.configuration.skillsRoot).toBe("/repo/skills");
        expect(result.configuration.skillsFound).toBe(2);
      } finally {
        await console_.close();
      }
    });

    it("prefers the session artifact root to the console-wide fallback", async () => {
      const console_ = startFakeConsole({
        streams: [completedStream()],
        runId: "fixture-run",
        artifactRoot: FIXTURE_ROOT,
        statusArtifactRoot: "/a/different/console-wide/root",
      });
      try {
        const client = await ConsoleClient.open(console_.url);
        const result = await runTask(
          client,
          { id: "books", text: "Track the books I am reading." },
          () => {},
          {
            ...RUN_TASK_OPTIONS,
            artifactRoot: "/no/such/fallback/root",
          },
        );
        expect(result.measurement?.totals.runPatterns).toBe(4);
      } finally {
        await console_.close();
      }
    });

    it("records that the artifact root could not be listed rather than reporting no calls", async () => {
      const console_ = startFakeConsole({
        streams: [completedStream()],
        runId: "fixture-run",
        artifactRoot: "/no/such/artifact/root",
      });
      try {
        const client = await ConsoleClient.open(console_.url);
        const result = await runTask(
          client,
          { id: "books", text: "Track the books I am reading." },
          () => {},
          RUN_TASK_OPTIONS,
        );
        expect(result.measurement).toBeUndefined();
        expect(result.measurementUnread).toContain(
          "the artifact root could not be listed",
        );
      } finally {
        await console_.close();
      }
    });

    it("counts no skills for a registry whose skills field is not a list", async () => {
      const dir = await Deno.makeTempDir();
      try {
        await writeRunCandidate(
          dir,
          "fixture-run",
          "2026-08-28T21:00:01.000Z",
          "do a thing",
        );
        await Deno.writeTextFile(
          `${dir}/fixture-run/skill-registry.json`,
          JSON.stringify({ skillsRoot: "/repo/skills", skills: "lots" }),
        );
        const console_ = startFakeConsole({
          streams: [completedStream()],
          runId: "fixture-run",
          artifactRoot: dir,
        });
        try {
          const client = await ConsoleClient.open(console_.url);
          const result = await runTask(
            client,
            { id: "a", text: "do a thing" },
            () => {},
            RUN_TASK_OPTIONS,
          );
          expect(result.configuration.skillsRoot).toBe("/repo/skills");
          expect(result.configuration.skillsFound).toBe(0);
        } finally {
          await console_.close();
        }
      } finally {
        // the directory is removed by this block's afterEach
      }
    });

    it("records a skill registry that could not be read for a reason other than absence", async () => {
      const dir = await Deno.makeTempDir();
      try {
        await writeRunCandidate(
          dir,
          "fixture-run",
          "2026-08-28T21:00:01.000Z",
          "do a thing",
        );
        await Deno.mkdir(`${dir}/fixture-run/skill-registry.json`);
        const console_ = startFakeConsole({
          streams: [completedStream()],
          runId: "fixture-run",
          artifactRoot: dir,
        });
        try {
          const client = await ConsoleClient.open(console_.url);
          const result = await runTask(
            client,
            { id: "a", text: "do a thing" },
            () => {},
            RUN_TASK_OPTIONS,
          );
          expect(result.configuration.skillsUnread).toContain(
            "skill-registry.json could not be read",
          );
        } finally {
          await console_.close();
        }
      } finally {
        // the directory is removed by this block's afterEach
      }
    });

    it("records a skill registry that names no skills root as its own reading", async () => {
      const dir = await Deno.makeTempDir();
      try {
        await writeRunCandidate(
          dir,
          "fixture-run",
          "2026-08-28T21:00:01.000Z",
          "do a thing",
        );
        await Deno.writeTextFile(
          `${dir}/fixture-run/skill-registry.json`,
          JSON.stringify({ type: "cf-harness.skill-registry", skills: [] }),
        );
        const console_ = startFakeConsole({
          streams: [completedStream()],
          runId: "fixture-run",
          artifactRoot: dir,
        });
        try {
          const client = await ConsoleClient.open(console_.url);
          const result = await runTask(
            client,
            { id: "books", text: "do a thing" },
            () => {},
            RUN_TASK_OPTIONS,
          );
          expect(result.configuration.skillsUnread).toBe(
            "skill-registry.json names no skills root",
          );
        } finally {
          await console_.close();
        }
      } finally {
        // the directory is removed by this block's afterEach
      }
    });

    it("records a missing turn artifact without selecting another task", async () => {
      const artifactRoot = await Deno.makeTempDir();
      try {
        await writeRunCandidate(
          artifactRoot,
          "another-turn",
          "2026-08-28T21:00:01.000Z",
          "same task",
        );
        const console_ = startFakeConsole({
          streams: [completedStream()],
          artifactRoot,
        });
        try {
          const result = await runTask(
            await ConsoleClient.open(console_.url),
            { id: "one", text: "same task" },
            () => {},
            { ...RUN_TASK_OPTIONS, artifactRoot },
          );
          expect(result.measurement).toBeUndefined();
          expect(result.measurementUnread).toContain(
            "no root run turn-1 created after",
          );
        } finally {
          await console_.close();
        }
      } finally {
        await Deno.remove(artifactRoot, { recursive: true });
      }
    });

    it("joins the exact turn despite host context, repeated tasks, and unrelated unread artifacts", async () => {
      const artifactRoot = await Deno.makeTempDir();
      try {
        for (const runId of ["turn-1", "another-turn"]) {
          await writeRunCandidate(
            artifactRoot,
            runId,
            "2026-08-28T21:00:01.000Z",
            "same task",
          );
        }
        await Deno.writeTextFile(
          `${artifactRoot}/turn-1/transcript.json`,
          JSON.stringify([
            { role: "user", content: "Host opening research: a complete kit" },
            { role: "user", content: "same task" },
          ]),
        );
        await Deno.writeTextFile(
          `${artifactRoot}/another-turn/run-state.json`,
          "{",
        );
        const console_ = startFakeConsole({
          streams: [completedStream()],
          artifactRoot,
        });
        try {
          const result = await runTask(
            await ConsoleClient.open(console_.url),
            { id: "one", text: "same task" },
            () => {},
            { ...RUN_TASK_OPTIONS, artifactRoot },
          );
          expect(result.runId).toBe(result.turnId);
          expect(result.measurement?.runs.map((run) => run.runId)).toEqual([
            "turn-1",
          ]);
          expect(result.measurement?.runs[0].transcript).toEqual({
            kind: "read",
            value: { messages: 2 },
          });
        } finally {
          await console_.close();
        }
      } finally {
        await Deno.remove(artifactRoot, { recursive: true });
      }
    });

    it("refuses stale, mismatched, or child run identities", async () => {
      const artifactRoot = await Deno.makeTempDir();
      try {
        await writeRunCandidate(
          artifactRoot,
          "turn-1",
          "2026-08-28T21:00:01.000Z",
          "same task",
        );
        for (
          const state of [
            { runId: "turn-1", createdAt: "2026-08-28T20:59:59.000Z" },
            { runId: "different-id", createdAt: "2026-08-28T21:00:01.000Z" },
            {
              runId: "turn-1",
              createdAt: "2026-08-28T21:00:01.000Z",
              lineage: { role: "subagent" },
            },
          ]
        ) {
          await Deno.writeTextFile(
            `${artifactRoot}/turn-1/run-state.json`,
            JSON.stringify(state),
          );
          const console_ = startFakeConsole({
            streams: [completedStream()],
            artifactRoot,
          });
          try {
            const result = await runTask(
              await ConsoleClient.open(console_.url),
              { id: "one", text: "same task" },
              () => {},
              { ...RUN_TASK_OPTIONS, artifactRoot },
            );
            expect(result.runId).toBeUndefined();
          } finally {
            await console_.close();
          }
        }
      } finally {
        await Deno.remove(artifactRoot, { recursive: true });
      }
    });

    it("reports an unread identified run state and keeps an unread transcript attributable", async () => {
      const artifactRoot = await Deno.makeTempDir();
      try {
        await writeRunCandidate(
          artifactRoot,
          "turn-1",
          "2026-08-28T21:00:01.000Z",
          "same task",
        );
        await Deno.writeTextFile(`${artifactRoot}/turn-1/run-state.json`, "[]");
        const console_ = startFakeConsole({
          streams: [completedStream(), completedStream()],
          artifactRoot,
        });
        try {
          const client = await ConsoleClient.open(console_.url);
          const task = { id: "one", text: "same task" };
          const options = { ...RUN_TASK_OPTIONS, artifactRoot };
          const unreadState = await runTask(client, task, () => {}, options);
          expect(unreadState.measurementUnread).toContain(
            "turn-1/run-state.json was not an object",
          );
          await writeRunCandidate(
            artifactRoot,
            "turn-1",
            "2026-08-28T21:00:01.000Z",
            "same task",
          );
          await Deno.writeTextFile(
            `${artifactRoot}/turn-1/transcript.json`,
            "{",
          );
          const unreadTranscript = await runTask(
            client,
            task,
            () => {},
            options,
          );
          expect(unreadTranscript.runId).toBe("turn-1");
          expect(unreadTranscript.measurement?.runs[0].transcript.kind).toBe(
            "unread",
          );
        } finally {
          await console_.close();
        }
      } finally {
        await Deno.remove(artifactRoot, { recursive: true });
      }
    });
  });

  describe("main()", () => {
    const temporaryDirectories: string[] = [];

    afterEach(async () => {
      for (const dir of temporaryDirectories.splice(0)) {
        await Deno.remove(dir, { recursive: true }).catch(() => {});
      }
    });

    /**
     * The real posture reader, with the two questions it asks of the local
     * repository answered by `run` rather than by `git` in the checkout the
     * tests are started in. The stand-in console reports a commit this
     * repository's own history holds, so each case says which repository it
     * means.
     */
    const postureAsking = (
      run: ReturnType<typeof gitRun>,
    ): typeof preflightPosture =>
    (fabricApiUrl, base, expectGitSha, fetchImpl, _run, allowDiverged) =>
      preflightPosture(
        fabricApiUrl,
        base,
        expectGitSha,
        fetchImpl,
        run,
        allowDiverged,
      );

    /** A repository holding the commit, with it on the base branch. */
    const POSTURE_ON_THE_BASE_BRANCH = postureAsking(gitRun(true, true));

    /**
     * Runs the command against a stand-in console, in a temporary directory
     * holding the suite it is given and receiving the report it writes.
     * `/api/meta` is served by the same stand-in, so the whole command runs
     * without a fabric server, a model, or an index.
     */
    const runMain = async (
      options: FakeConsoleOptions,
      suite: unknown,
      extraArgs: readonly string[] = [],
      postureReader: typeof preflightPosture = POSTURE_ON_THE_BASE_BRANCH,
    ): Promise<{ code: number; logs: string[]; dir: string }> => {
      const dir = await Deno.makeTempDir();
      // Registered before anything can throw, so the directory is removed
      // however this call ends. A caller's own `finally` cannot do that: if
      // `await runMain(...)` rejects, the destructuring throws and the
      // caller's cleanup never runs at all.
      temporaryDirectories.push(dir);
      let consoleOptions = options;
      if (options.artifactRoot === FIXTURE_ROOT) {
        const artifactRoot = `${dir}/runs`;
        await copy(FIXTURE_ROOT, artifactRoot);
        consoleOptions = {
          ...options,
          artifactRoot,
          touchRunState: true,
        };
      }
      const console_ = startFakeConsole(consoleOptions);
      try {
        const suitePath = `${dir}/suite.json`;
        await Deno.writeTextFile(suitePath, JSON.stringify(suite));
        const logs: string[] = [];
        const code = await main(
          [
            suitePath,
            `--console=${console_.url}`,
            `--fabric-api-url=${console_.url}`,
            `--out=${dir}/out`,
            ...extraArgs,
          ],
          (line) => logs.push(line),
          postureReader,
        );
        return { code, logs, dir };
      } finally {
        await console_.close();
      }
    };

    const ONE_TASK = {
      label: "one task",
      tasks: [{ id: "books", text: "Track the books I am reading." }],
    };

    it("returns 0 and writes both reports for a batch whose tasks all completed", async () => {
      const { code, dir, logs } = await runMain({
        streams: [completedStream()],
        runId: "fixture-run",
        artifactRoot: FIXTURE_ROOT,
      }, ONE_TASK);
      try {
        expect(code).toBe(0);
        const report = await Deno.readTextFile(`${dir}/out/report.md`);
        expect(report).toContain("# Pattern index measurement — one task");
        expect(report).toContain("Track the books I am reading.");
        expect(report).toContain("## What composed what");
        const json = JSON.parse(
          await Deno.readTextFile(`${dir}/out/report.json`),
        );
        expect(json.results).toHaveLength(1);
        expect(json.results[0].outcome.kind).toBe("turn_completed");
        expect(logs.some((line) => line.startsWith("fabric server at"))).toBe(
          true,
        );
      } finally {
        // the directory is removed by this block's afterEach
      }
    });

    it("returns 3 and runs no task when the index does not answer the pre-flight", async () => {
      const { code, dir, logs } = await runMain({
        streams: [completedStream()],
        indexAnswer: { status: 403, body: { error: "DID is not allowlisted" } },
      }, { ...ONE_TASK, supersededPatternIds: ["stale-one"] });
      try {
        expect(code).toBe(3);
        const report = await Deno.readTextFile(`${dir}/out/report.md`);
        expect(report).toContain(
          "**The batch refused to start, so no task ran.**",
        );
        // Declared and never asked about, rather than dropped: a refusal must
        // not report a suite that named superseded seeds as one that did not.
        expect(report).toContain("could not be read");
        expect(report).toContain("Nothing below ran.");
        expect(
          logs.some((line) => line.includes("the index did not answer")),
        ).toBe(true);
        const json = JSON.parse(
          await Deno.readTextFile(`${dir}/out/report.json`),
        );
        expect(json.results).toHaveLength(0);
      } finally {
        // the directory is removed by this block's afterEach
      }
    });

    /** Writes a cell spec beside the suite and points the command at it. */
    const cellSpecArgs = async (
      dir: string,
      spec: unknown,
    ): Promise<readonly string[]> => {
      const path = `${dir}/cell.json`;
      await Deno.writeTextFile(path, JSON.stringify(spec));
      return [`--cell-spec=${path}`];
    };

    it("returns 6, starts no task, and names each mismatch when the console is not the cell", async () => {
      const specDir = await Deno.makeTempDir();
      temporaryDirectories.push(specDir);
      const args = await cellSpecArgs(specDir, {
        label: "phase 3",
        fabricSpace: "somewhere-else",
        forbiddenSubagentProfiles: ["pattern-author"],
      });
      const { code, dir, logs } = await runMain(
        { streams: [completedStream()] },
        ONE_TASK,
        args,
      );
      expect(code).toBe(6);
      const report = await Deno.readTextFile(`${dir}/out/report.md`);
      expect(report).toContain(
        "**The console was not the cell this batch was told to measure, so no task ran.**",
      );
      expect(report).toContain(
        "`fabricSpace`: expected somewhere-else, and this console reports measurement",
      );
      expect(report).toContain(
        "`allowedSubagentProfiles (must exclude)`: expected none of pattern-author",
      );
      expect(report).toContain(
        "the cell spec pre-flight refused first, so the index was not asked",
      );
      expect(
        logs.some((line) =>
          line.includes("the console is not the cell this batch names")
        ),
      ).toBe(true);
      const json = JSON.parse(
        await Deno.readTextFile(`${dir}/out/report.json`),
      );
      expect(json.results).toHaveLength(0);
    });

    it("returns 0 and records which fields were checked when the console satisfies the spec", async () => {
      const specDir = await Deno.makeTempDir();
      temporaryDirectories.push(specDir);
      const args = await cellSpecArgs(specDir, {
        label: "phase 3",
        fabricSpace: "measurement",
        requiredToolIds: ["run_pattern", "search_patterns"],
        requiredSubagentProfiles: ["pattern-author"],
        systemPromptSha256: POLICY.systemPromptSha256,
        sessionDbPath: POLICY.sessionDbPath,
      });
      const { code, dir } = await runMain(
        {
          streams: [completedStream()],
          runId: "fixture-run",
          artifactRoot: FIXTURE_ROOT,
        },
        ONE_TASK,
        args,
      );
      expect(code).toBe(0);
      const report = await Deno.readTextFile(`${dir}/out/report.md`);
      expect(report).toContain("Checked against the cell spec `phase 3`");
      expect(report).toContain("fabricSpace");
      expect(report).toContain("Fields the spec does not name are unchecked.");
    });

    it("returns 6 when a spec was named and the console will not disclose its policy", async () => {
      const specDir = await Deno.makeTempDir();
      temporaryDirectories.push(specDir);
      const args = await cellSpecArgs(specDir, { fabricSpace: "measurement" });
      const { code, dir } = await runMain(
        {
          streams: [completedStream()],
          policy: null,
        },
        ONE_TASK,
        args,
      );
      expect(code).toBe(6);
      const report = await Deno.readTextFile(`${dir}/out/report.md`);
      expect(report).toContain("would not say what a session here runs under");
    });

    it("throws for a spec that asserts nothing, before any socket is opened", async () => {
      const specDir = await Deno.makeTempDir();
      temporaryDirectories.push(specDir);
      const args = await cellSpecArgs(specDir, { label: "asserts nothing" });
      await expect(
        runMain({ streams: [completedStream()] }, ONE_TASK, args),
      ).rejects.toThrow("a cell spec asserts nothing");
    });

    it("returns 4 and does not ask the index when the server is not the expected commit", async () => {
      const { code, dir } = await runMain(
        { streams: [completedStream()] },
        ONE_TASK,
        ["--expect-git-sha=0000000"],
      );
      try {
        expect(code).toBe(4);
        const report = await Deno.readTextFile(`${dir}/out/report.md`);
        expect(report).toContain(
          "**The fabric server did not satisfy the batch's commit contract",
        );
        // Pin the reason, not just the header: a `/api/meta` this stand-in
        // refused outright would print the same header and mean something
        // else entirely.
        expect(report).toContain(
          `told to expect the fabric server on 0000000, and it reports ${META.gitSha}`,
        );
        expect(report).toContain(
          "the commit pre-flight refused first, so the index was not asked",
        );
      } finally {
        // the directory is removed by this block's afterEach
      }
    });

    it("runs the batch when the local repository cannot place the server's commit, which is not divergence", async () => {
      // The shape a shallow clone gives: git answers, and what it answers is
      // that it does not hold the commit.
      const { code, dir } = await runMain(
        {
          streams: [completedStream()],
          runId: "fixture-run",
          artifactRoot: FIXTURE_ROOT,
        },
        ONE_TASK,
        [],
        postureAsking(gitRun(false, false)),
      );
      expect(code).toBe(0);
      const report = await Deno.readTextFile(`${dir}/out/report.md`);
      expect(report).toContain(
        `NOT CHECKED — this clone does not hold ${META.gitSha}`,
      );
      const json = JSON.parse(
        await Deno.readTextFile(`${dir}/out/report.json`),
      );
      expect(json.results).toHaveLength(1);
    });

    it("returns 4 for known divergence unless the explicit opt-out is passed", async () => {
      const postureReader = postureAsking(gitRun(true, false));
      const refused = await runMain(
        { streams: [completedStream()] },
        ONE_TASK,
        [],
        postureReader,
      );
      expect(refused.code).toBe(4);
      const allowed = await runMain(
        {
          streams: [completedStream()],
          artifactRoot: FIXTURE_ROOT,
        },
        ONE_TASK,
        ["--allow-diverged"],
        postureReader,
      );
      expect(allowed.code).toBe(0);
    });

    it("runs against `origin/main` by default when local `main` is stale, while honoring `--base=main`", async () => {
      const repository = await Deno.makeTempDir();
      temporaryDirectories.push(repository);
      const runGit = (args: readonly string[]) =>
        new Deno.Command("git", {
          args: [...args],
          cwd: repository,
          clearEnv: true,
          env: {
            PATH: Deno.env.get("PATH") ?? "",
            GIT_CONFIG_NOSYSTEM: "1",
            GIT_CONFIG_GLOBAL: "/dev/null",
            GIT_AUTHOR_NAME: "Test",
            GIT_AUTHOR_EMAIL: "test@example.com",
            GIT_COMMITTER_NAME: "Test",
            GIT_COMMITTER_EMAIL: "test@example.com",
          },
        }).output();
      const git = async (...args: string[]): Promise<string> => {
        const output = await runGit(args);
        expect(output.code, new TextDecoder().decode(output.stderr)).toBe(0);
        return new TextDecoder().decode(output.stdout).trim();
      };
      await git("init", "--bare", "--template=");
      const tree = await git("mktree");
      const stale = await git("commit-tree", tree, "-m", "Local main");
      const current = await git(
        "commit-tree",
        tree,
        "-p",
        stale,
        "-m",
        "Server commit",
      );
      await git("update-ref", "refs/heads/main", stale);
      await git("update-ref", "refs/remotes/origin/main", current);
      const postureReader = postureAsking(runGit);
      const options = {
        streams: [completedStream()],
        runId: "fixture-run",
        artifactRoot: FIXTURE_ROOT,
        meta: { ...META, gitSha: current },
      };

      const explicit = await runMain(
        options,
        ONE_TASK,
        ["--base=main"],
        postureReader,
      );
      expect(explicit.code).toBe(4);
      const refused = JSON.parse(
        await Deno.readTextFile(`${explicit.dir}/out/report.json`),
      );
      expect(refused.posture.ancestry).toEqual({
        kind: "diverged",
        base: "main",
      });
      expect(refused.results).toEqual([]);

      const { code, dir } = await runMain(options, ONE_TASK, [], postureReader);
      expect(code).toBe(0);
      const report = JSON.parse(
        await Deno.readTextFile(`${dir}/out/report.json`),
      );
      expect(report.posture.ancestry).toEqual({
        kind: "ancestor",
        base: "origin/main",
      });
      expect(report.results).toHaveLength(1);
      expect(report.results[0].outcome.kind).toBe("turn_completed");
    });

    it("returns 5 and runs no task when status names no top-level artifact root", async () => {
      const { code, dir, logs } = await runMain({
        streams: [completedStream()],
        statusArtifactRoot: null,
      }, ONE_TASK);
      expect(code).toBe(5);
      expect(logs.join("\n")).toContain("artifactRoot");
      const report = JSON.parse(
        await Deno.readTextFile(`${dir}/out/report.json`),
      );
      expect(report.results).toEqual([]);
    });

    it("returns 5 and runs no task when status names a relative artifact root", async () => {
      const { code, logs } = await runMain({
        streams: [completedStream()],
        statusArtifactRoot: "relative/runs",
      }, ONE_TASK);
      expect(code).toBe(5);
      expect(logs.join("\n")).toContain("absolute");
    });

    it("returns 5 and runs no task when status sessions is not an array", async () => {
      const { code, logs } = await runMain({
        streams: [completedStream()],
        statusSessions: {},
      }, ONE_TASK);
      expect(code).toBe(5);
      expect(logs.join("\n")).toContain("sessions");
    });

    it("returns 1 for a batch whose task did not complete", async () => {
      const { code, dir } = await runMain({
        streams: [{ frames: [], keepOpen: false }],
        runId: "fixture-run",
        artifactRoot: FIXTURE_ROOT,
      }, ONE_TASK);
      try {
        expect(code).toBe(1);
        expect(await Deno.readTextFile(`${dir}/out/report.md`)).toContain(
          "**unwitnessed**",
        );
      } finally {
        // the directory is removed by this block's afterEach
      }
    });

    it("records the notes, the seeded marks and the superseded visibility a full suite asks for", async () => {
      const { dir, code } = await runMain({
        streams: [completedStream()],
        runId: "fixture-run",
        artifactRoot: FIXTURE_ROOT,
        discoverable: { "stale-one": true, "stale-two": false },
        dependencies: { "pub-reading-shelf": [] },
      }, {
        ...ONE_TASK,
        notes: "Run against the gardened corpus.",
        seededPatternIds: ["pub-rating"],
        supersededPatternIds: ["stale-one", "stale-two"],
      });
      try {
        expect(code).toBe(0);
        const report = await Deno.readTextFile(`${dir}/out/report.md`);
        expect(report).toContain("Run against the gardened corpus.");
        expect(report).toContain("`pub-rating` **(seeded)**");
        expect(report).toContain("`pub-reading-shelf` (pre-existing)");
        expect(report).toContain(
          "Of 2 superseded seeds, 1 were still offered in search when this batch started, 1 were withheld, and 0 could not be read.",
        );
      } finally {
        // the directory is removed by this block's afterEach
      }
    });

    it("writes its report under a dated directory when given no --out", async () => {
      const console_ = startFakeConsole({ streams: [completedStream()] });
      const dir = await Deno.makeTempDir();
      const cwd = Deno.cwd();
      try {
        const suitePath = `${dir}/suite.json`;
        await Deno.writeTextFile(suitePath, JSON.stringify(ONE_TASK));
        Deno.chdir(dir);
        const code = await main(
          [
            suitePath,
            `--console=${console_.url}`,
            `--fabric-api-url=${console_.url}`,
          ],
          () => {},
          POSTURE_ON_THE_BASE_BRANCH,
        );
        expect(code).toBe(0);
        const measurements = `${dir}/.cf-harness-console/measurements`;
        const written = [...Deno.readDirSync(measurements)];
        expect(written).toHaveLength(1);
        const out = `${measurements}/${written[0].name}`;
        expect(await Deno.stat(`${out}/report.md`)).toBeDefined();
        // A refusal writes the dated report too, so the result is what says
        // the batch ran and put its report here.
        const json = JSON.parse(await Deno.readTextFile(`${out}/report.json`));
        expect(json.results).toHaveLength(1);
      } finally {
        Deno.chdir(cwd);
        await console_.close();
        await Deno.remove(dir, { recursive: true });
      }
    });

    it("returns 2 and names its usage when given no suite", async () => {
      const logs: string[] = [];
      expect(await main([], (line) => logs.push(line))).toBe(2);
      expect(logs[0]).toContain("usage: measure-batch <suite.json>");
    });

    it("marks a composed pattern as seeded, and one that re-exports it as seeded via alias", async () => {
      const { dir } = await runMain({
        streams: [completedStream()],
        runId: "fixture-run",
        artifactRoot: FIXTURE_ROOT,
        dependencies: { "pub-reading-shelf": ["pub-rating"] },
      }, { ...ONE_TASK, seededPatternIds: ["pub-rating"] });
      try {
        const report = await Deno.readTextFile(`${dir}/out/report.md`);
        expect(report).toContain("`pub-rating` **(seeded)**");
        // The re-exporting entry carries its own identifier, so without the
        // hop it would read as pre-existing and count against the seeding.
        expect(report).toContain(
          "`pub-reading-shelf` **(seeded, via alias of pub-rating)**",
        );
        expect(report).toContain("Hops beyond the first are not resolved.");
      } finally {
        // the directory is removed by this block's afterEach
      }
    });
  });

  describe("renderBatchReport()", () => {
    const reportOf = async (): Promise<string> => {
      const console_ = startFakeConsole({
        streams: [completedStream()],
        runId: "fixture-run",
        artifactRoot: FIXTURE_ROOT,
      });
      try {
        const client = await ConsoleClient.open(console_.url);
        const result = await runTask(
          client,
          { id: "books", text: "Track the books I am reading." },
          () => {},
          RUN_TASK_OPTIONS,
        );
        return renderBatchReport({
          suite: {
            label: "fixture batch",
            tasks: [result.task],
          },
          consoleUrl: console_.url,
          indexUrl: "https://index.example",
          preflight: { kind: "answered", results: 3, candidates: 30 },
          posture: POSTURE,
          importedPatternOrigins: {},
          startedAt: "2026-08-28T21:00:00.000Z",
          endedAt: "2026-08-28T23:00:00.000Z",
          indexBefore: {
            kind: "read",
            patterns: [patternOf("kept", 1)] as never,
          },
          indexAfter: {
            kind: "read",
            patterns: [patternOf("kept", 1), patternOf("fresh", 0)] as never,
          },
          results: [result],
        });
      } finally {
        await console_.close();
      }
    };

    it("quotes each task's text exactly as the session was given it", async () => {
      expect(await reportOf()).toContain("Track the books I am reading.");
    });

    it("names which task imported which published pattern", async () => {
      const report = await reportOf();
      expect(report).toContain("## What composed what");
      expect(report).toContain(
        "- **books** — 2 composing, 0 bare re-export, importing `pub-rating`, `pub-reading-shelf`",
      );
      expect(report).toContain("That is 1 of 1 tasks.");
      expect(report).toContain(
        "The suite named no seeded patterns, so nothing here separates",
      );
    });

    it("marks a composed pattern as seeded or pre-existing when the suite named the seeds", async () => {
      const console_ = startFakeConsole({
        streams: [completedStream()],
        runId: "fixture-run",
        artifactRoot: FIXTURE_ROOT,
      });
      try {
        const client = await ConsoleClient.open(console_.url);
        const result = await runTask(
          client,
          { id: "books", text: "Track the books I am reading." },
          () => {},
          RUN_TASK_OPTIONS,
        );
        const report = renderBatchReport({
          suite: {
            label: "l",
            tasks: [result.task],
            seededPatternIds: ["pub-rating"],
          },
          importedPatternOrigins: {
            "pub-rating": { kind: "seeded" },
            "pub-reading-shelf": { kind: "pre-existing" },
          },
          consoleUrl: console_.url,
          indexUrl: null,
          startedAt: "2026-08-28T21:00:00.000Z",
          endedAt: "2026-08-28T21:00:01.000Z",
          preflight: { kind: "answered", results: 1 },
          posture: POSTURE,
          indexBefore: { kind: "read", patterns: [] as never },
          indexAfter: { kind: "read", patterns: [] as never },
          results: [result],
        });
        expect(report).toContain(
          "`pub-rating` **(seeded)**, `pub-reading-shelf` (pre-existing)",
        );
      } finally {
        await console_.close();
      }
    });

    it("marks origins for a suite that named only superseded seeds", async () => {
      const console_ = startFakeConsole({
        streams: [completedStream()],
        runId: "fixture-run",
        artifactRoot: FIXTURE_ROOT,
      });
      try {
        const client = await ConsoleClient.open(console_.url);
        const result = await runTask(
          client,
          { id: "books", text: "Track the books I am reading." },
          () => {},
          RUN_TASK_OPTIONS,
        );
        const report = renderBatchReport({
          suite: {
            label: "l",
            tasks: [result.task],
            supersededPatternIds: ["pub-rating"],
          },
          consoleUrl: console_.url,
          indexUrl: null,
          startedAt: "2026-08-28T21:00:00.000Z",
          endedAt: "2026-08-28T21:00:01.000Z",
          preflight: { kind: "answered", results: 1 },
          posture: POSTURE,
          importedPatternOrigins: {
            "pub-rating": { kind: "seeded-superseded" },
            "pub-reading-shelf": { kind: "pre-existing" },
          },
          indexBefore: { kind: "read", patterns: [] as never },
          indexAfter: { kind: "read", patterns: [] as never },
          results: [result],
        });
        expect(report).toContain("**(seeded, superseded");
        expect(report).not.toContain("The suite named no seeded patterns");
      } finally {
        await console_.close();
      }
    });

    it("says a referenced-but-uncomposed pattern was referenced rather than that none was imported", () => {
      const report = renderBatchReport({
        suite: { label: "l", tasks: [{ id: "a", text: "do a thing" }] },
        consoleUrl: "http://127.0.0.1:1",
        indexUrl: null,
        startedAt: "2026-08-28T21:00:00.000Z",
        endedAt: "2026-08-28T21:00:01.000Z",
        preflight: { kind: "answered", results: 1 },
        posture: POSTURE,
        importedPatternOrigins: {},
        indexBefore: { kind: "read", patterns: [] as never },
        indexAfter: { kind: "read", patterns: [] as never },
        results: [{
          task: { id: "a", text: "do a thing" },
          sessionId: "s",
          turnId: "t",
          outcome: { kind: "turn_completed", detail: "done" },
          configuration: {},
          measurement: {
            familyId: "f",
            runs: [],
            totals: {
              ...emptyMeasurementTotals(),
              importedPatternIds: ["referenced-only"],
              composedPatternIds: [],
              runPatternsBareImporting: 1,
            },
          },
        }],
      });
      expect(report).toContain("No task composed a published pattern.");
      expect(report).toContain("neither puts a pattern to work");
      expect(report).not.toContain("No task imported a published pattern");
    });

    it("says plainly that no task composed when none did", () => {
      const report = renderBatchReport({
        suite: { label: "l", tasks: [{ id: "a", text: "do a thing" }] },
        consoleUrl: "http://127.0.0.1:1",
        indexUrl: null,
        startedAt: "2026-08-28T21:00:00.000Z",
        endedAt: "2026-08-28T21:00:01.000Z",
        preflight: { kind: "answered", results: 1 },
        posture: POSTURE,
        importedPatternOrigins: {},
        indexBefore: { kind: "read", patterns: [] as never },
        indexAfter: { kind: "read", patterns: [] as never },
        results: [],
      });
      expect(report).toContain("No task imported a published pattern at all.");
    });

    it("names a superseded seed that was still findable when the batch started", () => {
      const report = renderBatchReport({
        suite: {
          label: "l",
          tasks: [{ id: "a", text: "do a thing" }],
          supersededPatternIds: ["stale-a", "stale-b"],
        },
        consoleUrl: "http://127.0.0.1:1",
        indexUrl: null,
        startedAt: "2026-08-28T21:00:00.000Z",
        endedAt: "2026-08-28T21:00:01.000Z",
        preflight: { kind: "answered", results: 1 },
        posture: POSTURE,
        importedPatternOrigins: {},
        supersededVisibility: { "stale-a": true, "stale-b": false },
        indexBefore: { kind: "read", patterns: [] as never },
        indexAfter: { kind: "read", patterns: [] as never },
        results: [],
      });
      expect(report).toContain(
        "Of 2 superseded seeds, 1 were still offered in search when this batch started, 1 were withheld, and 0 could not be read.",
      );
      expect(report).toContain("- `stale-a`");
    });

    it("says a superseded seed's visibility could not be read rather than assuming it was withheld", () => {
      const report = renderBatchReport({
        suite: {
          label: "l",
          tasks: [{ id: "a", text: "do a thing" }],
          supersededPatternIds: ["stale-a"],
        },
        consoleUrl: "http://127.0.0.1:1",
        indexUrl: null,
        startedAt: "2026-08-28T21:00:00.000Z",
        endedAt: "2026-08-28T21:00:01.000Z",
        preflight: { kind: "answered", results: 1 },
        posture: POSTURE,
        importedPatternOrigins: {},
        supersededVisibility: { "stale-a": undefined },
        indexBefore: { kind: "read", patterns: [] as never },
        indexAfter: { kind: "read", patterns: [] as never },
        results: [],
      });
      expect(report).toContain("NOT READ, so nothing here says whether");
    });

    it("marks a composed identifier the batch resolved no origin for", () => {
      const report = renderBatchReport({
        suite: {
          label: "l",
          tasks: [{ id: "a", text: "do a thing" }],
          seededPatternIds: ["seed"],
          supersededPatternIds: ["stale"],
        },
        consoleUrl: "http://127.0.0.1:1",
        indexUrl: null,
        startedAt: "2026-08-28T21:00:00.000Z",
        endedAt: "2026-08-28T21:00:01.000Z",
        preflight: { kind: "answered", results: 1 },
        posture: POSTURE,
        importedPatternOrigins: {
          stale: { kind: "seeded-superseded" },
          mystery: { kind: "unresolved", reason: "the index said nothing" },
        },
        indexBefore: { kind: "read", patterns: [] as never },
        indexAfter: { kind: "read", patterns: [] as never },
        results: [{
          task: { id: "a", text: "do a thing" },
          sessionId: "s",
          turnId: "t",
          outcome: { kind: "turn_completed", detail: "done" },
          configuration: {},
          measurement: {
            familyId: "f",
            runs: [],
            totals: {
              ...emptyMeasurementTotals(),
              importedPatternIds: ["stale", "mystery", "unlisted"],
              composedPatternIds: ["stale", "mystery", "unlisted"],
              runPatternsComposing: 2,
            },
          },
        }],
      });
      expect(report).toContain("**(seeded, superseded");
      expect(report).toContain(
        "`mystery` (ORIGIN NOT RESOLVED — the index said nothing)",
      );
      expect(report).toContain(
        "`unlisted` (ORIGIN NOT RESOLVED — this batch resolved no origin for it)",
      );
    });

    it("names why a superseded seed was superseded, when the suite says", () => {
      const report = renderBatchReport({
        suite: {
          label: "l",
          tasks: [{ id: "a", text: "do a thing" }],
          supersededPatternIds: ["old"],
          supersededReasons: { old: "a defect in it was fixed" },
        },
        consoleUrl: "http://127.0.0.1:1",
        indexUrl: null,
        startedAt: "2026-08-28T21:00:00.000Z",
        endedAt: "2026-08-28T21:00:01.000Z",
        preflight: { kind: "answered", results: 1 },
        posture: POSTURE,
        importedPatternOrigins: { old: { kind: "seeded-superseded" } },
        indexBefore: { kind: "read", patterns: [] as never },
        indexAfter: { kind: "read", patterns: [] as never },
        results: [{
          task: { id: "a", text: "do a thing" },
          sessionId: "s",
          turnId: "t",
          outcome: { kind: "turn_completed", detail: "done" },
          configuration: {},
          measurement: {
            familyId: "f",
            runs: [],
            totals: {
              ...emptyMeasurementTotals(),
              importedPatternIds: ["old"],
              composedPatternIds: ["old"],
              runPatternsComposing: 1,
            },
          },
        }],
      });
      expect(report).toContain(
        "**(seeded, superseded — a defect in it was fixed)**",
      );
    });

    it("names an alias of a superseded seed as reaching what the committed source cannot rebuild", () => {
      const report = renderBatchReport({
        suite: {
          label: "l",
          tasks: [{ id: "a", text: "do a thing" }],
          seededPatternIds: ["live"],
          supersededPatternIds: ["old"],
        },
        consoleUrl: "http://127.0.0.1:1",
        indexUrl: null,
        startedAt: "2026-08-28T21:00:00.000Z",
        endedAt: "2026-08-28T21:00:01.000Z",
        preflight: { kind: "answered", results: 1 },
        posture: POSTURE,
        importedPatternOrigins: {
          alias: {
            kind: "seeded-via-alias",
            through: [],
            throughSuperseded: ["old"],
          },
        },
        indexBefore: { kind: "read", patterns: [] as never },
        indexAfter: { kind: "read", patterns: [] as never },
        results: [{
          task: { id: "a", text: "do a thing" },
          sessionId: "s",
          turnId: "t",
          outcome: { kind: "turn_completed", detail: "done" },
          configuration: {},
          measurement: {
            familyId: "f",
            runs: [],
            totals: {
              ...emptyMeasurementTotals(),
              importedPatternIds: ["alias"],
              composedPatternIds: ["alias"],
              runPatternsComposing: 1,
            },
          },
        }],
      });
      expect(report).toContain(
        "via alias of superseded old, which the committed source cannot rebuild",
      );
    });

    it("names what the batch added to the index", async () => {
      expect(await reportOf()).toContain("`fresh` (score 0)");
    });

    it("states that it does not show whether what a run built works", async () => {
      const report = await reportOf();
      expect(report).toContain(
        "It **does not say whether what a run built works.**",
      );
    });

    it("names the discoverability flag as not recorded when the index answer carries none", async () => {
      expect(await reportOf()).toContain(
        "NOT RECORDED — this index answer carries no discoverability flag",
      );
    });

    it("counts how much of the index is offered in search when the index says", () => {
      const report = renderBatchReport({
        suite: { label: "l", tasks: [{ id: "a", text: "do a thing" }] },
        consoleUrl: "http://127.0.0.1:1",
        indexUrl: null,
        startedAt: "2026-08-28T21:00:00.000Z",
        endedAt: "2026-08-28T21:00:01.000Z",
        preflight: { kind: "answered", results: 1 },
        posture: POSTURE,
        importedPatternOrigins: {},
        indexBefore: {
          kind: "read",
          patterns: [
            { ...patternOf("shown", 1), discoverable: true },
            { ...patternOf("withheld", 0), discoverable: false },
          ] as never,
          nonDiscoverableCount: 4,
        },
        indexAfter: { kind: "read", patterns: [] as never },
        results: [],
      });
      expect(report).toContain(
        "Read from each entry's `discoverable` field: 1 of 2 listed entries are offered in search results, 1 are listed and withheld, and 0 carry no flag either way. The index holds 4 further entries it did not list, recorded and withheld from search.",
      );
    });

    it("names the skills tree the runs scanned and how many skills it held", async () => {
      expect(await reportOf()).toContain(
        "- Skills root: /repo/skills (2 skills)",
      );
    });

    it("says the batch refused to start when the index did not answer the pre-flight", () => {
      const refused: IndexPreflight = {
        kind: "refused",
        reason: "/api/index/call answered 403: DID is not allowlisted",
      };
      const report = renderBatchReport({
        suite: { label: "l", tasks: [{ id: "a", text: "do a thing" }] },
        consoleUrl: "http://127.0.0.1:1",
        indexUrl: null,
        startedAt: "2026-08-28T21:00:00.000Z",
        endedAt: "2026-08-28T21:00:01.000Z",
        preflight: refused,
        posture: POSTURE,
        importedPatternOrigins: {},
        indexBefore: {
          kind: "unread",
          reason: "the pre-flight search was refused",
        },
        indexAfter: {
          kind: "unread",
          reason: "the pre-flight search was refused",
        },
        results: [],
      });
      expect(report).toContain(
        "**The batch refused to start, so no task ran.**",
      );
      expect(report).toContain("403: DID is not allowlisted");
      expect(report).toContain("Nothing below ran.");
    });

    it("says a run answered with nothing was answered rather than refused", async () => {
      expect(await reportOf()).toContain(
        "The index answered a search before the first task: 3 results over 30 candidates examined.",
      );
    });

    it("carries the per-call lines and totals the measurement produced", async () => {
      const report = await reportOf();
      expect(report).toContain("run_pattern by id pub-reading-shelf -> ok");
      expect(report).toContain("composes pub-rating,pub-reading-shelf");
      expect(report).toContain("2 with hits + 1 empty + 1 refused");
    });

    it("says a run was not measured rather than reporting it as a run with no calls", () => {
      const report = renderBatchReport({
        suite: { label: "l", tasks: [{ id: "a", text: "do a thing" }] },
        consoleUrl: "http://127.0.0.1:1",
        indexUrl: null,
        startedAt: "2026-08-28T21:00:00.000Z",
        endedAt: "2026-08-28T21:00:01.000Z",
        preflight: { kind: "answered", results: 1 },
        posture: POSTURE,
        importedPatternOrigins: {},
        indexBefore: { kind: "unread", reason: "no index configured" },
        indexAfter: { kind: "unread", reason: "no index configured" },
        results: [{
          task: { id: "a", text: "do a thing" },
          sessionId: "s",
          turnId: "t",
          outcome: { kind: "unwitnessed", reason: "the stream went away" },
          configuration: {},
          measurementUnread: "the console named no run",
        }],
      });
      expect(report).toContain("NOT MEASURED — the console named no run");
      expect(report).toContain(
        "- Skills root: NOT RECORDED; 1 of 1 runs scanned none",
      );
      expect(report).toContain(
        "Tasks: 1, of which 1 were not measured.",
      );
      expect(report).toContain("- Model: NOT RECORDED");
      expect(report).toContain("NOT READ — no index configured");
      expect(report).toContain(
        "one end of the comparison was never taken",
      );
    });
  });
});
