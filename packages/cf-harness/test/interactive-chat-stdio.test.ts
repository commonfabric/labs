import {
  assertEquals,
  assertRejects,
  assertStringIncludes,
  assertThrows,
} from "@std/assert";
import { fromFileUrl, join, toFileUrl } from "@std/path";
import {
  HARNESS_CHAT_PROTOCOL_VERSION,
  HARNESS_CHAT_REQUEST_TYPE,
  type HarnessChatListEventsResult,
  type HarnessChatListTurnsResult,
  type HarnessChatStatusResult,
} from "../src/contracts/interactive-chat.ts";
import { HARNESS_BROWSER_ACCESS_LEASE_TYPE } from "../src/contracts/browser-access.ts";
import { CFC_PROMPT_SLOT_BOUND_ATOM_TYPE } from "../src/contracts/prompt-slot.ts";
import { DEFAULT_PARENT_TOOL_IDS } from "../src/contracts/tool-descriptor.ts";
import {
  parseHostMountSpecs,
  resolveInteractiveProvisioning,
} from "../src/host-mounts.ts";
import {
  HarnessInteractiveChatService,
  type HarnessInteractivePromptLoopFactory,
} from "../src/interactive-chat-service.ts";
import {
  type HarnessChatStoreHeldRefusal,
  type HarnessInteractiveChatOutputEnvelope,
  parseHarnessInteractiveChatStdioCliOptions,
  runHarnessInteractiveChatNdjsonTransport,
  runHarnessInteractiveChatStdio,
  runHarnessInteractiveChatStdioCli,
  type RunHarnessInteractiveChatStdioOptions,
} from "../src/interactive-chat-stdio.ts";
import type { HarnessPromptLoopResult } from "../src/prompt-loop.ts";
import { HarnessChatStoreHeldError } from "../src/session-store.ts";
import {
  openSqliteHarnessChatSessionStore,
  sqliteHarnessChatSessionStoreHolderPath,
} from "../src/sqlite-session-store.ts";

const decodeLines = (
  lines: readonly string[],
): HarnessInteractiveChatOutputEnvelope[] =>
  lines.map((line) => JSON.parse(line) as HarnessInteractiveChatOutputEnvelope);

const encodeInputLines = (
  lines: readonly string[],
): ReadableStream<Uint8Array> => {
  const encoder = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      for (const line of lines) {
        controller.enqueue(encoder.encode(`${line}\n`));
      }
      controller.close();
    },
  });
};

const captureOutputLines = (): {
  output: WritableStream<Uint8Array>;
  lines: () => string[];
} => {
  const decoder = new TextDecoder();
  let text = "";
  return {
    output: new WritableStream({
      write(chunk) {
        text += decoder.decode(chunk, { stream: true });
      },
      close() {
        text += decoder.decode();
      },
    }),
    lines: () => text.split("\n").filter((line) => line.trim().length > 0),
  };
};

const runStdioCli = async (
  lines: readonly string[],
  args: readonly string[],
): Promise<{
  code: number;
  stdout: string;
  stderr: string;
  envelopes: HarnessInteractiveChatOutputEnvelope[];
}> => {
  const encoder = new TextEncoder();
  const decoder = new TextDecoder();
  const command = new Deno.Command(Deno.execPath(), {
    args: [
      "run",
      "-A",
      fromFileUrl(new URL("../src/interactive-chat-stdio.ts", import.meta.url)),
      ...args,
    ],
    stdin: "piped",
    stdout: "piped",
    stderr: "piped",
  });
  const child = command.spawn();
  const writer = child.stdin.getWriter();
  await writer.write(encoder.encode(lines.map((line) => `${line}\n`).join("")));
  await writer.close();
  const output = await child.output();
  const stdout = decoder.decode(output.stdout);
  const stderr = decoder.decode(output.stderr);
  return {
    code: output.code,
    stdout,
    stderr,
    envelopes: decodeLines(
      stdout.split("\n").filter((line) => line.trim().length > 0),
    ),
  };
};

Deno.test("interactive NDJSON transport emits events and responses", async () => {
  const output: string[] = [];
  await runHarnessInteractiveChatNdjsonTransport({
    lines: [
      JSON.stringify({
        type: HARNESS_CHAT_REQUEST_TYPE,
        protocolVersion: HARNESS_CHAT_PROTOCOL_VERSION,
        requestId: "req-1",
        method: "start_session",
        params: {
          sessionId: "session-1",
          workspace: { hostPath: "/workspace" },
          model: "gpt-test",
        },
      }),
      JSON.stringify({
        type: HARNESS_CHAT_REQUEST_TYPE,
        protocolVersion: HARNESS_CHAT_PROTOCOL_VERSION,
        requestId: "req-2",
        method: "start_turn",
        params: {
          sessionId: "session-1",
          turnId: "turn-1",
          input: { text: "Hello" },
        },
      }),
    ],
    writeLine: (line) => {
      output.push(line);
    },
    createService: (onEvent) =>
      new HarnessInteractiveChatService({
        onEvent,
        now: (() => {
          let counter = 0;
          return () =>
            `2026-05-22T00:00:${String(++counter).padStart(2, "0")}.000Z`;
        })(),
        createPromptLoop: () => ({
          runTranscript: async (options) => {
            const finalMessage = {
              role: "assistant" as const,
              content: "Hello from cf-harness.",
            };
            const transcript = [...options.transcript, finalMessage];
            await options.onTranscriptEvent?.({
              message: finalMessage,
              transcript,
            });
            return {
              model: "gpt-test",
              finalAssistantText: "Hello from cf-harness.",
              transcript,
              modelTurns: 1,
              runState: {} as HarnessPromptLoopResult["runState"],
            };
          },
        }),
      }),
  });

  const envelopes = decodeLines(output);
  assertEquals(
    envelopes.filter((envelope) => "event" in envelope).map((envelope) =>
      "event" in envelope ? envelope.event.kind : ""
    ),
    [
      "session_started",
      "turn_started",
      "assistant_delta",
      "assistant_completed",
      "turn_completed",
    ],
  );
  assertEquals(
    envelopes.filter((envelope) => "ok" in envelope).map((envelope) =>
      "ok" in envelope ? [envelope.requestId, envelope.ok] : undefined
    ),
    [["req-1", true], ["req-2", true]],
  );
});

