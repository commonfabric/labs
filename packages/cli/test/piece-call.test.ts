import { assertEquals, assertStringIncludes } from "@std/assert";
import { expect } from "@std/expect";
import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";

import { ValidationError } from "@cliffy/command";
import type { JSONSchema } from "@commonfabric/api";
import { Identity } from "@commonfabric/identity";
import {
  type Cell,
  entityIdFrom,
  type MemorySpace,
  type NormalizedFullLink,
  Runtime,
  type sendEvent,
} from "@commonfabric/runner";
import {
  createLLMFriendlyLink,
  parseLLMFriendlyLink,
} from "@commonfabric/runner/shared";
import { StorageManager } from "@commonfabric/runner/storage/cache.deno";
import { isObjectNotArray } from "@commonfabric/utils/types";

import {
  boundedSettlement,
  exitPieceCallFailure,
  exitWithDataError,
  invocationJson,
  invocationPhaseReporter,
  isPieceGetDataError,
  parseLink,
  parsePieceCallSelection,
  pieceCallInvocation,
  pieceCallPhaseObserver,
  pieceCallRawArgs,
  pieceGetDataErrorReport,
  pieceLinkDataErrorReport,
  renderPieceCallOutcome,
  reportVerbInputErrorOrRethrow,
  resolveInvocationIdentity,
  resolveWaitControl,
  verbInputErrorReport,
  WaitBoundExpired,
} from "../commands/piece.ts";
import {
  type CallableResolution,
  CF_RUNTIME_ERROR_LOG,
  collectInvocationResultLinks,
  executeResolvedCallable,
  normalizeAbsentVerbPayload,
  runtimeErrorLog,
  verbInputSchemaError,
  VerbInputValidationError,
} from "../lib/callable.ts";
import { schemaIsObjectShaped } from "../lib/declared-fields.ts";
import {
  type CellSelection,
  CellSelectionError,
  type deriveSelectedValue,
  parseCellSelectionOptions,
} from "../lib/cell-selection.ts";
import {
  executePieceCallable,
  LinkValidationError,
  PieceResultProjectionError,
  PieceVerbReadError,
  UnknownPieceVerbError,
} from "../lib/piece.ts";
import type { ExecutedPieceCallable } from "../lib/piece.ts";
import { cf, sendThroughStandIn, stripAnsi } from "./utils.ts";
import { createTransactionCommitReceipt } from "../../runner/src/storage/commit-receipt.ts";

/**
 * The runner's own stream-send options, derived from `sendEvent()` rather
 * than restated by hand — so a runner-side rename (`session`, `eventId`)
 * fails `deno task check` on this file instead of leaving these doubles
 * green while production breaks: the #5505/#5582 drift class, one layer
 * down.
 */
type CellSendOptions = NonNullable<Parameters<typeof sendEvent>[3]>;

// The session an invocation id is chosen within, for the calls whose subject
// is something else: a call names the pair or it names no invocation.
const callerSession = "ses:piece-call-test";

