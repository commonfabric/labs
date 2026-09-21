import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";
import { join } from "@std/path";

import type { HarnessPromptLoopResult } from "@commonfabric/cf-harness/prompt-loop";
import { Identity } from "@commonfabric/identity";
import { waitForCellValue } from "@commonfabric/integration/wait-for-cell-value";
import { StandaloneMemoryServer } from "@commonfabric/memory/v2/standalone";
import {
  getPatternEnvironment,
  resolveEntryIdentity,
  Runtime,
  runtimePresets,
  setPatternEnvironment,
} from "@commonfabric/runner";
import {
  agentQueueIndexCell,
  type AgentRunRecord,
  AgentRunRecordSchema,
} from "@commonfabric/runner/agent-run";
import { StorageManager } from "@commonfabric/runner/storage/cache.deno";

import { startAgentRunner } from "../commands/agent.ts";
import { openAgentStorageHost } from "../lib/agent-connections.ts";
import { createHarnessAgentRunExecutor } from "../lib/agent-run-harness.ts";
import { loadIdentity } from "../lib/identity.ts";

const HOME_PATH = "/api/patterns/system/home.tsx";

/** A home pattern with the queue and its real registration handler. */
const HOME_SOURCE = `
import { handler, pattern, Writable, type PerUser } from "commonfabric";
type Runner = { host: string; tools: string[]; registeredAt: string; lastClaimAt?: string };
type Entry = { run: PerUser<unknown>; host: string };
const register = handler<{ runner: Runner }, { runner: Writable<Runner | undefined> }>(
  ({ runner }, state) => state.runner.set(runner),
);
export default pattern(() => {
  const entries = new Writable<Entry[]>([]).for("entries");
  const runner = new Writable<Runner | undefined>(undefined).for("runner");
  return { agentQueue: { entries, agentRunner: runner, setAgentRunner: register({ runner }) } };
});
`;

describe("agent-connections", () => {
  it("registers at home and completes a run on another host through the default result session", async () => {
    const directory = await Deno.makeTempDir({ prefix: "agent-connections-" });
    const identityPath = join(directory, "identity.key");
    await Deno.writeFile(identityPath, await Identity.generatePkcs8());
    const identity = await loadIdentity(identityPath);
    const homeIdentity = await resolveEntryIdentity(
      HOME_PATH,
      (path) =>
        path === HOME_PATH
          ? Promise.resolve(HOME_SOURCE)
          : Promise.reject(new Error(`Unexpected pattern module: ${path}`)),
    );
    const homeServer = StandaloneMemoryServer.start({
      serve: (request) => {
        const url = new URL(request.url);
        if (url.pathname === HOME_PATH) {
          return new Response(
            url.searchParams.has("identity") ? homeIdentity : HOME_SOURCE,
            {
              headers: { "content-type": "text/plain" },
            },
          );
        }
      },
    });
    const recordServer = StandaloneMemoryServer.start();
    const connect = (url: URL) =>
      new Runtime(runtimePresets.remoteClient({
        apiUrl: url,
        storageManager: StorageManager.open({ as: identity, memoryHost: url }),
        experimental: { serverExecution: false },
      }));
    const home = connect(homeServer.url);
    const remote = connect(recordServer.url);
    let runner: Awaited<ReturnType<typeof startAgentRunner>> | undefined;
    const messages: string[] = [];
    try {
      const execute = createHarnessAgentRunExecutor({
        identityKeyPath: identityPath,
        requester: identity.did(),
        workRoot: directory,
        report: (message) => messages.push(message),
        harnessDeps: {
          env: {
            CF_HARNESS_MODEL_PROVIDER: "openai-compatible-gateway",
            CF_HARNESS_GATEWAY_AUTH_MODE: "none",
          },
          createPromptLoop: (options) => ({
            runPrompt: async () => {
              await Deno.writeTextFile(
                join(options.workspaceHostPath!, "agent-result.json"),
                JSON.stringify({ answer: "Solaris" }),
              );
              return {
                model: "scripted",
                finalAssistantText: "Done.",
                transcript: [],
                modelTurns: 1,
                runState: {
                  runId: "remote-result",
                  status: "completed",
                  createdAt: "2026-09-20T12:00:00Z",
                  updatedAt: "2026-09-20T12:00:01Z",
                  currentDir: "/workspace",
                  policyEvents: [],
                  toolOutputs: [],
                } as unknown as HarnessPromptLoopResult["runState"],
              };
            },
            runTranscript: () =>
              Promise.reject(new Error("No transcript supplied")),
          }),
        },
      });
      runner = await startAgentRunner(
        {
          identityPath,
          home: identity.did(),
          homeHost: homeServer.url.origin,
          runnerHost: recordServer.url.origin,
          tools: ["describe_handle"],
          maxConcurrent: 1,
          leaseMs: 60_000,
          workRoot: directory,
        },
        (message) => messages.push(message),
        undefined,
        execute,
      );
      const queue = agentQueueIndexCell(home, identity.did());
      await queue.sync();
      expect(queue.get().agentRunner).toMatchObject({
        host: recordServer.url.origin,
        tools: ["describe_handle"],
        registeredAt: expect.any(String),
      });
      const record = remote.getCell(
        identity.did(),
        "remote-agent-run",
        AgentRunRecordSchema,
      );
      await remote.editWithRetry((tx) => {
        const request = remote.getCell(identity.did(), "request");
        record.withTx(tx).set({
          request,
          piece: request,
          space: request,
          requestHash: "remote-request",
          task: "Choose a book",
          inputs: {},
          resultSchema: {
            type: "object",
            properties: { answer: { type: "string" } },
            required: ["answer"],
          },
          state: "queued",
          stateSince: "2026-09-20T12:00:00Z",
          submittedAt: "2026-09-20T12:00:00Z",
        });
      });
      await home.editWithRetry((tx) => {
        queue.withTx(tx).key("entries").set([{
          run: record,
          host: recordServer.url.origin,
        }]);
      });
      const ended = await waitForCellValue<AgentRunRecord>(
        remote,
        record,
        (value) => value?.outcome !== undefined,
        { stuckLabel: "default deployed runner completes the remote record" },
      );
      expect({ state: ended.state, messages }).toMatchObject({
        state: "completed",
      });
      expect(ended.result?.get()).toEqual({ answer: "Solaris" });
      expect(ended.modelTurns).toBe(1);
      await queue.pull();
      expect(queue.get().agentRunner?.lastClaimAt).toEqual(expect.any(String));
    } finally {
      await runner?.stop();
      await home.dispose();
      await remote.dispose();
      await homeServer.close();
      await recordServer.close();
      await Deno.remove(directory, { recursive: true });
    }
  });

  it("keeps the home pattern environment when opening a record host", async () => {
    const directory = await Deno.makeTempDir({ prefix: "agent-connections-" });
    const identityPath = join(directory, "identity.key");
    await Deno.writeFile(identityPath, await Identity.generatePkcs8());
    const recordServer = StandaloneMemoryServer.start();
    const originalEnvironment = getPatternEnvironment();
    const homeUrl = new URL("https://home.example.test");
    setPatternEnvironment({ apiUrl: homeUrl });
    let storageHost: Runtime | undefined;
    try {
      storageHost = await openAgentStorageHost(
        identityPath,
        recordServer.url.origin,
      );

      expect(getPatternEnvironment().apiUrl).toEqual(homeUrl);
    } finally {
      await storageHost?.dispose();
      setPatternEnvironment(originalEnvironment);
      await recordServer.close();
      await Deno.remove(directory, { recursive: true });
    }
  });
});