Deno.test("interactive NDJSON transport waits for active turns before close after write failure", async () => {
  let loopFinished = false;
  let resolveLoop: (() => void) | undefined;
  let closeBeforeLoopFinished = false;
  const service = new HarnessInteractiveChatService({
    onEvent: async () => {},
    createPromptLoop: () => ({
      runTranscript: async (options) => {
        await new Promise<void>((resolve) => {
          resolveLoop = resolve;
        });
        loopFinished = true;
        const finalMessage = {
          role: "assistant" as const,
          content: "done",
        };
        const transcript = [...options.transcript, finalMessage];
        await options.onTranscriptEvent?.({
          message: finalMessage,
          transcript,
        });
        return {
          model: "gpt-test",
          finalAssistantText: "done",
          transcript,
          modelTurns: 1,
          runState: {} as HarnessPromptLoopResult["runState"],
        };
      },
    }),
  });

  await assertRejects(
    () =>
      runHarnessInteractiveChatNdjsonTransport({
        lines: [
          JSON.stringify({
            type: HARNESS_CHAT_REQUEST_TYPE,
            protocolVersion: HARNESS_CHAT_PROTOCOL_VERSION,
            requestId: "req-start-session",
            method: "start_session",
            params: {
              sessionId: "session-1",
              workspace: { hostPath: "/workspace" },
              model: "gpt-test",
            },
          }),
          JSON.stringify({
            type: HARNESS_CHAT_REQUEST_TYPE,
            protocolVersion: HARNESS_CHAT_PROTOCOL_VERSION,
            requestId: "req-start-turn",
            method: "start_turn",
            params: {
              sessionId: "session-1",
              turnId: "turn-1",
              input: { text: "finish later" },
            },
          }),
        ],
        createService: () => service,
        closeService: () => {
          closeBeforeLoopFinished = !loopFinished;
        },
        writeLine: (line) => {
          const envelope = JSON.parse(line) as Record<string, unknown>;
          if (envelope.requestId === "req-start-turn") {
            resolveLoop?.();
            throw new Error("simulated stdout failure");
          }
        },
      }),
    Error,
    "simulated stdout failure",
  );

  assertEquals(loopFinished, true);
  assertEquals(closeBeforeLoopFinished, false);
});

Deno.test("interactive NDJSON transport preserves write failure over close hook failure", async () => {
  let closeCalls = 0;
  const service = new HarnessInteractiveChatService({
    onEvent: async () => {},
  });

  await assertRejects(
    () =>
      runHarnessInteractiveChatNdjsonTransport({
        lines: [
          JSON.stringify({
            type: HARNESS_CHAT_REQUEST_TYPE,
            protocolVersion: HARNESS_CHAT_PROTOCOL_VERSION,
            requestId: "req-start-session",
            method: "start_session",
            params: {
              sessionId: "session-1",
              workspace: { hostPath: "/workspace" },
              model: "gpt-test",
            },
          }),
        ],
        createService: () => service,
        closeService: () => {
          closeCalls += 1;
          throw new Error("simulated close failure");
        },
        writeLine: (line) => {
          const envelope = JSON.parse(line) as Record<string, unknown>;
          if (envelope.requestId === "req-start-session") {
            throw new Error("simulated stdout failure");
          }
        },
      }),
    Error,
    "simulated stdout failure",
  );

  assertEquals(closeCalls, 1);
});

Deno.test("interactive NDJSON transport calls close hook after normal completion", async () => {
  const output: string[] = [];
  let closeCalls = 0;
  const service = new HarnessInteractiveChatService({
    onEvent: async () => {},
  });

  await runHarnessInteractiveChatNdjsonTransport({
    lines: [
      JSON.stringify({
        type: HARNESS_CHAT_REQUEST_TYPE,
        protocolVersion: HARNESS_CHAT_PROTOCOL_VERSION,
        requestId: "req-start-session",
        method: "start_session",
        params: {
          sessionId: "session-1",
          workspace: { hostPath: "/workspace" },
          model: "gpt-test",
        },
      }),
    ],
    createService: () => service,
    closeService: (closedService) => {
      assertEquals(closedService, service);
      closeCalls += 1;
    },
    writeLine: (line) => {
      output.push(line);
    },
  });

  assertEquals(closeCalls, 1);
  assertEquals(
    decodeLines(output).filter((envelope) => "ok" in envelope).map((
      envelope,
    ) => "ok" in envelope ? [envelope.requestId, envelope.ok] : undefined),
    [["req-start-session", true]],
  );
});