describe("executePieceCallable", () => {
  it("reports not-found when the piece cell has no schema-cast surface", async () => {
    // The forced-stream probe's type guard: a piece cell without asSchema
    // cannot take the cast, so the third resolution path returns null and
    // the resolver reports not-found instead of crashing on the probe.
    const emptyChild: Record<string, unknown> = {
      schema: undefined,
      get: () => undefined,
      getRaw: () => undefined,
    };
    emptyChild.key = () => emptyChild;
    emptyChild.asSchemaFromLinks = () => emptyChild;
    const emptyRoot = {
      schema: undefined,
      get: () => ({}),
      getRaw: () => ({}),
      key: () => emptyChild,
      asSchemaFromLinks: () => emptyChild,
    };
    const piece = {
      result: { getCell: () => Promise.resolve(emptyRoot) },
      input: { getCell: () => Promise.resolve(emptyRoot) },
      getCell: () => ({}),
    };
    await expect(
      executePieceCallable(
        {
          apiUrl: "http://localhost:8000",
          identity: "/tmp/test-identity.pem",
          piece: "fid1:piece-123",
          space: "home",
        },
        "missing",
        [],
        {
          loadPieces: () =>
            Promise.resolve({ getSpace: () => "home" } as never),
          loadPiece: () => Promise.resolve(piece as never),
        },
      ),
    ).rejects.toThrow('Callable "missing" not found');

    // A piece exposing no cell at all skips the probe the same way.
    const { getCell: _getCell, ...pieceWithoutCell } = piece;
    await expect(
      executePieceCallable(
        {
          apiUrl: "http://localhost:8000",
          identity: "/tmp/test-identity.pem",
          piece: "fid1:piece-123",
          space: "home",
        },
        "missing",
        [],
        {
          loadPieces: () =>
            Promise.resolve({ getSpace: () => "home" } as never),
          loadPiece: () => Promise.resolve(pieceWithoutCell as never),
        },
      ),
    ).rejects.toThrow('Callable "missing" not found');
  });

  it("starts only the addressed piece before resolving, help page included", async () => {
    // A help page rides the dispatch path because resolution precedes
    // parsing. Its only startup dependency is the addressed piece; the
    // controller records any attempt to initialize the space root too.
    const harness = createPieceCallableHarness({
      callableKind: "handler",
      cellKey: "refresh",
      inputSchema: { type: "object", properties: {} },
    });
    const order: string[] = [];
    const manager = {
      ...harness.pieces,
      ensureDefaultPattern: () => {
        order.push("ensureDefaultPattern");
        return Promise.resolve();
      },
      get: (id: string, runIt: boolean) => {
        order.push(`get:${id}:${runIt}`);
        return Promise.resolve(harness.piece);
      },
    };

    const executed = await executePieceCallable(
      {
        apiUrl: "http://localhost:8000",
        identity: "/tmp/test-identity.pem",
        piece: "fid1:piece-123",
        space: "home",
      },
      "refresh",
      ["--help"],
      { loadPieces: () => Promise.resolve(manager as never) },
    );

    expect(order).toEqual(["get:fid1:piece-123:true"]);
    expect(executed.helpText).toContain("refresh");
    expect(harness.tracker.handlerWrites).toEqual([]);
  });

  it("preserves plain-text mode while resolving a callable", async () => {
    const harness = createPieceCallableHarness({
      callableKind: "handler",
      cellKey: "refresh",
      inputSchema: {
        type: "object",
        properties: {},
      },
    });
    let managerConfig: unknown;

    await executePieceCallable(
      {
        apiUrl: "http://localhost:8000",
        identity: "/tmp/test-identity.pem",
        piece: "fid1:piece-123",
        space: "home",
      },
      "refresh",
      [],
      {
        sendEvent: sendThroughStandIn,
        loadPieces: (config) => {
          managerConfig = config;
          return Promise.resolve(harness.pieces);
        },
        loadPiece: () => Promise.resolve(harness.piece),
        isStdinTerminal: () => true,
      },
    );

    expect(managerConfig).toEqual({
      apiUrl: "http://localhost:8000",
      identity: "/tmp/test-identity.pem",
      piece: "fid1:piece-123",
      space: "home",
    });
  });

  it("preserves JSON output mode while resolving a callable", async () => {
    const harness = createPieceCallableHarness({
      callableKind: "handler",
      cellKey: "refresh",
      inputSchema: {
        type: "object",
        properties: {},
      },
    });
    let managerConfig: unknown;

    await executePieceCallable(
      {
        apiUrl: "http://localhost:8000",
        identity: "/tmp/test-identity.pem",
        jsonOutput: true,
        piece: "fid1:piece-123",
        space: "home",
      },
      "refresh",
      [],
      {
        sendEvent: sendThroughStandIn,
        loadPieces: (config) => {
          managerConfig = config;
          return Promise.resolve(harness.pieces);
        },
        loadPiece: () => Promise.resolve(harness.piece),
        isStdinTerminal: () => true,
      },
    );

    expect(managerConfig).toEqual({
      apiUrl: "http://localhost:8000",
      identity: "/tmp/test-identity.pem",
      jsonOutput: true,
      piece: "fid1:piece-123",
      space: "home",
    });
  });

  it("invokes handlers from schema-derived flags", async () => {
    const harness = createPieceCallableHarness({
      callableKind: "handler",
      cellKey: "recordMessage",
      inputSchema: {
        type: "object",
        properties: {
          message: { type: "string" },
        },
        required: ["message"],
      },
    });

    const result = await executePieceCallable(
      {
        apiUrl: "http://localhost:8000",
        identity: "/tmp/test-identity.pem",
        piece: "fid1:piece-123",
        space: "home",
      },
      "recordMessage",
      ["--message", "milk"],
      {
        sendEvent: sendThroughStandIn,
        loadPieces: () => Promise.resolve(harness.pieces),
        loadPiece: () => Promise.resolve(harness.piece),
      },
    );

    expect(result.outputText).toBeUndefined();
    expect(result.resolved.callableKind).toBe("handler");
    expect(harness.tracker.handlerWrites).toEqual([
      {
        cellProp: "result",
        path: ["recordMessage"],
        value: { message: "milk" },
      },
    ]);
  });

  it("rejects a piped payload that fails the verb's schema before dispatch", async () => {
    const harness = createPieceCallableHarness({
      callableKind: "handler",
      cellKey: "recordMessage",
      inputSchema: {
        type: "object",
        properties: {
          message: { type: "string" },
        },
        required: ["message"],
      },
    });

    await expect(
      executePieceCallable(
        {
          apiUrl: "http://localhost:8000",
          identity: "/tmp/test-identity.pem",
          piece: "fid1:piece-123",
          space: "home",
        },
        "recordMessage",
        [],
        {
          loadPieces: () => Promise.resolve(harness.pieces),
          loadPiece: () => Promise.resolve(harness.piece),
          isStdinTerminal: () => false,
          readTextInput: () => Promise.resolve('{"mesage":"milk"}'),
          invocation: { id: "inv-typo-retry", session: callerSession },
        },
      ),
    ).rejects.toThrow(/Invalid input for "recordMessage"/);

    // Nothing reached the stream, so the invocation id was never spent — the
    // corrected retry can still use it. Without this gate the typo'd payload
    // reads back as an absent `$event`, the verb runs with no event, and its
    // receipt burns the id while the call reports settled.
    expect(harness.tracker.handlerWrites).toEqual([]);
    expect(harness.tracker.sendOptions).toEqual([]);
  });

  it("refuses an absent payload against a verb that provably cannot run without one", async () => {
    // The schema below is the deployed shape a stream's event is routinely
    // written in: a top-level local $ref with the stream marker. The arg
    // parser reads the definition's fields, so absence is refused where the
    // caller can act on it — naming the type to supply — rather than deeper in
    // at the payload gate. Either way nothing dispatches; what this pins is
    // that the id survives a refusal, so the retry that does send a payload
    // can still use it.

    const harness = createPieceCallableHarness({
      callableKind: "handler",
      cellKey: "recordMessage",
      inputSchema: {
        $ref: "#/$defs/RecordMessageEvent",
        asCell: ["stream"],
        $defs: {
          RecordMessageEvent: {
            type: "object",
            properties: {
              message: { type: "string" },
            },
            required: ["message"],
          },
        },
      } as JSONSchema,
    });

    await expect(
      executePieceCallable(
        {
          apiUrl: "http://localhost:8000",
          identity: "/tmp/test-identity.pem",
          piece: "fid1:piece-123",
          space: "home",
        },
        "recordMessage",
        [],
        {
          loadPieces: () => Promise.resolve(harness.pieces),
          loadPiece: () => Promise.resolve(harness.piece),
          isStdinTerminal: () => true,
          invocation: { id: "inv-absent-retry", session: callerSession },
        },
      ),
    ).rejects.toThrow(
      /Handler requires input\. Expected type: \{\s*message: string\s*\}/,
    );

    // Nothing reached the stream, so the invocation id was never spent — the
    // retry that actually sends a payload can still use it.
    expect(harness.tracker.handlerWrites).toEqual([]);
    expect(harness.tracker.sendOptions).toEqual([]);
  });

  it("infers piped stdin for a bare $ref-stream verb call", async () => {
    // A $ref-carrying stream shape declares its fields in the definition, and
    // the arg parser reads them there — so a bare call takes the same
    // implicit-pipe path as the identical verb written without the
    // indirection ("infers piped stdin for object handlers", below). Piped
    // bytes reach a verb through this shape; how the schema spells its event
    // is not something a caller should have to know to pipe into it.

    const harness = createPieceCallableHarness({
      callableKind: "handler",
      cellKey: "recordMessage",
      inputSchema: {
        $ref: "#/$defs/RecordMessageEvent",
        asCell: ["stream"],
        $defs: {
          RecordMessageEvent: {
            type: "object",
            properties: {
              message: { type: "string" },
            },
            required: ["message"],
          },
        },
      } as JSONSchema,
    });

    await executePieceCallable(
      {
        apiUrl: "http://localhost:8000",
        identity: "/tmp/test-identity.pem",
        piece: "fid1:piece-123",
        space: "home",
      },
      "recordMessage",
      [],
      {
        sendEvent: sendThroughStandIn,
        loadPieces: () => Promise.resolve(harness.pieces),
        loadPiece: () => Promise.resolve(harness.piece),
        isStdinTerminal: () => false,
        readTextInput: () => Promise.resolve('{"message":"Milk"}'),
      },
    );

    expect(harness.tracker.handlerWrites).toEqual([
      {
        cellProp: "result",
        path: ["recordMessage"],
        value: { message: "Milk" },
      },
    ]);
  });

  it("normalizes an absent payload to {} so an all-defaulted verb receives its defaults", async () => {
    const harness = createPieceCallableHarness({
      callableKind: "handler",
      cellKey: "refreshFeed",
      inputSchema: {
        $ref: "#/$defs/RefreshEvent",
        asCell: ["stream"],
        $defs: {
          RefreshEvent: {
            type: "object",
            properties: {
              mode: { type: "string", default: "fast" },
              limit: { type: "number", default: 10 },
            },
            required: ["mode", "limit"],
          },
        },
      } as JSONSchema,
      receiptValue: {},
    });

    const result = await executePieceCallable(
      {
        apiUrl: "http://localhost:8000",
        identity: "/tmp/test-identity.pem",
        piece: "fid1:piece-123",
        space: "home",
      },
      "refreshFeed",
      [],
      {
        sendEvent: sendThroughStandIn,
        loadPieces: () => Promise.resolve(harness.pieces),
        loadPiece: () => Promise.resolve(harness.piece),
        isStdinTerminal: () => true,
        invocation: { id: "inv-defaulted", session: callerSession },
      },
    );

    // `{}` goes out instead of nothing: the runtime materializes defaults for
    // a PRESENT object payload only, so this is the difference between the
    // handler seeing `{ mode: "fast", limit: 10 }` and seeing `undefined`.
    expect(harness.tracker.handlerWrites).toEqual([
      {
        cellProp: "result",
        path: ["refreshFeed"],
        value: {},
      },
    ]);
    expect(result.invocation).toEqual({
      id: "inv-defaulted",
      status: "settled",
      receipt: harnessReceipt,
    });
  });

  it("runs tools from schema-derived flags and returns JSON output", async () => {
    const toolPattern: {
      nodes: Array<{ module: string }>;
      argumentSchema: JSONSchema;
      resultSchema: JSONSchema;
    } = {
      nodes: [{ module: "sentinel-node" }],
      argumentSchema: {
        type: "object",
        properties: {
          query: { type: "string" },
          help: { type: "string" },
          source: { type: "string" },
        },
        required: ["query", "source"],
      },
      resultSchema: {
        type: "object",
        properties: {
          summary: { type: "string" },
          source: { type: "string" },
        },
      },
    };
    const harness = createPieceCallableHarness({
      callableKind: "tool",
      cellKey: "search",
      inputSchema: {
        type: "object",
        properties: {
          query: { type: "string" },
          help: { type: "string" },
        },
        required: ["query"],
      },
      pattern: toolPattern,
      extraParams: {
        source: "bound-source",
      },
      toolResult: {
        summary: "bound-source:tea",
        source: "bound-source",
      },
    });

    const result = await executePieceCallable(
      {
        apiUrl: "http://localhost:8000",
        identity: "/tmp/test-identity.pem",
        piece: "fid1:piece-123",
        space: "home",
      },
      "search",
      ["--query", "tea"],
      {
        loadPieces: () => Promise.resolve(harness.pieces),
        loadPiece: () => Promise.resolve(harness.piece),
        uuid: () => "tool-result-id",
      },
    );

    expect(result.resolved.callableKind).toBe("tool");
    expect(harness.tracker.toolRunPattern).toBe(toolPattern);
    expect(harness.tracker.toolRunInput).toEqual({
      query: "tea",
      help: "",
      source: "bound-source",
    });
    expect(JSON.parse(result.outputText!)).toEqual({
      summary: "bound-source:tea",
      source: "bound-source",
    });
    // The result cell's durable address rides along — the handle a caller can
    // revisit instead of re-running the tool (verb contract Part 2).
    expect(result.resultRef).toEqual({
      id: "of:tool-result-cell",
      space: "did:key:test-home",
      scope: "space",
    });
  });

  it("passes the configured piece scope when resolving callables", async () => {
    const harness = createPieceCallableHarness({
      callableKind: "handler",
      cellKey: "recordMessage",
      inputSchema: {
        type: "object",
        properties: {
          message: { type: "string" },
        },
        required: ["message"],
      },
    });
    let resolvedScope: string | undefined;

    await executePieceCallable(
      {
        apiUrl: "http://localhost:8000",
        identity: "/tmp/test-identity.pem",
        piece: "fid1:piece-123",
        pieceScope: "session",
        space: "home",
      },
      "recordMessage",
      ["--message", "milk"],
      {
        sendEvent: sendThroughStandIn,
        loadPieces: () => Promise.resolve(harness.pieces),
        loadPiece: (_manager, _pieceId, scope) => {
          resolvedScope = scope;
          return Promise.resolve(harness.piece);
        },
      },
    );

    expect(resolvedScope).toBe("session");
  });

  it("creates pattern tool result cells with the callable scope", async () => {
    const harness = createPieceCallableHarness({
      callableKind: "tool",
      cellKey: "search",
      callableScope: "user",
      inputSchema: {
        type: "object",
        properties: {
          query: { type: "string" },
        },
        required: ["query"],
      },
      pattern: {
        argumentSchema: {
          type: "object",
          properties: {
            query: { type: "string" },
          },
          required: ["query"],
        },
        resultSchema: { type: "object" },
      },
      toolResult: { ok: true },
    });

    const result = await executePieceCallable(
      {
        apiUrl: "http://localhost:8000",
        identity: "/tmp/test-identity.pem",
        piece: "fid1:piece-123",
        space: "home",
      },
      "search",
      ["--query", "tea"],
      {
        loadPieces: () => Promise.resolve(harness.pieces),
        loadPiece: () => Promise.resolve(harness.piece),
        uuid: () => "tool-result-id",
      },
    );

    expect(harness.tracker.toolResultScope).toBe("user");
    // The returned handle preserves the scope — dropping it would silently
    // retarget a user-scoped result to the space-scoped instance.
    expect(result.resultRef?.scope).toBe("user");
  });

  it("reads primitive handler input from --value-file", async () => {
    const harness = createPieceCallableHarness({
      callableKind: "handler",
      cellKey: "editContent",
      inputSchema: { type: "string" },
    });

    await executePieceCallable(
      {
        apiUrl: "http://localhost:8000",
        identity: "/tmp/test-identity.pem",
        piece: "fid1:piece-123",
        space: "home",
      },
      "editContent",
      ["--value-file", "/tmp/content.md"],
      {
        sendEvent: sendThroughStandIn,
        loadPieces: () => Promise.resolve(harness.pieces),
        loadPiece: () => Promise.resolve(harness.piece),
        readTextFile: () => Promise.resolve("# Title\n\nUse `cat` here"),
      },
    );

    expect(harness.tracker.handlerWrites).toEqual([
      {
        cellProp: "result",
        path: ["editContent"],
        value: "# Title\n\nUse `cat` here",
      },
    ]);
  });

  it("reads object handler input from --json-file", async () => {
    const harness = createPieceCallableHarness({
      callableKind: "handler",
      cellKey: "editContent",
      inputSchema: {
        type: "object",
        properties: {
          detail: {
            type: "object",
            properties: {
              value: { type: "string" },
            },
          },
        },
        required: ["detail"],
      },
    });

    await executePieceCallable(
      {
        apiUrl: "http://localhost:8000",
        identity: "/tmp/test-identity.pem",
        piece: "fid1:piece-123",
        space: "home",
      },
      "editContent",
      ["--json-file", "/tmp/input.json"],
      {
        sendEvent: sendThroughStandIn,
        loadPieces: () => Promise.resolve(harness.pieces),
        loadPiece: () => Promise.resolve(harness.piece),
        readTextFile: () =>
          Promise.resolve(
            '{"detail":{"value":"Use `cat` to read files"}}',
          ),
      },
    );

    expect(harness.tracker.handlerWrites).toEqual([
      {
        cellProp: "result",
        path: ["editContent"],
        value: {
          detail: { value: "Use `cat` to read files" },
        },
      },
    ]);
  });

  it("refuses a --json-file payload that cannot satisfy an object handler", async () => {
    const harness = createPieceCallableHarness({
      callableKind: "handler",
      cellKey: "editContent",
      inputSchema: {
        type: "object",
        properties: {
          detail: {
            type: "object",
            properties: {
              value: { type: "string" },
            },
          },
        },
        required: ["detail"],
      },
    });

    // The arg parser still passes JSON through verbatim — it neither reshapes
    // nor rejects. The refusal happens at dispatch, where the payload is
    // measured against the verb's own schema.
    await expect(
      executePieceCallable(
        {
          apiUrl: "http://localhost:8000",
          identity: "/tmp/test-identity.pem",
          piece: "fid1:piece-123",
          space: "home",
        },
        "editContent",
        ["--json-file", "/tmp/input.json"],
        {
          loadPieces: () => Promise.resolve(harness.pieces),
          loadPiece: () => Promise.resolve(harness.piece),
          readTextFile: () => Promise.resolve('["not-an-object"]'),
        },
      ),
    ).rejects.toThrow(/Invalid input for "editContent"/);

    expect(harness.tracker.handlerWrites).toEqual([]);
  });

  it("infers piped stdin for primitive handlers when no args are provided", async () => {
    const harness = createPieceCallableHarness({
      callableKind: "handler",
      cellKey: "editContent",
      inputSchema: { type: "string" },
    });

    await executePieceCallable(
      {
        apiUrl: "http://localhost:8000",
        identity: "/tmp/test-identity.pem",
        piece: "fid1:piece-123",
        space: "home",
      },
      "editContent",
      [],
      {
        sendEvent: sendThroughStandIn,
        loadPieces: () => Promise.resolve(harness.pieces),
        loadPiece: () => Promise.resolve(harness.piece),
        isStdinTerminal: () => false,
        readTextInput: () => Promise.resolve("# Title\n\nLine 2"),
      },
    );

    expect(harness.tracker.handlerWrites).toEqual([
      {
        cellProp: "result",
        path: ["editContent"],
        value: "# Title\n\nLine 2",
      },
    ]);
  });

  it("infers piped stdin for object handlers when no args are provided", async () => {
    const harness = createPieceCallableHarness({
      callableKind: "handler",
      cellKey: "editContent",
      inputSchema: {
        type: "object",
        properties: {
          detail: {
            type: "object",
            properties: {
              value: { type: "string" },
            },
          },
        },
        required: ["detail"],
      },
    });

    await executePieceCallable(
      {
        apiUrl: "http://localhost:8000",
        identity: "/tmp/test-identity.pem",
        piece: "fid1:piece-123",
        space: "home",
      },
      "editContent",
      [],
      {
        sendEvent: sendThroughStandIn,
        loadPieces: () => Promise.resolve(harness.pieces),
        loadPiece: () => Promise.resolve(harness.piece),
        isStdinTerminal: () => false,
        readTextInput: () =>
          Promise.resolve('{"detail":{"value":"Use `cat` to read files"}}'),
      },
    );

    expect(harness.tracker.handlerWrites).toEqual([
      {
        cellProp: "result",
        path: ["editContent"],
        value: {
          detail: { value: "Use `cat` to read files" },
        },
      },
    ]);
  });

  it("invokes a schema-less verb bare without reading piped stdin", async () => {
    const harness = createPieceCallableHarness({
      callableKind: "handler",
      cellKey: "archive",
      inputSchema: { asCell: ["stream"] } as JSONSchema,
    });

    // A rejecting reader proves stdin stays untouched: the verb declares no
    // input, so the bare spelling dispatches immediately instead of waiting
    // for a pipe to reach EOF.
    await executePieceCallable(
      {
        apiUrl: "http://localhost:8000",
        identity: "/tmp/test-identity.pem",
        piece: "fid1:piece-123",
        space: "home",
      },
      "archive",
      [],
      {
        sendEvent: sendThroughStandIn,
        loadPieces: () => Promise.resolve(harness.pieces),
        loadPiece: () => Promise.resolve(harness.piece),
        isStdinTerminal: () => false,
        readTextInput: () => Promise.reject(new Error("stdin was read")),
      },
    );

    expect(harness.tracker.handlerWrites).toEqual([
      {
        cellProp: "result",
        path: ["archive"],
        value: undefined,
      },
    ]);
  });

  it("refuses implicit piped JSON that cannot satisfy an object handler", async () => {
    const harness = createPieceCallableHarness({
      callableKind: "handler",
      cellKey: "editContent",
      inputSchema: {
        type: "object",
        properties: {
          detail: {
            type: "object",
            properties: {
              value: { type: "string" },
            },
          },
        },
        required: ["detail"],
      },
    });

    await expect(
      executePieceCallable(
        {
          apiUrl: "http://localhost:8000",
          identity: "/tmp/test-identity.pem",
          piece: "fid1:piece-123",
          space: "home",
        },
        "editContent",
        [],
        {
          loadPieces: () => Promise.resolve(harness.pieces),
          loadPiece: () => Promise.resolve(harness.piece),
          isStdinTerminal: () => false,
          readTextInput: () => Promise.resolve('["not-an-object"]'),
        },
      ),
    ).rejects.toThrow(/Invalid input for "editContent"/);

    expect(harness.tracker.handlerWrites).toEqual([]);
  });

  it("refuses inline --json that cannot satisfy an object handler", async () => {
    const harness = createPieceCallableHarness({
      callableKind: "handler",
      cellKey: "editContent",
      inputSchema: {
        type: "object",
        properties: {
          detail: {
            type: "object",
            properties: {
              value: { type: "string" },
            },
          },
        },
        required: ["detail"],
      },
    });

    await expect(
      executePieceCallable(
        {
          apiUrl: "http://localhost:8000",
          identity: "/tmp/test-identity.pem",
          piece: "fid1:piece-123",
          space: "home",
        },
        "editContent",
        ["--json", '["not-an-object"]'],
        {
          loadPieces: () => Promise.resolve(harness.pieces),
          loadPiece: () => Promise.resolve(harness.piece),
        },
      ),
    ).rejects.toThrow(/Invalid input for "editContent"/);

    expect(harness.tracker.handlerWrites).toEqual([]);
  });

  it("reads the words past the marker as a projection whatever the verb declares", async () => {
    // `record` declares a `select` field and the read step owns `--select`,
    // and the two vocabularies stay independent: past the marker the word is
    // the read step's, so the line carries no verb input and the ordinary
    // parse says so. Nothing here weighs the two readings against each other.
    const declaring = () =>
      createPieceCallableHarness({
        callableKind: "handler",
        cellKey: "record",
        inputSchema: {
          type: "object",
          properties: { select: { type: "string" } },
          required: ["select"],
        },
      });
    const config = {
      apiUrl: "http://localhost:8000",
      identity: "/tmp/test-identity.pem",
      piece: "fid1:piece-123",
      space: "home",
    };

    const bare = declaring();
    await expect(
      executePieceCallable(config, "record", [], {
        sendEvent: sendThroughStandIn,
        loadPieces: () => Promise.resolve(bare.pieces),
        loadPiece: () => Promise.resolve(bare.piece),
        isStdinTerminal: () => true,
      }),
    ).rejects.toThrow(/Handler requires input/);
    expect(bare.tracker.handlerWrites).toStrictEqual([]);

    // And a pipe is input, so the same line dispatches: the projection was
    // never the verb's to read, and stdin fills the section it left empty.
    const piped = declaring();
    await executePieceCallable(config, "record", [], {
      sendEvent: sendThroughStandIn,
      loadPieces: () => Promise.resolve(piped.pieces),
      loadPiece: () => Promise.resolve(piped.piece),
      isStdinTerminal: () => false,
      readTextInput: () => Promise.resolve('{"select":"input"}'),
    });
    expect(piped.tracker.handlerWrites).toStrictEqual([
      { cellProp: "result", path: ["record"], value: { select: "input" } },
    ]);
  });

  it("renders help under the canonical spelling when no mount names itself", async () => {
    const harness = createPieceCallableHarness({
      callableKind: "tool",
      cellKey: "search",
      inputSchema: {
        type: "object",
        properties: {
          query: { type: "string" },
        },
        required: ["query"],
      },
      pattern: {
        argumentSchema: {
          type: "object",
          properties: {
            query: { type: "string" },
          },
          required: ["query"],
        },
      },
    });

    const result = await executePieceCallable(
      {
        apiUrl: "http://localhost:8000",
        identity: "/tmp/test-identity.pem",
        piece: "fid1:piece-123",
        space: "home",
      },
      "search",
      ["--help"],
      {
        loadPieces: () => Promise.resolve(harness.pieces),
        loadPiece: () => Promise.resolve(harness.piece),
      },
    );

    // The default prefix is the top-level spelling: a page minted with no
    // mount to name must not teach the deprecated one. Each mount passes its
    // own spelling as helpCommandPrefix.
    expect(result.helpText).toContain(
      "cf piece call ... search --help",
    );
    expect(result.helpText).toContain(
      "cf piece call ... search [run] --query <string>",
    );
    expect(result.helpText).toContain("JSON input:");
    expect(result.helpText).toContain(
      "Pass inline JSON as one positional argument or after `--json`",
    );
    expect(result.helpText).toContain(
      "cf piece call ... search --json [<json>]",
    );
    expect(result.helpText).toContain("query: string");
    expect(result.helpText).toContain("Flags:");
    expect(result.helpText).not.toContain(
      "Read the full input object from stdin.",
    );
    expect(result.helpText).not.toContain(
      "cf piece call ... search [run] --help",
    );
    expect(result.helpText).not.toContain("cf exec");
  });

  it("surfaces handler transaction failures as errors", async () => {
    const harness = createPieceCallableHarness({
      callableKind: "handler",
      cellKey: "recordMessage",
      inputSchema: {
        type: "object",
        properties: {
          message: { type: "string" },
        },
        required: ["message"],
      },
      handlerFailureMessage: "Bad message payload",
    });

    await expect(
      executePieceCallable(
        {
          apiUrl: "http://localhost:8000",
          identity: "/tmp/test-identity.pem",
          piece: "fid1:piece-123",
          space: "home",
        },
        "recordMessage",
        ["--message", "milk"],
        {
          sendEvent: sendThroughStandIn,
          loadPieces: () => Promise.resolve(harness.pieces),
          loadPiece: () => Promise.resolve(harness.piece),
        },
      ),
    ).rejects.toThrow(/Handler "recordMessage" failed: Bad message payload/);
  });

  it("surfaces a pre-dispatch drop's reason from the aborted transaction", async () => {
    const harness = createPieceCallableHarness({
      callableKind: "handler",
      cellKey: "recordMessage",
      inputSchema: {
        type: "object",
        properties: {
          message: { type: "string" },
        },
        required: ["message"],
      },
      abortedWithReason: "Event backlog for this stream is full " +
        "(256 pending), so this send was refused before dispatch",
    });

    await expect(
      executePieceCallable(
        {
          apiUrl: "http://localhost:8000",
          identity: "/tmp/test-identity.pem",
          piece: "fid1:piece-123",
          space: "home",
        },
        "recordMessage",
        ["--message", "milk"],
        {
          sendEvent: sendThroughStandIn,
          loadPieces: () => Promise.resolve(harness.pieces),
          loadPiece: () => Promise.resolve(harness.piece),
        },
      ),
    ).rejects.toThrow(
      /Handler "recordMessage" failed: Event backlog for this stream is full/,
    );
  });

  it("threads the invocation id to send and settles with receipt readback, without awaiting graph quiescence", async () => {
    const harness = createPieceCallableHarness({
      callableKind: "handler",
      cellKey: "addComment",
      inputSchema: {
        type: "object",
        properties: {
          message: { type: "string" },
        },
        required: ["message"],
      },
      receiptValue: { commentId: "c-1" },
    });
    const phases: string[] = [];

    const result = await executePieceCallable(
      {
        apiUrl: "http://localhost:8000",
        identity: "/tmp/test-identity.pem",
        piece: "fid1:piece-123",
        space: "home",
      },
      "addComment",
      ["--message", "milk"],
      {
        sendEvent: sendThroughStandIn,
        loadPieces: () => Promise.resolve(harness.pieces),
        loadPiece: () => Promise.resolve(harness.piece),
        invocation: { id: "inv-123", session: callerSession },
        onPhase: (phase) => phases.push(phase),
      },
    );

    expect(harness.tracker.sendOptions).toEqual([
      {
        eventId: "inv-123",
        session: callerSession,
        onAppended: expect.any(Function),
      },
    ]);
    expect(result.invocation).toEqual({
      id: "inv-123",
      status: "settled",
      receipt: harnessReceipt,
      result: { commentId: "c-1" },
    });
    expect(phases).toEqual(["dispatched", "committed", "readback"]);
    expect(harness.tracker.receiptLinkRequested?.id).toBe("of:receipt-1");
    // Transaction-local acknowledgment: the settled result must come straight
    // off this handling's commit — never from draining the whole graph.
    expect(harness.tracker.idleCalls).toBe(0);
    expect(harness.tracker.syncedCalls).toBe(0);
  });

  it("carries the caller's session beside the invocation id to send", async () => {
    const harness = createPieceCallableHarness({
      callableKind: "handler",
      cellKey: "addComment",
      inputSchema: {
        type: "object",
        properties: {
          message: { type: "string" },
        },
        required: ["message"],
      },
      receiptValue: { commentId: "c-1" },
    });

    const result = await executePieceCallable(
      {
        apiUrl: "http://localhost:8000",
        identity: "/tmp/test-identity.pem",
        piece: "fid1:piece-123",
        space: "home",
      },
      "addComment",
      ["--message", "milk"],
      {
        sendEvent: sendThroughStandIn,
        loadPieces: () => Promise.resolve(harness.pieces),
        loadPiece: () => Promise.resolve(harness.piece),
        invocation: { id: "inv-123", session: "ses-abc" },
      },
    );

    // An invocation id is the caller's own word, so the session that chose it
    // travels with it: they reach the send together or the id says nothing
    // about whose invocation it is.
    expect(harness.tracker.sendOptions).toEqual([
      {
        eventId: "inv-123",
        session: "ses-abc",
        onAppended: expect.any(Function),
      },
    ]);
    // The outcome a caller reads is its own invocation's, and reports the id
    // the caller named rather than anything derived from the pair.
    expect(result.invocation).toEqual({
      id: "inv-123",
      status: "settled",
      receipt: harnessReceipt,
      result: { commentId: "c-1" },
    });
  });

  it("sends no invocation id or session for a call that names no invocation", async () => {
    const harness = createPieceCallableHarness({
      callableKind: "handler",
      cellKey: "addComment",
      inputSchema: {
        type: "object",
        properties: {
          message: { type: "string" },
        },
        required: ["message"],
      },
      receiptValue: { commentId: "c-1" },
    });

    await executePieceCallable(
      {
        apiUrl: "http://localhost:8000",
        identity: "/tmp/test-identity.pem",
        piece: "fid1:piece-123",
        space: "home",
      },
      "addComment",
      ["--message", "milk"],
      {
        sendEvent: sendThroughStandIn,
        loadPieces: () => Promise.resolve(harness.pieces),
        loadPiece: () => Promise.resolve(harness.piece),
      },
    );

    // Absent, not substituted: the runtime mints the delivery id for such a
    // call, and nothing downstream is handed a stand-in id or session it
    // would have to tell apart from a caller's own.
    // The appended hook rides every send; no id and no session do.
    expect(harness.tracker.sendOptions).toEqual([
      { onAppended: expect.any(Function) },
    ]);
  });

  it("reclassifies a receipt-exists collision as the original settled outcome", async () => {
    const harness = createPieceCallableHarness({
      callableKind: "handler",
      cellKey: "addComment",
      inputSchema: {
        type: "object",
        properties: {
          message: { type: "string" },
        },
        required: ["message"],
      },
      receiptExists: true,
      receiptValue: { commentId: "c-original" },
    });

    const result = await executePieceCallable(
      {
        apiUrl: "http://localhost:8000",
        identity: "/tmp/test-identity.pem",
        piece: "fid1:piece-123",
        space: "home",
      },
      "addComment",
      ["--message", "milk"],
      {
        sendEvent: sendThroughStandIn,
        loadPieces: () => Promise.resolve(harness.pieces),
        loadPiece: () => Promise.resolve(harness.piece),
        invocation: { id: "inv-dup", session: callerSession },
      },
    );

    // The `receipt` here says only that the address survives a collision.
    // That it is the WINNER's address is the runner's guarantee and needs
    // two competing handlings to witness, which this harness does not have —
    // see "cell.send carries a caller-supplied eventId and exposes the
    // receipt link" in packages/runner/test/scheduler-event-receipts.test.ts.
    expect(result.invocation).toEqual({
      id: "inv-dup",
      status: "settled",
      deduplicated: true,
      receipt: harnessReceipt,
      result: { commentId: "c-original" },
    });
  });

  it("names the receipt the settled result was read out of", async () => {
    // One envelope shape whether or not the caller waited: the address is
    // published on both exits, and on the settled one it is demonstrably the
    // document the readback opened — not a second address for the same
    // outcome.
    const harness = createPieceCallableHarness({
      callableKind: "handler",
      cellKey: "addComment",
      inputSchema: {
        type: "object",
        properties: { message: { type: "string" } },
        required: ["message"],
      },
      receiptValue: { commentId: "c-1" },
    });

    const result = await executePieceCallable(
      {
        apiUrl: "http://localhost:8000",
        identity: "/tmp/test-identity.pem",
        piece: "fid1:piece-123",
        space: "home",
      },
      "addComment",
      ["--message", "milk"],
      {
        sendEvent: sendThroughStandIn,
        loadPieces: () => Promise.resolve(harness.pieces),
        loadPiece: () => Promise.resolve(harness.piece),
        invocation: { id: "inv-settled-address", session: callerSession },
      },
    );

    expect(result.invocation?.receipt).toEqual(harnessReceipt);
    expect(result.invocation?.receipt).toBe(
      createLLMFriendlyLink(
        harness.tracker.receiptLinkRequested as NormalizedFullLink,
        "did:key:test-home" as MemorySpace,
      ),
    );
  });

  it("settles a value-less verb with no result key (existence-only receipt)", async () => {
    const harness = createPieceCallableHarness({
      callableKind: "handler",
      cellKey: "refresh",
      inputSchema: { type: "object", properties: {} },
      receiptValue: {},
    });

    const result = await executePieceCallable(
      {
        apiUrl: "http://localhost:8000",
        identity: "/tmp/test-identity.pem",
        piece: "fid1:piece-123",
        space: "home",
      },
      "refresh",
      [],
      {
        sendEvent: sendThroughStandIn,
        loadPieces: () => Promise.resolve(harness.pieces),
        loadPiece: () => Promise.resolve(harness.piece),
        isStdinTerminal: () => true,
        invocation: { id: "inv-empty", session: callerSession },
      },
    );

    expect(result.invocation).toEqual({
      id: "inv-empty",
      status: "settled",
      receipt: harnessReceipt,
    });
  });

  it("returns a keyless instance result instead of reading it as value-less", async () => {
    // The value-less witness is a PLAIN empty record. A `FabricPrimitive`
    // whose slots are private — FabricBytes — has no enumerable keys, and a
    // key-count test alone would swallow it as "no result".
    class FakeBytes {
      #bytes = "private";
      describe(): string {
        return this.#bytes;
      }
    }
    const bytes = new FakeBytes();
    const harness = createPieceCallableHarness({
      callableKind: "handler",
      cellKey: "exportBytes",
      inputSchema: { type: "object", properties: {} },
      receiptValue: bytes,
    });

    const result = await executePieceCallable(
      {
        apiUrl: "http://localhost:8000",
        identity: "/tmp/test-identity.pem",
        piece: "fid1:piece-123",
        space: "home",
      },
      "exportBytes",
      [],
      {
        sendEvent: sendThroughStandIn,
        loadPieces: () => Promise.resolve(harness.pieces),
        loadPiece: () => Promise.resolve(harness.piece),
        isStdinTerminal: () => true,
        invocation: { id: "inv-bytes", session: callerSession },
      },
    );

    expect(result.invocation?.status).toBe("settled");
    expect(result.invocation?.result).toBe(bytes);
  });

  it("keeps a result whose stored form is non-empty when it materializes keyless", async () => {
    // The stored-vs-materialized divergence the presence check exists for: a
    // FabricInstance materializes as a query-result proxy over an empty
    // ordinary stub — plain-looking, keyless — while its STORED form is the
    // non-empty codec shape. Presence reads the stored form, so the result
    // survives. (The live suite pins the same seam through a real runtime;
    // this is the harness-level mirror, and what `receiptRaw` models.)
    const proxyLikeStub = {};
    const harness = createPieceCallableHarness({
      callableKind: "handler",
      cellKey: "exportLink",
      inputSchema: { type: "object", properties: {} },
      receiptValue: proxyLikeStub,
      receiptRaw: { "link@1": { id: "of:fid1:target", path: [] } },
    });

    const result = await executePieceCallable(
      {
        apiUrl: "http://localhost:8000",
        identity: "/tmp/test-identity.pem",
        piece: "fid1:piece-123",
        space: "home",
      },
      "exportLink",
      [],
      {
        sendEvent: sendThroughStandIn,
        loadPieces: () => Promise.resolve(harness.pieces),
        loadPiece: () => Promise.resolve(harness.piece),
        isStdinTerminal: () => true,
        invocation: { id: "inv-stored-form", session: callerSession },
      },
    );

    expect(result.invocation?.status).toBe("settled");
    expect(result.invocation?.result).toBe(proxyLikeStub);
  });

  it("sends no invocation id and returns no invocation when no id is supplied", async () => {
    const harness = createPieceCallableHarness({
      callableKind: "handler",
      cellKey: "refresh",
      inputSchema: { type: "object", properties: {} },
      receiptValue: { ignored: true },
    });

    const result = await executePieceCallable(
      {
        apiUrl: "http://localhost:8000",
        identity: "/tmp/test-identity.pem",
        piece: "fid1:piece-123",
        space: "home",
      },
      "refresh",
      [],
      {
        sendEvent: sendThroughStandIn,
        loadPieces: () => Promise.resolve(harness.pieces),
        loadPiece: () => Promise.resolve(harness.piece),
        isStdinTerminal: () => true,
      },
    );

    // The appended hook rides every send; no id and no session do.
    expect(harness.tracker.sendOptions).toEqual([
      { onAppended: expect.any(Function) },
    ]);
    expect(result.invocation).toBeUndefined();
    expect(harness.tracker.receiptLinkRequested).toBeUndefined();
  });
});

