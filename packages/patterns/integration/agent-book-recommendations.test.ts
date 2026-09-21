import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { fromFileUrl, join } from "@std/path";
import { Identity } from "@commonfabric/identity";
import { CFC_ATOM_TYPE } from "@commonfabric/api/cfc";
import {
  type Cell,
  type Pattern,
  Runtime,
  runtimePresets,
} from "@commonfabric/runner";
import {
  type AgentRunRecord,
  AgentRunRecordSchema,
} from "@commonfabric/runner/agent-run";
import { StorageManager } from "@commonfabric/runner/storage/cache.deno";
import { resolveLocalProgram } from "@commonfabric/runner/local-program.deno";
import { waitForCellValue } from "@commonfabric/integration/wait-for-cell-value";
import { runDenoCommandWithTemporaryLock } from "@commonfabric/test-support/isolated-deno";
import { startAgentRunner } from "../../cli/commands/agent.ts";
import { loadIdentity } from "../../cli/lib/identity.ts";
import { shellQuote } from "../../cli/lib/shell-quote.ts";
import { runAgentBookPatternTest } from "./agent-book-cf-test.ts";

const root = fromFileUrl(new URL("../../../", import.meta.url));
const apiUrl = Deno.env.get("AGENT_DEMO_API_URL");

/** Runs against an explicitly selected disposable dev-local deployment and runsc-cfc. */
describe("agent book recommendations", () => {
  it({
    name:
      "persists five live book links and labeled Loom sources through the real harness",
    ignore: apiUrl === undefined,
    // The remote runtime's shared connections outlive individual runtime disposal.
    sanitizeResources: false,
    sanitizeOps: false,
    fn: async () => {
      const store = Deno.env.get("AGENT_DEMO_STORE");
      if (store === undefined) {
        throw new Error(
          "AGENT_DEMO_STORE must name the disposable server's SQLite directory.",
        );
      }
      const evidence = Deno.env.get("AGENT_DEMO_EVIDENCE_DIR") ??
        await Deno.makeTempDir({ prefix: "agent-book-demo-" });
      await Deno.mkdir(evidence, { recursive: true });
      const identityPath = join(evidence, "identity.key");
      await Deno.writeFile(identityPath, await Identity.generatePkcs8(), {
        createNew: true,
      });
      const identity = await loadIdentity(identityPath);
      const user = { type: CFC_ATOM_TYPE.User, subject: identity.did() };
      const label = { confidentiality: [user] };
      const hits = [
        {
          source: "fc",
          reference: "Books/reading.md",
          title: "Reading notes",
          snippet: "Linked books for this reader.",
          ifc: label,
        },
        {
          source: "fc",
          reference: "Books/authors.md",
          title: "Favorite authors",
          snippet: "Authors the reader follows.",
          ifc: label,
        },
      ];
      const page = {
        path: "Books/reading.md",
        content: "Five books with reasons and live links.",
        ifc: label,
      };
      await Deno.writeTextFile(
        join(evidence, "search.json"),
        JSON.stringify({
          schemaVersion: 1,
          query: "books",
          hits,
          filters: {},
          source_status: {},
          warnings: [],
          truncated: false,
        }),
      );
      await Deno.writeTextFile(
        join(evidence, "page.json"),
        JSON.stringify(page),
      );
      const loom = join(evidence, "loom-fixture");
      await Deno.writeTextFile(
        loom,
        `#!/bin/sh\ncase "$1" in\nsearch) exec /bin/cat ${
          shellQuote(join(evidence, "search.json"))
        } ;;\npage) exec /bin/cat ${
          shellQuote(join(evidence, "page.json"))
        } ;;\n*) exit 2 ;;\nesac\n`,
        { mode: 0o700 },
      );
      const configPath = join(evidence, "loom.json");
      await Deno.writeTextFile(
        configPath,
        JSON.stringify({
          cliPath: loom,
          transport: { kind: "broker", queuePath: join(evidence, "queue") },
        }),
      );

      const model = "scripted-agent-book-demo";
      const requests: unknown[] = [];
      const modelServer = Deno.serve({
        hostname: "127.0.0.1",
        port: 0,
        onListen: () => {},
      }, async (request) => {
        if (request.method === "GET") {
          return Response.json({ data: [{ id: model }] });
        }
        const body = await request.json();
        requests.push(body);
        await Deno.writeTextFile(
          join(evidence, "model-requests.json"),
          JSON.stringify(requests, null, 2),
        );
        const messages = body.messages as Array<
          { role: string; content?: string; tool_call_id?: string }
        >;
        const has = (id: string) =>
          messages.some((message) =>
            message.role === "tool" && message.tool_call_id === id
          );
        const call = (id: string, name: string, args: unknown) => ({
          role: "assistant",
          content: null,
          tool_calls: [{
            id,
            type: "function",
            function: { name, arguments: JSON.stringify(args) },
          }],
        });
        let message: unknown;
        if (!has("search-books")) {
          message = call("search-books", "loom_search", { query: "books" });
        } else if (!has("read-page")) {
          message = call("read-page", "loom_page_read", {
            target: "Books/reading.md",
          });
        } else if (!has("submit-books")) {
          const text = messages.map((item) => item.content ?? "").join("\n");
          const books = [
            ...text.matchAll(/(cfh:[a-z]:[A-Za-z0-9_-]+) — book_(\d+)/g),
          ]
            .sort((a, b) => Number(a[2]) - Number(b[2]));
          expect(books).toHaveLength(5);
          const sources = [
            ...text.matchAll(/"handle"\s*:\s*"(cfh:[a-z]:[A-Za-z0-9_-]+)"/g),
          ].map((match) => match[1]);
          expect(sources).toHaveLength(3);
          message = call("submit-books", "submit_result", {
            result: {
              picks: books.map((book, index) => ({
                book: book[1],
                why: `Recommendation ${
                  index + 1
                } follows the reader's linked history.`,
              })),
              sources,
            },
          });
        } else {message = {
            role: "assistant",
            content: "The five linked recommendations are ready.",
          };}
        return Response.json({
          id: `books-${requests.length}`,
          object: "chat.completion",
          created: 0,
          model,
          choices: [{
            index: 0,
            message,
            finish_reason: has("submit-books") ? "stop" : "tool_calls",
          }],
          usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
        });
      });
      const environment: Record<string, string> = {
        CF_HARNESS_HOME: join(evidence, "harness-home"),
        CF_HARNESS_MODEL_PROVIDER: "openai-compatible-gateway",
        CF_HARNESS_GATEWAY_BASE_URL:
          `http://127.0.0.1:${modelServer.addr.port}/`,
        CF_HARNESS_GATEWAY_AUTH_MODE: "none",
        // Context-role tasks can read Loom only at this explicit operator-selected rung.
        CF_HARNESS_CFC_ENFORCEMENT_MODE: "enforce-explicit",
      };
      const previous = new Map(
        Object.keys(environment).map((key) => [key, Deno.env.get(key)]),
      );
      for (const [key, value] of Object.entries(environment)) {
        Deno.env.set(key, value);
      }
      let runner: Awaited<ReturnType<typeof startAgentRunner>> | undefined;
      let runtime: Runtime | undefined;
      try {
        runner = await startAgentRunner({
          identityPath,
          home: identity.did(),
          homeHost: apiUrl!,
          runnerHost: apiUrl!,
          tools: ["loom_search", "loom_page_read"],
          maxConcurrent: 1,
          leaseMs: 300_000,
          workRoot: join(evidence, "runs"),
          loomRetrievalConfigPath: configPath,
          model,
        }, console.log);
        runtime = new Runtime(
          runtimePresets.remoteClient({
            apiUrl: new URL(apiUrl!),
            storageManager: StorageManager.open({
              as: identity,
              memoryHost: new URL(apiUrl!),
            }),
            experimental: { agentBuiltin: true, serverExecution: false },
            cfcEnforcementMode: "enforce-strict",
            cfcFlowLabels: "persist",
          }),
        );
        const engine = runtime.harness;
        const program = await resolveLocalProgram(
          (request) => engine.resolve(request),
          {
            main: join(root, "packages/patterns/book-recommendations/main.tsx"),
            root: join(root, "packages/patterns"),
          },
        );
        const compiled = await runtime.patternManager.compileAndRegisterModules(
          program,
        );
        expect(compiled.main?.default).toBeDefined();
        const pattern = compiled.main!.default as Pattern;
        const tx = runtime.edit();
        const books = Array.from({ length: 5 }, (_, index) => {
          const book = runtime!.getCell(identity.did(), `book-${index}`, {
            type: "object",
            properties: {
              title: { type: "string" },
              author: { type: "string" },
            },
            ifc: label,
          }, tx);
          book.set({
            title: `Book ${index + 1}`,
            author: `Author ${index + 1}`,
          });
          return book;
        });
        const result = runtime.run(
          tx,
          pattern,
          { finishedBooks: books, favoriteAuthors: ["Author 1"] },
          runtime.getCell(
            identity.did(),
            "book-demo",
            pattern.resultSchema,
            tx,
          ),
        );
        runtime.prepareTxForCommit(tx);
        expect((await tx.commit()).error).toBeUndefined();
        const state = result.key("recommendation");
        await waitForCellValue(
          runtime,
          state.key("run"),
          (value) => value !== undefined,
          { stuckLabel: "the book request's agent run record" },
        );
        const recordCell = state.key("run").resolveAsCell().asSchema<
          AgentRunRecord
        >(AgentRunRecordSchema);
        const record = await waitForCellValue<AgentRunRecord>(
          runtime,
          recordCell,
          (value) =>
            value !== undefined &&
            ["completed", "failed", "refused", "cancelled"].includes(
              value.state,
            ),
          { stuckLabel: "the book agent run's terminal state" },
        );
        await Deno.writeTextFile(
          join(evidence, "terminal.json"),
          JSON.stringify(record, null, 2),
        );
        expect(record?.state).toBe("completed");
        expect(record.runRef).toBeDefined();
        const runState = JSON.parse(
          await Deno.readTextFile(join(record.runRef!, "run-state.json")),
        );
        expect(runState.fabricSessionCfc?.readMaxConfidentiality).toEqual([
          user,
        ]);
        const resultCell = recordCell.key("result").resolveAsCell();
        const resolved = await resultCell.asSchema<
          {
            picks: Array<{ book: Cell<unknown>; why: string }>;
            sources: Cell<unknown>[];
          }
        >({
          type: "object",
          properties: {
            picks: {
              type: "array",
              items: {
                type: "object",
                properties: {
                  book: { asCell: ["cell"] },
                  why: { type: "string" },
                },
              },
            },
            sources: { type: "array", items: { asCell: ["cell"] } },
          },
        }).pull();
        expect(resolved.picks).toHaveLength(5);
        expect(
          resolved.picks.map((pick) => pick.book.getAsNormalizedFullLink().id),
        ).toEqual(books.map((book) => book.getAsNormalizedFullLink().id));
        expect(resolved.sources).toHaveLength(3);

        const inspect = async (cell: Cell<unknown>, name: string) => {
          const link = cell.getAsNormalizedFullLink();
          const output = await runDenoCommandWithTemporaryLock({
            root,
            args: (
              lock,
            ) => [
              "run",
              "--lock",
              lock,
              "--frozen",
              "-A",
              "packages/cli/mod.ts",
              "inspect",
              "value-at",
              join(store, `${link.space}.sqlite`),
              link.id,
              "--scope",
              link.scope ?? "space",
              "--doc",
              "--full-depth",
              "--json",
            ],
          });
          expect(output.code, new TextDecoder().decode(output.stderr)).toBe(0);
          const value = JSON.parse(new TextDecoder().decode(output.stdout));
          await Deno.writeTextFile(
            join(evidence, `inspect-${name}.json`),
            JSON.stringify(value, null, 2),
          );
          expect(value.exists).toBe(true);
          return value.value;
        };
        const resultDocument = await inspect(resultCell, "result");
        const declaredLabel = (
          confidentiality: unknown[],
          integrity?: unknown[],
        ) =>
          expect.objectContaining({
            path: [],
            label: expect.objectContaining({
              confidentiality,
              ...(integrity === undefined ? {} : { integrity }),
            }),
          });
        expect(resultDocument.cfc.labelMap.entries).toContainEqual(
          declaredLabel([user], [{ type: CFC_ATOM_TYPE.LlmDerived }]),
        );
        for (let index = 0; index < books.length; index++) {
          const document = await inspect(books[index], `book-${index}`);
          expect(document.value.title).toBe(`Book ${index + 1}`);
          expect(document.cfc.labelMap.entries).toContainEqual(
            declaredLabel([user]),
          );
          const pick = await inspect(
            resultCell.key("picks").key(index).resolveAsCell(),
            `pick-${index}`,
          );
          expect(pick.value.book.$link.id).toBe(
            books[index].getAsNormalizedFullLink().id,
          );
          expect(pick.value.why).toBe(
            `Recommendation ${index + 1} follows the reader's linked history.`,
          );
          expect(pick.cfc.labelMap.entries).toContainEqual(
            declaredLabel([user], [{ type: CFC_ATOM_TYPE.LlmDerived }]),
          );
        }
        for (let index = 0; index < resolved.sources.length; index++) {
          const document = await inspect(
            resolved.sources[index],
            `source-${index}`,
          );
          expect(document.cfc.labelMap.entries).toContainEqual(
            declaredLabel([user]),
          );
        }
        const authored = await runAgentBookPatternTest({
          apiUrl: new URL(apiUrl!),
          identityPath,
          patternCoverageDir: join(evidence, "pattern-coverage"),
        });
        await Deno.writeTextFile(
          join(evidence, "cf-test.json"),
          JSON.stringify(authored, null, 2),
        );
        expect(authored.error).toBeUndefined();
        expect(authored.runtimeErrors).toEqual([]);
        expect(authored.consoleErrors).toEqual([]);
        expect(authored.consoleWarnings).toEqual([]);
        expect(authored.nonIdempotent).toEqual([]);
        expect(authored.results).toHaveLength(1);
        expect(authored.results[0].passed).toBe(true);
      } finally {
        await runner?.stop();
        await runtime?.dispose();
        await modelServer.shutdown();
        for (const [key, value] of previous) {
          if (value === undefined) Deno.env.delete(key);
          else Deno.env.set(key, value);
        }
      }
    },
  });
});