Deno.test({
  name: "interactive stdio persists and restores SQLite chat runtime state",
  // Dynamic SQLite imports load a native library that @db/sqlite does not unload.
  sanitizeResources: false,
  fn: async () => {
    const tempDir = await Deno.makeTempDir({
      prefix: "cf-harness-chat-stdio-",
    });
    const dbPath = join(tempDir, "chat.sqlite");
    const createPromptLoop: HarnessInteractivePromptLoopFactory = () => ({
      runTranscript: async (options) => {
        const finalMessage = {
          role: "assistant" as const,
          content: "Persisted over stdio.",
        };
        const transcript = [...options.transcript, finalMessage];
        await options.onTranscriptEvent?.({
          message: finalMessage,
          transcript,
        });
        return {
          model: "gpt-test",
          finalAssistantText: "Persisted over stdio.",
          transcript,
          modelTurns: 1,
          runState: {} as HarnessPromptLoopResult["runState"],
        };
      },
    });
    try {
      const firstOutput = captureOutputLines();
      await runHarnessInteractiveChatStdio({
        sessionDbPath: dbPath,
        createPromptLoop,
        input: encodeInputLines([
          JSON.stringify({
            type: HARNESS_CHAT_REQUEST_TYPE,
            protocolVersion: HARNESS_CHAT_PROTOCOL_VERSION,
            requestId: "req-1",
            method: "start_session",
            params: {
              sessionId: "session-1",
              workspace: { hostPath: "/workspace" },
              model: "gpt-test",
            },
          }),
          JSON.stringify({
            type: HARNESS_CHAT_REQUEST_TYPE,
            protocolVersion: HARNESS_CHAT_PROTOCOL_VERSION,
            requestId: "req-2",
            method: "start_turn",
            params: {
              sessionId: "session-1",
              turnId: "turn-1",
              input: { text: "Remember this" },
            },
          }),
        ]),
        output: firstOutput.output,
      });
      assertEquals(
        decodeLines(firstOutput.lines()).filter((envelope) =>
          "event" in envelope
        )
          .map((envelope) => "event" in envelope ? envelope.event.kind : ""),
        [
          "session_started",
          "turn_started",
          "assistant_delta",
          "assistant_completed",
          "turn_completed",
        ],
      );

      const restoredOutput = captureOutputLines();
      await runHarnessInteractiveChatStdio({
        sessionDbPath: dbPath,
        createPromptLoop,
        input: encodeInputLines([
          JSON.stringify({
            type: HARNESS_CHAT_REQUEST_TYPE,
            protocolVersion: HARNESS_CHAT_PROTOCOL_VERSION,
            requestId: "req-status",
            method: "status",
            params: {
              sessionId: "session-1",
            },
          }),
          JSON.stringify({
            type: HARNESS_CHAT_REQUEST_TYPE,
            protocolVersion: HARNESS_CHAT_PROTOCOL_VERSION,
            requestId: "req-events",
            method: "list_events",
            params: {
              sessionId: "session-1",
              afterSequence: 0,
            },
          }),
          JSON.stringify({
            type: HARNESS_CHAT_REQUEST_TYPE,
            protocolVersion: HARNESS_CHAT_PROTOCOL_VERSION,
            requestId: "req-turns",
            method: "list_turns",
            params: {
              sessionId: "session-1",
              status: "completed",
            },
          }),
        ]),
        output: restoredOutput.output,
      });

      const restoredEnvelopes = decodeLines(restoredOutput.lines());
      const statusResponse = restoredEnvelopes.find((envelope) =>
        "ok" in envelope && envelope.requestId === "req-status"
      );
      const statusResult = statusResponse !== undefined &&
          "ok" in statusResponse && statusResponse.ok
        ? statusResponse.result as HarnessChatStatusResult
        : undefined;
      assertEquals(
        statusResult?.sessions.map((session) => ({
          sessionId: session.sessionId,
          status: session.status,
          turnCount: session.turnCount,
        })),
        [{
          sessionId: "session-1",
          status: "idle",
          turnCount: 1,
        }],
      );

      const eventsResponse = restoredEnvelopes.find((envelope) =>
        "ok" in envelope && envelope.requestId === "req-events"
      );
      const eventsResult = eventsResponse !== undefined &&
          "ok" in eventsResponse && eventsResponse.ok
        ? eventsResponse.result as HarnessChatListEventsResult
        : undefined;
      assertEquals(
        eventsResult?.events.map((event) => event.event.kind),
        [
          "session_started",
          "turn_started",
          "assistant_delta",
          "assistant_completed",
          "turn_completed",
        ],
      );

      const turnsResponse = restoredEnvelopes.find((envelope) =>
        "ok" in envelope && envelope.requestId === "req-turns"
      );
      const turnsResult =
        turnsResponse !== undefined && "ok" in turnsResponse &&
          turnsResponse.ok
          ? turnsResponse.result as HarnessChatListTurnsResult
          : undefined;
      assertEquals(
        turnsResult?.turns.map((turn) => ({
          turnId: turn.turn.turnId,
          status: turn.turn.status,
          input: turn.input,
        })),
        [{
          turnId: "turn-1",
          status: "completed",
          input: { text: "Remember this" },
        }],
      );
    } finally {
      await Deno.remove(tempDir, { recursive: true });
    }
  },
});

Deno.test("interactive stdio CLI persists sessions across process invocations", async () => {
  const tempDir = await Deno.makeTempDir({
    prefix: "cf-harness-chat-stdio-cli-",
  });
  const dbPath = join(tempDir, "chat.sqlite");
  try {
    const first = await runStdioCli([
      JSON.stringify({
        type: HARNESS_CHAT_REQUEST_TYPE,
        protocolVersion: HARNESS_CHAT_PROTOCOL_VERSION,
        requestId: "req-start",
        method: "start_session",
        params: {
          sessionId: "cli-session-1",
          workspace: { hostPath: "/workspace" },
          model: "gpt-test",
        },
      }),
    ], ["--chat-session-db", dbPath]);
    assertEquals(first.code, 0, first.stderr);
    assertEquals(
      first.envelopes.filter((envelope) => "event" in envelope).map((
        envelope,
      ) => "event" in envelope ? envelope.event.kind : ""),
      ["session_started"],
    );
    assertEquals(
      first.envelopes.filter((envelope) => "ok" in envelope).map((
        envelope,
      ) => "ok" in envelope ? [envelope.requestId, envelope.ok] : undefined),
      [["req-start", true]],
    );

    const restored = await runStdioCli([
      JSON.stringify({
        type: HARNESS_CHAT_REQUEST_TYPE,
        protocolVersion: HARNESS_CHAT_PROTOCOL_VERSION,
        requestId: "req-status",
        method: "status",
        params: {
          sessionId: "cli-session-1",
        },
      }),
      JSON.stringify({
        type: HARNESS_CHAT_REQUEST_TYPE,
        protocolVersion: HARNESS_CHAT_PROTOCOL_VERSION,
        requestId: "req-events",
        method: "list_events",
        params: {
          sessionId: "cli-session-1",
          afterSequence: 0,
        },
      }),
    ], [`--chat-session-db=${dbPath}`]);
    assertEquals(restored.code, 0, restored.stderr);
    const statusResponse = restored.envelopes.find((envelope) =>
      "ok" in envelope && envelope.requestId === "req-status"
    );
    const statusResult = statusResponse !== undefined &&
        "ok" in statusResponse && statusResponse.ok
      ? statusResponse.result as HarnessChatStatusResult
      : undefined;
    assertEquals(
      statusResult?.sessions.map((session) => ({
        sessionId: session.sessionId,
        status: session.status,
        turnCount: session.turnCount,
      })),
      [{
        sessionId: "cli-session-1",
        status: "idle",
        turnCount: 0,
      }],
    );

    const eventsResponse = restored.envelopes.find((envelope) =>
      "ok" in envelope && envelope.requestId === "req-events"
    );
    const eventsResult = eventsResponse !== undefined &&
        "ok" in eventsResponse && eventsResponse.ok
      ? eventsResponse.result as HarnessChatListEventsResult
      : undefined;
    assertEquals(
      eventsResult?.events.map((event) => event.event.kind),
      ["session_started"],
    );
  } finally {
    await Deno.remove(tempDir, { recursive: true });
  }
});

Deno.test("interactive stdio bounds in-memory event replay when configured", async () => {
  const output = captureOutputLines();
  await runHarnessInteractiveChatStdio({
    maxInMemoryEvents: 0,
    input: encodeInputLines([
      JSON.stringify({
        type: HARNESS_CHAT_REQUEST_TYPE,
        protocolVersion: HARNESS_CHAT_PROTOCOL_VERSION,
        requestId: "req-start",
        method: "start_session",
        params: {
          sessionId: "session-pruned",
          workspace: { hostPath: "/workspace" },
        },
      }),
      JSON.stringify({
        type: HARNESS_CHAT_REQUEST_TYPE,
        protocolVersion: HARNESS_CHAT_PROTOCOL_VERSION,
        requestId: "req-events",
        method: "list_events",
        params: {
          sessionId: "session-pruned",
          afterSequence: 0,
        },
      }),
    ]),
    output: output.output,
  });

  const envelopes = decodeLines(output.lines());
  assertEquals(
    envelopes.filter((envelope) => "event" in envelope).map((envelope) =>
      "event" in envelope ? envelope.event.kind : undefined
    ),
    ["session_started"],
  );
  const response = envelopes.find((envelope) =>
    "ok" in envelope && envelope.requestId === "req-events"
  );
  const result = response !== undefined && "ok" in response && response.ok
    ? response.result as HarnessChatListEventsResult
    : undefined;
  assertEquals(result, {
    events: [],
    latestSequence: 1,
  });
});

