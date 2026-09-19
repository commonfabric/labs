/**
 * A Loom row from retrieval to the written result: a scripted run searches,
 * names a hit by its handle in the result it submits, and the result writer
 * links a document minted from that row under the row's label.
 */

import { expect } from "@std/expect";
import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { join } from "@std/path";

import { createSession, Identity } from "@commonfabric/identity";
import { PiecesController } from "@commonfabric/piece/ops";
import { isLink, Runtime } from "@commonfabric/runner";
import { cfcLabelViewForCell } from "@commonfabric/runner/cfc";
import type { NormalizedFullLink } from "@commonfabric/runner/shared";
import { StorageManager } from "@commonfabric/runner/storage/cache.deno";

import {
  CFC_PROMPT_SLOT_BOUND_ATOM_TYPE,
  type PromptSlotBinding,
} from "../src/contracts/prompt-slot.ts";
import { CfHarnessEngine } from "../src/engine.ts";
import type { HarnessFabricSession } from "../src/fabric-session.ts";
import { createHarnessHandleTable } from "../src/handle-table.ts";
import { LOOM_SEARCH_SCHEMA_VERSION } from "../src/loom-retrieval.ts";
import { CfHarnessPromptLoop } from "../src/prompt-loop.ts";
import {
  agentObservedHandlesOfTable,
  AgentResultWriteError,
  writeAgentResult,
} from "../src/result-writer.ts";
import type { SandboxRuntime } from "../src/sandbox/types.ts";
import {
  chatViewOfRequest,
  responsesBodyFromChatFixture,
} from "./support/responses-fixture.ts";

const signer = await Identity.fromPassphrase("agent result loom rows");

const WORK = "https://cfc.test/atom/facet/work";
const HOME = "https://cfc.test/atom/facet/home";

const RESULT_SCHEMA = {
  type: "object",
  properties: {
    summary: { type: "string" },
    source: { asCell: ["cell"] },
  },
  required: ["summary"],
} as const;

const contextBinding: PromptSlotBinding = {
  type: CFC_PROMPT_SLOT_BOUND_ATOM_TYPE,
  source: { type: "test.prompt-slot", subject: "loom-rows" },
  role: "context",
  kernelName: "cf-harness",
  surface: "test",
  subject: "loom-rows",
  eventId: "event-loom-rows",
};

/** Sandbox fixture which never starts a process. */
const sandbox: SandboxRuntime = {
  describe: () => ({
    kind: "docker-runsc-cfc",
    defaultWorkingDirectory: "/workspace",
    cfc: { runtimeRequested: true, workspaceMountPath: "/workspace" },
  }),
  defaultWorkingDirectory: () => "/workspace",
  resolvePath: (path) => path,
  isPathWithinWorkspace: () => true,
  isPathWithinAllowedRoots: () => true,
  run: () => Promise.resolve({ stdout: "", stderr: "", exitCode: 0 }),
  runShell: () => Promise.resolve({ stdout: "", stderr: "", exitCode: 0 }),
};

const searchPayload = JSON.stringify({
  schemaVersion: LOOM_SEARCH_SCHEMA_VERSION,
  query: "donuts",
  filters: {},
  hits: [
    { sourceRef: "m1", title: "Donut order", ifc: { confidentiality: [WORK] } },
    {
      sourceRef: "m2",
      title: "Donut recipe",
      ifc: { confidentiality: [HOME] },
    },
  ],
  truncated: false,
});

const toolCall = (id: string, name: string, args: unknown) => ({
  choices: [{
    index: 0,
    message: {
      role: "assistant",
      content: "",
      tool_calls: [{
        id,
        type: "function",
        function: { name, arguments: JSON.stringify(args) },
      }],
    },
  }],
});

