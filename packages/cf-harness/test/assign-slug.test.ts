/**
 * The naming tool over a handle the run holds: registry join plus slug
 * assignment, the pre-flight availability rules ported from the days when
 * `run_pattern` carried a `register` option, and the boundary refusals — a
 * token that is not a piece, a position inside one, another space's
 * reference.
 */

import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { stub } from "@std/testing/mock";

import { expect } from "@std/expect";
import { join, toFileUrl } from "@std/path";
import { normalize } from "@std/path/posix";
import { createSession, Identity } from "@commonfabric/identity";
import { table } from "@commonfabric/memory/sqlite/schema";
import type { SqliteDbRef } from "@commonfabric/memory/v2";
import {
  assignSlug,
  resolvePieceAddress,
  resolveSlugTarget,
  setSlugLink,
} from "@commonfabric/piece";
import { PiecesController } from "@commonfabric/piece/ops";
import {
  entityIdFrom,
  getEntityId,
  Runtime,
  slugIdForSpace,
} from "@commonfabric/runner";
import {
  createLLMFriendlyLink,
  parseLLMFriendlyLink,
} from "@commonfabric/runner/shared";
import {
  EmulatedStorageManager,
  newLoopbackServer,
  StorageManager,
} from "@commonfabric/runner/storage/cache.deno";
import { ExecutorHost } from "@commonfabric/runner/executor/host";
import { CfHarnessEngine } from "../src/engine.ts";
import {
  HarnessInteractiveChatService,
  type HarnessInteractivePromptLoopFactory,
} from "../src/interactive-chat-service.ts";
import { openSqliteHarnessChatSessionStore } from "../src/sqlite-session-store.ts";
import { resolveHandleToken } from "../src/handle-table.ts";
import type { ReadPieceSourceToolSuccessOutput } from "../src/tools/piece-source.ts";
import {
  type AssignSlugToolErrorOutput,
  type AssignSlugToolSuccessOutput,
  namedPieceUrl,
} from "../src/tools/assign-slug.ts";
import type { RunPatternToolSuccessOutput } from "../src/tools/run-pattern.ts";
import type {
  SandboxCommandRequest,
  SandboxCommandResult,
  SandboxRuntime,
  SandboxRuntimeDescription,
  SandboxShellRequest,
} from "../src/sandbox/types.ts";

const signer = await Identity.fromPassphrase("cf-harness assign-slug tool");

const DOUBLING_PATTERN_SOURCE = [
  "import { computed, pattern, UI } from 'commonfabric';",
  "interface Input { n: number; }",
  "interface Output { doubled: number; }",
  "export default pattern<Input, Output>(({ n }) => ({",
  "  doubled: computed(() => n * 2),",
  "  [UI]: <div>{n}</div>,",
  "}));",
  "",
].join("\n");

const DEFAULT_PATTERN_SOURCE = [
  "import { handler, pattern, type Cell, type Stream } from 'commonfabric';",
  "const addPiece = handler<{ piece: unknown }, { pieceRegistry: Cell<unknown[]> }>(",
  "  true,",
  "  { type: 'object', properties: { pieceRegistry: { type: 'array', asCell: ['cell'] } } },",
  "  ({ piece }, { pieceRegistry }) => {",
  "    pieceRegistry.push(piece);",
  "  },",
  ");",
  "export default pattern<",
  "  { pieceRegistry: unknown[] },",
  "  { pieceRegistry: unknown[]; addPiece: Stream<{ piece: unknown }> }",
  ">(({ pieceRegistry }) => ({",
  "  pieceRegistry,",
  "  addPiece: addPiece({ pieceRegistry }),",
  "}));",
].join("\n");

class FakeSandboxRuntime implements SandboxRuntime {
  describe(): SandboxRuntimeDescription {
    return {
      kind: "docker-runsc-cfc",
      defaultWorkingDirectory: this.defaultWorkingDirectory(),
      cfc: { runtimeRequested: true, workspaceMountPath: "/workspace" },
    };
  }
  resolvePath(path: string, cwd = this.defaultWorkingDirectory()): string {
    return normalize(path.startsWith("/") ? path : `${cwd}/${path}`);
  }
  isPathWithinWorkspace(path: string): boolean {
    return path === "/workspace" || path.startsWith("/workspace/");
  }
  isPathWithinAllowedRoots(path: string): boolean {
    return this.isPathWithinWorkspace(path);
  }
  defaultWorkingDirectory(): string {
    return "/workspace";
  }
  run(_request: SandboxCommandRequest): Promise<SandboxCommandResult> {
    return Promise.resolve({ stdout: "", stderr: "", exitCode: 0 });
  }
  runShell(_request: SandboxShellRequest): Promise<SandboxCommandResult> {
    return Promise.resolve({ stdout: "", stderr: "", exitCode: 0 });
  }
}