Deno.test({
  name:
    "interactive stdio CLI reports invalid SQLite session DB startup failures",
  // Dynamic SQLite imports load a native library that @db/sqlite does not unload.
  sanitizeResources: false,
  fn: async () => {
    const tempDir = await Deno.makeTempDir({
      prefix: "cf-harness-chat-stdio-bad-db-",
    });
    try {
      const result = await runStdioCli([], [
        "--chat-session-db",
        join(tempDir, "missing", "chat.sqlite"),
      ]);
      assertEquals(result.code, 1);
      assertEquals(result.stdout, "");
      assertEquals(result.envelopes, []);
      assertEquals(result.stderr.trim().length > 0, true);
    } finally {
      await Deno.remove(tempDir, { recursive: true });
    }
  },
});

Deno.test("interactive stdio CLI parses runtime options", () => {
  assertEquals(
    parseHarnessInteractiveChatStdioCliOptions([], {
      CF_HARNESS_CHAT_SESSION_DB: "/tmp/chat.sqlite",
    }),
    {
      sessionDbPath: "/tmp/chat.sqlite",
      help: false,
    },
  );
  assertEquals(
    parseHarnessInteractiveChatStdioCliOptions([
      "--chat-session-db",
      "/tmp/explicit.sqlite",
    ], {
      CF_HARNESS_CHAT_SESSION_DB: "/tmp/env.sqlite",
    }),
    {
      sessionDbPath: "/tmp/explicit.sqlite",
      help: false,
    },
  );
  assertEquals(
    parseHarnessInteractiveChatStdioCliOptions([], {
      CF_HARNESS_CHAT_MAX_IN_MEMORY_EVENTS: "3",
    }),
    {
      maxInMemoryEvents: 3,
      help: false,
    },
  );
  assertEquals(
    parseHarnessInteractiveChatStdioCliOptions([
      "--chat-max-in-memory-events",
      "0",
    ], {}),
    {
      maxInMemoryEvents: 0,
      help: false,
    },
  );
  assertEquals(
    parseHarnessInteractiveChatStdioCliOptions([
      "--chat-session-db=/tmp/inline.sqlite",
      "--chat-max-in-memory-events=2",
      "--help",
    ], {}),
    {
      sessionDbPath: "/tmp/inline.sqlite",
      maxInMemoryEvents: 2,
      help: true,
    },
  );
  assertThrows(
    () =>
      parseHarnessInteractiveChatStdioCliOptions([
        "--chat-max-in-memory-events",
        "-1",
      ], {}),
    Error,
    "--chat-max-in-memory-events requires a non-negative integer value",
  );
  assertThrows(
    () =>
      parseHarnessInteractiveChatStdioCliOptions([
        "--chat-max-in-memory-events=1.5",
      ], {}),
    Error,
    "--chat-max-in-memory-events requires a non-negative integer value",
  );
  assertThrows(
    () =>
      parseHarnessInteractiveChatStdioCliOptions([
        "--chat-max-in-memory-events=9007199254740992",
      ], {}),
    Error,
    "--chat-max-in-memory-events requires a safe non-negative integer value",
  );
  assertThrows(
    () =>
      parseHarnessInteractiveChatStdioCliOptions([
        "--chat-max-in-memory-events",
      ], {}),
    Error,
    "--chat-max-in-memory-events requires a non-empty value",
  );
});

Deno.test("interactive NDJSON transport returns structured parse errors", async () => {
  const output: string[] = [];
  await runHarnessInteractiveChatNdjsonTransport({
    lines: ["not json"],
    writeLine: (line) => {
      output.push(line);
    },
  });

  const envelopes = decodeLines(output);
  assertEquals(envelopes.length, 1);
  const response = envelopes[0];
  assertEquals("ok" in response ? response.ok : true, false);
  assertEquals(
    "ok" in response && response.ok === false ? response.error.code : "",
    "invalid_request",
  );
  assertStringIncludes(
    "ok" in response && response.ok === false ? response.error.message : "",
    "failed to parse chat request JSON:",
  );
});

Deno.test("interactive NDJSON transport accepts list_events requests", async () => {
  const output: string[] = [];
  await runHarnessInteractiveChatNdjsonTransport({
    lines: [
      JSON.stringify({
        type: HARNESS_CHAT_REQUEST_TYPE,
        protocolVersion: HARNESS_CHAT_PROTOCOL_VERSION,
        requestId: "req-1",
        method: "start_session",
        params: {
          sessionId: "session-1",
          workspace: { hostPath: "/workspace" },
        },
      }),
      JSON.stringify({
        type: HARNESS_CHAT_REQUEST_TYPE,
        protocolVersion: HARNESS_CHAT_PROTOCOL_VERSION,
        requestId: "req-2",
        method: "list_events",
        params: {
          sessionId: "session-1",
          afterSequence: 0,
          limit: 10,
        },
      }),
    ],
    writeLine: (line) => {
      output.push(line);
    },
  });

  const response = decodeLines(output).find((envelope) =>
    "ok" in envelope && envelope.requestId === "req-2"
  );
  assertEquals(
    response !== undefined && "ok" in response ? response.ok : false,
    true,
  );
  assertEquals(
    response !== undefined && "ok" in response && response.ok
      ? response.result
      : undefined,
    {
      events: [decodeLines(output)[0]],
      latestSequence: 1,
    },
  );
});

Deno.test("interactive NDJSON transport accepts list_turns requests", async () => {
  const output: string[] = [];
  await runHarnessInteractiveChatNdjsonTransport({
    lines: [
      JSON.stringify({
        type: HARNESS_CHAT_REQUEST_TYPE,
        protocolVersion: HARNESS_CHAT_PROTOCOL_VERSION,
        requestId: "req-1",
        method: "start_session",
        params: {
          sessionId: "session-1",
          workspace: { hostPath: "/workspace" },
        },
      }),
      JSON.stringify({
        type: HARNESS_CHAT_REQUEST_TYPE,
        protocolVersion: HARNESS_CHAT_PROTOCOL_VERSION,
        requestId: "req-2",
        method: "list_turns",
        params: {
          sessionId: "session-1",
          status: "completed",
        },
      }),
    ],
    writeLine: (line) => {
      output.push(line);
    },
  });

  const response = decodeLines(output).find((envelope) =>
    "ok" in envelope && envelope.requestId === "req-2"
  );
  assertEquals(
    response !== undefined && "ok" in response ? response.ok : false,
    true,
  );
  assertEquals(
    response !== undefined && "ok" in response && response.ok
      ? response.result
      : undefined,
    {
      turns: [],
    },
  );
});