/** The address the harness's handling files its receipt under: the link its
 * `send` hands the commit callback, in the canonical reference syntax the
 * envelope publishes. Every settled or committed invocation the harness produces
 * carries it, because the runtime hands the address over at commit rather
 * than at readback. */
const harnessReceipt = "/of:receipt-1";

function createPieceCallableHarness(options: {
  callableKind: "handler" | "tool";
  cellKey: string;
  inputSchema: JSONSchema;
  pattern?: {
    argumentSchema: JSONSchema;
    resultSchema?: JSONSchema;
  } & Record<string, unknown>;
  extraParams?: Record<string, unknown>;
  toolResult?: unknown;
  handlerFailureMessage?: string;

  /** Commit settles as an aborted transaction whose error wraps the drop
   * reason (`StorageTransactionAborted.reason`) — the shape a pre-dispatch
   * drop hands the commit callback (a send refused at the event-backlog
   * cap, a piece that failed to load). Unlike `handlerFailureMessage`,
   * nothing reaches the runtime error log: the reason on the transaction is
   * the whole signal. */
  abortedWithReason?: string;

  callableScope?: "space" | "user" | "session";

  /** Value the handling's receipt cell reads back ({} = value-less verb). */
  receiptValue?: unknown;

  /** The receipt's STORED form, when it differs from the materialized
   * `receiptValue` — a proxied instance's codec shape, most usefully.
   * Presence is decided on this, mirroring the production readback. */
  receiptRaw?: unknown;

  /** Simulate the create-only receipt collision: commit fails with
   * precondition "receipt-exists" while the link addresses the winner's
   * original receipt. */
  receiptExists?: boolean;

  /** Hold settlement open: `send` records the dispatch but never invokes the
   * commit callback, so anything awaiting acknowledgment waits forever.
   * This is how a test proves a path does NOT await the commit — the path
   * completes anyway — or exercises a wait bound against a call that can
   * never beat it. */
  neverCommit?: boolean;

  /** Commit with no `handlingReceiptLink` on the transaction, which is what
   * the runner leaves behind when receipts are not being written
   * (`commitPreconditions` off): it stashes the link only when it will
   * create the cell. */
  noReceiptLink?: boolean;

  /** Replace the readback receipt cell wholesale — for --show-links tests,
   * whose receipt must support key()/resolveAsCell link traversal. */
  receiptCell?: Cell<any>;
}) {
  const tracker = {
    handlerWrites: [] as Array<{
      cellProp: "input" | "result";
      path: (string | number)[] | undefined;
      value: unknown;
    }>,
    sendOptions: [] as Array<CellSendOptions | undefined>,
    receiptLinkRequested: undefined as { id?: string } | undefined,
    idleCalls: 0,
    syncedCalls: 0,
    toolRunPattern: undefined as unknown,
    toolRunInput: undefined as unknown,
    toolResultScope: undefined as string | undefined,
  };

  const callableSchema: JSONSchema = options.callableKind === "tool"
    ? {
      type: "object",
      properties: {
        pattern: {
          type: "object",
          properties: {
            argumentSchema: { type: "object" },
            resultSchema: { type: "object" },
          },
        },
        extraParams: { type: "object" },
      },
    }
    : options.inputSchema;
  const callableValue = options.callableKind === "tool"
    ? {
      pattern: options.pattern,
      extraParams: options.extraParams ?? {},
    }
    : { $stream: true };
  const runtimeErrors: Array<{ message: string }> = [];
  const callableCell = createMockCell(
    callableValue,
    callableSchema,
    {
      scope: options.callableScope,
      ...(options.callableKind === "handler"
        ? {
          send: (
            value: unknown,
            onCommit?: (
              tx: {
                status: () => { status: string; error?: Error };
                handlingReceiptLink?: NormalizedFullLink;
              },
            ) => void,
            sendOptions?: CellSendOptions,
          ) => {
            tracker.handlerWrites.push({
              cellProp: "result",
              path: [options.cellKey],
              value,
            });
            tracker.sendOptions.push(sendOptions);
            if (options.handlerFailureMessage) {
              runtimeErrors.push({ message: options.handlerFailureMessage });
            }
            if (options.neverCommit) return;
            onCommit?.({
              status: () =>
                options.abortedWithReason
                  ? {
                    status: "error",
                    error: Object.assign(
                      new Error("Transaction was aborted"),
                      { reason: new Error(options.abortedWithReason) },
                    ),
                  }
                  : options.handlerFailureMessage
                  ? {
                    status: "error",
                    error: new Error(options.handlerFailureMessage),
                  }
                  : options.receiptExists
                  ? {
                    status: "error",
                    error: Object.assign(
                      new Error("Result receipt already exists"),
                      { precondition: "receipt-exists" },
                    ),
                  }
                  : { status: "done" },
              ...(options.noReceiptLink ? {} : {
                handlingReceiptLink: mockLink({
                  id: "of:receipt-1",
                  space: "did:key:test-home",
                }),
              }),
            });
          },
        }
        : {}),
    },
  );
  const rootCell = createMockCell(
    {
      [options.cellKey]: callableValue,
    },
    {
      type: "object",
      properties: {
        [options.cellKey]: callableSchema,
      },
    },
    { childOverrides: { [options.cellKey]: callableCell } },
  );

  const state = { value: options.toolResult };
  const resultCell = {
    schema: options.pattern?.resultSchema,
    get: () => state.value,
    pull: () => Promise.resolve(state.value),
    key: (_key: string) => resultCell,
    asSchemaFromLinks: () => resultCell,
    getAsNormalizedFullLink: () => ({
      id: "of:tool-result-cell",
      space: "did:key:test-home",
      scope: options.callableScope ?? "space",
    }),
  };

  const piece = {
    getCell: () => ({
      asSchema: () => ({
        key: (key: string) => ({
          isStream: () =>
            options.callableKind === "handler" && key === options.cellKey,
        }),
      }),
    }),
    input: {
      getCell: () => Promise.resolve(createMockCell({}, { type: "object" })),
      set: (value: unknown, path?: (string | number)[]) => {
        tracker.handlerWrites.push({ cellProp: "input", path, value });
        return Promise.resolve();
      },
    },
    result: {
      getCell: () => Promise.resolve(rootCell),
      set: (value: unknown, path?: (string | number)[]) => {
        tracker.handlerWrites.push({ cellProp: "result", path, value });
        return Promise.resolve();
      },
    },
  };

  const defaultReceiptCell = {
    asSchema: () => defaultReceiptCell,
    get: () => options.receiptValue,
    pull: () => Promise.resolve(options.receiptValue),
    // The stored form presence is decided on. Defaults to the materialized
    // value — faithful for plain JSON; a test modeling a proxied instance
    // sets `receiptRaw` to the stored shape the runtime would hold.
    getRaw: () =>
      "receiptRaw" in options ? options.receiptRaw : options.receiptValue,
    key: (_key: string) => defaultReceiptCell,
  };

  const pieces = {
    // The DID the CLI's `--space home` resolves to: a resolution's space is
    // always the space DID, and an address rendered relative to it carries no
    // `@did` prefix.
    getSpace: () => "did:key:test-home",
    synced: () => {
      tracker.syncedCalls++;
      return Promise.resolve();
    },
    runtime: {
      [CF_RUNTIME_ERROR_LOG]: runtimeErrors,
      getCellFromLink: (link: { id?: string }) => {
        tracker.receiptLinkRequested = link;
        return options.receiptCell ?? defaultReceiptCell;
      },
      storageManager: {
        synced: async () => {},
      },
      edit: () => ({
        commit: () =>
          createTransactionCommitReceipt(Promise.resolve({ ok: {} })),
        // The real transaction reports one, and the write receipt reads it
        // rather than treating a resolved `commit()` as proof of a write.
        status: () => ({ status: "done", journal: { novelty: () => [] } }),
      }),
      prepareTxForCommit: () => {},
      settled: () => Promise.resolve(),
      getCell: (
        _space: string,
        _id: string,
        _schema: JSONSchema | undefined,
        _tx: unknown,
        scope?: string,
      ) => {
        tracker.toolResultScope = scope;
        return resultCell;
      },
      run: (
        _tx: unknown,
        pattern: unknown,
        input: unknown,
        _result: unknown,
      ) => {
        tracker.toolRunPattern = pattern;
        tracker.toolRunInput = input;
        state.value = options.toolResult;
        return {
          sink: () => () => {},
        };
      },
      idle: () => {
        tracker.idleCalls++;
        return Promise.resolve();
      },
    },
  };

  return { pieces, piece, tracker };
}

function createMockCell(
  value: unknown,
  schema: JSONSchema | undefined,
  options?: {
    childOverrides?: Record<string, ReturnType<typeof createMockCell>>;
    send?: (
      value: unknown,
      onCommit?: (
        tx: { status: () => { status: string; error?: Error } },
      ) => void,
    ) => void;
    scope?: "space" | "user" | "session";
  },
) {
  const cell = {
    schema,
    get: () => value,
    getRaw: () => value,
    asSchemaFromLinks: () => cell,
    getAsNormalizedFullLink: () => ({ scope: options?.scope }),
    send: options?.send,
    key: (key: string) => {
      if (options?.childOverrides?.[key]) {
        return options.childOverrides[key];
      }
      const nextValue = isObjectNotArray(value)
        ? (value as Record<string, unknown>)[key]
        : undefined;
      const nextSchema = getChildSchema(schema, key);
      return createMockCell(nextValue, nextSchema);
    },
  };

  return cell;
}

function getChildSchema(
  schema: JSONSchema | undefined,
  key: string,
): JSONSchema | undefined {
  if (
    !schema || !isObjectNotArray(schema)
  ) {
    return undefined;
  }

  const properties = schema.properties;
  if (!isObjectNotArray(properties)) {
    return undefined;
  }

  return properties[key] as JSONSchema | undefined;
}

describe("forced-stream fallback dispatch", () => {
  /** A verb that defeats ordinary detection — plain object value, no `$stream`
   * marker, no stream schema — but that the forced stream cast proves is a
   * handler. This is the only case `tryResolvePieceHandler` exists for, and
   * the one where the cell that passed detection and the cell built by reading
   * the schema back from links are not interchangeable. */
  function createFallbackHarness() {
    const sends: unknown[] = [];
    const dataWrites: unknown[] = [];

    // The cell the forced cast proves. Only this one dispatches.
    const streamCell = {
      isStream: () => true,
      send: (value: unknown, onCommit?: (tx: unknown) => void) => {
        sends.push(value);
        onCommit?.({ status: () => ({ status: "done" }) });
      },
    };

    // What `rootCell.key(name).asSchemaFromLinks()` yields: carries the
    // published payload schema, but nothing marking it a stream. A real cell
    // here has a `send` that routes to `.set()`'s non-stream branch and
    // throws "Transaction required for .set()".
    // `key()` must yield nothing for "pattern"/"extraParams", or
    // detectCallableKind's tool probe classifies this as a tool and the
    // fallback path under test is never reached.
    const emptyChild = {
      get: () => undefined,
      getRaw: () => undefined,
    };
    const linkDerivedCell = {
      schema: {
        type: "object",
        properties: { note: { type: "string" } },
      } as JSONSchema,
      get: () => ({}),
      getRaw: () => ({}),
      asSchemaFromLinks: () => linkDerivedCell,
      key: () => emptyChild,
    };

    const rootValue = { hiddenPing: {} };
    const rootCell = {
      schema: {
        type: "object",
        properties: { hiddenPing: { type: "object" } },
      } as JSONSchema,
      get: () => rootValue,
      getRaw: () => rootValue,
      asSchemaFromLinks: () => rootCell,
      key: (name: string) => name === "hiddenPing" ? linkDerivedCell : absent,
    };
    // The input root offers nothing, so resolution falls past both ordinary
    // paths to the forced cast.
    const absent: {
      schema?: JSONSchema;
      get: () => unknown;
      getRaw: () => unknown;
      asSchemaFromLinks: () => unknown;
      key: () => unknown;
    } = {
      get: () => undefined,
      getRaw: () => undefined,
      asSchemaFromLinks: () => absent,
      key: () => emptyChild,
    };
    const emptyCell = {
      schema: { type: "object" } as JSONSchema,
      get: () => ({}),
      getRaw: () => ({}),
      asSchemaFromLinks: () => emptyCell,
      key: () => absent,
    };

    const piece = {
      getCell: () => ({
        get: () => rootValue,
        asSchema: () => ({ key: () => streamCell }),
      }),
      input: {
        getCell: () => Promise.resolve(emptyCell),
        set: (value: unknown) => {
          dataWrites.push(value);
          return Promise.resolve();
        },
      },
      result: {
        getCell: () => Promise.resolve(rootCell),
        set: (value: unknown) => {
          dataWrites.push(value);
          return Promise.resolve();
        },
      },
    };

    const pieces = {
      getSpace: () => "home",
      synced: async () => {},
      runtime: {
        [CF_RUNTIME_ERROR_LOG]: [] as Array<{ message: string }>,
        idle: async () => {},
      },
    };

    return { sends, dataWrites, piece, pieces, linkDerivedCell, streamCell };
  }

  const config = {
    apiUrl: "http://localhost:8000",
    identity: "/tmp/test-identity.pem",
    piece: "fid1:piece-123",
    space: "home",
  };

  it("sends through the cell whose stream-ness was proven, not a link-derived one", async () => {
    const harness = createFallbackHarness();

    const result = await executePieceCallable(
      config,
      "hiddenPing",
      ["--note", "hi"],
      {
        sendEvent: sendThroughStandIn,
        loadPieces: () => Promise.resolve(harness.pieces as never),
        loadPiece: () => Promise.resolve(harness.piece as never),
        isStdinTerminal: () => true,
      },
    );

    expect(result.resolved.callableKind).toBe("handler");
    // Dispatched as an event through the proven cell. Resolving to the
    // link-derived cell instead leaves a cell that `.set()` treats as data.
    expect(result.resolved.callableCell).toBe(harness.streamCell);
    expect(harness.sends).toEqual([{ note: "hi" }]);
    expect(harness.dataWrites).toEqual([]);
  });

  it("dispatches a cataloged verb whose stored schema lost the stream marker", async () => {
    const harness = createFallbackHarness();
    const reads: unknown[] = [];
    const piece = {
      ...harness.piece,
      getPattern: (options: unknown) => {
        reads.push(options);
        return Promise.resolve({
          resultSchema: {
            type: "object",
            properties: { hiddenPing: { asCell: ["stream"] } },
          },
        });
      },
    };
    await executePieceCallable(config, "hiddenPing", ["--note", "hi"], {
      sendEvent: sendThroughStandIn,
      loadPieces: () => Promise.resolve(harness.pieces as never),
      loadPiece: () => Promise.resolve(piece as never),
      isStdinTerminal: () => true,
    });
    expect(harness.sends).toEqual([{ note: "hi" }]);
    expect(reads).toEqual([{ projectResult: false }]);
  });

  it("keeps the stream fallback usable when the pattern cannot be read", async () => {
    const harness = createFallbackHarness();
    const piece = {
      ...harness.piece,
      getPattern: () => Promise.reject(new Error("pattern unavailable")),
    };
    await executePieceCallable(config, "hiddenPing", ["--note", "hi"], {
      sendEvent: sendThroughStandIn,
      loadPieces: () => Promise.resolve(harness.pieces as never),
      loadPiece: () => Promise.resolve(piece as never),
      isStdinTerminal: () => true,
    });
    expect(harness.sends).toEqual([{ note: "hi" }]);
  });

  it("refuses a stream cast against an available empty catalog", async () => {
    const harness = createFallbackHarness();
    const piece = {
      ...harness.piece,
      getPattern: () =>
        Promise.resolve({ resultSchema: { type: "object", properties: {} } }),
    };
    const call = executePieceCallable(config, "hiddenPing", ["--note", "hi"], {
      loadPieces: () => Promise.resolve(harness.pieces as never),
      loadPiece: () => Promise.resolve(piece as never),
      isStdinTerminal: () => true,
    });
    await expect(call).rejects.toThrow(UnknownPieceVerbError);
    await expect(call).rejects.toHaveProperty("name", "UnknownPieceVerbError");
    await expect(call).rejects.toThrow(
      "Available verbs (including wrappers and deprecated verbs): none.",
    );
    expect(harness.sends).toEqual([]);
  });

  it("keeps the published payload schema for the command spec", async () => {
    const harness = createFallbackHarness();

    const result = await executePieceCallable(
      config,
      "hiddenPing",
      ["--note", "hi"],
      {
        sendEvent: sendThroughStandIn,
        loadPieces: () => Promise.resolve(harness.pieces as never),
        loadPiece: () => Promise.resolve(harness.piece as never),
        isStdinTerminal: () => true,
      },
    );

    // The forced cast's own schema is just the stream marker; `--help` and
    // input validation must still see what the piece publishes.
    expect(result.resolved.commandSpec.inputSchema).toEqual(
      harness.linkDerivedCell.schema,
    );
  });
});