describe("assign-slug", () => {
  let storageManager: ReturnType<typeof StorageManager.emulate>;
  let runtime: Runtime;
  let pieces: PiecesController;
  let originalFetch: typeof globalThis.fetch;

  beforeEach(async () => {
    originalFetch = globalThis.fetch;
    const patternFetch: typeof globalThis.fetch = () =>
      Promise.resolve(
        new Response(DEFAULT_PATTERN_SOURCE, {
          headers: { "content-type": "text/typescript-jsx" },
        }),
      );
    globalThis.fetch = patternFetch;
    storageManager = StorageManager.emulate({ as: signer });
    runtime = new Runtime({
      apiUrl: new URL("http://toolshed.test"),
      storageManager,
      fetch: patternFetch,
    });
    pieces = new PiecesController(
      await createSession({
        identity: signer,
        spaceName: `assign-slug-${crypto.randomUUID()}`,
      }),
      runtime,
    );
    await pieces.synced();
  });

  afterEach(async () => {
    await runtime?.dispose();
    await storageManager?.close();
    globalThis.fetch = originalFetch;
  });

  function createEngine() {
    return new CfHarnessEngine({
      sandboxRuntime: new FakeSandboxRuntime(),
      runId: `assign-slug-test-${crypto.randomUUID()}`,
      fabricSessionFactory: () => Promise.resolve({ pieces }),
    });
  }

  it("marks a pending served read as not-yet-data and names the same page after its reply arrives", async () => {
    await runtime.dispose();
    await storageManager.close();
    const server = newLoopbackServer({ subscriptionRefreshDelayMs: 0 });
    const reply = Promise.withResolvers<{ rows: { n: number }[] }>();
    const requested = Promise.withResolvers<void>();
    let queries = 0;
    const service = await Identity.fromPassphrase("pending-page-service");
    const host = new ExecutorHost({
      server,
      serviceIdentity: service.did(),
      ensureSpaceRoots: false,
      createRuntime: (space) => {
        const manager = EmulatedStorageManager.connectTo(server, {
          as: service,
        });
        const rpc = stub(manager.open(space), "sqliteQuery", () => {
          queries++;
          requested.resolve();
          return reply.promise;
        });
        const serving = new Runtime({
          apiUrl: new URL("http://toolshed.test"),
          storageManager: manager,
          servingPosture: true,
          experimental: { serverExecution: true },
        });
        return Promise.resolve({
          runtime: serving,
          dispose: async () => {
            await serving.dispose();
            rpc.restore();
            await manager.close();
          },
        });
      },
    });
    storageManager = EmulatedStorageManager.connectTo(server, { as: signer });
    runtime = new Runtime({
      apiUrl: new URL("http://toolshed.test"),
      storageManager,
    });
    pieces = new PiecesController(
      await createSession({
        identity: signer,
        spaceName: "pending-served-page",
      }),
      runtime,
    );
    try {
      const space = pieces.getSpace();
      const tx = runtime.edit();
      const mail = runtime.getCell<SqliteDbRef>(
        space,
        "pending-mail",
        undefined,
        tx,
      );
      mail.set({
        id: "pending-mailbox",
        tables: { messages: table({ id: "integer primary key" }) },
      });
      expect((await tx.commit()).error).toBeUndefined();

      const resultSchema = {
        type: "object",
        properties: { n: { type: "number" }, pending: { type: "boolean" } },
        required: ["n", "pending"],
      } as const;
      const runPersistent = pieces.runPersistent.bind(pieces);
      const creation = stub(pieces, "runPersistent", async (...args) => {
        const cell = await runPersistent(...args);
        const pending = Promise.withResolvers<void>();
        const cancel = pieces.getResult(cell).asSchema(resultSchema).sink(
          (value) => {
            if (value?.pending === true) pending.resolve();
          },
        );
        try {
          await pending.promise;
        } finally {
          cancel();
        }
        return cell;
      });
      const engine = createEngine();
      const result = await engine.invokeBuiltinTool("run_pattern", {
        sourceText: `
        import { computed, pattern, UI, type SqliteDb } from "commonfabric";
        export default pattern<{ mail: SqliteDb }, { n: number; pending: boolean }>(({ mail }) => {
          const read = mail.query<{ n: number }>("SELECT count(*) AS n FROM messages", { scope: "session" });
          const n = computed(() => read.result?.[0]?.n ?? 0);
          const pending = computed(() => read.pending === true);
          return { n, pending, [UI]: <div>{pending ? "Loading" : n}</div> };
        });
      `,
        inputs: {
          mail: createLLMFriendlyLink(mail.getAsNormalizedFullLink(), space),
        },
        resultSchema,
      });
      creation.restore();
      const output = result.output as RunPatternToolSuccessOutput;
      expect(output.status).toBe("ok");
      expect(output.value).toMatchObject({ n: 0, pending: true });
      expect(output.outputConcerns).toContainEqual(
        expect.objectContaining({ concern: "pending" }),
      );
      await requested.promise;
      expect(queries).toBe(1);
      const naming = { token: output.resultRef, slug: "mailbox-size" };
      const refused = await engine.invokeBuiltinTool("assign_slug", naming);
      expect(refused.output).toMatchObject({
        status: "error",
        message: expect.stringContaining("pending"),
      });
      expect(engine.getRunState().assignedPieces).toBeUndefined();

      const resultCell = runtime.getCellFromLink(
        parseLLMFriendlyLink(output.resultRef, space),
      )
        .asSchema(resultSchema);
      const settled = Promise.withResolvers<unknown>();
      const cancel = resultCell.sink((value) => {
        if (value?.pending === false) settled.resolve(value);
      });
      try {
        reply.resolve({ rows: [{ n: 1739 }] });
        expect(await settled.promise).toEqual({ n: 1739, pending: false });
        const accepted = await engine.invokeBuiltinTool("assign_slug", naming);
        expect(accepted.output).toMatchObject({
          status: "ok",
          slug: "mailbox-size",
        });
        expect(await resolvePieceAddress(pieces, "mailbox-size")).toBe(
          output.pieceId,
        );
        expect(engine.getRunState().assignedPieces).toEqual([{
          slug: "mailbox-size",
          ref: createLLMFriendlyLink(resultCell.getAsNormalizedFullLink()),
        }]);
      } finally {
        cancel();
        reply.resolve({ rows: [] });
      }
    } finally {
      reply.resolve({ rows: [] });
      await host.close();
      await runtime.dispose();
      await storageManager.close();
      await server.close();
    }
  });

  async function linkDefaultPattern() {
    const defaultRoot = await pieces.create(DEFAULT_PATTERN_SOURCE, {
      input: { pieceRegistry: [] },
    });
    await pieces.linkDefaultPattern(defaultRoot.getCell());
    await runtime.idle();
    await pieces.synced();
  }

  async function createPiece(
    engine: CfHarnessEngine,
    n = 21,
  ): Promise<RunPatternToolSuccessOutput> {
    const result = await engine.invokeBuiltinTool("run_pattern", {
      sourceText: DOUBLING_PATTERN_SOURCE,
      inputs: { n },
    });
    const output = result.output as RunPatternToolSuccessOutput;
    expect(output.status).toBe("ok");
    return output;
  }

  it("remints the last named piece after session restart and lets a bare follow-up revise it", async () => {
    const root = await Deno.makeTempDir();
    const url = toFileUrl(join(root, "sessions.sqlite"));
    let store = await openSqliteHarnessChatSessionStore({ url });
    let created: RunPatternToolSuccessOutput;
    const inputs: { name: string; token: string; ref: string }[][] = [];
    const createPromptLoop: HarnessInteractivePromptLoopFactory = (
      options,
    ) => ({
      runTranscript: async (request) => {
        const engine = options.engine ?? new CfHarnessEngine(options);
        inputs.push(engine.getRunState().inputCells ?? []);
        if (options.taskText === "Make a counter") {
          created = await createPiece(engine);
          const named = await engine.invokeBuiltinTool("assign_slug", {
            token: created.resultRef,
            slug: "my-counter",
          });
          expect(named.output.status).toBe("ok");
          // Unnamed intermediate results do not become next-turn targets.
          await createPiece(engine, 99);
        } else if (options.taskText === "Triple it") {
          const state = engine.getRunState();
          const input = state.inputCells![0];
          const entry = resolveHandleToken(state.handleTable!, input.token);
          expect(entry?.ref).toBe(input.ref);
          const read = await engine.invokeBuiltinTool("read_piece_source", {
            token: entry!.ref,
          });
          const source = read.output as ReadPieceSourceToolSuccessOutput;
          expect(source.status).toBe("ok");
          expect(source.files[0].contents).toBe(DOUBLING_PATTERN_SOURCE);
          const revised = await engine.invokeBuiltinTool("revise_piece", {
            token: entry!.ref,
            sourceText: DOUBLING_PATTERN_SOURCE.replace("n * 2", "n * 3"),
            expectedRevisionId: source.sourceRevisionId,
          });
          expect(revised.output.status).toBe("ok");
        } else if (options.taskText === "Fail after naming") {
          const other = await createPiece(engine, 3);
          await engine.invokeBuiltinTool("assign_slug", {
            token: other.resultRef,
            slug: "unfinished-counter",
          });
          throw new Error("fixture interrupted before session commit");
        }
        return {
          model: "gpt-test",
          modelTurns: 1,
          finalAssistantText: "Done",
          transcript: [...request.transcript, {
            role: "assistant",
            content: "Done",
          }],
          runState: engine.getRunState(),
        };
      },
    });
    const serviceOptions = () => ({
      sessionStore: store,
      createPromptLoop,
      basePromptLoopOptions: {
        sandboxRuntime: new FakeSandboxRuntime(),
        cfcEnforcementMode: "disabled" as const,
        fabricSessionFactory: () => Promise.resolve({ pieces }),
      },
    });
    try {
      let service = new HarnessInteractiveChatService(serviceOptions());
      await service.startSession("start", {
        sessionId: "follow-up",
        model: "gpt-test",
        workspace: { hostPath: "/workspace" },
      });
      await service.startTurn("first", {
        sessionId: "follow-up",
        turnId: "first",
        input: { text: "Make a counter" },
      });
      await service.waitForTurn("follow-up", "first");
      expect(store.getTurn("follow-up", "first")?.turn.status).toBe(
        "completed",
      );
      const checkpoint = store.getSession("follow-up")!.assignedPieces!;
      expect(checkpoint).toEqual([{
        slug: "my-counter",
        ref: createLLMFriendlyLink(
          parseLLMFriendlyLink(created!.resultRef, pieces.getSpace()),
        ),
      }]);
      expect(inputs[0]).toEqual([]);
      store.close();
      store = await openSqliteHarnessChatSessionStore({ url });
      service = new HarnessInteractiveChatService(serviceOptions());
      await service.initializeFromStore();
      await service.startTurn("second", {
        sessionId: "follow-up",
        turnId: "second",
        input: { text: "Triple it" },
      });
      await service.waitForTurn("follow-up", "second");
      expect(store.getTurn("follow-up", "second")?.turn.status).toBe(
        "completed",
      );
      expect(inputs[1]).toEqual([
        expect.objectContaining({ name: "my-counter", ref: checkpoint[0].ref }),
      ]);
      expect(await (await pieces.get(created!.pieceId)).result.get())
        .toMatchObject({ doubled: 63 });
      expect(await resolvePieceAddress(pieces, "my-counter")).toBe(
        created!.pieceId,
      );

      await service.startTurn("failed", {
        sessionId: "follow-up",
        turnId: "failed",
        input: { text: "Fail after naming" },
      });
      await service.waitForTurn("follow-up", "failed");
      expect(store.getTurn("follow-up", "failed")?.turn.status).toBe("failed");
      expect(store.getSession("follow-up")?.assignedPieces).toEqual(checkpoint);

      const attached = await createPiece(createEngine(), 5);
      await service.startTurn("attached", {
        sessionId: "follow-up",
        turnId: "attached",
        input: { text: "Use this counter" },
        inputCells: [{ name: "attached", ref: attached.resultRef }],
      });
      await service.waitForTurn("follow-up", "attached");
      expect(inputs[3]).toEqual([
        expect.objectContaining({ name: "attached", ref: attached.resultRef }),
      ]);

      expect(store.getSession("follow-up")?.assignedPieces).toEqual([]);
    } finally {
      store.close();
      await Deno.remove(root, { recursive: true });
    }
  });

  describe("assignSlugTool", () => {
    it("refuses naming when the piece's read state cannot be established", async () => {
      await linkDefaultPattern();
      const engine = createEngine();
      const created = await createPiece(engine);
      const unreadable = stub(pieces, "getResult", () => {
        throw new Error("private result-read diagnostic");
      });
      try {
        const result = await engine.invokeBuiltinTool("assign_slug", {
          token: created.resultRef,
          slug: "unverified-report",
        });
        expect(result.output).toMatchObject({
          status: "error",
          message:
            "assign_slug could not verify the piece's read state and UI; no name was assigned.",
        });
        expect(engine.getRunState().assignedPieces).toBeUndefined();
      } finally {
        unreadable.restore();
      }
      expect(await pieces.getRegisteredPieces()).toEqual([]);
      await expect(resolvePieceAddress(pieces, "unverified-report"))
        .rejects.toMatchObject({ code: "missing" });
    });

    it("refuses a data-only result before registering or naming it", async () => {
      await linkDefaultPattern();
      const engine = createEngine();
      const created = await engine.invokeBuiltinTool("run_pattern", {
        sourceText: DOUBLING_PATTERN_SOURCE.replace(
          "  [UI]: <div>{n}</div>,\n",
          "",
        ),
        inputs: { n: 21 },
      });
      const result = await engine.invokeBuiltinTool("assign_slug", {
        token: (created.output as RunPatternToolSuccessOutput).resultRef,
        slug: "data-only-probe",
      });
      expect(result.output).toMatchObject({ status: "error" });
      expect((result.output as AssignSlugToolErrorOutput).message).toContain(
        "confirm a UI",
      );
      expect(await pieces.getRegisteredPieces()).toEqual([]);
    });

    it("refuses a pending result and names the same piece after its read settles", async () => {
      await linkDefaultPattern();
      const engine = createEngine();
      const created = await engine.invokeBuiltinTool("run_pattern", {
        sourceText: [
          'import { pattern, UI } from "commonfabric";',
          "export default pattern<{ pending: boolean }>(({ pending }) => ({",
          "  pending, [UI]: <div>Report</div>,",
          "}));",
        ].join("\n"),
        inputs: { pending: true },
      });
      const output = created.output as RunPatternToolSuccessOutput;
      const assign = () =>
        engine.invokeBuiltinTool("assign_slug", {
          token: output.resultRef,
          slug: "settled-report",
        });
      const refused = await assign();
      expect(refused.output).toMatchObject({ status: "error" });
      expect((refused.output as AssignSlugToolErrorOutput).message).toContain(
        "pending",
      );
      expect(await pieces.getRegisteredPieces()).toEqual([]);
      const piece = await pieces.get(output.pieceId);
      await piece.input.set(false, ["pending"]);
      await runtime.idle();
      expect((await assign()).output).toMatchObject({
        status: "ok",
        slug: "settled-report",
      });
      expect((await pieces.getRegisteredPieces()).map((piece) => piece.id))
        .toEqual([output.pieceId]);
    });

    it("registers the referenced piece and points the slug at it", async () => {
      await linkDefaultPattern();
      const engine = createEngine();
      const created = await createPiece(engine);

      const result = await engine.invokeBuiltinTool("assign_slug", {
        token: created.resultRef,
        slug: "doubling-report",
      });
      const output = result.output as AssignSlugToolSuccessOutput;
      expect(output.status).toBe("ok");
      expect(output.slug).toBe("doubling-report");
      // The URL is the session's API URL, the space name, and the slug.
      expect(output.url).toContain("http://toolshed.test/");
      expect(output.url).toContain("/doubling-report");
      const registered = await pieces.getRegisteredPieces();
      expect(registered.map((piece) => piece.id)).toEqual([created.pieceId]);
      // The slug resolves to the same piece, so the address a person opens
      // names the piece the handle named rather than merely existing.
      expect(await resolvePieceAddress(pieces, "doubling-report")).toBe(
        created.pieceId,
      );
    });

    it("refuses a slug that already names another piece, leaving the address where it pointed", async () => {
      // A second call naming the same slug would repoint an address a person
      // already opens. The refusal is a pre-flight one, so the attempt costs
      // a message and nothing else — and it is the one that names which kind
      // of address is in the way, where the assignment's own refusal
      // underneath would only say the name is taken.
      await linkDefaultPattern();
      const engine = createEngine();
      const first = await createPiece(engine, 21);
      const second = await createPiece(engine, 22);
      const held = await engine.invokeBuiltinTool("assign_slug", {
        token: first.resultRef,
        slug: "doubling-report",
      });
      expect((held.output as AssignSlugToolSuccessOutput).status).toBe("ok");

      const result = await engine.invokeBuiltinTool("assign_slug", {
        token: second.resultRef,
        slug: "doubling-report",
      });
      const output = result.output as AssignSlugToolErrorOutput;
      expect(output.status).toBe("error");
      expect(output.message).toContain("doubling-report");
      // The address still names the piece it named before, so the refusal
      // protected the name rather than merely reporting on it.
      expect(await resolvePieceAddress(pieces, "doubling-report")).toBe(
        first.pieceId,
      );
    });

    it("refuses a slug that names a collection, leaving the address where it pointed", async () => {
      // A slug pointing at a cell inside a piece names a collection, which is
      // an address a person opens as much as a piece is. Reading that as an
      // operational failure would report a positive statement about what the
      // space holds as a "try again", and reading it as vacancy would repoint
      // the name.
      await linkDefaultPattern();
      const engine = createEngine();
      const held = await createPiece(engine, 21);
      const taking = await createPiece(engine, 22);
      const cell = pieces.runtime.getCellFromLink(
        parseLLMFriendlyLink(held.resultRef, pieces.getSpace()),
      );
      await cell.sync();
      await setSlugLink(pieces, "doubling-report", cell.key("doubled"));

      const result = await engine.invokeBuiltinTool("assign_slug", {
        token: taking.resultRef,
        slug: "doubling-report",
      });
      const output = result.output as AssignSlugToolErrorOutput;
      expect(output.status).toBe("error");
      expect(output.message).toContain("already names a collection");
      expect(output.message).not.toContain("could not establish");
      // The refusal names the caller's own slug and nothing behind it, the
      // way the refusal for a name already taken by a piece does: the address
      // the name resolves to stays trusted-side.
      expect(output.message).not.toContain(held.pieceId);
      // The name still points into the piece it pointed into, so the refusal
      // protected the address rather than merely reporting on it.
      expect(await resolveSlugTarget(pieces, "doubling-report")).toEqual({
        piece: held.pieceId,
        pathInside: ["doubled"],
      });
    });

    it("takes a name whose document points at no piece, which this tool calls free", async () => {
      // The tool's availability rule competes only with pieces and
      // collections, so a name redirecting to a plain document is free here
      // even though the assignment underneath refuses a bound name by
      // default. Carrying the binding this rule was judged against into the
      // write is what lets the wider rule stand without spending the claim.
      await linkDefaultPattern();
      const engine = createEngine();
      const created = await createPiece(engine);
      const plain = pieces.runtime.getCell(
        pieces.getSpace(),
        { space: pieces.getSpace(), random: "plain" },
      );
      await pieces.runtime.editWithRetry((tx) => {
        plain.withTx(tx).set({ value: 1 });
      });
      await setSlugLink(pieces, "doubling-report", plain);

      const result = await engine.invokeBuiltinTool("assign_slug", {
        token: created.resultRef,
        slug: "doubling-report",
      });

      const output = result.output as AssignSlugToolSuccessOutput;
      expect(output.status).toBe("ok");
      expect(await resolvePieceAddress(pieces, "doubling-report")).toBe(
        created.pieceId,
      );
    });

    it("gives a free name to the first of two calls and refuses the second", async () => {
      // Two calls for one free name, started together and settling one after
      // the other. What this asserts is the outcome — exactly one takes the
      // name — and nothing about the interleaving: the assertions hold
      // whether the two overlapped or ran in sequence. Forcing over the read
      // instead of carrying it into the write would let the loser overwrite
      // the winner and report success, which is what the assertions catch.
      //
      // The racing path is the library's, pinned over two sessions where the
      // losing replica is provably behind: `packages/piece/test/slug.test.ts`,
      // under "the read a refusal claims on".
      //
      // The two tokens name different pieces, so the address the name ends
      // up holding says which call won rather than being true either way.
      await linkDefaultPattern();
      const engine = createEngine();
      const first = await createPiece(engine, 21);
      const second = await createPiece(engine, 22);
      expect(first.pieceId).not.toBe(second.pieceId);

      const results = await Promise.all([
        engine.invokeBuiltinTool("assign_slug", {
          token: first.resultRef,
          slug: "doubling-report",
        }),
        engine.invokeBuiltinTool("assign_slug", {
          token: second.resultRef,
          slug: "doubling-report",
        }),
      ]);
      const outputs = results.map((result) =>
        result.output as AssignSlugToolSuccessOutput | AssignSlugToolErrorOutput
      );

      expect(outputs.filter((output) => output.status === "ok")).toHaveLength(
        1,
      );
      const loser = outputs.find((output) => output.status === "error") as
        | AssignSlugToolErrorOutput
        | undefined;
      expect(loser?.message).toContain("doubling-report");
      expect(loser?.message).toContain("Choose another slug");
      const winner = outputs[0].status === "ok" ? first : second;
      expect(await resolvePieceAddress(pieces, "doubling-report")).toBe(
        winner.pieceId,
      );
    });

    it("answers ok for a slug already pointing at the very piece the token names", async () => {
      // The request is already true, so saying so beats refusing it — a
      // retried call settles on the outcome instead of failing.
      await linkDefaultPattern();
      const engine = createEngine();
      const created = await createPiece(engine);
      const first = await engine.invokeBuiltinTool("assign_slug", {
        token: created.resultRef,
        slug: "doubling-report",
      });
      expect((first.output as AssignSlugToolSuccessOutput).status).toBe("ok");

      const again = await engine.invokeBuiltinTool("assign_slug", {
        token: created.resultRef,
        slug: "doubling-report",
      });
      const output = again.output as AssignSlugToolSuccessOutput;
      expect(output.status).toBe("ok");
      expect(output.slug).toBe("doubling-report");
    });

    it("registers an unlisted piece whose slug already points at it", async () => {
      // A slug can point at a piece the registry does not list — a
      // pre-existing name, or a naming interrupted between its two steps.
      // The idempotent answer still delivers the contract's other half.
      await linkDefaultPattern();
      const engine = createEngine();
      const created = await createPiece(engine);
      const cell = pieces.runtime.getCellFromLink(
        // The resultRef names the piece cell itself.
        parseLLMFriendlyLink(created.resultRef, pieces.getSpace()),
      );
      await cell.sync();
      await assignSlug(pieces, cell, "doubling-report");
      expect(await pieces.getRegisteredPieces()).toEqual([]);

      const result = await engine.invokeBuiltinTool("assign_slug", {
        token: created.resultRef,
        slug: "doubling-report",
      });
      const output = result.output as AssignSlugToolSuccessOutput;
      expect(output.status).toBe("ok");
      const registered = await pieces.getRegisteredPieces();
      expect(registered.map((piece) => piece.id)).toEqual([created.pieceId]);
    });

    it("initializes the space when an already-named piece has no registry to join", async () => {
      const engine = createEngine();
      const created = await createPiece(engine);
      const cell = pieces.runtime.getCellFromLink(
        parseLLMFriendlyLink(created.resultRef, pieces.getSpace()),
      );
      await cell.sync();
      await assignSlug(pieces, cell, "doubling-report");

      const result = await engine.invokeBuiltinTool("assign_slug", {
        token: created.resultRef,
        slug: "doubling-report",
      });
      const output = result.output as AssignSlugToolSuccessOutput;
      expect(output.status).toBe("ok");
      expect(await pieces.getDefaultPattern(false)).toBeDefined();
      const registered = await pieces.getRegisteredPieces();
      expect(registered.map((piece) => piece.id)).toEqual([created.pieceId]);
    });

    it("reports an initialization failure while listing an already-named piece", async () => {
      const engine = createEngine();
      const created = await createPiece(engine);
      const cell = pieces.runtime.getCellFromLink(
        parseLLMFriendlyLink(created.resultRef, pieces.getSpace()),
      );
      await cell.sync();
      await assignSlug(pieces, cell, "doubling-report");
      const originalEnsureDefaultPattern = pieces.ensureDefaultPattern;
      pieces.ensureDefaultPattern = () =>
        Promise.reject(new Error("space root unavailable"));

      const result = await engine.invokeBuiltinTool("assign_slug", {
        token: created.resultRef,
        slug: "doubling-report",
      });
      pieces.ensureDefaultPattern = originalEnsureDefaultPattern;

      const output = result.output as AssignSlugToolErrorOutput;
      expect(output.status).toBe("error");
      expect(output.message).toContain("failed while listing");
      expect(output.message).toContain("space root unavailable");
    });

    it("reports a name released between the availability read and the write as one to retry", async () => {
      // The tool judges a name free, and the name comes to point nowhere
      // before the write lands. That is not the same outcome as a name
      // somebody else took: nobody holds it, so the answer is to read it
      // again rather than to choose another name. The registry join sits
      // between the two, which is where the release is staged.
      await linkDefaultPattern();
      const engine = createEngine();
      const created = await createPiece(engine);
      // A name pointing at a plain document: free by this tool's rule, and a
      // binding the claim carries, so the release below is a change to it.
      const plain = pieces.runtime.getCell(
        pieces.getSpace(),
        { space: pieces.getSpace(), random: "released-target" },
      );
      await pieces.runtime.editWithRetry((tx) => {
        plain.withTx(tx).set({ value: 1 });
      });
      await setSlugLink(pieces, "doubling-report", plain);

      const slugCell = pieces.runtime.getCellFromEntityId(
        pieces.getSpace(),
        entityIdFrom(slugIdForSpace(pieces.getSpace(), "doubling-report")),
      );
      const originalAdd = pieces.add.bind(pieces);
      pieces.add = async (cells) => {
        await originalAdd(cells);
        // The join has landed and the availability answer is already read;
        // the name now points at nothing.
        await pieces.runtime.editWithRetry((tx) => {
          slugCell.withTx(tx).setRawUntyped("not a redirect");
        });
      };
      const result = await engine.invokeBuiltinTool("assign_slug", {
        token: created.resultRef,
        slug: "doubling-report",
      });
      pieces.add = originalAdd;

      const output = result.output as AssignSlugToolErrorOutput;
      expect(output.status).toBe("error");
      expect(output.message).toContain("doubling-report");
      expect(output.message).toContain("names nothing");
      expect(output.message).toContain("Try the same call again");
      // The registry join landed before the refusal, so the answer says the
      // piece is listed rather than that nothing happened.
      expect(output.message).toContain("the piece is listed");
      expect(output.message).not.toContain("Nothing was assigned");
      // Told to retry rather than to choose another name, which is the
      // answer a name somebody else holds gets.
      expect(output.message).not.toContain("Choose another slug");
    });

    it("does not list the piece twice when retried after a failed assignment", async () => {
      // A first call can join the registry and then fail at the slug write.
      // The retry must settle the name without appending a second entry.
      await linkDefaultPattern();
      const engine = createEngine();
      const created = await createPiece(engine);

      const originalAdd = pieces.add.bind(pieces);
      const originalGetCell = runtime.getCellFromEntityId.bind(runtime);
      pieces.add = async (cells) => {
        await originalAdd(cells);
        // The join has landed; make the assignment that follows fail once.
        // Through a call only the slug write makes, so the failure is the
        // assignment's rather than the listing's — the tool reports those
        // separately, because only one of them leaves a listed piece.
        runtime.getCellFromEntityId = (() => {
          runtime.getCellFromEntityId = originalGetCell;
          throw new Error("slug assignment refused");
        }) as Runtime["getCellFromEntityId"];
      };
      const first = await engine.invokeBuiltinTool("assign_slug", {
        token: created.resultRef,
        slug: "doubling-report",
      });
      pieces.add = originalAdd;
      runtime.getCellFromEntityId = originalGetCell;
      const failed = first.output as AssignSlugToolErrorOutput;
      expect(failed.status).toBe("error");
      expect(failed.message).toContain("failed while naming");

      const retry = await engine.invokeBuiltinTool("assign_slug", {
        token: created.resultRef,
        slug: "doubling-report",
      });
      expect((retry.output as AssignSlugToolSuccessOutput).status).toBe("ok");
      const registered = await pieces.getRegisteredPieces();
      expect(registered.map((piece) => piece.id)).toEqual([created.pieceId]);
      expect(await resolvePieceAddress(pieces, "doubling-report")).toBe(
        created.pieceId,
      );
    });

    it("reports a structured error when the referenced piece cannot be loaded", async () => {
      // A storage or connection failure while loading the referent is the
      // tool's answer to give, not an exception to escape with.
      await linkDefaultPattern();
      const engine = createEngine();
      const created = await createPiece(engine);
      const originalGetCellFromLink = pieces.runtime.getCellFromLink.bind(
        pieces.runtime,
      );
      pieces.runtime.getCellFromLink = ((
        ...args: Parameters<Runtime["getCellFromLink"]>
      ) => {
        const cell = originalGetCellFromLink(...args);
        (cell as unknown as { sync: () => Promise<unknown> }).sync = () =>
          Promise.reject(new Error("storage unavailable"));
        return cell;
        // deno-lint-ignore no-explicit-any
      }) as any;
      const result = await engine.invokeBuiltinTool("assign_slug", {
        token: created.resultRef,
        slug: "doubling-report",
      });
      pieces.runtime.getCellFromLink = originalGetCellFromLink;
      const output = result.output as AssignSlugToolErrorOutput;
      expect(output.status).toBe("error");
      expect(output.message).toContain("could not load the referenced piece");
      expect(output.message).toContain("storage unavailable");
    });

    it("refuses when the slug's availability could not be established, assigning nothing", async () => {
      // A resolution that fails operationally — storage error, sync that
      // never landed — says nothing about what the slug holds. Reading it as
      // vacancy would send the call on to take a name this side never
      // established was free, which is what the availability check exists to
      // prevent.
      await linkDefaultPattern();
      const engine = createEngine();
      const created = await createPiece(engine);

      // The slug document's own cell, so only its sync fails and every other
      // cell the call reaches behaves normally.
      const slugEntity = JSON.stringify(
        entityIdFrom(slugIdForSpace(pieces.getSpace(), "doubling-report")),
      );
      const originalGetCell = runtime.getCellFromEntityId.bind(runtime);
      let syncFailures = 0;
      runtime.getCellFromEntityId = ((
        ...args: Parameters<Runtime["getCellFromEntityId"]>
      ) => {
        const cell = originalGetCell(...args);
        if (JSON.stringify(args[1]) !== slugEntity) {
          return cell;
        }
        (cell as unknown as { sync: () => Promise<unknown> }).sync = () => {
          syncFailures += 1;
          return Promise.reject(new Error("storage unavailable"));
        };
        return cell;
      }) as Runtime["getCellFromEntityId"];

      const result = await engine.invokeBuiltinTool("assign_slug", {
        token: created.resultRef,
        slug: "doubling-report",
      });
      runtime.getCellFromEntityId = originalGetCell;

      // The injected failure really was the slug resolution's, so the
      // refusal below answers it rather than something else going wrong.
      expect(syncFailures).toBe(1);
      const output = result.output as AssignSlugToolErrorOutput;
      expect(output.status).toBe("error");
      expect(output.message).toContain("could not establish");
      expect(output.message).toContain("doubling-report");
      expect(output.message).not.toContain("already names another piece");
      expect(await pieces.getRegisteredPieces()).toEqual([]);
    });

    it("returns the slug without a URL when the session's space is configured by DID", async () => {
      // A space configured by `did:key` has no name to put in a URL, and the
      // only address available would carry the space DID — a bare fabric
      // identifier that does not cross the model boundary. The slug still
      // reaches the model, because it is the caller's own word.
      const spaceIdentity = await signer.derive(
        `assign-slug-did-${crypto.randomUUID()}`,
      );
      const didPieces = new PiecesController(
        await createSession({
          identity: signer,
          spaceDid: spaceIdentity.did(),
        }),
        runtime,
      );
      await didPieces.synced();
      expect(didPieces.getSpaceName()).toBeUndefined();
      const defaultRoot = await didPieces.create(DEFAULT_PATTERN_SOURCE, {
        input: { pieceRegistry: [] },
      });
      await didPieces.linkDefaultPattern(defaultRoot.getCell());
      await runtime.idle();
      await didPieces.synced();
      const engine = new CfHarnessEngine({
        sandboxRuntime: new FakeSandboxRuntime(),
        runId: `assign-slug-test-${crypto.randomUUID()}`,
        fabricSessionFactory: () => Promise.resolve({ pieces: didPieces }),
      });
      const created = await engine.invokeBuiltinTool("run_pattern", {
        sourceText: DOUBLING_PATTERN_SOURCE,
        inputs: { n: 21 },
      });
      const piece = created.output as RunPatternToolSuccessOutput;
      expect(piece.status).toBe("ok");

      const result = await engine.invokeBuiltinTool("assign_slug", {
        token: piece.resultRef,
        slug: "doubling-report",
      });
      const output = result.output as AssignSlugToolSuccessOutput;
      expect(output.status).toBe("ok");
      expect(output.slug).toBe("doubling-report");
      expect(output.url).toBeUndefined();
      // The naming really happened, so the missing URL is a refusal to
      // compose one rather than an assignment that did not take place.
      expect(await resolvePieceAddress(didPieces, "doubling-report")).toBe(
        piece.pieceId,
      );
    });

    it("returns an error for an unusable slug, assigning nothing", async () => {
      await linkDefaultPattern();
      const engine = createEngine();
      const created = await createPiece(engine);
      const result = await engine.invokeBuiltinTool("assign_slug", {
        token: created.resultRef,
        slug: "Not A Slug!",
      });
      const output = result.output as AssignSlugToolErrorOutput;
      expect(output.status).toBe("error");
      expect(output.message).toContain("slug is invalid");
      expect(await pieces.getRegisteredPieces()).toEqual([]);
    });

    it("returns an error when the slug is not a string", async () => {
      await linkDefaultPattern();
      const engine = createEngine();
      const created = await createPiece(engine);
      const result = await engine.invokeBuiltinTool("assign_slug", {
        token: created.resultRef,
        slug: 7 as unknown as string,
      });
      const output = result.output as AssignSlugToolErrorOutput;
      expect(output.status).toBe("error");
      expect(output.message).toContain("string slug");
    });

    it("refuses a token naming a position inside a piece rather than the piece itself", async () => {
      await linkDefaultPattern();
      const engine = createEngine();
      const created = await createPiece(engine);
      const result = await engine.invokeBuiltinTool("assign_slug", {
        token: `${created.resultRef}/doubled`,
        slug: "doubling-report",
      });
      const output = result.output as AssignSlugToolErrorOutput;
      expect(output.status).toBe("error");
      expect(output.message).toContain("not a position inside one");
      expect(await pieces.getRegisteredPieces()).toEqual([]);
    });

    it("refuses a token whose document is not a piece", async () => {
      await linkDefaultPattern();
      const engine = createEngine();
      // A document that exists but carries no pattern identity: an ordinary
      // data cell is not a piece and naming it would put a dead entry in the
      // piece list.
      const cell = runtime.getCell<Record<string, unknown>>(
        pieces.getSpace(),
        `assign-slug-plain-${crypto.randomUUID()}`,
      );
      const { error } = await runtime.editWithRetry((tx) => {
        cell.withTx(tx).set({ n: 1 });
      });
      expect(error).toBeUndefined();
      const link = cell.getAsNormalizedFullLink();
      const result = await engine.invokeBuiltinTool("assign_slug", {
        token: `/${link.id}`,
        slug: "doubling-report",
      });
      const output = result.output as AssignSlugToolErrorOutput;
      expect(output.status).toBe("error");
      expect(output.message).toContain("does not refer to a piece");
      expect(await pieces.getRegisteredPieces()).toEqual([]);
    });

    it("refuses a token naming a reference in another space", async () => {
      await linkDefaultPattern();
      const engine = createEngine();
      const created = await createPiece(engine);
      const otherSpace =
        "did:key:z6MkhaXgBZDvotDkL5257faiztiGiC2QtKLGpbnnEGta2doK";
      const bare = created.resultRef.replace(/^\//, "");
      const result = await engine.invokeBuiltinTool("assign_slug", {
        token: `/@${otherSpace}/${bare}`,
        slug: "doubling-report",
      });
      const output = result.output as AssignSlugToolErrorOutput;
      expect(output.status).toBe("error");
      expect(output.message).toContain("own space");
    });

    it("returns an error when the run has no fabric session", async () => {
      const engine = new CfHarnessEngine({
        sandboxRuntime: new FakeSandboxRuntime(),
        runId: `assign-slug-test-${crypto.randomUUID()}`,
      });
      const result = await engine.invokeBuiltinTool("assign_slug", {
        token: "/of:fid1:abc",
        slug: "doubling-report",
      });
      const output = result.output as AssignSlugToolErrorOutput;
      expect(output.status).toBe("error");
      expect(output.message).toContain("requires a fabric session");
    });

    it("returns an error for a missing token", async () => {
      await linkDefaultPattern();
      const engine = createEngine();
      const result = await engine.invokeBuiltinTool("assign_slug", {
        slug: "doubling-report",
      });
      const output = result.output as AssignSlugToolErrorOutput;
      expect(output.status).toBe("error");
      expect(output.message).toContain("requires a token");
    });

    it("initializes a fresh space before registering and naming the piece", async () => {
      const engine = createEngine();
      const created = await createPiece(engine);
      expect(await pieces.getDefaultPattern(false)).toBeUndefined();

      const result = await engine.invokeBuiltinTool("assign_slug", {
        token: created.resultRef,
        slug: "doubling-report",
      });
      const output = result.output as AssignSlugToolSuccessOutput;
      expect(output.status).toBe("ok");
      expect(await pieces.getDefaultPattern(false)).toBeDefined();
      const registered = await pieces.getRegisteredPieces();
      expect(registered.map((piece) => piece.id)).toEqual([created.pieceId]);
      expect(await resolvePieceAddress(pieces, "doubling-report")).toBe(
        created.pieceId,
      );
    });

    it("reports the listing failure when the space root cannot be initialized, claiming no listing", async () => {
      // The registry join is where this fails, so it is the listing that is
      // reported and the piece is not listed. The refusals on the other side
      // of the join say the piece IS listed, and a report that conflated the
      // two would send a caller looking for a piece that is not there.
      const engine = createEngine();
      const created = await createPiece(engine);
      const originalEnsureDefaultPattern = pieces.ensureDefaultPattern;
      pieces.ensureDefaultPattern = () =>
        Promise.reject(new Error("space root unavailable"));

      const result = await engine.invokeBuiltinTool("assign_slug", {
        token: created.resultRef,
        slug: "doubling-report",
      });
      pieces.ensureDefaultPattern = originalEnsureDefaultPattern;

      const output = result.output as AssignSlugToolErrorOutput;
      expect(output.status).toBe("error");
      expect(output.message).toContain("failed while listing");
      expect(output.message).toContain("space root unavailable");
      expect(output.message).not.toContain("the piece is listed");
      expect(await pieces.getRegisteredPieces()).toEqual([]);
    });

    it("leaves an initialized space root untouched while assigning the slug", async () => {
      await linkDefaultPattern();
      const existingRoot = await pieces.getDefaultPattern(false);
      expect(existingRoot).toBeDefined();
      const existingRootId = getEntityId(existingRoot!);
      const originalEnsureDefaultPattern = pieces.ensureDefaultPattern.bind(
        pieces,
      );
      const originalEditWithRetry = runtime.editWithRetry.bind(runtime);
      let ensureCalls = 0;
      let rootWriteAttempts = 0;
      pieces.ensureDefaultPattern = async () => {
        ensureCalls++;
        runtime.editWithRetry = ((fn, maxRetries) => {
          rootWriteAttempts++;
          return originalEditWithRetry(fn, maxRetries);
        }) as typeof runtime.editWithRetry;
        try {
          return await originalEnsureDefaultPattern();
        } finally {
          runtime.editWithRetry = originalEditWithRetry;
        }
      };

      const engine = createEngine();
      const created = await createPiece(engine);
      const result = await engine.invokeBuiltinTool("assign_slug", {
        token: created.resultRef,
        slug: "doubling-report",
      });
      pieces.ensureDefaultPattern = originalEnsureDefaultPattern;

      const output = result.output as AssignSlugToolSuccessOutput;
      expect(output.status).toBe("ok");
      expect(ensureCalls).toBe(1);
      expect(rootWriteAttempts).toBe(0);
      const rootAfterAssignment = await pieces.getDefaultPattern(false);
      expect(getEntityId(rootAfterAssignment!)).toEqual(existingRootId);
    });

    it("surfaces a rejected session construction as a structured error", async () => {
      const engine = new CfHarnessEngine({
        sandboxRuntime: new FakeSandboxRuntime(),
        runId: `assign-slug-test-${crypto.randomUUID()}`,
        fabricSessionFactory: () =>
          Promise.reject(new Error("authorization denied")),
      });
      const result = await engine.invokeBuiltinTool("assign_slug", {
        token: "/of:fid1:abc",
        slug: "doubling-report",
      });
      const output = result.output as AssignSlugToolErrorOutput;
      expect(output.status).toBe("error");
      expect(output.message).toContain(
        "could not establish the fabric session",
      );
      expect(output.message).toContain("authorization denied");
    });

    it("composes no URL when the session's API URL cannot carry one", () => {
      // The URL guard fails closed: a session whose API URL does not parse
      // yields no link rather than a broken one.
      const broken = {
        getSpaceName: () => "demo",
        runtime: { apiUrl: "http://[invalid" },
      } as unknown as Parameters<typeof namedPieceUrl>[0];
      expect(namedPieceUrl(broken, "doubling-report")).toBeUndefined();
    });

    it("returns an error for a token that does not parse as a reference", async () => {
      await linkDefaultPattern();
      const engine = createEngine();
      const result = await engine.invokeBuiltinTool("assign_slug", {
        token: "not a reference at all",
        slug: "doubling-report",
      });
      const output = result.output as AssignSlugToolErrorOutput;
      expect(output.status).toBe("error");
      expect(output.message).toContain("does not name a reference");
    });
  });
});