describe("agent result over Loom rows", () => {
  let dir: string;
  let storageManager: ReturnType<typeof StorageManager.emulate>;
  let runtime: Runtime;
  let session: HarnessFabricSession;

  beforeEach(async () => {
    dir = await Deno.makeTempDir({ prefix: "agent-result-loom-rows-" });
    storageManager = StorageManager.emulate({ as: signer });
    runtime = new Runtime({
      apiUrl: new URL("http://toolshed.test"),
      storageManager,
      cfcEnforcementMode: "enforce-strict",
      cfcFlowLabels: "persist",
    });
    const pieces = new PiecesController(
      await createSession({
        identity: signer,
        spaceName: `loom-rows-${crypto.randomUUID()}`,
      }),
      runtime,
    );
    await pieces.synced();
    session = { pieces };
  });

  afterEach(async () => {
    await runtime.dispose();
    await storageManager.close();
    await Deno.remove(dir, { recursive: true });
  });

  /**
   * Runs a search and a submission. `result` builds the submitted value from
   * the handles the search returned, in hit order.
   */
  const run = async (result: (handles: string[]) => unknown) => {
    const resultPath = join(dir, "result.json");
    const engine = new CfHarnessEngine({
      model: "gpt-5.4",
      runId: "run-loom-rows",
      sandboxRuntime: sandbox,
      // A `context` run is refused its read tools at `enforce-strict`.
      cfcEnforcementMode: "enforce-explicit",
      loomRetrieval: {
        cliPath: "/trusted/loom",
        transport: { kind: "broker", queuePath: "/trusted/queue" },
      },
      structuredResult: { schema: RESULT_SCHEMA, path: resultPath },
      processRunner: {
        run: () =>
          Promise.resolve({ stdout: searchPayload, stderr: "", exitCode: 0 }),
      },
    });
    let turn = 0;
    const loop = new CfHarnessPromptLoop({
      apiKey: "test-key",
      engine,
      fetchFn: (_input, init) => {
        turn += 1;
        const view = chatViewOfRequest(JSON.parse(String(init?.body)));
        let payload: unknown;
        if (turn === 1) {
          payload = toolCall("call-1", "loom_search", { query: "donuts" });
        } else if (turn === 2) {
          const output = JSON.parse(
            view.messages.findLast((message) => message.role === "tool")!
              .content,
          ) as { entries: { handle: string }[] };
          payload = toolCall("call-2", "submit_result", {
            result: result(output.entries.map((entry) => entry.handle)),
          });
        } else {
          payload = {
            choices: [{
              index: 0,
              message: { role: "assistant", content: "Done." },
            }],
          };
        }
        return Promise.resolve(
          new Response(JSON.stringify(responsesBodyFromChatFixture(payload)), {
            status: 200,
          }),
        );
      },
    });
    const loopResult = await loop.runPrompt({
      prompt: "Find the donut order.",
      promptSlotBinding: contextBinding,
    });
    const handleTable = loopResult.runState.handleTable ??
      createHarnessHandleTable("run-loom-rows");
    return {
      handleTable,
      write: async () =>
        await writeAgentResult({
          session,
          handleTable,
          structuredResult: JSON.parse(await Deno.readTextFile(resultPath)),
          resultSchema: RESULT_SCHEMA,
          observedHandles: agentObservedHandlesOfTable(handleTable),
          maxConfidentiality: [WORK, HOME],
        }),
    };
  };

  const confidentialityOf = async (
    link: NormalizedFullLink,
  ): Promise<unknown[]> => {
    const cell = runtime.getCellFromLink(link);
    await cell.sync();
    return (cfcLabelViewForCell(cell)?.entries ?? []).flatMap((entry) =>
      entry.label.confidentiality ?? []
    );
  };

  it("links a referenced hit to a minted document carrying the row's label", async () => {
    const { handleTable, write } = await run(([order]) => ({
      summary: "The order is in the first mail.",
      source: order,
    }));

    expect(handleTable.referents?.map((referent) => referent.labelSource))
      .toEqual(["row", "row"]);
    const written = await write();

    const result = runtime.getCellFromLink(written.link);
    await result.sync();
    expect(isLink(result.key("source").getRaw())).toBe(true);
    // Read without the result schema, whose `asCell` would hand back a cell.
    const { schema: _schema, ...sourceLink } = result.key("source")
      .resolveAsCell().getAsNormalizedFullLink();
    const source = runtime.getCellFromLink(sourceLink);
    await source.sync();
    expect(source.get()).toMatchObject({ title: "Donut order" });
    expect(await confidentialityOf(sourceLink)).toEqual([WORK]);
  });

  it("links nothing for a hit the result does not name, and still joins its label", async () => {
    const { write } = await run(() => ({ summary: "Nothing to cite." }));

    const written = await write();

    const result = runtime.getCellFromLink(written.link);
    await result.sync();
    expect(result.get()).toEqual({ summary: "Nothing to cite." });
    // Both rows entered model context, so the inline text carries both
    // labels: each observed row is minted and read, named or not.
    expect(written.joinLabel.confidentiality).toEqual(
      expect.arrayContaining([WORK, HOME]),
    );
    expect(written.mintedDocuments.length).toBe(2);
  });

  it("fails the write for a referent token the run does not hold", async () => {
    const { write } = await run(() => ({
      summary: "From a row I never saw.",
      source: "cfh:v:zzzzz",
    }));

    const failure = await write().catch((error) => error);

    expect(failure).toBeInstanceOf(AgentResultWriteError);
    expect((failure as AgentResultWriteError).code).toBe("unheld_handle");
  });
});