describe("call stdin payloads", () => {
  it("identifies JSON output without treating delimited fields as selectors", () => {
    expect(
      pieceCallInvocation(["--json", '{"query":"milk"}']),
    ).toEqual({
      rawArgs: ["--json", '{"query":"milk"}'],
      jsonOutput: true,
    });
    expect(
      pieceCallInvocation(["--json-file", "/tmp/input.json"]),
    ).toEqual({
      rawArgs: ["--json-file", "/tmp/input.json"],
      jsonOutput: true,
    });
    expect(pieceCallInvocation(["run", "--json", "{}"])).toEqual({
      rawArgs: ["run", "--json", "{}"],
      jsonOutput: true,
    });
    expect(pieceCallInvocation(["--query", "--json"])).toEqual({
      rawArgs: ["--query", "--json"],
      jsonOutput: false,
    });
    expect(
      pieceCallInvocation(["invoke", "--query", "--json"]),
    ).toEqual({
      rawArgs: ["invoke", "--query", "--json"],
      jsonOutput: false,
    });
  });

  it("carries an id named within a named session", () => {
    expect(
      resolveInvocationIdentity("add-comment-1", "ses-7"),
    ).toEqual({ id: "add-comment-1", session: "ses-7" });
  });

  it("mints an id for a caller that names only a session", () => {
    expect(
      resolveInvocationIdentity(undefined, "ses-7", () => "minted-1"),
    ).toEqual({ id: "minted-1", session: "ses-7" });
  });

  it("mints both for a caller that names neither", () => {
    // A minted id is random, so it addresses an outcome nothing else will
    // ask for, and minting the session it belongs to alongside it costs such
    // a call nothing: every call then derives its address the one way.
    expect(
      resolveInvocationIdentity(
        undefined,
        undefined,
        () => "minted-1",
        () => "minted-session-1",
      ),
    ).toEqual({ id: "minted-1", session: "minted-session-1" });
  });

  it("refuses an id named without a session, naming the remedy", () => {
    // Naming an id asks for an outcome to be replayable, and a session
    // minted per request would move that outcome each time — so the request
    // cannot be honored as it was made, and the refusal says what to do.
    expect(() => resolveInvocationIdentity("add-comment-1", undefined))
      .toThrow(ValidationError);
    expect(() => resolveInvocationIdentity("add-comment-1", undefined))
      .toThrow(/`cf invocation-session new` and set `CF_INVOCATION_SESSION`/);
  });

  it("rejects a blank id or a blank session", () => {
    // Either would read as "the caller named one" while carrying nothing
    // that tells two deliveries apart, so the retry an id promises to make
    // safe would not be.
    expect(() => resolveInvocationIdentity("", "ses-7")).toThrow(
      /--invocation requires a non-blank id/,
    );
    expect(() => resolveInvocationIdentity("   ", "ses-7")).toThrow(
      /--invocation requires a non-blank id/,
    );
    expect(() => resolveInvocationIdentity("inv-1", "")).toThrow(
      /--invocation-session requires a non-blank id/,
    );
    expect(() => resolveInvocationIdentity("inv-1", "   ")).toThrow(
      /--invocation-session requires a non-blank id/,
    );
  });

  it("announces the invocation id and its session once, at dispatch", () => {
    const announced: string[] = [];
    const seen: string[] = [];
    const report = invocationPhaseReporter(
      { id: "inv-9", session: "ses-9" },
      (p) => seen.push(p),
      (m) => announced.push(m),
    );
    // Nothing is announced before dispatch: until the event is on its way
    // there is nothing a retry would deduplicate against.
    report("initial_sync");
    expect(announced).toEqual([]);
    report("dispatched");
    // Both halves, because an id deduplicates only under its session: a caller
    // holding one without the other holds nothing it can retry with.
    expect(announced).toEqual(["invocation: inv-9", "session: ses-9"]);
    // Later phases, and a second dispatch, must not re-announce — a caller
    // scraping stderr should not have to pick among several ids.
    report("committed");
    report("dispatched");
    report("readback");
    expect(announced).toEqual(["invocation: inv-9", "session: ses-9"]);
    expect(seen).toEqual([
      "initial_sync",
      "dispatched",
      "committed",
      "dispatched",
      "readback",
    ]);
  });

  it("streams one wall-clock span per observed phase to stderr under --verbose", () => {
    const lines: string[] = [];
    const seen: string[] = [];
    let t = 1000;
    const observer = pieceCallPhaseObserver(
      true,
      (phase) => seen.push(phase),
      (line) => lines.push(line),
      () => t,
    );
    t = 1012.5;
    observer.onPhase("dispatched");
    t = 1093.5;
    observer.onPhase("committed");
    t = 1094.5;
    observer.onPhase("readback");
    t = 1100;
    observer.finish();
    // A second finish must not double-close the settled span.
    observer.finish();
    expect(lines).toEqual([
      "timing: initial_sync → dispatched 12.5ms",
      "timing: dispatched → committed 81.0ms",
      "timing: committed → readback 1.0ms",
      "timing: readback → settled 5.5ms",
    ]);
    // The furthest-phase tracker still advances for the failure report.
    expect(seen).toEqual(["dispatched", "committed", "readback"]);
  });

  it("closes the in-flight span with the failure that ended it", () => {
    const lines: string[] = [];
    let t = 2000;
    const observer = pieceCallPhaseObserver(
      true,
      () => {},
      (line) => lines.push(line),
      () => t,
    );
    t = 2010;
    observer.onPhase("dispatched");
    t = 2500;
    observer.finish("failed");
    // Lines stream per transition, so the spans observed before the failure
    // are already out; the failure only closes the one in flight.
    expect(lines).toEqual([
      "timing: initial_sync → dispatched 10.0ms",
      "timing: dispatched → failed 490.0ms",
    ]);
  });

  it("emits no timing lines without --verbose while phases still advance", () => {
    const lines: string[] = [];
    const seen: string[] = [];
    const observer = pieceCallPhaseObserver(
      false,
      (phase) => seen.push(phase),
      (line) => lines.push(line),
    );
    observer.onPhase("dispatched");
    observer.onPhase("committed");
    observer.finish();
    expect(lines).toEqual([]);
    expect(seen).toEqual(["dispatched", "committed"]);
  });

  it("defaults to console.error — stdout stays exactly the command output", () => {
    const stderrLines: string[] = [];
    const stdoutLines: string[] = [];
    const originalError = console.error;
    const originalLog = console.log;
    console.error = (...args: unknown[]) => {
      stderrLines.push(args.join(" "));
    };
    console.log = (...args: unknown[]) => {
      stdoutLines.push(args.join(" "));
    };
    try {
      const observer = pieceCallPhaseObserver(true, () => {});
      observer.onPhase("dispatched");
      observer.finish();
    } finally {
      console.error = originalError;
      console.log = originalLog;
    }
    expect(stderrLines).toHaveLength(2);
    expect(stderrLines[0]).toMatch(/^timing: initial_sync → dispatched \d/);
    expect(stderrLines[1]).toMatch(/^timing: dispatched → settled \d/);
    expect(stdoutLines).toEqual([]);
  });

  it("closes the verbose span on the failure exit and reports the retry key", () => {
    const lines: string[] = [];
    const printed: string[] = [];
    const exited: number[] = [];
    let t = 3000;
    const observer = pieceCallPhaseObserver(
      true,
      () => {},
      (line) => lines.push(line),
      () => t,
    );
    t = 3020;
    observer.onPhase("dispatched");
    t = 3050;
    expect(() =>
      exitPieceCallFailure(
        observer,
        new Error("send blew up"),
        "inv-7",
        "dispatched",
        {
          printError: (message) => printed.push(message),
          exit: (code): never => {
            exited.push(code);
            throw new Error("exit-sentinel");
          },
        },
      )
    ).toThrow("exit-sentinel");
    expect(lines).toEqual([
      "timing: initial_sync → dispatched 20.0ms",
      "timing: dispatched → failed 30.0ms",
    ]);
    expect(printed).toEqual([
      "send blew up",
      "invocation: inv-7 phase: dispatched",
    ]);
    expect(exited).toEqual([1]);
  });

  it("closes the verbose span before rethrowing a usage error", () => {
    // A Cliffy ValidationError renders the usage screen upstream — but the
    // in-flight span must still close as failed first, so malformed
    // input/options leave a complete timing stream.
    const lines: string[] = [];
    const printed: string[] = [];
    const observer = pieceCallPhaseObserver(
      true,
      () => {},
      (line) => lines.push(line),
      () => 0,
    );
    expect(() =>
      exitPieceCallFailure(
        observer,
        new ValidationError("bad flags"),
        "inv-8",
        "initial_sync",
        {
          printError: (message) => printed.push(message),
          exit: (): never => {
            throw new Error("exit-sentinel");
          },
        },
      )
    ).toThrow(ValidationError);
    expect(lines).toEqual(["timing: initial_sync → failed 0.0ms"]);
    // The usage error reports through Cliffy, not the failure printer.
    expect(printed).toEqual([]);
  });

  it("writes the Invocation JSON to stdout when the wait bound expires", () => {
    // A wait expiry is the one failure that still owes stdout a machine
    // surface: the same Invocation JSON shape as a settled call, carrying
    // the furthest observed phase as its status, so a script parses one
    // shape either way. The stderr lines stay exactly the ordinary failure
    // contract.
    const printed: string[] = [];
    const rendered: string[] = [];
    const exited: number[] = [];
    const observer = pieceCallPhaseObserver(false, () => {}, () => {}, () => 0);
    expect(() =>
      exitPieceCallFailure(
        observer,
        new WaitBoundExpired(5),
        "inv-9",
        "dispatched",
        {
          printError: (message) => printed.push(message),
          render: (text) => rendered.push(text),
          exit: (code): never => {
            exited.push(code);
            throw new Error("exit-sentinel");
          },
        },
      )
    ).toThrow("exit-sentinel");
    expect(printed[1]).toBe("invocation: inv-9 phase: dispatched");
    expect(rendered).toEqual([
      JSON.stringify({ invocation: "inv-9", status: "dispatched" }, null, 2),
    ]);
    expect(exited).toEqual([1]);
  });

  it("closes the verbose span on the pre-dispatch payload-rejection exit", () => {
    // reportVerbInputErrorOrRethrow terminates the process from inside the
    // promise chain, bypassing the action's catch — without the observer
    // threading, --verbose would leave the initial_sync span dangling.
    const lines: string[] = [];
    const printed: string[] = [];
    const exited: number[] = [];
    let t = 4000;
    const observer = pieceCallPhaseObserver(
      true,
      () => {},
      (line) => lines.push(line),
      () => t,
    );
    t = 4012;
    expect(() =>
      reportVerbInputErrorOrRethrow(
        new VerbInputValidationError("addTopic", "missing required title"),
        "fid1:piece-123",
        {
          printError: (message) => printed.push(message),
          printHint: () => {},
          exit: (code): never => {
            exited.push(code);
            throw new Error("exit-sentinel");
          },
        },
        observer,
      )
    ).toThrow("exit-sentinel");
    expect(lines).toEqual(["timing: initial_sync → failed 12.0ms"]);
    expect(printed).toHaveLength(1);
    expect(printed[0]).toMatch(/Invalid input for "addTopic"/);
    expect(exited).toEqual([1]);

    // A rethrown (non-payload) error leaves the span open: the action's own
    // failure exit closes it later, so nothing may be emitted here.
    const rethrowLines: string[] = [];
    const rethrowObserver = pieceCallPhaseObserver(
      true,
      () => {},
      (line) => rethrowLines.push(line),
      () => 0,
    );
    expect(() =>
      reportVerbInputErrorOrRethrow(
        new Error("network unreachable"),
        "fid1:piece-123",
        undefined,
        rethrowObserver,
      )
    ).toThrow("network unreachable");
    expect(rethrowLines).toEqual([]);
  });

  it("announces per-phase lines only under the test hook", () => {
    // Disabled (the default): no phase lines — normal output stays exactly
    // the dispatch announcement and its session.
    const silent: string[] = [];
    const off = invocationPhaseReporter(
      { id: "inv-10", session: "ses-10" },
      () => {},
      (m) => silent.push(m),
    );
    off("initial_sync");
    off("dispatched");
    off("committed");
    expect(silent).toEqual(["invocation: inv-10", "session: ses-10"]);

    // Enabled: every advance also carries `invocation: <id> phase: <phase>`,
    // the shape failure exits already print. The `committed` line is the one
    // the dropped-response fixture blocks on before killing its call — it
    // must appear at committed, and not before.
    const announced: string[] = [];
    const seen: string[] = [];
    const on = invocationPhaseReporter(
      { id: "inv-11", session: "ses-11" },
      (p) => seen.push(p),
      (m) => announced.push(m),
      true,
    );
    on("initial_sync");
    expect(announced).toEqual(["invocation: inv-11 phase: initial_sync"]);
    on("dispatched");
    on("committed");
    on("readback");
    expect(announced).toEqual([
      "invocation: inv-11 phase: initial_sync",
      "invocation: inv-11",
      "session: ses-11",
      "invocation: inv-11 phase: dispatched",
      "invocation: inv-11 phase: committed",
      "invocation: inv-11 phase: readback",
    ]);
    expect(seen).toEqual([
      "initial_sync",
      "dispatched",
      "committed",
      "readback",
    ]);
  });

  it("shapes the settled Invocation JSON an agent parses", () => {
    expect(invocationJson({ id: "inv-1", status: "settled" })).toEqual({
      invocation: "inv-1",
      status: "settled",
    });
    expect(
      invocationJson({ id: "inv-1", status: "settled", deduplicated: true }),
    ).toEqual({
      invocation: "inv-1",
      status: "settled",
      deduplicated: true,
    });
    expect(
      invocationJson({
        id: "inv-1",
        status: "settled",
        result: { commentId: "c-1" },
      }),
    ).toEqual({
      invocation: "inv-1",
      status: "settled",
      result: { commentId: "c-1" },
    });
    // deduplicated: false is never emitted — its absence is the signal.
    expect(
      invocationJson({ id: "inv-1", status: "settled", deduplicated: false }),
    ).not.toHaveProperty("deduplicated");
    // A verb that genuinely returned null keeps it; a value-less verb omits
    // the key entirely, so the two stay distinguishable on the wire.
    expect(invocationJson({ id: "inv-1", status: "settled", result: null }))
      .toEqual({ invocation: "inv-1", status: "settled", result: null });
    expect(
      invocationJson({ id: "inv-1", status: "settled", result: undefined }),
    ).not.toHaveProperty("result");
  });

  it("carries the receipt address as a top-level envelope key", () => {
    // Beside the id and the status, not inside the result: it addresses the
    // outcome rather than being part of one, and a value-less verb has an
    // address just the same.
    const receipt = "/of:receipt-1";
    expect(
      invocationJson({
        id: "inv-1",
        status: "settled",
        receipt,
        result: { commentId: "c-1" },
      }),
    ).toEqual({
      invocation: "inv-1",
      status: "settled",
      receipt,
      result: { commentId: "c-1" },
    });
    expect(invocationJson({ id: "inv-1", status: "committed", receipt }))
      .toEqual({ invocation: "inv-1", status: "committed", receipt });
    expect(invocationJson({ id: "inv-1", status: "settled" }))
      .not.toHaveProperty("receipt");
  });

  it('maps a bare "-" payload onto the --json-file stdin path', () => {
    expect(pieceCallRawArgs(["-"])).toEqual(["--json-file", "-"]);
    // Behind the verb keyword the payload is still the one positional it is,
    // and the keyword stays where the caller wrote it.
    expect(pieceCallRawArgs(["invoke", "-"])).toEqual([
      "invoke",
      "--json-file",
      "-",
    ]);
  });

  it("forwards the callable's own flags to its parser untranslated", () => {
    // The verb opened the section, so everything in it is the verb's
    // vocabulary and reaches its parser as written — including the file paths
    // and stdin sentinels that used to need a marker in front of them.
    expect(pieceCallRawArgs(["--json-file", "-"])).toEqual([
      "--json-file",
      "-",
    ]);
    expect(pieceCallRawArgs(["--value-file", "-"])).toEqual([
      "--value-file",
      "-",
    ]);
    expect(pieceCallRawArgs(["--json", "-"])).toEqual(["--json", "-"]);
    expect(pieceCallRawArgs(["--json-file", "/p.json"])).toEqual([
      "--json-file",
      "/p.json",
    ]);
    expect(pieceCallRawArgs(["--query", "milk", "--limit", "5"])).toEqual([
      "--query",
      "milk",
      "--limit",
      "5",
    ]);
  });

  it("forwards a payload written beside flags rather than translating it", () => {
    // `cf piece call ... search '{"x":1}' --query milk` names its input twice. The
    // verb's own parser owns both spellings, so it is the door that refuses
    // them together — this one does not translate the payload and so does not
    // hide the second spelling from it.
    expect(pieceCallRawArgs(['{"x":1}', "--query", "milk"])).toEqual([
      '{"x":1}',
      "--query",
      "milk",
    ]);
    expect(pieceCallRawArgs(["-", "--query", "milk"])).toEqual([
      "-",
      "--query",
      "milk",
    ]);
  });

  it('reads the payload from stdin for a bare "-"', async () => {
    const harness = createPieceCallableHarness({
      callableKind: "handler",
      cellKey: "recordMessage",
      inputSchema: {
        type: "object",
        properties: {
          message: { type: "string" },
        },
        required: ["message"],
      },
    });

    await executePieceCallable(
      {
        apiUrl: "http://localhost:8000",
        identity: "/tmp/test-identity.pem",
        piece: "fid1:piece-123",
        space: "home",
      },
      "recordMessage",
      ["--json-file", "-"],
      {
        sendEvent: sendThroughStandIn,
        loadPieces: () => Promise.resolve(harness.pieces),
        loadPiece: () => Promise.resolve(harness.piece),
        isStdinTerminal: () => false,
        readTextInput: () => Promise.resolve('{"message":"from stdin"}'),
      },
    );

    expect(harness.tracker.handlerWrites).toEqual([
      {
        cellProp: "result",
        path: ["recordMessage"],
        value: { message: "from stdin" },
      },
    ]);
  });

  it('treats "--json -" as the stdin sentinel', async () => {
    const harness = createPieceCallableHarness({
      callableKind: "handler",
      cellKey: "recordMessage",
      inputSchema: {
        type: "object",
        properties: {
          message: { type: "string" },
        },
        required: ["message"],
      },
    });

    await executePieceCallable(
      {
        apiUrl: "http://localhost:8000",
        identity: "/tmp/test-identity.pem",
        piece: "fid1:piece-123",
        space: "home",
      },
      "recordMessage",
      ["--json", "-"],
      {
        sendEvent: sendThroughStandIn,
        loadPieces: () => Promise.resolve(harness.pieces),
        loadPiece: () => Promise.resolve(harness.piece),
        isStdinTerminal: () => false,
        readTextInput: () => Promise.resolve('{"message":"json stdin"}'),
      },
    );

    expect(harness.tracker.handlerWrites).toEqual([
      {
        cellProp: "result",
        path: ["recordMessage"],
        value: { message: "json stdin" },
      },
    ]);
  });

  it('fails loudly when "-" gets empty stdin', async () => {
    const harness = createPieceCallableHarness({
      callableKind: "handler",
      cellKey: "recordMessage",
      inputSchema: {
        type: "object",
        properties: {
          message: { type: "string" },
        },
        required: ["message"],
      },
    });

    await expect(
      executePieceCallable(
        {
          apiUrl: "http://localhost:8000",
          identity: "/tmp/test-identity.pem",
          piece: "fid1:piece-123",
          space: "home",
        },
        "recordMessage",
        ["--json-file", "-"],
        {
          loadPieces: () => Promise.resolve(harness.pieces),
          loadPiece: () => Promise.resolve(harness.piece),
          isStdinTerminal: () => false,
          readTextInput: () => Promise.resolve(""),
        },
      ),
    ).rejects.toThrow(/Expected JSON from stdin/);
  });
});