Deno.test("interactive NDJSON transport rejects unsupported methods", async () => {
  const output: string[] = [];
  await runHarnessInteractiveChatNdjsonTransport({
    lines: [
      JSON.stringify({
        type: HARNESS_CHAT_REQUEST_TYPE,
        protocolVersion: HARNESS_CHAT_PROTOCOL_VERSION,
        requestId: "req-bad-method",
        method: "delete_everything",
        params: {},
      }),
    ],
    writeLine: (line) => {
      output.push(line);
    },
  });

  const response = decodeLines(output)[0];
  assertEquals("ok" in response ? response.ok : true, false);
  assertEquals(
    "ok" in response && response.ok === false ? response.error.code : "",
    "invalid_request",
  );
});

Deno.test("interactive NDJSON transport validates method-specific params", async () => {
  const output: string[] = [];
  await runHarnessInteractiveChatNdjsonTransport({
    lines: [
      JSON.stringify({
        type: HARNESS_CHAT_REQUEST_TYPE,
        protocolVersion: HARNESS_CHAT_PROTOCOL_VERSION,
        requestId: "req-bad-turn",
        method: "start_turn",
        params: {
          sessionId: "session-1",
          input: {},
        },
      }),
    ],
    writeLine: (line) => {
      output.push(line);
    },
  });

  const response = decodeLines(output)[0];
  assertEquals("ok" in response ? response.ok : true, false);
  assertEquals(
    "ok" in response && response.ok === false ? response.error.code : "",
    "invalid_request",
  );
});

Deno.test("interactive NDJSON transport rejects malformed policy params", async () => {
  const output: string[] = [];
  await runHarnessInteractiveChatNdjsonTransport({
    lines: [
      JSON.stringify({
        type: HARNESS_CHAT_REQUEST_TYPE,
        protocolVersion: HARNESS_CHAT_PROTOCOL_VERSION,
        requestId: "req-bad-policy",
        method: "start_session",
        params: {
          sessionId: "session-1",
          workspace: { hostPath: "/workspace" },
          policy: {
            type: "cf-harness.chat-policy",
            toolMode: "workspace-write",
          },
        },
      }),
    ],
    writeLine: (line) => {
      output.push(line);
    },
  });

  const response = decodeLines(output)[0];
  assertEquals("ok" in response ? response.ok : true, false);
  assertEquals(
    "ok" in response && response.ok === false ? response.error.code : "",
    "invalid_request",
  );
});

Deno.test("interactive NDJSON transport rejects malformed policy prompt slots", async () => {
  const output: string[] = [];
  await runHarnessInteractiveChatNdjsonTransport({
    lines: [
      JSON.stringify({
        type: HARNESS_CHAT_REQUEST_TYPE,
        protocolVersion: HARNESS_CHAT_PROTOCOL_VERSION,
        requestId: "req-bad-prompt-slot",
        method: "start_session",
        params: {
          sessionId: "session-1",
          workspace: { hostPath: "/workspace" },
          policy: {
            type: "cf-harness.chat-policy",
            toolMode: "workspace-write",
            allowedToolIds: ["write_file"],
            allowedSubagentProfiles: [],
            promptSlot: {
              role: "direct-command",
            },
          },
        },
      }),
    ],
    writeLine: (line) => {
      output.push(line);
    },
  });

  const response = decodeLines(output)[0];
  assertEquals("ok" in response ? response.ok : true, false);
  assertEquals(
    "ok" in response && response.ok === false ? response.error.code : "",
    "invalid_request",
  );
});

Deno.test("interactive NDJSON transport accepts valid policy prompt slots", async () => {
  const output: string[] = [];
  await runHarnessInteractiveChatNdjsonTransport({
    lines: [
      JSON.stringify({
        type: HARNESS_CHAT_REQUEST_TYPE,
        protocolVersion: HARNESS_CHAT_PROTOCOL_VERSION,
        requestId: "req-good-prompt-slot",
        method: "start_session",
        params: {
          sessionId: "session-1",
          workspace: { hostPath: "/workspace" },
          policy: {
            type: "cf-harness.chat-policy",
            toolMode: "workspace-write",
            allowedToolIds: ["write_file"],
            allowedSubagentProfiles: [],
            promptSlot: {
              type: CFC_PROMPT_SLOT_BOUND_ATOM_TYPE,
              source: "comment-1",
              role: "direct-command",
              kernelName: "loom",
              surface: "comment-thread",
            },
          },
        },
      }),
    ],
    writeLine: (line) => {
      output.push(line);
    },
  });

  const response = decodeLines(output).find((envelope) =>
    "ok" in envelope && envelope.requestId === "req-good-prompt-slot"
  );
  assertEquals(
    response !== undefined && "ok" in response ? response.ok : false,
    true,
  );
});

Deno.test("interactive NDJSON transport accepts a policy naming the run's default tools", async () => {
  // The default parent surface is what a run advertises, so a client that
  // submits it back must be understood — including whichever tools were added
  // to that surface most recently.
  const output: string[] = [];
  await runHarnessInteractiveChatNdjsonTransport({
    lines: [
      JSON.stringify({
        type: HARNESS_CHAT_REQUEST_TYPE,
        protocolVersion: HARNESS_CHAT_PROTOCOL_VERSION,
        requestId: "req-default-tools",
        method: "start_session",
        params: {
          sessionId: "session-1",
          workspace: { hostPath: "/workspace" },
          policy: {
            type: "cf-harness.chat-policy",
            toolMode: "workspace-write",
            allowedToolIds: [...DEFAULT_PARENT_TOOL_IDS],
            allowedSubagentProfiles: [],
          },
        },
      }),
    ],
    writeLine: (line) => {
      output.push(line);
    },
  });

  const response = decodeLines(output).find((envelope) =>
    "ok" in envelope && envelope.requestId === "req-default-tools"
  );
  assertEquals(
    response !== undefined && "ok" in response ? response.ok : false,
    true,
  );
});