describe("call wait control", () => {
  const config = {
    apiUrl: "http://localhost:8000",
    identity: "/tmp/test-identity.pem",
    piece: "fid1:piece-123",
    space: "home",
  };

  it("waits for settlement by default, with --await as its explicit spelling", () => {
    expect(resolveWaitControl({})).toEqual({ mode: "settle" });
    expect(resolveWaitControl({ await: true })).toEqual({ mode: "settle" });
  });

  it("maps --no-wait to a commit-acknowledged, readback-skipped exit", () => {
    expect(resolveWaitControl({ wait: false })).toEqual({ mode: "commit" });
  });

  it("refuses the --await --no-wait contradiction", () => {
    expect(() => resolveWaitControl({ await: true, wait: false })).toThrow(
      /--await and --no-wait contradict/,
    );
  });

  it("carries the --wait bound in seconds, compatible with --await", () => {
    // --await is the explicit spelling of "wait", and --wait names the
    // patience of that same wait, so the two compose rather than conflict.
    expect(resolveWaitControl({ wait: 5 })).toEqual({
      mode: "settle",
      boundSeconds: 5,
    });
    expect(resolveWaitControl({ await: true, wait: 2.5 })).toEqual({
      mode: "settle",
      boundSeconds: 2.5,
    });
  });

  it('refuses a bound that means "don\'t wait"', () => {
    expect(() => resolveWaitControl({ wait: 0 })).toThrow(/positive/);
    expect(() => resolveWaitControl({ wait: -1 })).toThrow(/positive/);
    expect(() => resolveWaitControl({ wait: Number.NaN })).toThrow(/positive/);
  });

  it("returns the settlement untouched when no bound is chosen", () => {
    const settlement = Promise.resolve("done");
    // The same promise, not a wrapper: the default path must not gain a
    // deadline, a race, or any timer at all.
    expect(boundedSettlement(settlement, undefined)).toBe(settlement);
  });

  it("resolves a settlement that beats the bound and disarms the deadline", async () => {
    // The op sanitizer proves the second half: a deadline timer left armed
    // after settlement would leak past the end of this test and fail it.
    await expect(boundedSettlement(Promise.resolve("done"), 60)).resolves.toBe(
      "done",
    );
  });

  it("propagates a settlement failure unchanged", async () => {
    await expect(
      boundedSettlement(Promise.reject(new Error("boom")), 60),
    ).rejects.toThrow("boom");
  });

  it("expires with WaitBoundExpired when the call outlives the caller's patience", async () => {
    // A promise that never settles holds the wait open by construction, so
    // the deadline firing is the only way this test can complete — nothing
    // races, and no timing alignment is being relied on. The real (tiny)
    // timer is deliberate: the deadline mechanism itself is what is under
    // test here.
    const never = new Promise<never>(() => {});
    const error = await boundedSettlement(never, 0.01).catch((e) => e);
    expect(error).toBeInstanceOf(WaitBoundExpired);
    // The wording is pinned: the handler runs in THIS process, so an expiry
    // must not claim the invocation "continues settling" — it may never have
    // executed or committed, and re-invoking the same pair is the recovery.
    // The pair is anchored to the end of the string: an id on its own names
    // no address, and `resolveInvocationIdentity` refuses one offered without
    // its session, so guidance that stopped at the id would send a caller
    // into a rejected retry.
    expect((error as WaitBoundExpired).message).toMatch(
      /--wait bound of 0\.01s expired: the invocation may not have executed or committed — re-invoke with the same invocation id and session to finish it or read the outcome back$/,
    );
    expect((error as WaitBoundExpired).seconds).toBe(0.01);
  });

  it("skips only the readback under --no-wait: commit acknowledged, receipt never read", async () => {
    const harness = createPieceCallableHarness({
      callableKind: "handler",
      cellKey: "addComment",
      inputSchema: {
        type: "object",
        properties: {
          message: { type: "string" },
        },
        required: ["message"],
      },
      receiptValue: { commentId: "c-1" },
    });
    const phases: string[] = [];

    const result = await executePieceCallable(
      config,
      "addComment",
      ["--message", "milk"],
      {
        sendEvent: sendThroughStandIn,
        loadPieces: () => Promise.resolve(harness.pieces),
        loadPiece: () => Promise.resolve(harness.piece),
        invocation: { id: "inv-no-readback", session: callerSession },
        skipReadback: true,
        onPhase: (phase) => phases.push(phase),
      },
    );

    // Status is "committed", not "settled": the JSON must not claim a
    // settlement nobody observed. And not "dispatched" either — the handler
    // ran HERE and its commit was acknowledged before this returned.
    expect(result.invocation).toEqual({
      id: "inv-no-readback",
      status: "committed",
      receipt: harnessReceipt,
    });
    expect(phases).toEqual(["dispatched", "committed"]);
    expect(harness.tracker.sendOptions).toEqual([
      {
        eventId: "inv-no-readback",
        session: callerSession,
        onAppended: expect.any(Function),
      },
    ]);
    // The receipt was never opened — the readback (sync + read) is the whole
    // saving — and no quiescence drain crept in either.
    expect(harness.tracker.receiptLinkRequested).toBeUndefined();
    expect(harness.tracker.idleCalls).toBe(0);
    expect(harness.tracker.syncedCalls).toBe(0);
  });

  it("publishes the receipt address a detached call has to collect with", async () => {
    // Without it --no-wait is a dead end: the caller holds an id whose only
    // use is re-invoking the verb. The address is known at commit, so it
    // costs nothing the mode skips — and it reaches stdout as a top-level
    // envelope key, beside the id rather than inside the result.
    const harness = createPieceCallableHarness({
      callableKind: "handler",
      cellKey: "addComment",
      inputSchema: {
        type: "object",
        properties: { message: { type: "string" } },
        required: ["message"],
      },
      receiptValue: { commentId: "c-1" },
    });

    const result = await executePieceCallable(
      config,
      "addComment",
      ["--message", "milk"],
      {
        sendEvent: sendThroughStandIn,
        loadPieces: () => Promise.resolve(harness.pieces),
        loadPiece: () => Promise.resolve(harness.piece),
        invocation: { id: "inv-detached-address", session: callerSession },
        skipReadback: true,
      },
    );

    expect(result.invocation?.receipt).toEqual(harnessReceipt);
    // Published from the commit, not from a readback: the receipt cell is
    // never opened on this path.
    expect(harness.tracker.receiptLinkRequested).toBeUndefined();
    expect(invocationJson(result.invocation!)).toEqual({
      invocation: "inv-detached-address",
      status: "committed",
      receipt: harnessReceipt,
    });
  });

  it("omits the receipt when the runtime published no address", async () => {
    // With receipts off nothing is created for the link to name. An address
    // that resolves to no cell would invite a readback against a document
    // that does not exist, so absent beats fabricated.
    const harness = createPieceCallableHarness({
      callableKind: "handler",
      cellKey: "addComment",
      inputSchema: {
        type: "object",
        properties: { message: { type: "string" } },
        required: ["message"],
      },
      noReceiptLink: true,
    });

    const detached = await executePieceCallable(
      config,
      "addComment",
      ["--message", "milk"],
      {
        sendEvent: sendThroughStandIn,
        loadPieces: () => Promise.resolve(harness.pieces),
        loadPiece: () => Promise.resolve(harness.piece),
        invocation: { id: "inv-no-receipt", session: callerSession },
        skipReadback: true,
      },
    );

    expect(detached.invocation).toEqual({
      id: "inv-no-receipt",
      status: "committed",
    });
    expect(invocationJson(detached.invocation!)).not.toHaveProperty("receipt");

    const settled = await executePieceCallable(
      config,
      "addComment",
      ["--message", "milk"],
      {
        sendEvent: sendThroughStandIn,
        loadPieces: () => Promise.resolve(harness.pieces),
        loadPiece: () => Promise.resolve(harness.piece),
        invocation: { id: "inv-no-receipt-settled", session: callerSession },
      },
    );

    expect(settled.invocation).toEqual({
      id: "inv-no-receipt-settled",
      status: "settled",
    });
  });

  it("still awaits the commit acknowledgment under --no-wait", async () => {
    const harness = createPieceCallableHarness({
      callableKind: "handler",
      cellKey: "addComment",
      inputSchema: {
        type: "object",
        properties: {
          message: { type: "string" },
        },
        required: ["message"],
      },
      // The commit callback never fires. --no-wait must NOT return: exiting
      // before the acknowledgment would abandon the invocation un-executed
      // (the handler runs in this process), not leave it settling elsewhere.
      neverCommit: true,
    });
    const phases: string[] = [];

    const error = await boundedSettlement(
      executePieceCallable(config, "addComment", ["--message", "milk"], {
        sendEvent: sendThroughStandIn,
        loadPieces: () => Promise.resolve(harness.pieces),
        loadPiece: () => Promise.resolve(harness.piece),
        invocation: { id: "inv-held-commit", session: callerSession },
        skipReadback: true,
        onPhase: (phase) => phases.push(phase),
      }),
      0.01,
    ).catch((e) => e);

    // Only the deadline got us out — the skip-readback path was still
    // parked on the commit acknowledgment, exactly where it must wait.
    expect(error).toBeInstanceOf(WaitBoundExpired);
    expect(phases).toEqual(["dispatched"]);
    expect(harness.tracker.receiptLinkRequested).toBeUndefined();
  });

  it("reports a deduplicated collision without reading the receipt back", async () => {
    const harness = createPieceCallableHarness({
      callableKind: "handler",
      cellKey: "addComment",
      inputSchema: {
        type: "object",
        properties: {
          message: { type: "string" },
        },
        required: ["message"],
      },
      receiptExists: true,
      receiptValue: { commentId: "c-original" },
    });

    const result = await executePieceCallable(
      config,
      "addComment",
      ["--message", "milk"],
      {
        sendEvent: sendThroughStandIn,
        loadPieces: () => Promise.resolve(harness.pieces),
        loadPiece: () => Promise.resolve(harness.piece),
        invocation: { id: "inv-dup-no-readback", session: callerSession },
        skipReadback: true,
      },
    );

    // The collision is still a success — the ORIGINAL commit stands and is
    // durable — but the original outcome is not fetched; the address it
    // published is what reads it back. Which handling's address that is, on
    // a real collision, is the runner's guarantee rather than this harness's
    // (see the settled collision case above).
    expect(result.invocation).toEqual({
      id: "inv-dup-no-readback",
      status: "committed",
      deduplicated: true,
      receipt: harnessReceipt,
    });
    expect(harness.tracker.receiptLinkRequested).toBeUndefined();
  });

  it("surfaces a commit failure under --no-wait as a normal failure", async () => {
    const harness = createPieceCallableHarness({
      callableKind: "handler",
      cellKey: "recordMessage",
      inputSchema: {
        type: "object",
        properties: {
          message: { type: "string" },
        },
        required: ["message"],
      },
      handlerFailureMessage: "Bad message payload",
    });

    // Skipping the readback must not skip the verdict: a commit that fails
    // is reported exactly as it would be on the default path.
    await expect(
      executePieceCallable(config, "recordMessage", ["--message", "milk"], {
        sendEvent: sendThroughStandIn,
        loadPieces: () => Promise.resolve(harness.pieces),
        loadPiece: () => Promise.resolve(harness.piece),
        invocation: { id: "inv-failed-commit", session: callerSession },
        skipReadback: true,
      }),
    ).rejects.toThrow(/Handler "recordMessage" failed: Bad message payload/);
  });

  it("requires an invocation id to skip the readback", async () => {
    const harness = createPieceCallableHarness({
      callableKind: "handler",
      cellKey: "refresh",
      inputSchema: { type: "object", properties: {} },
    });

    await expect(
      executePieceCallable(config, "refresh", [], {
        loadPieces: () => Promise.resolve(harness.pieces),
        loadPiece: () => Promise.resolve(harness.piece),
        isStdinTerminal: () => true,
        skipReadback: true,
      }),
    ).rejects.toThrow(/requires an invocation id/);

    // Refused BEFORE dispatch: skipping the readback is only sound when a
    // later same-id call can fetch the outcome, and that needs the id.
    expect(harness.tracker.handlerWrites).toEqual([]);
  });

  it("keeps the pre-dispatch gate ahead of a readback-skipping dispatch", async () => {
    const harness = createPieceCallableHarness({
      callableKind: "handler",
      cellKey: "recordMessage",
      inputSchema: {
        type: "object",
        properties: {
          message: { type: "string" },
        },
        required: ["message"],
      },
    });

    await expect(
      executePieceCallable(
        config,
        "recordMessage",
        ["--json", '{"mesage":"milk"}'],
        {
          loadPieces: () => Promise.resolve(harness.pieces),
          loadPiece: () => Promise.resolve(harness.piece),
          invocation: { id: "inv-no-wait-typo", session: callerSession },
          skipReadback: true,
        },
      ),
    ).rejects.toThrow(/Invalid input for "recordMessage"/);

    // A --no-wait caller never sees the settled outcome, so the gate
    // refusing a bad payload locally — id unspent — matters even more than
    // usual.
    expect(harness.tracker.handlerWrites).toEqual([]);
    expect(harness.tracker.sendOptions).toEqual([]);
  });

  it("refuses --no-wait for a tool run", async () => {
    const harness = createPieceCallableHarness({
      callableKind: "tool",
      cellKey: "search",
      inputSchema: {
        type: "object",
        properties: {
          query: { type: "string" },
        },
        required: ["query"],
      },
      pattern: {
        argumentSchema: {
          type: "object",
          properties: {
            query: { type: "string" },
          },
          required: ["query"],
        },
        resultSchema: { type: "object" },
      },
      toolResult: { ok: true },
    });

    await expect(
      executePieceCallable(config, "search", ["--query", "tea"], {
        loadPieces: () => Promise.resolve(harness.pieces),
        loadPiece: () => Promise.resolve(harness.piece),
        invocation: { id: "inv-tool-no-wait", session: callerSession },
        skipReadback: true,
      }),
    ).rejects.toThrow(/--no-wait is not available for tool "search"/);

    // The run was never started: an abandoned half-run would be worse than
    // the refusal.
    expect(harness.tracker.toolRunPattern).toBeUndefined();
  });

  it("carries the furthest phase as status for an unsettled invocation", () => {
    expect(invocationJson({ id: "inv-1", status: "dispatched" })).toEqual({
      invocation: "inv-1",
      status: "dispatched",
    });
    expect(invocationJson({ id: "inv-1", status: "committed" })).toEqual({
      invocation: "inv-1",
      status: "committed",
    });
  });

  it("closes the in-flight span as detached under --no-wait --verbose", () => {
    const lines: string[] = [];
    let t = 3000;
    const observer = pieceCallPhaseObserver(
      true,
      () => {},
      (line) => lines.push(line),
      () => t,
    );
    t = 3020;
    observer.onPhase("dispatched");
    t = 3050;
    observer.onPhase("committed");
    t = 3051;
    observer.finish("detached");
    // "settled" would be a lie here — the readback was skipped, so nobody
    // observed a settlement. The span sequence also documents where
    // --no-wait stops: after the commit acknowledgment, never before it.
    expect(lines).toEqual([
      "timing: initial_sync → dispatched 20.0ms",
      "timing: dispatched → committed 30.0ms",
      "timing: committed → detached 1.0ms",
    ]);
  });
});

/** The address of a backing document in the linked-receipt mock below. */
interface MockLinkedDoc {
  id: string;
  space: string;
  scope?: "space" | "user" | "session";

  /** Where inside the backing doc the link points (a link below its root). */
  path?: string[];
}

/** One node of a mock receipt tree: `doc` marks the value at this path as a
 * reference into another document (on the ROOT node, a stored result that is
 * itself a reference); children without one live in the enclosing doc. */
interface MockLinkedNode {
  doc?: MockLinkedDoc;
  children?: Record<string, MockLinkedNode>;
}

/** The full normalized link a real cell reports for a mock document: the
 * space scope and a root path are what a runner-minted link carries when the
 * fixture leaves them out. */
function mockLink(
  doc: MockLinkedDoc,
  path: string[] = doc.path ?? [],
): NormalizedFullLink {
  return {
    id: doc.id,
    space: doc.space,
    scope: doc.scope ?? "space",
    path,
  } as unknown as NormalizedFullLink;
}

/** A partial cell double, cast at the seam where the invocation engine takes
 * it. Every member the engine reaches for is present; the rest of `Cell` is
 * not. */
function mockCell(members: Record<string, unknown>): Cell<any> {
  return members as unknown as Cell<any>;
}

/**
 * A receipt cell whose key()/resolveAsCell traversal mirrors the runner's:
 * `key(segment)` reports the ENCLOSING doc's address extended by the segment
 * (the cell's own link), and only `resolveAsCell()` reveals the backing
 * document a stored reference points at — including at the root, where the
 * receipt cell reports the receipt's address and resolving reveals whether
 * the stored result is itself a reference. A collector that skipped the
 * resolve step would read every path as receipt-internal and emit no links.
 *
 * Unresolved wrappers refuse traversal outright (`key()` hands back a
 * barren cell), pinning that the collector reads descendants from RESOLVED
 * cells only — a same-document link can redirect elsewhere, and children
 * live under its target. The barren cell reports the receipt's own address,
 * so descending through one by mistake shows up as a missing entry rather
 * than a foreign document.
 */
function linkedReceiptCell(
  receiptDoc: MockLinkedDoc,
  value: unknown,
  root: MockLinkedNode = {},
): Cell<any> {
  const barren: Cell<any> = mockCell({
    get: () => undefined,
    resolveAsCell: () => barren,
    getAsNormalizedFullLink: () => mockLink(receiptDoc),
    key: () => barren,
  });
  const build = (
    node: MockLinkedNode,
    doc: MockLinkedDoc,
    pathInDoc: string[],
  ): Cell<any> => {
    const cell: Cell<any> = mockCell({
      get: () => value,
      pull: () => Promise.resolve(value),
      resolveAsCell: () => cell,
      getAsNormalizedFullLink: () => mockLink(doc, pathInDoc),
      key: (segment: string) => {
        const childNode = node.children?.[segment] ?? {};
        const resolved = childNode.doc
          ? build(childNode, childNode.doc, childNode.doc.path ?? [])
          : build(childNode, doc, [...pathInDoc, segment]);
        return mockCell({
          get: () => undefined,
          key: () => barren,
          resolveAsCell: () => resolved,
          getAsNormalizedFullLink: () => mockLink(doc, [...pathInDoc, segment]),
        });
      },
    });
    return cell;
  };
  const resolvedRoot = root.doc
    ? build(root, root.doc, root.doc.path ?? [])
    : build(root, receiptDoc, receiptDoc.path ?? []);
  const receipt = mockCell({
    asSchema: () => receipt,
    get: () => value,
    pull: () => Promise.resolve(value),
    // These receipts hold plain JSON, whose stored form is the value itself;
    // presence is decided on this, mirroring the production readback.
    getRaw: () => value,
    key: () => barren,
    resolveAsCell: () => resolvedRoot,
    getAsNormalizedFullLink: () => mockLink(receiptDoc),
  });
  return receipt;
}

/**
 * A fully addressable receipt cell that logs every `key()` segment the
 * walk requests into `requested` (as `/`-joined paths) — the observable
 * seam for "the walk never addresses inside a live object". Descent is cut
 * off after a small budget, so an errant walk fails a path assertion
 * deterministically instead of racing the stack limit, whose overflow the
 * walk's own addressability catch can swallow.
 */
function recordingReceiptCell(
  doc: MockLinkedDoc,
  requested: string[],
  path: string[] = [],
): Cell<any> {
  const cell: Cell<any> = mockCell({
    get: () => undefined,
    resolveAsCell: () => cell,
    getAsNormalizedFullLink: () => mockLink(doc, path),
    key: (segment: string) => {
      if (requested.length >= 32) {
        throw new Error("fake cell budget exhausted");
      }
      const next = [...path, segment];
      requested.push(next.join("/"));
      return recordingReceiptCell(doc, requested, next);
    },
  });
  return cell;
}

describe("collectInvocationResultLinks", () => {
  const receiptDoc = { id: "of:receipt-1", space: "did:key:test-home" };
  const receiptLink = mockLink(receiptDoc);

  /** The space the call targeted: an address in it carries no `@did`. */
  const contextSpace = "did:key:test-home" as MemorySpace;

  const receiptRef = "/of:receipt-1";

  it("yields just the receipt for a plain-JSON-only result", () => {
    const value = { total: 3, tags: ["a", "b"], nested: { deep: true } };
    const cell = linkedReceiptCell(receiptDoc, value);
    expect(collectInvocationResultLinks(receiptLink, cell, value, contextSpace))
      .toEqual({
        "/": receiptRef,
      });
  });

  it("skips a child key() refuses to address, keeping its siblings' links", () => {
    // The walk's catch-and-continue: a value entry the receipt cell cannot
    // address as a child (key() throws) contributes no link and must not
    // abort the walk — its addressable siblings still annotate.
    const value = { weird: { x: 1 }, comment: { body: "hi" } };
    const inner = linkedReceiptCell(receiptDoc, value, {
      children: {
        comment: { doc: { id: "of:comment-1", space: "did:key:test-home" } },
      },
    });
    // Wrap the RESOLVED root: the outer wrapper is deliberately unresolved
    // (its own key() refuses traversal), so the throwing key must shadow the
    // cell the walk actually descends through.
    const innerRoot = inner.resolveAsCell();
    const cell: Cell<any> = mockCell({
      ...innerRoot,
      resolveAsCell: () => cell,
      key: (segment: string) => {
        if (segment === "weird") throw new Error("not addressable");
        return innerRoot.key(segment);
      },
    });
    expect(collectInvocationResultLinks(receiptLink, cell, value, contextSpace))
      .toEqual({
        "/": receiptRef,
        "/comment": "/of:comment-1",
      });
  });

  it("annotates each hop to a different backing document, rebasing below it", () => {
    const value = {
      comment: { body: "hi", author: { name: "b" } },
      count: 1,
    };
    const cell = linkedReceiptCell(receiptDoc, value, {
      children: {
        comment: {
          doc: { id: "of:comment-1", space: "did:key:test-home" },
          children: {
            author: {
              doc: {
                id: "of:author-1",
                space: "did:key:test-home",
                scope: "user",
              },
            },
          },
        },
      },
    });
    expect(collectInvocationResultLinks(receiptLink, cell, value, contextSpace))
      .toEqual({
        "/": receiptRef,
        "/comment": "/of:comment-1",
        // Compared against of:comment-1, not the receipt — each hop is
        // annotated exactly once, where the document changes. The scope is
        // part of the address and rides along.
        "/comment/author": "/of:author-1@user",
        // No "/comment/body", no "/count": a path inside the same plain JSON
        // needs no link.
      });
  });

  it("addresses an array element reference by its index", () => {
    const value = { items: [{ t: "inline" }, { t: "linked" }] };
    const cell = linkedReceiptCell(receiptDoc, value, {
      children: {
        items: {
          children: {
            "1": { doc: { id: "of:item-b", space: "did:key:test-home" } },
          },
        },
      },
    });
    expect(collectInvocationResultLinks(receiptLink, cell, value, contextSpace))
      .toEqual({
        "/": receiptRef,
        "/items/1": "/of:item-b",
      });
  });

  it("keeps the sub-document path of a link below a doc's root", () => {
    const value = { pick: { t: "third entry" } };
    const cell = linkedReceiptCell(receiptDoc, value, {
      children: {
        pick: {
          doc: {
            id: "of:list-1",
            space: "did:key:test-home",
            path: ["entries", "3"],
          },
        },
      },
    });
    // Without the path the address would name the wrong value — the list
    // document's root rather than the entry the result actually references.
    expect(collectInvocationResultLinks(receiptLink, cell, value, contextSpace))
      .toEqual({
        "/": receiptRef,
        "/pick": "/of:list-1/entries/3",
      });
  });

  it("escapes pointer-special characters in path keys (RFC 6901)", () => {
    const value = { "a/b": { linked: true } };
    const cell = linkedReceiptCell(receiptDoc, value, {
      children: {
        "a/b": { doc: { id: "of:odd-key", space: "did:key:test-home" } },
      },
    });
    expect(collectInvocationResultLinks(receiptLink, cell, value, contextSpace))
      .toEqual({
        "/": receiptRef,
        "/a~1b": "/of:odd-key",
      });
  });

  it("resolves a result that is itself a reference — a scalar that is its own doc", () => {
    // The design's motivating case for provenance-beside-the-value: an
    // inline marker cannot annotate a scalar, and a scalar can be its own
    // doc. "/" must expose the document that BACKS the value, not the
    // receipt it was read through — and the receipt address stays available
    // under the reserved bare key (pointer keys always start with "/", so
    // no result path can collide with it).
    const cell = linkedReceiptCell(receiptDoc, 42, {
      doc: { id: "of:answer-1", space: "did:key:test-home" },
    });
    expect(collectInvocationResultLinks(receiptLink, cell, 42, contextSpace))
      .toEqual({
        "/": "/of:answer-1",
        receipt: receiptRef,
      });
  });

  it("rebases children of a reference-backed root onto its document", () => {
    const value = { body: "hi", author: { name: "b" } };
    const cell = linkedReceiptCell(receiptDoc, value, {
      doc: { id: "of:comment-1", space: "did:key:test-home" },
      children: {
        author: { doc: { id: "of:author-1", space: "did:key:test-home" } },
      },
    });
    expect(collectInvocationResultLinks(receiptLink, cell, value, contextSpace))
      .toEqual({
        "/": "/of:comment-1",
        receipt: receiptRef,
        "/author": "/of:author-1",
        // No "/body": it lives in the ROOT's backing document — comparing it
        // against the receipt instead would wrongly annotate every child.
      });
  });

  it("carries the receipt's own scope on the root entry", () => {
    const scoped = {
      id: "of:receipt-2",
      space: "did:key:test-home",
      scope: "session" as const,
    };
    expect(
      collectInvocationResultLinks(
        mockLink(scoped),
        linkedReceiptCell(scoped, {}),
        {},
        contextSpace,
      ),
    ).toEqual({
      "/": "/of:receipt-2@session",
    });
  });

  it("prefixes an address in another space with its space DID", () => {
    // The space is part of the address: a caller reading a link that left
    // the space they called in needs it spelled out, or the reference
    // resolves in their own space, which is a different cell.
    const value = { shared: { title: "elsewhere" } };
    const cell = linkedReceiptCell(receiptDoc, value, {
      children: {
        shared: { doc: { id: "of:shared-1", space: "did:key:other-space" } },
      },
    });
    expect(collectInvocationResultLinks(receiptLink, cell, value, contextSpace))
      .toEqual({
        "/": receiptRef,
        "/shared": "//did:key:other-space/of:shared-1",
      });
  });

  it("addresses no path inside a live (non-plain) object in the result", () => {
    // The --show-links crash shape: a stream on a returned piece is a live
    // runtime object whose runtime/scheduler properties refer back to each
    // other, and a walk that descends into it recurses until the stack runs
    // out. "Terminates without throwing" is NOT a testable contract for that
    // bug: when the overflow happens to land on the `cell.key()` call, the
    // walk's own addressability catch swallows the RangeError and unwinds
    // cleanly, so whether a crash is observable depends on where the stack
    // limit falls (fake frame sizes, V8 --stack-size) — not on the walk.
    // What the walk must guarantee is stronger and observable at this seam:
    // it never ADDRESSES a path inside a non-plain object, whose properties
    // belong to the runtime rather than the result. The fake records every
    // key() the walk requests and cuts descent off after a small budget, so
    // an errant walk fails the path assertion deterministically, far from
    // any stack limit.
    class FakeScheduler {
      runtime!: FakeRuntime;
    }
    class FakeRuntime {
      scheduler = new FakeScheduler();
      constructor() {
        this.scheduler.runtime = this;
      }
    }
    class FakeStream {
      runtime = new FakeRuntime();
    }
    const value = { child: { touch: new FakeStream() } };
    const requested: string[] = [];
    const links = collectInvocationResultLinks(
      receiptLink,
      recordingReceiptCell(receiptDoc, requested),
      value,
      contextSpace,
    );
    // The stream itself is addressed — it is a property of the result and
    // may carry a document of its own. Nothing below it is.
    expect(requested).toEqual(["child", "child/touch"]);
    expect(links).toEqual({ "/": receiptRef });
  });

  it("addresses nothing when the result is itself a live object", () => {
    // The same contract at the root: the walk's entry guard — not only the
    // per-child check — is what keeps a live result's properties
    // unaddressed. With the guard on children alone, the walk enumerated a
    // root instance and addressed "scheduler".
    class FakeScheduler {
      runtime!: FakeRuntime;
    }
    class FakeRuntime {
      scheduler = new FakeScheduler();
      constructor() {
        this.scheduler.runtime = this;
      }
    }
    const requested: string[] = [];
    const links = collectInvocationResultLinks(
      receiptLink,
      recordingReceiptCell(receiptDoc, requested),
      new FakeRuntime(),
      contextSpace,
    );
    expect(requested).toEqual([]);
    expect(links).toEqual({ "/": receiptRef });
  });
});

describe("call --show-links", () => {
  const config = {
    apiUrl: "http://localhost:8000",
    identity: "/tmp/test-identity.pem",
    piece: "fid1:piece-123",
    space: "home",
  };
  const commentValue = {
    comment: { body: "hi" },
    count: 1,
  };
  const commentReceipt = () =>
    linkedReceiptCell(
      // Must match the harness's handlingReceiptLink, or every path would
      // read as a foreign document.
      { id: "of:receipt-1", space: "did:key:test-home" },
      commentValue,
      {
        children: {
          comment: {
            doc: { id: "of:comment-1", space: "did:key:test-home" },
          },
        },
      },
    );
  const handlerOptions = {
    callableKind: "handler" as const,
    cellKey: "addComment",
    inputSchema: {
      type: "object",
      properties: {
        message: { type: "string" },
      },
      required: ["message"],
    } as JSONSchema,
  };

  it("emits the links dictionary beside the result", async () => {
    const harness = createPieceCallableHarness({
      ...handlerOptions,
      receiptCell: commentReceipt(),
    });

    const result = await executePieceCallable(
      config,
      "addComment",
      ["--message", "milk"],
      {
        sendEvent: sendThroughStandIn,
        loadPieces: () => Promise.resolve(harness.pieces),
        loadPiece: () => Promise.resolve(harness.piece),
        invocation: { id: "inv-links", session: callerSession },
        showLinks: true,
      },
    );

    expect(result.invocation).toEqual({
      id: "inv-links",
      status: "settled",
      receipt: harnessReceipt,
      result: commentValue,
      links: {
        "/": "/of:receipt-1",
        "/comment": "/of:comment-1",
      },
    });
    // And the stdout JSON carries it as a sibling of result — beside the
    // value, never inline in it.
    const json = invocationJson(result.invocation!);
    expect(Object.keys(json)).toEqual([
      "invocation",
      "status",
      "receipt",
      "result",
      "links",
    ]);
  });

  it("leaves the Invocation JSON untouched without the flag", async () => {
    const harness = createPieceCallableHarness({
      ...handlerOptions,
      receiptCell: commentReceipt(),
    });

    const result = await executePieceCallable(
      config,
      "addComment",
      ["--message", "milk"],
      {
        sendEvent: sendThroughStandIn,
        loadPieces: () => Promise.resolve(harness.pieces),
        loadPiece: () => Promise.resolve(harness.piece),
        invocation: { id: "inv-no-links", session: callerSession },
      },
    );

    expect(result.invocation).toEqual({
      id: "inv-no-links",
      status: "settled",
      receipt: harnessReceipt,
      result: commentValue,
    });
    expect(invocationJson(result.invocation!)).not.toHaveProperty("links");
  });

  it("annotates a value-less verb with just the receipt", async () => {
    const harness = createPieceCallableHarness({
      callableKind: "handler",
      cellKey: "refresh",
      inputSchema: { type: "object", properties: {} },
      receiptCell: linkedReceiptCell(
        { id: "of:receipt-1", space: "did:key:test-home" },
        {},
      ),
    });

    const result = await executePieceCallable(config, "refresh", [], {
      sendEvent: sendThroughStandIn,
      loadPieces: () => Promise.resolve(harness.pieces),
      loadPiece: () => Promise.resolve(harness.piece),
      isStdinTerminal: () => true,
      invocation: { id: "inv-void-links", session: callerSession },
      showLinks: true,
    });

    // No result key — the existence-only receipt stays distinguishable from
    // a verb that returned a value — but the receipt's address is real and
    // the caller asked for it.
    expect(result.invocation).toEqual({
      id: "inv-void-links",
      status: "settled",
      receipt: harnessReceipt,
      links: {
        "/": "/of:receipt-1",
      },
    });
  });

  it("keeps the tool path unchanged: resultRef stays the tool's address surface", async () => {
    const harness = createPieceCallableHarness({
      callableKind: "tool",
      cellKey: "search",
      inputSchema: {
        type: "object",
        properties: {
          query: { type: "string" },
        },
        required: ["query"],
      },
      pattern: {
        argumentSchema: {
          type: "object",
          properties: {
            query: { type: "string" },
          },
          required: ["query"],
        },
        resultSchema: { type: "object" },
      },
      toolResult: { ok: true },
    });

    const result = await executePieceCallable(
      config,
      "search",
      ["--query", "tea"],
      {
        loadPieces: () => Promise.resolve(harness.pieces),
        loadPiece: () => Promise.resolve(harness.piece),
        uuid: () => "tool-result-id",
        showLinks: true,
      },
    );

    // Links ride the Invocation JSON, which only handler invocations emit;
    // the tool's own address already rides resultRef (WS-B), unchanged.
    expect(result.invocation).toBeUndefined();
    expect(JSON.parse(result.outputText!)).toEqual({ ok: true });
    expect(result.resultRef).toEqual({
      id: "of:tool-result-cell",
      space: "did:key:test-home",
      scope: "space",
    });
  });

  it("refuses --show-links with --no-wait, and allows it with a wait", () => {
    expect(() => resolveWaitControl({ wait: false, showLinks: true })).toThrow(
      /--show-links needs the receipt readback/,
    );
    expect(resolveWaitControl({ showLinks: true })).toEqual({ mode: "settle" });
    expect(resolveWaitControl({ wait: 5, showLinks: true })).toEqual({
      mode: "settle",
      boundSeconds: 5,
    });
  });
});

/** What the shared selection step was handed, and the answer it gives back.
 * Standing in for `deriveSelectedValue` is what makes "which cell did the
 * call point the step at" observable — the answer itself is the step's own
 * business, and `piece-get-transform.test.ts` is where it is pinned. */
function recordingSelector(answer: unknown) {
  const calls: Array<{
    space: unknown;
    cell: unknown;
    selection: CellSelection;
  }> = [];
  const derive = ((
    _runtime: unknown,
    space: unknown,
    cell: unknown,
    selection: CellSelection,
  ) => {
    calls.push({ space, cell, selection });
    return Promise.resolve(answer);
  }) as unknown as typeof deriveSelectedValue;
  return { calls, derive };
}

describe("call selection", () => {
  const config = {
    apiUrl: "http://localhost:8000",
    identity: "/tmp/test-identity.pem",
    piece: "fid1:piece-123",
    space: "home",
  };
  const addTopic = {
    callableKind: "handler" as const,
    cellKey: "addTopic",
    inputSchema: {
      type: "object",
      properties: { title: { type: "string" } },
      required: ["title"],
    } as JSONSchema,
  };
  const topicResult = {
    topic: { title: "Ship it", body: "the initial document" },
  };

  it("points the shared selection step at the receipt the result came from", async () => {
    // The whole of C2: a call reaches the same step `cf cell get` reads
    // through, pointed at the cell the value was read from — so the shaped
    // answer carries the source's own links rather than a copy of a copy.
    const receiptCell = {
      asSchema: () => receiptCell,
      get: () => topicResult,
      pull: () => Promise.resolve(topicResult),
      getRaw: () => topicResult,
      key: () => receiptCell,
    } as unknown as Cell<any>;
    const harness = createPieceCallableHarness({ ...addTopic, receiptCell });
    const selector = recordingSelector({ topic: { title: "Ship it" } });
    const selection = await parseCellSelectionOptions({
      select: "topic.title",
    });

    const result = await executePieceCallable(
      config,
      "addTopic",
      ["--title", "Ship it"],
      {
        sendEvent: sendThroughStandIn,
        loadPieces: () => Promise.resolve(harness.pieces),
        loadPiece: () => Promise.resolve(harness.piece),
        invocation: { id: "inv-select", session: callerSession },
        selection,
        deriveSelectedValue: selector.derive,
      },
    );

    expect(result.invocation).toEqual({
      id: "inv-select",
      status: "settled",
      receipt: harnessReceipt,
      result: { topic: { title: "Ship it" } },
    });
    expect(selector.calls).toHaveLength(1);
    expect(selector.calls[0].cell).toBe(receiptCell);
    expect(selector.calls[0].selection).toBe(selection);
    expect(selector.calls[0].space).toBe("did:key:test-home");
  });

  it("leaves the Invocation JSON unshaped when no selection was asked for", async () => {
    const harness = createPieceCallableHarness({
      ...addTopic,
      receiptValue: topicResult,
    });
    const selector = recordingSelector("never");

    const result = await executePieceCallable(
      config,
      "addTopic",
      ["--title", "Ship it"],
      {
        sendEvent: sendThroughStandIn,
        loadPieces: () => Promise.resolve(harness.pieces),
        loadPiece: () => Promise.resolve(harness.piece),
        invocation: { id: "inv-plain", session: callerSession },
        deriveSelectedValue: selector.derive,
      },
    );

    expect(result.invocation).toEqual({
      id: "inv-plain",
      status: "settled",
      receipt: harnessReceipt,
      result: topicResult,
    });
    expect(selector.calls).toEqual([]);
  });

  it("keeps a value-less verb reporting no result at all", async () => {
    // The empty witness means "this verb returns nothing". A selection is
    // about a value, and there is none, so the step never runs — reporting
    // `{}` here would erase the distinction the empty receipt draws.
    const harness = createPieceCallableHarness({
      callableKind: "handler",
      cellKey: "refresh",
      inputSchema: { type: "object", properties: {} },
      receiptValue: {},
    });
    const selector = recordingSelector({ never: true });

    const result = await executePieceCallable(config, "refresh", [], {
      sendEvent: sendThroughStandIn,
      loadPieces: () => Promise.resolve(harness.pieces),
      loadPiece: () => Promise.resolve(harness.piece),
      isStdinTerminal: () => true,
      invocation: { id: "inv-void-select", session: callerSession },
      selection: await parseCellSelectionOptions({ select: "anything" }),
      deriveSelectedValue: selector.derive,
    });

    expect(result.invocation).toEqual({
      id: "inv-void-select",
      status: "settled",
      receipt: harnessReceipt,
    });
    expect(invocationJson(result.invocation!)).not.toHaveProperty("result");
    expect(selector.calls).toEqual([]);
  });

  it("refuses a selection that materializes nothing over a result that exists", async () => {
    // Reporting no result here would say "the verb returned nothing", which
    // is a different fact from "your projection kept nothing".
    const harness = createPieceCallableHarness({
      ...addTopic,
      receiptValue: topicResult,
    });
    const selector = recordingSelector(undefined);

    await expect(
      executePieceCallable(config, "addTopic", ["--title", "Ship it"], {
        sendEvent: sendThroughStandIn,
        loadPieces: () => Promise.resolve(harness.pieces),
        loadPiece: () => Promise.resolve(harness.piece),
        invocation: { id: "inv-empty-select", session: callerSession },
        selection: await parseCellSelectionOptions({
          schema: '{"type":"string"}',
        }),
        deriveSelectedValue: selector.derive,
      }),
    ).rejects.toThrow(CellSelectionError);
    expect(selector.calls).toHaveLength(1);
  });

  it("shapes a tool's stdout through the same step", async () => {
    const harness = createPieceCallableHarness({
      callableKind: "tool",
      cellKey: "search",
      inputSchema: {
        type: "object",
        properties: { query: { type: "string" } },
        required: ["query"],
      },
      pattern: {
        argumentSchema: {
          type: "object",
          properties: { query: { type: "string" } },
          required: ["query"],
        },
        resultSchema: { type: "object" },
      },
      toolResult: { hits: [{ id: 1, title: "Tea" }], cursor: "abc" },
    });
    const selector = recordingSelector({ hits: [{ title: "Tea" }] });

    const result = await executePieceCallable(
      config,
      "search",
      ["--query", "tea"],
      {
        loadPieces: () => Promise.resolve(harness.pieces),
        loadPiece: () => Promise.resolve(harness.piece),
        uuid: () => "tool-result-id",
        selection: await parseCellSelectionOptions({ select: "hits.title" }),
        deriveSelectedValue: selector.derive,
      },
    );

    // One grammar covers both callable kinds; the tool's own address surface
    // is untouched by the shaping.
    expect(JSON.parse(result.outputText!)).toEqual({
      hits: [{ title: "Tea" }],
    });
    expect(result.resultRef).toEqual({
      id: "of:tool-result-cell",
      space: "did:key:test-home",
      scope: "space",
    });
    expect(selector.calls).toHaveLength(1);
  });

  it("collects --show-links against the shaped result, not the whole receipt", async () => {
    // Links annotate the value the caller is holding. With a projection that
    // drops `comment`, an entry for `/comment` would name provenance for
    // something the caller was not given.
    const receiptDoc = { id: "of:receipt-1", space: "did:key:test-home" };
    const stored = { comment: { body: "hi" }, count: 1 };
    const harness = createPieceCallableHarness({
      ...addTopic,
      receiptCell: linkedReceiptCell(receiptDoc, stored, {
        children: {
          comment: { doc: { id: "of:comment-1", space: "did:key:test-home" } },
        },
      }),
    });
    const selector = recordingSelector({ count: 1 });

    const result = await executePieceCallable(
      config,
      "addTopic",
      ["--title", "Ship it"],
      {
        sendEvent: sendThroughStandIn,
        loadPieces: () => Promise.resolve(harness.pieces),
        loadPiece: () => Promise.resolve(harness.piece),
        invocation: { id: "inv-select-links", session: callerSession },
        showLinks: true,
        selection: await parseCellSelectionOptions({ select: "count" }),
        deriveSelectedValue: selector.derive,
      },
    );

    expect(result.invocation).toEqual({
      id: "inv-select-links",
      status: "settled",
      receipt: harnessReceipt,
      result: { count: 1 },
      links: {
        "/": "/of:receipt-1",
      },
    });
  });

  describe("flag combinations", () => {
    it("refuses each selection flag with --no-wait, naming the ones passed", () => {
      expect(() => resolveWaitControl({ wait: false, filter: ".a" })).toThrow(
        /^--filter needs the receipt readback that --no-wait skips/,
      );
      expect(() => resolveWaitControl({ wait: false, select: "a" })).toThrow(
        /^--select needs the receipt readback/,
      );
      expect(() => resolveWaitControl({ wait: false, schema: "{}" })).toThrow(
        /^--schema needs the receipt readback/,
      );
      expect(() =>
        resolveWaitControl({
          wait: false,
          showLinks: true,
          filter: ".a",
          select: "a",
        })
      ).toThrow(
        /^--show-links, --filter and --select need the receipt readback/,
      );
    });

    it("allows every selection flag with the default and bounded waits", () => {
      expect(resolveWaitControl({ filter: ".a", select: "a" })).toEqual({
        mode: "settle",
      });
      expect(resolveWaitControl({ wait: 5, schema: "{}" })).toEqual({
        mode: "settle",
        boundSeconds: 5,
      });
    });

    it("refuses --filter with --show-links: a predicate moves the positions a link names", async () => {
      await expect(
        parsePieceCallSelection({
          filter: '.status == "open"',
          showLinks: true,
        }),
      ).rejects.toThrow(ValidationError);
      await expect(
        parsePieceCallSelection({
          filter: '.status == "open"',
          showLinks: true,
        }),
      ).rejects.toThrow(/--show-links cannot be combined with --filter/);
      // A projection keeps every surviving path where it was, so it composes.
      expect(
        await parsePieceCallSelection({ select: "title", showLinks: true }),
      ).toBeDefined();
    });

    it("parses through the same grammar `cf cell get` reads", async () => {
      expect(await parsePieceCallSelection({})).toBeUndefined();
      const selection = await parsePieceCallSelection({
        filter: ".done == false",
        select: "id,title",
      });
      expect(selection?.filter?.source).toBe(".done == false");
      expect(selection?.projection?.flag).toBe("--select");
      // The parser's own refusals arrive unchanged, so a caller reads one
      // set of messages whichever command produced them.
      await expect(parsePieceCallSelection({ filter: ".a ==" })).rejects
        .toThrow(CellSelectionError);
    });

    it("reports a malformed selection without naming an invocation to retry", async () => {
      const { code, stderr } = await cf(
        "call " +
          "--identity ./definitely-missing-piece-call-review.key " +
          "--api-url https://cf.dev --space common-knowledge " +
          "--piece fid1:piece-123 addTopic -- --select a..b",
      );
      const errors = stripAnsi(stderr.join("\n"));
      expect(code).toBe(1);
      expect(errors).toContain('Invalid --select field path "a..b"');
      // The selection is read before a callable is resolved and before
      // anything is sent, so no id has been spent and no phase has been
      // reached. An `invocation: <id> phase: <phase>` line here would send
      // the caller to recover a call that was never made.
      expect(errors).not.toContain("invocation:");
      expect(errors).not.toContain("phase:");
    });
  });
});