Deno.test("interactive NDJSON transport rejects malformed Browser Access leases", async () => {
  const output: string[] = [];
  await runHarnessInteractiveChatNdjsonTransport({
    lines: [
      JSON.stringify({
        type: HARNESS_CHAT_REQUEST_TYPE,
        protocolVersion: HARNESS_CHAT_PROTOCOL_VERSION,
        requestId: "req-bad-browser-access",
        method: "start_session",
        params: {
          sessionId: "session-1",
          workspace: { hostPath: "/workspace" },
          browserAccess: {},
        },
      }),
    ],
    writeLine: (line) => {
      output.push(line);
    },
  });

  const response = decodeLines(output)[0];
  assertEquals("ok" in response ? response.ok : true, false);
  assertEquals(
    "ok" in response && response.ok === false ? response.error.code : "",
    "invalid_request",
  );
});

Deno.test("interactive NDJSON transport accepts valid Browser Access leases", async () => {
  const output: string[] = [];
  await runHarnessInteractiveChatNdjsonTransport({
    lines: [
      JSON.stringify({
        type: HARNESS_CHAT_REQUEST_TYPE,
        protocolVersion: HARNESS_CHAT_PROTOCOL_VERSION,
        requestId: "req-good-browser-access",
        method: "start_session",
        params: {
          sessionId: "session-1",
          workspace: { hostPath: "/workspace" },
          browserAccess: {
            type: HARNESS_BROWSER_ACCESS_LEASE_TYPE,
            leaseId: "lease-1",
            cdpUrl: "http://127.0.0.1:9222",
            owner: "loom",
            profileMode: "transient",
            accountAccess: "none",
          },
        },
      }),
    ],
    writeLine: (line) => {
      output.push(line);
    },
  });

  const response = decodeLines(output).find((envelope) =>
    "ok" in envelope && envelope.requestId === "req-good-browser-access"
  );
  assertEquals(
    response !== undefined && "ok" in response ? response.ok : false,
    true,
  );
});

Deno.test("interactive NDJSON transport rejects invalid Browser Access profile mode", async () => {
  const output: string[] = [];
  await runHarnessInteractiveChatNdjsonTransport({
    lines: [
      JSON.stringify({
        type: HARNESS_CHAT_REQUEST_TYPE,
        protocolVersion: HARNESS_CHAT_PROTOCOL_VERSION,
        requestId: "req-bad-browser-mode",
        method: "start_session",
        params: {
          sessionId: "session-1",
          workspace: { hostPath: "/workspace" },
          browserAccess: {
            type: HARNESS_BROWSER_ACCESS_LEASE_TYPE,
            leaseId: "lease-1",
            cdpUrl: "http://127.0.0.1:9222",
            profileMode: "loggedout",
          },
        },
      }),
    ],
    writeLine: (line) => {
      output.push(line);
    },
  });

  const response = decodeLines(output)[0];
  assertEquals("ok" in response ? response.ok : true, false);
  assertEquals(
    "ok" in response && response.ok === false ? response.error.code : "",
    "invalid_request",
  );
});

Deno.test("interactive stdio CLI help returns without starting the transport", async () => {
  assertEquals(await runHarnessInteractiveChatStdioCli(["--help"]), undefined);
});

Deno.test("interactive stdio CLI accepts the batch entrypoint's provisioning flags", () => {
  // The interactive host used to parse three flags and throw on everything
  // else, so an embedder could provision a batch run and not a chat session.
  // Loom shipped cf-harness chat on that gap: no loom mount, no Page RPC, so
  // page authoring silently vanished from chat.
  assertEquals(
    parseHarnessInteractiveChatStdioCliOptions([
      "--host-mount",
      "name=loom,source=/tmp,target=/loom,mode=readonly",
      "--host-mount=name=gtd,source=/tmp,target=/gtd,mode=writable",
      "--max-model-turns",
      "64",
    ], {}),
    {
      hostMountSpecs: [
        "name=loom,source=/tmp,target=/loom,mode=readonly",
        "name=gtd,source=/tmp,target=/gtd,mode=writable",
      ],
      maxModelTurns: 64,
      help: false,
    },
  );
});

Deno.test("interactive stdio CLI accepts the inline --flag=value spelling", () => {
  // Both spellings exist for every other flag on this parser, so both are part
  // of the contract; only the space-separated form was covered.
  assertEquals(
    parseHarnessInteractiveChatStdioCliOptions([
      "--max-model-turns=48",
      "--host-mount=name=gtd,source=/tmp,target=/gtd,mode=writable",
    ], {}),
    {
      hostMountSpecs: ["name=gtd,source=/tmp,target=/gtd,mode=writable"],
      maxModelTurns: 48,
      help: false,
    },
  );
  assertThrows(
    () =>
      parseHarnessInteractiveChatStdioCliOptions(["--max-model-turns=0"], {}),
    Error,
    "requires a positive integer",
  );
});

Deno.test("interactive stdio CLI rejects a zero model-turn budget", () => {
  // 0 would mean "no model turns", which is not a smaller budget, it is a
  // session that cannot answer.
  assertThrows(
    () =>
      parseHarnessInteractiveChatStdioCliOptions(
        ["--max-model-turns", "0"],
        {},
      ),
    Error,
    "requires a positive integer",
  );
});

Deno.test("interactive stdio CLI still rejects unknown arguments", () => {
  assertThrows(
    () => parseHarnessInteractiveChatStdioCliOptions(["--not-a-flag"], {}),
    Error,
    "unsupported interactive chat stdio argument",
  );
});

Deno.test("the standalone stdio entrypoint applies the flags it advertises", async () => {
  // The first version of this change wired only the Loom-local host, so the
  // standalone entrypoint parsed --host-mount, printed it in its usage text and
  // dropped it — the same "second entrypoint, no provisioning" defect this PR
  // exists to remove, one layer in. Both entrypoints now resolve through
  // resolveInteractiveProvisioning.
  const source = await Deno.makeTempDir();
  try {
    const seen: RunHarnessInteractiveChatStdioOptions[] = [];
    await runHarnessInteractiveChatStdioCli(
      [
        "--host-mount",
        `name=loom,source=${source},target=/loom,mode=readonly`,
        "--max-model-turns",
        "64",
      ],
      Deno.cwd(),
      (options) => {
        seen.push(options);
        return Promise.resolve();
      },
    );
    assertEquals(seen.length, 1);
    const base = seen[0].basePromptLoopOptions;
    assertEquals(base?.maxModelTurns, 64);
    assertEquals(base?.additionalMounts?.length, 1);
    assertEquals(base?.additionalMounts?.[0].sandboxPath, "/loom");
    assertEquals(base?.additionalMounts?.[0].readOnly, true);
  } finally {
    await Deno.remove(source, { recursive: true });
  }
});