const selectionSigner = await Identity.fromPassphrase(
  "cf-piece-call-selection",
);

describe("call over a live runtime", () => {
  const signer = selectionSigner;
  const space = signer.did();
  let storageManager: ReturnType<typeof StorageManager.emulate>;
  let runtime: Runtime;

  beforeEach(() => {
    storageManager = StorageManager.emulate({ as: signer });
    const runtimeErrors: Array<{ message: string }> = [];
    runtime = new Runtime({
      apiUrl: new URL("https://example.com"),
      storageManager,
      errorHandlers: [
        (error) => runtimeErrors.push({ message: error.message }),
      ],
    });
    (runtime as unknown as Record<symbol, unknown>)[CF_RUNTIME_ERROR_LOG] =
      runtimeErrors;
  });

  afterEach(async () => {
    await runtime.dispose();
    await storageManager.close();
  });

  /**
   * A verb whose handling commits a receipt holding `value`, dispatched
   * against the real runtime the selection then runs in. The receipt is
   * written with NO declared schema, which is what a handling's receipt
   * carries today — so this also pins that a schema-less source still
   * projects.
   */
  async function settleWith(value: unknown): Promise<CallableResolution> {
    const tx = runtime.edit();
    const receipt = runtime.getCell(space, "handling-receipt", undefined, tx);
    receipt.set(value);
    expect((await tx.commit().settled).ok).toBeDefined();
    const handlingReceiptLink = runtime
      .getCell(space, "handling-receipt")
      .getAsNormalizedFullLink();
    return {
      callableCell: {
        schema: {
          type: "object",
          properties: { title: { type: "string" } },
          required: ["title"],
        },
        send: (
          _payload: unknown,
          onCommit?: (tx: unknown) => void,
        ) =>
          onCommit?.({
            status: () => ({ status: "done", journal: { novelty: () => [] } }),
            handlingReceiptLink,
          }),
      } as unknown as Cell<any>,
      callableKind: "handler",
      cellKey: "addTopic",
      pieces: { runtime, getSpace: () => space } as never,
      space,
    };
  }

  /** The serialized address of the receipt `settleWith` commits — what the
   * envelope publishes, read off the same real cell the handling hands the
   * commit callback. */
  function receiptAddress(): string {
    const link = runtime
      .getCell(space, "handling-receipt")
      .getAsNormalizedFullLink();
    return createLLMFriendlyLink(link, space);
  }

  it("projects a settled result through the real selection step", async () => {
    const resolved = await settleWith({
      topics: [
        { id: 1, title: "First", status: "open" },
        { id: 2, title: "Second", status: "closed" },
      ],
    });

    const executed = await executeResolvedCallable(
      resolved,
      { title: "Ship it" },
      {
        sendEvent: sendThroughStandIn,
        invocation: { id: "inv-live", session: callerSession },
        selection: await parseCellSelectionOptions({ select: "topics.title" }),
      },
    );

    expect(executed.invocation).toEqual({
      id: "inv-live",
      status: "settled",
      receipt: receiptAddress(),
      result: { topics: [{ title: "First" }, { title: "Second" }] },
    });
  });

  it("filters a settled array result", async () => {
    const resolved = await settleWith([
      { id: 1, title: "First", status: "open" },
      { id: 2, title: "Second", status: "closed" },
      { id: 3, title: "Third", status: "open" },
    ]);

    const executed = await executeResolvedCallable(
      resolved,
      { title: "Ship it" },
      {
        sendEvent: sendThroughStandIn,
        invocation: { id: "inv-live-filter", session: callerSession },
        selection: await parseCellSelectionOptions({
          filter: '.status == "open"',
          select: "id,title",
        }),
      },
    );

    expect(executed.invocation?.result).toEqual([
      { id: 1, title: "First" },
      { id: 3, title: "Third" },
    ]);
  });

  it("returns the address of what a verb returned, in place of its contents", async () => {
    // The `$link` marker reaches a call through the same step, which is what
    // makes `cf piece call ... addTopic <json> -- --schema
    // '{"properties":{"topic":{"$link":true}}}'` — the command's own example
    // — an address a later call can use.
    const tx = runtime.edit();
    const topic = runtime.getCell(space, "created-topic", undefined, tx);
    topic.set({ title: "Ship it", body: "the initial document" });
    expect((await tx.commit().settled).ok).toBeDefined();
    const resolved = await settleWith({
      topic: runtime.getCell(space, "created-topic"),
    });

    const executed = await executeResolvedCallable(
      resolved,
      { title: "Ship it" },
      {
        sendEvent: sendThroughStandIn,
        invocation: { id: "inv-live-link", session: callerSession },
        selection: await parseCellSelectionOptions({
          schema: '{"properties":{"topic":{"$link":true}}}',
        }),
      },
    );

    // One string, and the string `--piece` takes back in: the address a
    // later call is written with.
    const created = runtime.getCell(space, "created-topic")
      .getAsNormalizedFullLink();
    expect(executed.invocation?.result).toEqual({
      topic: { $link: createLLMFriendlyLink(created, space) },
    });
    expect(parseLLMFriendlyLink(
      (executed.invocation?.result as { topic: { $link: string } }).topic
        .$link,
    )).toMatchObject({ id: created.id, path: [] });
  });

  it("refuses a selection that materializes nothing over a real result", async () => {
    const resolved = await settleWith({ topic: { title: "Ship it" } });

    await expect(
      executeResolvedCallable(resolved, { title: "Ship it" }, {
        sendEvent: sendThroughStandIn,
        invocation: { id: "inv-live-nothing", session: callerSession },
        selection: await parseCellSelectionOptions({
          schema: '{"type":"string"}',
        }),
      }),
    ).rejects.toThrow(
      /Cannot shape the result of "addTopic".*did not materialize/s,
    );
  });

  it("hands a detached call an address that reads the outcome back", async () => {
    // The whole of `receipt`: a caller that skipped the readback holds an
    // address, and that address resolves to the outcome it named. Reading it
    // is an ordinary read — no second dispatch, so a verb whose body has
    // effects outside its transaction does not repeat them.
    const outcome = { topic: { title: "Ship it", body: "the document" } };
    const resolved = await settleWith(outcome);

    const executed = await executeResolvedCallable(
      resolved,
      { title: "Ship it" },
      {
        sendEvent: sendThroughStandIn,
        invocation: { id: "inv-live-detached", session: callerSession },
        skipReadback: true,
      },
    );

    // Nothing was read back — the envelope carries no result — and the
    // address is still there to collect with.
    expect(executed.invocation).toEqual({
      id: "inv-live-detached",
      status: "committed",
      receipt: receiptAddress(),
    });

    // Resolve the published address through the reference intake `--piece`
    // runs it through — the published form IS that intake's form — and read
    // the cell it names. This covers the address and the intake; it stops
    // short of the whole `cf cell get` route, which also runs slug
    // resolution and the read-path guards before reaching the same cell.
    const published = parseLink(executed.invocation!.receipt!, { space });
    const collected = runtime.getCellFromEntityId(
      space,
      entityIdFrom(published.pieceId),
      published.path ?? [],
      undefined,
    );
    await collected.sync();
    expect(collected.get()).toEqual(outcome);
  });
});

describe("get data errors", () => {
  it("classifies unresolved-path failures as data errors, not usage errors", () => {
    expect(
      isPieceGetDataError(
        new Error('Cannot access path "bogus" - property "bogus" not found'),
      ),
    ).toBe(true);
    expect(isPieceGetDataError(new Error("network unreachable"))).toBe(false);
    expect(isPieceGetDataError("Cannot access path")).toBe(false);
  });

  it("reports a result-mode data error with an --input hint", () => {
    const report = pieceGetDataErrorReport(
      new Error('Cannot access path "x" - property "x" not found'),
      { input: false, piece: "fid1:piece-123" },
    );
    expect(report?.message).toMatch(/Cannot access path "x"/);
    expect(report?.hint).toMatch(/retry with --input/);
    expect(report?.hint).toMatch(/fid1:piece-123/);
  });

  it("omits the hint in input mode (nothing left to suggest)", () => {
    const report = pieceGetDataErrorReport(
      new Error('Cannot access path "x" - property "x" not found'),
      { input: true, piece: "fid1:piece-123" },
    );
    expect(report?.message).toMatch(/Cannot access path "x"/);
    expect(report?.hint).toBeUndefined();
  });

  it("returns null for a non-data error (caller rethrows)", () => {
    expect(
      pieceGetDataErrorReport(new Error("network unreachable"), {
        input: false,
        piece: "fid1:piece-123",
      }),
    ).toBeNull();
  });

  it("treats a result-projection failure as a data error, keeping its own --step hint", () => {
    const projectionError = new PieceResultProjectionError(
      ["totalSpent"],
      false,
    );
    expect(isPieceGetDataError(projectionError)).toBe(true);
    const report = pieceGetDataErrorReport(projectionError, {
      input: false,
      piece: "fid1:piece-123",
    });
    // The message carries its own --step guidance; we must not bury it under
    // the generic --input tip (a different remedy).
    expect(report?.message).toMatch(/schema could not resolve/);
    expect(report?.message).toMatch(/--step/);
    expect(report?.hint).toBeUndefined();
  });

  it("reports selection failures without an unrelated --input hint", () => {
    const selectionError = new CellSelectionError(
      "--filter can only be applied to an array",
    );
    expect(isPieceGetDataError(selectionError)).toBe(true);
    const report = pieceGetDataErrorReport(selectionError, {
      input: false,
      piece: "fid1:piece-123",
    });
    expect(report?.message).toBe("--filter can only be applied to an array");
    expect(report?.hint).toBeUndefined();
  });

  it("refuses a path that lands on a verb with the call redirect and exit 1", () => {
    const verbError = new PieceVerbReadError(
      "addTopic",
      "fid1:piece-123",
      true,
    );
    expect(isPieceGetDataError(verbError)).toBe(true);
    const report = pieceGetDataErrorReport(verbError, {
      input: false,
      piece: "fid1:piece-123",
    });
    // The message IS the redirect — mirroring the llm-dialog read tool's
    // "Path resolves to a handler; use invoke() instead." — so no extra hint
    // rides along (the --input tip would be a wrong remedy for a verb).
    expect(report?.message).toBe(
      "Path resolves to a verb; use 'cf piece call --cell fid1:piece-123 addTopic' instead.",
    );
    expect(report?.hint).toBeUndefined();

    // A nested verb is not root-callable, so its report must not suggest a
    // command that would fail — it redirects at the parent read and the
    // verbs listing instead, still hint-free.
    const nestedReport = pieceGetDataErrorReport(
      new PieceVerbReadError("removeItem", "fid1:piece-123", false),
      { input: false, piece: "fid1:piece-123" },
    );
    expect(nestedReport?.message).toMatch(/not directly callable/);
    expect(nestedReport?.message).toMatch(
      /cf piece verbs --cell fid1:piece-123/,
    );
    expect(nestedReport?.message).not.toContain("cf piece call");
    expect(nestedReport?.hint).toBeUndefined();

    // Threaded through the shared data-error exit: stderr message, exit 1.
    const printed: string[] = [];
    const exited: number[] = [];
    expect(() =>
      exitWithDataError(report!, {
        printError: (m) => printed.push(m),
        printHint: () => {},
        exit: (code: number): never => {
          exited.push(code);
          throw new Error("exit-sentinel");
        },
      })
    ).toThrow("exit-sentinel");
    expect(printed).toEqual([
      "Path resolves to a verb; use 'cf piece call --cell fid1:piece-123 addTopic' instead.",
    ]);
    expect(exited).toEqual([1]);
  });
});

describe("piece link data errors", () => {
  it("reports a validation failure with an inspect hint for both pieces", () => {
    const report = pieceLinkDataErrorReport(
      new LinkValidationError(
        'Source path "config/email" does not exist on piece fid1:source-1\n\nUse --allow-non-existing to link anyway.',
      ),
      { sourcePieceId: "fid1:source-1", targetPieceId: "fid1:target-1" },
    );
    // The runtime's message survives verbatim — it carries its own
    // --allow-non-existing next step — and the hint adds the inspect pointer.
    expect(report?.message).toMatch(/does not exist on piece fid1:source-1/);
    expect(report?.message).toMatch(/--allow-non-existing/);
    expect(report?.hint).toMatch(/piece inspect/);
    expect(report?.hint).toMatch(/fid1:source-1/);
    expect(report?.hint).toMatch(/fid1:target-1/);
  });

  it("returns null for a non-validation error (caller rethrows)", () => {
    expect(
      pieceLinkDataErrorReport(new Error("network unreachable"), {
        sourcePieceId: "fid1:source-1",
        targetPieceId: "fid1:target-1",
      }),
    ).toBeNull();
  });
});

describe("call input errors", () => {
  it("reports the rejection with a pointer at the verb listing", () => {
    const report = verbInputErrorReport(
      new VerbInputValidationError(
        "recordMessage",
        "missing required property message",
      ),
      { piece: "fid1:piece-123" },
    );
    expect(report?.message).toMatch(/Invalid input for "recordMessage"/);
    expect(report?.message).toMatch(/missing required property message/);
    expect(report?.hint).toMatch(/piece verbs/);
    expect(report?.hint).toMatch(/fid1:piece-123/);
  });

  it("returns null for a non-input error (caller rethrows)", () => {
    expect(
      verbInputErrorReport(new Error("network unreachable"), {
        piece: "fid1:piece-123",
      }),
    ).toBeNull();
  });
});

describe("exitWithDataError", () => {
  const exitSentinel = (exited: number[]) => (code: number): never => {
    exited.push(code);
    throw new Error("exit-sentinel");
  };

  it("prints message then hint to stderr sinks and exits 1", () => {
    const printed: string[] = [];
    const exited: number[] = [];
    expect(() =>
      exitWithDataError({ message: "boom", hint: "TIP: look closer" }, {
        printError: (m) => printed.push(`error:${m}`),
        printHint: (m) => printed.push(`hint:${m}`),
        exit: exitSentinel(exited),
      })
    ).toThrow("exit-sentinel");
    expect(printed).toEqual(["error:boom", "hint:TIP: look closer"]);
    expect(exited).toEqual([1]);
  });

  it("omits the hint line when the report has none", () => {
    const printed: string[] = [];
    const exited: number[] = [];
    expect(() =>
      exitWithDataError({ message: "boom" }, {
        printError: (m) => printed.push(`error:${m}`),
        printHint: (m) => printed.push(`hint:${m}`),
        exit: exitSentinel(exited),
      })
    ).toThrow("exit-sentinel");
    expect(printed).toEqual(["error:boom"]);
    expect(exited).toEqual([1]);
  });
});

describe("verbInputSchemaError", () => {
  const objectSchema: JSONSchema = {
    type: "object",
    properties: { message: { type: "string" } },
    required: ["message"],
  };

  it("accepts a payload that matches", () => {
    expect(verbInputSchemaError({ message: "milk" }, objectSchema))
      .toBeUndefined();
  });

  it("rejects a missing required property", () => {
    // `{}` rather than a misspelling, so this reaches the schema validation
    // rather than the undeclared-field refusal that now precedes it — a
    // misspelled required property is BOTH, and it is refused as the undeclared
    // field it is (verb-undeclared-field.test.ts).

    expect(verbInputSchemaError({}, objectSchema)).toMatch(/message/);
  });

  it("rejects a payload of the wrong type", () => {
    expect(verbInputSchemaError(["not-an-object"], objectSchema))
      .toMatch(/object/);
  });

  it("leaves an absent payload alone so value-less verbs still send", () => {
    expect(verbInputSchemaError(undefined, objectSchema)).toBeUndefined();
  });

  it("accepts anything when the verb declares no schema", () => {
    expect(verbInputSchemaError({ anything: 1 }, undefined)).toBeUndefined();
    expect(verbInputSchemaError({ anything: 1 }, true)).toBeUndefined();
  });

  it("treats a defaulted property as satisfied when omitted", () => {
    // The runtime injects a property's default when the payload omits it, so
    // requiring it here would refuse a call the verb would have accepted. This
    // pins that the gate APPLIES the relaxation; the relaxation's own semantics
    // ($ref chains, combinators, cycles, the `definitions` refusal) are pinned
    // where the helpers live (runner
    // `cfc-defaulted-required-relaxation.test.ts` — verb contract D6).

    expect(verbInputSchemaError({}, {
      type: "object",
      properties: { mode: { type: "string", default: "fast" } },
      required: ["mode"],
    })).toBeUndefined();
  });

  it("accepts asCell fields given either a plain value or a link", () => {
    const schema: JSONSchema = {
      type: "object",
      properties: {
        target: {
          type: "object",
          properties: { n: { type: "number" } },
          asCell: ["cell"],
        },
      },
      required: ["target"],
    };
    expect(verbInputSchemaError({ target: { n: 1 } }, schema)).toBeUndefined();
    expect(
      verbInputSchemaError(
        { target: { "/": { id: "of:abc", path: [], space: "did:x:y" } } },
        schema,
      ),
    ).toBeUndefined();
  });
});

describe("normalizeAbsentVerbPayload", () => {
  it("normalizes absence to {} against a plain object schema", () => {
    expect(normalizeAbsentVerbPayload(undefined, {
      type: "object",
      properties: { message: { type: "string" } },
      required: ["message"],
    })).toEqual({});
  });

  it("normalizes absence to {} through a top-level local $ref", () => {
    expect(normalizeAbsentVerbPayload(undefined, {
      $ref: "#/$defs/Event",
      asCell: ["stream"],
      $defs: {
        Event: {
          type: "object",
          properties: { message: { type: "string" } },
          required: ["message"],
        },
      },
    } as JSONSchema)).toEqual({});
  });

  it("leaves a supplied payload untouched, object schema or not", () => {
    const payload = { message: "milk" };
    expect(normalizeAbsentVerbPayload(payload, {
      type: "object",
      properties: { message: { type: "string" } },
    })).toBe(payload);
    expect(normalizeAbsentVerbPayload("text", { type: "string" })).toBe(
      "text",
    );
  });

  it("leaves absence alone when the verb declares no schema", () => {
    expect(normalizeAbsentVerbPayload(undefined, undefined)).toBeUndefined();
    expect(normalizeAbsentVerbPayload(undefined, true)).toBeUndefined();
  });

  it("leaves absence alone against a boolean false schema", () => {
    // An absent payload must keep passing a `false` schema — a supplied one is
    // already refused by the validator ("schema rejects all values"), and
    // normalizing here would convert every call into that refusal.

    expect(normalizeAbsentVerbPayload(undefined, false)).toBeUndefined();
  });

  it("leaves absence alone against a non-object schema", () => {
    expect(normalizeAbsentVerbPayload(undefined, { type: "string" }))
      .toBeUndefined();
    expect(normalizeAbsentVerbPayload(undefined, {
      type: "array",
      items: { type: "string" },
    })).toBeUndefined();
  });

  it("leaves absence alone when the top-level $ref cannot be resolved", () => {
    // Refuse only on proof: a $ref nobody can resolve proves nothing about the
    // event being an object, so absence keeps today's pass-through behavior.

    expect(normalizeAbsentVerbPayload(undefined, {
      $ref: "#/$defs/Absent",
      asCell: ["stream"],
      $defs: { Present: { type: "object" } },
    } as JSONSchema)).toBeUndefined();
  });

  it("leaves absence alone when the top-level $ref names a boolean def", () => {
    // A boolean definition is a resolvable target that still proves nothing
    // about the event being an object — absence passes through, like any other
    // non-object target.

    expect(normalizeAbsentVerbPayload(undefined, {
      $ref: "#/$defs/Anything",
      asCell: ["stream"],
      $defs: { Anything: true },
    } as JSONSchema)).toBeUndefined();
  });

  it("normalizes absence to {} against an allOf of object schemas", () => {
    // An allOf conjunction with an object-schema branch IS an object schema —
    // no branch choice is involved, so `{}` is exactly as meaningful as for a
    // direct object root, and the gate then judges it the same way (refused
    // when non-defaulted required survives relaxation, dispatched with defaults
    // engaging when it does not).

    expect(normalizeAbsentVerbPayload(undefined, {
      allOf: [
        {
          type: "object",
          properties: { mode: { type: "string", default: "fast" } },
          required: ["mode"],
        },
      ],
    } as unknown as JSONSchema)).toEqual({});
  });

  it("normalizes absence through an allOf branch behind a $ref", () => {
    expect(normalizeAbsentVerbPayload(undefined, {
      allOf: [{ $ref: "#/$defs/Base" }],
      $defs: {
        Base: {
          type: "object",
          properties: { mode: { type: "string", default: "fast" } },
        },
      },
    } as unknown as JSONSchema)).toEqual({});
  });

  it("leaves absence alone against anyOf/oneOf roots", () => {
    // Disjunctive roots stay out of scope (the D5 rule's recorded combinator
    // boundary): normalizing `{}` against anyOf/oneOf would pick among
    // alternatives on the caller's behalf.

    expect(normalizeAbsentVerbPayload(undefined, {
      anyOf: [{ type: "object", properties: {} }],
    } as unknown as JSONSchema)).toBeUndefined();
    expect(normalizeAbsentVerbPayload(undefined, {
      oneOf: [{ type: "object", properties: {} }],
    } as unknown as JSONSchema)).toBeUndefined();
  });

  it("leaves absence alone against a schema-less stream marker", () => {
    // The schema-less handler-input shape (`{ asCell: ["stream"] }` with no
    // type and no properties) is not an object schema; `{}` means nothing
    // there.

    expect(normalizeAbsentVerbPayload(undefined, {
      asCell: ["stream"],
    } as JSONSchema)).toBeUndefined();
  });
});

describe("reportVerbInputErrorOrRethrow", () => {
  const sink = () => {
    const printed: string[] = [];
    const exited: number[] = [];
    return {
      printed,
      exited,
      deps: {
        printError: (m: string) => printed.push(`error:${m}`),
        printHint: (m: string) => printed.push(`hint:${m}`),
        exit: ((code: number) => {
          exited.push(code);
          throw new Error("exit-sentinel");
        }) as (code: number) => never,
      },
    };
  };

  it("reports a rejected payload and exits 1", () => {
    const { printed, exited, deps } = sink();

    expect(() =>
      reportVerbInputErrorOrRethrow(
        new VerbInputValidationError(
          "recordMessage",
          "missing required property message",
        ),
        "fid1:piece-123",
        deps,
      )
    ).toThrow("exit-sentinel");

    expect(printed[0]).toMatch(/Invalid input for "recordMessage"/);
    expect(printed[1]).toMatch(/piece verbs/);
    expect(printed[1]).toMatch(/fid1:piece-123/);
    expect(exited).toEqual([1]);
  });

  it("names the piece as <piece> when the config carries none", () => {
    const { printed, deps } = sink();

    expect(() =>
      reportVerbInputErrorOrRethrow(
        new VerbInputValidationError("recordMessage", "bad"),
        undefined,
        deps,
      )
    ).toThrow("exit-sentinel");

    expect(printed[1]).toMatch(/<piece>/);
  });

  it("re-throws an unrelated failure untouched", () => {
    // Anything that is not an input rejection has to keep traveling: a network
    // failure reported as a payload problem would send an agent to fix a
    // payload that was fine.

    const { printed, exited, deps } = sink();
    const original = new Error("network unreachable");

    expect(() =>
      reportVerbInputErrorOrRethrow(original, "fid1:piece-123", deps)
    )
      .toThrow("network unreachable");

    expect(printed).toEqual([]);
    expect(exited).toEqual([]);
  });
});

describe("the pre-dispatch gate on the forced-stream path", () => {
  // A handler resolved through the forced-stream fallback dispatches on a
  // cast cell whose schema is only { asCell: ["stream"] } — a shape every
  // payload satisfies. The resolution carries the piece's published payload
  // schema as `inputSchema`, and the gate judges against THAT, so a
  // malformed payload is refused before the invocation id is spent instead
  // of dispatching a handling that runs with no event.
  const forcedStreamResolution = (sends: unknown[]) =>
    ({
      callableCell: createMockCell({ $stream: true }, { asCell: ["stream"] }, {
        send: (value, onCommit) => {
          sends.push(value);
          onCommit?.({ status: () => ({ status: "done" }) });
        },
      }),
      callableKind: "handler",
      cellKey: "addNote",
      pieces: { runtime: {} },
      space: "did:key:test-home",
      inputSchema: {
        type: "object",
        properties: { title: { type: "string" } },
        required: ["title"],
      },
    }) as unknown as CallableResolution;

  it("refuses a payload the published schema rejects, before dispatch", async () => {
    const sends: unknown[] = [];
    const resolved = forcedStreamResolution(sends);

    await expect(
      executeResolvedCallable(resolved, { titel: "typo" }),
    ).rejects.toThrow(VerbInputValidationError);
    expect(sends).toEqual([]);
  });

  it("dispatches a payload the published schema accepts", async () => {
    const sends: unknown[] = [];
    const resolved = forcedStreamResolution(sends);

    const executed = await executeResolvedCallable(resolved, {
      title: "Ship it",
    }, { sendEvent: sendThroughStandIn });

    expect(sends).toEqual([{ title: "Ship it" }]);
    expect(executed).toEqual({});
  });
});

describe("runtimeErrorLog", () => {
  it("returns [] for non-object runtimes and runtimes without a log", () => {
    // Pinned directly rather than left to incidental coverage: which execution
    // paths hand this a non-object runtime varies by run and sharding, and the
    // coverage gate has flagged the resulting phantom deltas on unrelated PRs.

    expect(runtimeErrorLog(undefined)).toEqual([]);
    expect(runtimeErrorLog("not a runtime")).toEqual([]);
    expect(runtimeErrorLog({})).toEqual([]);
    expect(runtimeErrorLog({ [CF_RUNTIME_ERROR_LOG]: "not an array" }))
      .toEqual([]);
  });

  it("returns the recorded log when present", () => {
    const records = [{ message: "boom" }];
    expect(runtimeErrorLog({ [CF_RUNTIME_ERROR_LOG]: records }))
      .toEqual(records);
  });
});

describe("schemaIsObjectShaped", () => {
  // Pinned directly: the gate's caller pre-filters non-object roots, so the
  // defensive boolean-target guard is unreachable through it, and the
  // combinator boundary this function encodes (allOf conjunctions count,
  // disjunctions never) deserves its own record.

  it("rejects boolean schemas and accepts object shapes", () => {
    expect(schemaIsObjectShaped(true, true)).toBe(false);
    expect(schemaIsObjectShaped(false, false)).toBe(false);
    expect(schemaIsObjectShaped({ type: "object" }, {})).toBe(true);
    expect(schemaIsObjectShaped({ properties: { a: {} } }, {})).toBe(true);
  });

  it("counts allOf conjunctions with an object branch, never disjunctions", () => {
    expect(schemaIsObjectShaped(
      { allOf: [{ type: "string" }, { type: "object" }] },
      {},
    )).toBe(true);
    expect(schemaIsObjectShaped(
      { anyOf: [{ type: "object" }] },
      {},
    )).toBe(false);
    expect(schemaIsObjectShaped(
      { oneOf: [{ type: "object" }] },
      {},
    )).toBe(false);
  });
});

describe("renderPieceCallOutcome", () => {
  const observerRecorder = () => {
    const finishes: (string | undefined)[] = [];
    return {
      observer: {
        finish: (end?: "settled" | "failed" | "detached") => {
          finishes.push(end);
        },
      },
      finishes,
    };
  };
  const sinkRecorder = () => {
    const rendered: string[] = [];
    const hinted: string[] = [];
    const errored: string[] = [];
    return {
      deps: {
        render: (t: string) => rendered.push(t),
        hint: (t: string) => hinted.push(t),
        printError: (t: string) => errored.push(t),
      },
      rendered,
      hinted,
      errored,
    };
  };
  const base = { parsed: { usedJsonInput: false }, resolved: {} };

  it("help output returns before the observer finishes", () => {
    const { observer, finishes } = observerRecorder();
    const { deps, rendered } = sinkRecorder();
    renderPieceCallOutcome(
      observer,
      { ...base, helpText: "usage" } as ExecutedPieceCallable,
      "addTopic",
      "fid1:piece",
      deps,
    );
    assertEquals(rendered, ["usage"]);
    assertEquals(finishes.length, 0);
  });

  it("tool output finishes the span and hints the result ref", () => {
    const { observer, finishes } = observerRecorder();
    const { deps, rendered, hinted } = sinkRecorder();
    renderPieceCallOutcome(
      observer,
      {
        ...base,
        outputText: "{}",
        resultRef: { id: "of:x", space: "did:key:s", scope: "space" },
      } as ExecutedPieceCallable,
      "tool",
      "fid1:piece",
      deps,
    );
    assertEquals(finishes, [undefined]);
    assertEquals(rendered, ["{}"]);
    assertEquals(hinted.length, 1);
    assertStringIncludes(hinted[0], "of:x");
    // The address argument the next command takes, not the three-part prose
    // that named the same cell in a spelling nothing parses. The token stays
    // bare because the readback runs under the same configured space as the
    // call; `cf exec`, whose space comes from the mount instead, prints the
    // space-carrying canonical form for the same cell.
    assertStringIncludes(hinted[0], "cf cell get --cell of:x");
    expect(hinted[0]).not.toContain("(space did:key:s");
  });

  it("spells a non-space-scoped tool result cell with its scope", () => {
    const { observer } = observerRecorder();
    const { deps, hinted } = sinkRecorder();
    renderPieceCallOutcome(
      observer,
      {
        ...base,
        outputText: "{}",
        resultRef: { id: "of:x", space: "did:key:s", scope: "user" },
      } as ExecutedPieceCallable,
      "tool",
      "fid1:piece",
      deps,
    );
    // Reopening a user-scoped cell without its scope resolves the
    // space-scoped instance, which is a different cell — so the suffix rides
    // the address rather than sitting in a parenthetical the way the prose
    // form's did.
    assertStringIncludes(hinted[0], "cf cell get --cell of:x@user");
  });

  it("handler invocations render the Invocation JSON with next steps", () => {
    const { observer, finishes } = observerRecorder();
    const { deps, rendered, hinted } = sinkRecorder();
    renderPieceCallOutcome(
      observer,
      {
        ...base,
        invocation: { id: "inv-1", status: "settled" },
      } as unknown as ExecutedPieceCallable,
      "addTopic",
      "fid1:piece",
      deps,
    );
    assertEquals(finishes, [undefined]);
    assertEquals(JSON.parse(rendered[0]).invocation, "inv-1");
    assertStringIncludes(hinted[0], "NEXT STEPS");
  });

  it("names the session as well as the id in the detached next step", () => {
    const { observer } = observerRecorder();
    const { deps, hinted } = sinkRecorder();
    renderPieceCallOutcome(
      observer,
      {
        ...base,
        invocation: {
          id: "inv-1",
          status: "committed",
          receipt: "/of:receipt-1",
        },
      } as unknown as ExecutedPieceCallable,
      "addTopic",
      "fid1:piece",
      deps,
      { detached: true, invocation: { id: "inv-1", session: "ses-7" } },
    );
    // The replay is a command the caller runs against the outcome it chose
    // not to wait for, and an id reaches that outcome only within the
    // session it was chosen in — so the hint has to carry both. The session
    // travels in the environment because it is what makes that outcome's
    // address unguessable, and an argument is readable in a process listing.
    assertStringIncludes(
      hinted[0],
      "CF_INVOCATION_SESSION=ses-7 cf piece call",
    );
    assertStringIncludes(hinted[0], "--invocation inv-1");
    // And it says what the replay costs: the receipt witnesses the commit,
    // not the execution, so the body runs a second time.
    assertStringIncludes(hinted[0], "RUNS AGAIN");
  });

  it("offers no replay in the detached step that published no address", () => {
    // No receipt means receipts are not being written, and that is exactly
    // when a same-pair call does NOT deduplicate: it executes and commits
    // again ("allows redelivered events to commit twice while receipts are
    // disabled", packages/runner/test/scheduler-event-receipts.test.ts).
    // Offering the replay here would be offering a duplicate.
    const { observer } = observerRecorder();
    const { deps, hinted } = sinkRecorder();
    renderPieceCallOutcome(
      observer,
      {
        ...base,
        invocation: { id: "inv-1", status: "committed" },
      } as unknown as ExecutedPieceCallable,
      "addTopic",
      "fid1:piece",
      deps,
      { detached: true, invocation: { id: "inv-1", session: "ses-7" } },
    );
    expect(hinted[0]).not.toContain("CF_INVOCATION_SESSION");
    assertStringIncludes(hinted[0], "executes and commits AGAIN");
    // And no dangling alternative: there is nothing for an "Or" to be or to.
    expect(hinted[0]).not.toContain("Or replay");
    assertStringIncludes(hinted[0], "cf cell get --cell fid1:piece");
  });

  it("leads the detached next steps with the address it published", () => {
    const { observer } = observerRecorder();
    const { deps, hinted } = sinkRecorder();
    renderPieceCallOutcome(
      observer,
      {
        ...base,
        invocation: {
          id: "inv-1",
          status: "committed",
          receipt: "/of:receipt-1",
        },
      } as unknown as ExecutedPieceCallable,
      "addTopic",
      "fid1:piece",
      deps,
      { detached: true, invocation: { id: "inv-1", session: "ses-7" } },
    );
    // Collecting the outcome is a read of the address this call published,
    // and it comes first because it does not run the verb again. The replay
    // stays on offer below it, for a caller that lost the address.
    assertStringIncludes(hinted[0], "cf cell get --cell /of:receipt-1");
    assertStringIncludes(
      hinted[0],
      "CF_INVOCATION_SESSION=ses-7 cf piece call",
    );
    expect(hinted[0].indexOf("cf cell get --cell /of:receipt-1"))
      .toBeLessThan(hinted[0].indexOf("CF_INVOCATION_SESSION"));
  });

  it("writes a non-space receipt scope into the collect address", () => {
    // The scope is part of the address: reopening a session-scoped cell
    // without it resolves the space-scoped instance — a different cell — so
    // the reference string the envelope published carries its `@scope`, and
    // the hint hands that string on whole. The bare form stays bare for space
    // scope, which it already means.
    const { observer } = observerRecorder();
    const { deps, hinted } = sinkRecorder();
    renderPieceCallOutcome(
      observer,
      {
        ...base,
        invocation: {
          id: "inv-1",
          status: "committed",
          receipt: "/of:receipt-1@session",
        },
      } as unknown as ExecutedPieceCallable,
      "addTopic",
      "fid1:piece",
      deps,
      { detached: true, invocation: { id: "inv-1", session: "ses-7" } },
    );
    assertStringIncludes(
      hinted[0],
      "cf cell get --cell /of:receipt-1@session",
    );
  });

  it("confirmations route to stderr under JSON input, stdout otherwise", () => {
    const jsonCase = observerRecorder();
    const jsonSinks = sinkRecorder();
    renderPieceCallOutcome(
      jsonCase.observer,
      { ...base, parsed: { usedJsonInput: true } } as ExecutedPieceCallable,
      "addTopic",
      "fid1:piece",
      jsonSinks.deps,
    );
    assertEquals(jsonSinks.errored.length, 1);
    assertEquals(jsonSinks.rendered.length, 0);

    const plainCase = observerRecorder();
    const plainSinks = sinkRecorder();
    renderPieceCallOutcome(
      plainCase.observer,
      { ...base } as ExecutedPieceCallable,
      "addTopic",
      "fid1:piece",
      plainSinks.deps,
    );
    assertEquals(plainSinks.errored.length, 0);
    assertStringIncludes(plainSinks.rendered[0], 'Called handler "addTopic"');
  });
});