Deno.test("a typo in a host-mount field is refused, not silently defaulted", async () => {
  // `mdoe=writable` used to fall through to the readonly default and provision
  // a mount the caller believed was writable.
  const source = await Deno.makeTempDir();
  try {
    await assertRejects(
      () =>
        parseHostMountSpecs(
          [`name=loom,source=${source},target=/loom,mdoe=writable`],
          Deno.cwd(),
        ),
      Error,
      "--host-mount field unknown: mdoe",
    );
  } finally {
    await Deno.remove(source, { recursive: true });
  }
});

Deno.test("no provisioning flags leaves the run options untouched", async () => {
  // The other half of the standalone-entrypoint contract: adding these flags
  // must not change what happens when nobody passes them, or every existing
  // embedder gets a behaviour change for free.
  assertEquals(await resolveInteractiveProvisioning({}, Deno.cwd(), {}), {});

  const seen: RunHarnessInteractiveChatStdioOptions[] = [];
  await runHarnessInteractiveChatStdioCli(
    ["--chat-max-in-memory-events", "8"],
    Deno.cwd(),
    (options) => {
      seen.push(options);
      return Promise.resolve();
    },
  );
  assertEquals(seen.length, 1);
  assertEquals(seen[0].basePromptLoopOptions, undefined);
  assertEquals(seen[0].maxInMemoryEvents, 8);
});

Deno.test("resolveInteractiveProvisioning carries a turn budget without mounts", async () => {
  assertEquals(
    await resolveInteractiveProvisioning({ maxModelTurns: 32 }, Deno.cwd(), {}),
    { maxModelTurns: 32 },
  );
});

Deno.test("interactive NDJSON transport reports a failed event write as a transport error", async () => {
  const written: string[] = [];
  const requests = [
    JSON.stringify({
      type: HARNESS_CHAT_REQUEST_TYPE,
      protocolVersion: HARNESS_CHAT_PROTOCOL_VERSION,
      requestId: "req-1",
      method: "start_session",
      params: { sessionId: "session-1", workspace: { hostPath: "/workspace" } },
    }),
    JSON.stringify({
      type: HARNESS_CHAT_REQUEST_TYPE,
      protocolVersion: HARNESS_CHAT_PROTOCOL_VERSION,
      requestId: "req-2",
      method: "start_turn",
      params: {
        sessionId: "session-1",
        turnId: "turn-1",
        input: { text: "Hi" },
      },
    }),
  ];

  await assertRejects(
    () =>
      runHarnessInteractiveChatNdjsonTransport({
        lines: requests,
        writeLine: (line: string) => {
          // Stands in for a peer that has gone away mid-session.
          if (line.includes("turn_completed")) {
            throw new Error("broken pipe");
          }
          written.push(line);
        },
        createService: (onEvent, onEventDeliveryError) =>
          new HarnessInteractiveChatService({
            createPromptLoop: () => ({
              runTranscript: (options) =>
                Promise.resolve({
                  model: "gpt-test",
                  finalAssistantText: "Done.",
                  transcript: [...options.transcript, {
                    role: "assistant" as const,
                    content: "Done.",
                  }],
                  modelTurns: 1,
                  runState: {} as HarnessPromptLoopResult["runState"],
                }),
            }),
            onEvent,
            onEventDeliveryError,
          }),
      }),
    Error,
    "broken pipe",
  );
});

Deno.test("interactive stdio refuses a session database another live process holds", async () => {
  const encoder = new TextEncoder();
  const decoder = new TextDecoder();
  const dir = await Deno.makeTempDir();
  const dbPath = join(dir, "chat.sqlite");
  const args = [
    "run",
    "-A",
    fromFileUrl(new URL("../src/interactive-chat-stdio.ts", import.meta.url)),
    "--chat-session-db",
    dbPath,
  ];
  const first = new Deno.Command(Deno.execPath(), {
    args,
    stdin: "piped",
    stdout: "piped",
    stderr: "piped",
  }).spawn();
  const input = first.stdin.getWriter();
  let firstResponse = "";
  let second: Deno.CommandOutput | undefined;
  try {
    // The response is the first process's proof that it initialized, and so
    // holds the database, before the second process starts.
    await input.write(encoder.encode(`${
      JSON.stringify({
        type: HARNESS_CHAT_REQUEST_TYPE,
        protocolVersion: HARNESS_CHAT_PROTOCOL_VERSION,
        requestId: "req-status",
        method: "status",
        params: {},
      })
    }\n`));
    const reader = first.stdout.getReader();
    while (!firstResponse.includes("\n")) {
      const { value, done } = await reader.read();
      if (done) {
        break;
      }
      firstResponse += decoder.decode(value, { stream: true });
    }
    reader.releaseLock();
    second = await new Deno.Command(Deno.execPath(), {
      args,
      stdin: "null",
      stdout: "piped",
      stderr: "piped",
    }).output();
  } finally {
    await input.close();
  }
  const firstStatus = await first.status;
  const firstStderr = await new Response(first.stderr).text();
  await first.stdout.cancel();
  const resolvedDbPath = await Deno.realPath(dbPath);
  await Deno.remove(dir, { recursive: true });

  assertEquals(firstStatus.code, 0, firstStderr);
  const [statusResponse] = decodeLines([firstResponse.split("\n")[0]]);
  assertEquals("ok" in statusResponse && statusResponse.ok, true);
  assertEquals(second?.code, 1);
  assertEquals(decoder.decode(second?.stdout), "");
  const [refusalLine, message] = decoder.decode(second?.stderr).split("\n");
  const refusal = JSON.parse(refusalLine) as HarnessChatStoreHeldRefusal;
  assertEquals(refusal.kind, "cf-harness.store-held");
  assertEquals(refusal.version, 1);
  assertEquals(refusal.store, resolvedDbPath);
  assertEquals(refusal.holder?.pid, first.pid);
  assertEquals(typeof refusal.holder?.instanceId, "string");
  assertEquals(typeof refusal.holder?.heldSince, "string");
  assertStringIncludes(
    message,
    `cf-harness chat session store ${refusal.store} is held by another live process: instance ${refusal.holder?.instanceId}, pid ${first.pid}, since ${refusal.holder?.heldSince}`,
  );
});

Deno.test("interactive stdio still rejects with `HarnessChatStoreHeldError` when its error output is locked", async () => {
  const dir = await Deno.makeTempDir();
  const dbPath = join(dir, "chat.sqlite");
  const holder = await openSqliteHarnessChatSessionStore({
    url: toFileUrl(dbPath),
  });
  const stdout = captureOutputLines();
  const locked = new WritableStream<Uint8Array>();
  const lock = locked.getWriter();
  try {
    await assertRejects(
      () =>
        runHarnessInteractiveChatStdio({
          sessionDbPath: dbPath,
          input: encodeInputLines([]),
          output: stdout.output,
          errorOutput: locked,
        }),
      HarnessChatStoreHeldError,
    );
    assertEquals(stdout.lines(), []);
  } finally {
    lock.releaseLock();
    holder.close();
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("interactive stdio still rejects with `HarnessChatStoreHeldError` when its error output fails to write", async () => {
  const dir = await Deno.makeTempDir();
  const dbPath = join(dir, "chat.sqlite");
  const holder = await openSqliteHarnessChatSessionStore({
    url: toFileUrl(dbPath),
  });
  const stdout = captureOutputLines();
  const failing = new WritableStream<Uint8Array>({
    write: () => Promise.reject(new Error("the error sink went away")),
  });
  try {
    await assertRejects(
      () =>
        runHarnessInteractiveChatStdio({
          sessionDbPath: dbPath,
          input: encodeInputLines([]),
          output: stdout.output,
          errorOutput: failing,
        }),
      HarnessChatStoreHeldError,
    );
    assertEquals(stdout.lines(), []);
  } finally {
    holder.close();
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("interactive stdio writes one refusal line to its error output for a held session database", async () => {
  const dir = await Deno.makeTempDir();
  const dbPath = join(dir, "chat.sqlite");
  const holder = await openSqliteHarnessChatSessionStore({
    url: toFileUrl(dbPath),
    holder: {
      instanceId: "instance-1",
      pid: Deno.pid,
      heldSince: "2026-09-15T00:00:00.000Z",
    },
  });
  const stdout = captureOutputLines();
  const stderr = captureOutputLines();
  try {
    await assertRejects(
      () =>
        runHarnessInteractiveChatStdio({
          sessionDbPath: dbPath,
          input: encodeInputLines([]),
          output: stdout.output,
          errorOutput: stderr.output,
        }),
      HarnessChatStoreHeldError,
    );
    assertEquals(stdout.lines(), []);
    assertEquals(stderr.lines().map((line) => JSON.parse(line)), [{
      kind: "cf-harness.store-held",
      version: 1,
      store: await Deno.realPath(dbPath),
      holder: {
        instanceId: "instance-1",
        pid: Deno.pid,
        heldSince: "2026-09-15T00:00:00.000Z",
      },
    }]);

    // A record the holder has not finished writing reads as no holder, and
    // the line says so rather than naming nobody.
    await Deno.writeTextFile(
      await sqliteHarnessChatSessionStoreHolderPath(toFileUrl(dbPath)),
      "{",
    );
    const unnamed = captureOutputLines();
    await assertRejects(
      () =>
        runHarnessInteractiveChatStdio({
          sessionDbPath: dbPath,
          input: encodeInputLines([]),
          output: stdout.output,
          errorOutput: unnamed.output,
        }),
      HarnessChatStoreHeldError,
    );
    assertEquals(stdout.lines(), []);
    assertEquals(unnamed.lines().map((line) => JSON.parse(line)), [{
      kind: "cf-harness.store-held",
      version: 1,
      store: await Deno.realPath(dbPath),
      holder: null,
    }]);
  } finally {
    holder.close();
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("resolveInteractiveProvisioning selects the sandbox runtime the environment names", async () => {
  // Same derivation as the batch CLI, so a chat session and a batch run
  // launched from one environment execute in the same sandbox.
  assertEquals(
    await resolveInteractiveProvisioning({}, Deno.cwd(), {
      CF_HARNESS_SANDBOX_RUNTIME: "runsc",
      CF_HARNESS_SANDBOX_ROOTFS: "/r",
      CF_HARNESS_RUNSC_CFC_POLICY: "/p",
      CF_HARNESS_RUNSC_BINARY: "/b",
      CF_HARNESS_DOCKER_NETWORK_MODE: "host",
    }),
    {
      sandboxRuntimeKind: "runsc",
      sandboxRootfs: "/r",
      sandboxCfcPolicy: "/p",
      sandboxRunscBinary: "/b",
      sandboxRunscNetworkMode: "host",
    },
  );
  await assertRejects(
    () =>
      resolveInteractiveProvisioning({}, Deno.cwd(), {
        CF_HARNESS_SANDBOX_RUNTIME: "runsc",
        CF_HARNESS_DOCKER_NETWORK_MODE: "bridgeish",
      }),
    Error,
    "CF_HARNESS_DOCKER_NETWORK_MODE must be one of none, bridge, or host",
  );

  // The default policy the usage text promises is discovered under HOME for
  // the runsc runtime, through the real file system.
  const home = await Deno.makeTempDir();
  try {
    const policy = join(home, ".local", "share", "runsc-cfc", "cfc-policy.json");
    assertEquals(
      await resolveInteractiveProvisioning({}, Deno.cwd(), {
        HOME: home,
        CF_HARNESS_SANDBOX_RUNTIME: "runsc",
      }),
      { sandboxRuntimeKind: "runsc" },
    );
    await Deno.mkdir(join(home, ".local", "share", "runsc-cfc"), {
      recursive: true,
    });
    await Deno.writeTextFile(policy, "{}");
    assertEquals(
      await resolveInteractiveProvisioning({}, Deno.cwd(), {
        HOME: home,
        CF_HARNESS_SANDBOX_RUNTIME: "runsc",
      }),
      { sandboxRuntimeKind: "runsc", sandboxCfcPolicy: policy },
    );
  } finally {
    await Deno.remove(home, { recursive: true });
  }
});

Deno.test("the standalone stdio entrypoint selects the sandbox runtime from its environment", async () => {
  // The standalone entrypoint reads the process environment itself; the
  // Loom-local host is covered in its own suite.
  const previous = Deno.env.get("CF_HARNESS_SANDBOX_RUNTIME");
  Deno.env.set("CF_HARNESS_SANDBOX_RUNTIME", "runsc");
  try {
    const seen: RunHarnessInteractiveChatStdioOptions[] = [];
    await runHarnessInteractiveChatStdioCli([], Deno.cwd(), (options) => {
      seen.push(options);
      return Promise.resolve();
    });
    assertEquals(seen.length, 1);
    assertEquals(seen[0].basePromptLoopOptions?.sandboxRuntimeKind, "runsc");
  } finally {
    if (previous === undefined) {
      Deno.env.delete("CF_HARNESS_SANDBOX_RUNTIME");
    } else {
      Deno.env.set("CF_HARNESS_SANDBOX_RUNTIME", previous);
    }
  }
});
