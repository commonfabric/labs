import { beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { join, resolve, toFileUrl } from "@std/path";
import { Identity } from "@commonfabric/identity";
import { runDenoCommandWithTemporaryLock } from "@commonfabric/test-support/isolated-deno";
import {
  consoleHealthRows,
  ConsoleServer,
  createConsoleInteractiveServiceOptions,
  resolveConsoleConfig,
} from "../../console/server.ts";
import { ConsoleHealth, type ConsoleHealthRow } from "../../console/health.ts";
import { harnessSessionChatPolicy } from "../../src/session-assembly.ts";
import type { CfHarnessEngine } from "../../src/engine.ts";
import type { ConsoleSessionListing } from "../../console/sessions.ts";
import type { HarnessFetch } from "../../src/contracts/http-fetch.ts";
import { PatternIndexClient } from "../../src/pattern-index/client.ts";
import { MAX_HARNESS_PATTERN_REFS } from "../../src/pattern-refs.ts";
import {
  type HarnessInteractiveChatEventListener,
  HarnessInteractiveChatService,
  type HarnessInteractivePromptLoopFactory,
} from "../../src/interactive-chat-service.ts";
import { openSqliteHarnessChatSessionStore } from "../../src/sqlite-session-store.ts";
import type {
  CreateHarnessPromptLoopOptions,
  HarnessPromptLoopResult,
  RunHarnessTranscriptOptions,
} from "../../src/prompt-loop.ts";
import type { HarnessTranscriptMessage } from "../../src/contracts/transcript.ts";

/**
 * A loop that answers the task it was given and nothing else. The console
 * server's routes are what these tests are about, so the turn behind them only
 * has to reach a terminal state.
 */
const answeringLoop: HarnessInteractivePromptLoopFactory = () => ({
  runTranscript: async (
    options: RunHarnessTranscriptOptions,
  ): Promise<HarnessPromptLoopResult> => {
    const answer = { role: "assistant" as const, content: "built it" };
    const transcript = [...options.transcript, answer];
    await options.onTranscriptEvent?.({ message: answer, transcript });
    return {
      model: "gpt-test",
      finalAssistantText: answer.content,
      transcript,
      modelTurns: 1,
      runState: {} as HarnessPromptLoopResult["runState"],
    };
  },
});

/**
 * A loop that records the supplied completion in the run artifact directory.
 * This is the production ordering the console depends on: the prompt loop
 * persists its transcript before the service emits `turn_completed`.
 */
const artifactLoop = (
  messages: readonly HarnessTranscriptMessage[],
): HarnessInteractivePromptLoopFactory =>
(loopOptions) => ({
  runTranscript: async (
    options: RunHarnessTranscriptOptions,
  ): Promise<HarnessPromptLoopResult> => {
    if (
      loopOptions.artifactRoot === undefined || loopOptions.runId === undefined
    ) {
      throw new Error("artifact loop requires an artifact root and run id");
    }
    const transcript = [...options.transcript, ...messages];
    await writeTurnTranscript(
      loopOptions.artifactRoot,
      loopOptions.runId,
      transcript,
      options.transcript.length,
    );
    const finalAssistantText =
      transcript.findLast((message) => message.role === "assistant")?.content ??
        "";
    return {
      model: "gpt-test",
      finalAssistantText,
      transcript,
      modelTurns: 1,
      runState: {} as HarnessPromptLoopResult["runState"],
    };
  },
});

/**
 * A clock that advances a second per reading. Two turns started in the same
 * millisecond are ordered by turn id, which a real session's random ids make
 * arbitrary, so the tests that turn on which turn came first give the service
 * a clock that distinguishes them.
 */
const advancingClock = () => {
  let seconds = 0;
  return () => {
    seconds += 1;
    return `2026-01-01T00:00:${String(seconds).padStart(2, "0")}.000Z`;
  };
};

/** The identity the proxied index client signs with in these tests. */
const signer = await Identity.fromPassphrase("cf-harness console index proxy");

/** What the index answers for the pattern a task attaches by id. */
const INDEXED_PATTERN = {
  patternId: "pat-expenses",
  ownerDid: "did:key:zOwner",
  createdAt: "2026-08-01T00:00:00.000Z",
  description: "Totals an expense list",
  hashtags: ["expenses"],
  dependencies: [],
};

/** An entity id of the shape an input-cell reference has to carry. */
const CELL_ID = `of:fid1:${"A".repeat(43)}`;

const config = () =>
  resolveConsoleConfig(
    [
      "--fabric-identity",
      "key.pkcs8",
      "--fabric-space",
      "console-test",
      "--session-db",
      "none",
    ],
    {},
    "/console",
  );

/** The same configuration, with an index for the proxy route to reach. */
const configWithIndex = () =>
  resolveConsoleConfig(
    [
      "--fabric-identity",
      "key.pkcs8",
      "--fabric-space",
      "console-test",
      "--session-db",
      "none",
      "--pattern-index-url",
      "https://index.test/api",
    ],
    {},
    "/console",
  );

const jsonRequest = (
  path: string,
  body: unknown,
  headers: Record<string, string> = {},
): Request =>
  new Request(`http://127.0.0.1:8100${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });

const getRequest = (
  path: string,
  headers: Record<string, string> = {},
): Request => new Request(`http://127.0.0.1:8100${path}`, { headers });

const writeTurnTranscript = async (
  artifactRoot: string,
  turnId: string,
  transcript: readonly HarnessTranscriptMessage[],
  firstGeneratedIndex = 0,
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

describe("console/server", () => {
  let server: ConsoleServer;

  beforeEach(async () => {
    server = new ConsoleServer(
      await config(),
      (onEvent) =>
        new HarnessInteractiveChatService({
          createPromptLoop: answeringLoop,
          now: advancingClock(),
          onEvent,
        }),
    );
  });

  /** Starts a task and waits for the turn it started to finish. */
  const startTask = async (
    body: unknown,
  ): Promise<{ sessionId: string; turnId: string }> => {
    const response = await server.handle(
      jsonRequest("/api/task", body),
    );
    expect(response.status).toBe(200);
    const started = await response.json();
    await server.service.waitForTurn(started.sessionId, started.turnId);
    return started;
  };

  const listSessions = async (): Promise<ConsoleSessionListing> => {
    const response = await server.handle(
      getRequest("/api/sessions"),
    );
    expect(response.status).toBe(200);
    return await response.json();
  };

  /** What the index client was asked for, as it composed the request. */
  interface IndexRequest {
    url: string;
    body: string;
  }

  /**
   * A second server, configured with an index, whose client answers from
   * `responses` rather than from a deployment. The client is handed in because
   * the real one reads a keyfile off disk to sign with; what the routes are
   * about is which requests reach it and which are refused before they do.
   */
  const indexServer = async (
    responses: readonly Response[],
    artifactRoot?: string,
  ): Promise<
    { server: ConsoleServer; requests: IndexRequest[] }
  > => {
    const requests: IndexRequest[] = [];
    let answered = 0;
    const fetchFn: HarnessFetch = (input, init) => {
      requests.push({
        url: String(input),
        body: typeof init?.body === "string" ? init.body : "",
      });
      const response = responses[answered] ?? Response.json({});
      answered += 1;
      return Promise.resolve(response);
    };
    const indexed = new ConsoleServer(
      {
        ...await configWithIndex(),
        ...(artifactRoot !== undefined ? { artifactRoot } : {}),
      },
      (onEvent) =>
        new HarnessInteractiveChatService({
          createPromptLoop: answeringLoop,
          now: advancingClock(),
          onEvent,
        }),
      () =>
        Promise.resolve(
          new PatternIndexClient({
            baseUrl: "https://index.test/api",
            fetchFn,
            signer,
          }),
        ),
    );
    return { server: indexed, requests };
  };

  /** Reads one live completed event backed by its durable run transcript. */
  const liveTurnResult = async (
    messages: readonly HarnessTranscriptMessage[],
  ): Promise<unknown> => {
    const artifactRoot = await Deno.makeTempDir({
      prefix: "cf-harness-console-result-event-",
    });
    try {
      const resultConfig = await resolveConsoleConfig(
        [
          "--fabric-identity",
          "key.pkcs8",
          "--fabric-space",
          "console-test",
          "--session-db",
          "none",
          "--artifact-root",
          artifactRoot,
        ],
        {},
        "/console",
      );
      const resultServer = new ConsoleServer(
        resultConfig,
        (onEvent) =>
          new HarnessInteractiveChatService({
            basePromptLoopOptions: { artifactRoot },
            createPromptLoop: artifactLoop(messages),
            now: advancingClock(),
            onEvent,
            runIdForTurn: (_sessionId, turnId) => turnId,
          }),
      );
      const page = await resultServer.handle(getRequest("/"));
      await page.body?.cancel();
      const response = await resultServer.handle(getRequest(
        "/api/events?afterSequence=0",
        {},
      ));
      const startedResponse = await resultServer.handle(
        jsonRequest("/api/task", { text: "track my books" }, {}),
      );
      expect(startedResponse.status).toBe(200);
      return (await envelopesUntil(response, "turn_completed")).at(-1)!.event
        .result;
    } finally {
      await Deno.remove(artifactRoot, { recursive: true });
    }
  };

  describe("console prompt configuration", () => {
    it("threads configured skills.sh discovery into the run and policy", async () => {
      const resolved = await resolveConsoleConfig(
        [
          "--fabric-identity",
          "key.pkcs8",
          "--fabric-space",
          "console-test",
          "--session-db",
          "none",
          "--skills-registry-url",
          "https://registry.example",
        ],
        {},
        "/console",
      );
      const serviceOptions = createConsoleInteractiveServiceOptions(
        resolved,
        {
          modelProvider: "openai-compatible-gateway",
          modelAuthSource: "none",
          gatewayAuthMode: "none",
        },
        () => {},
      );

      expect(resolved.skillsSh).toEqual({
        baseUrl: "https://registry.example",
      });
      expect(serviceOptions.basePromptLoopOptions?.skillsSh).toEqual({
        baseUrl: "https://registry.example",
      });
      expect(serviceOptions.runIdForTurn?.("session-1", "turn-1")).toBe(
        "turn-1",
      );
      // A registry and a fabric session back both skill tools, so a session
      // configured for one offers acquisition as well as discovery.
      const policy = harnessSessionChatPolicy(resolved);
      expect(policy.allowedToolIds).toContain("search_skills");
      expect(policy.allowedToolIds).toContain("acquire_skill");
    });

    it("runs skill scripts when the console was launched with the switch", async () => {
      const named = await resolveConsoleConfig(
        [
          "--fabric-identity",
          "key.pkcs8",
          "--fabric-space",
          "console-test",
          "--session-db",
          "none",
          "--allow-skill-scripts",
        ],
        {},
        "/console",
      );
      expect(named.allowSkillScripts).toBe(true);

      const inherited = await resolveConsoleConfig(
        [
          "--fabric-identity",
          "key.pkcs8",
          "--fabric-space",
          "console-test",
          "--session-db",
          "none",
        ],
        { CF_HARNESS_ALLOW_SKILL_SCRIPTS: "1" },
        "/console",
      );
      expect(inherited.allowSkillScripts).toBe(true);
    });

    it("runs no skill script when the console was launched without it", async () => {
      expect((await config()).allowSkillScripts).toBe(false);
    });

    it("offers `run_skill_script` when a registry backs it and the switch is on", async () => {
      // Backing alone never offers this tool — it appears only in the withheld
      // set — so without this the switch would reach an acquired child through
      // its own surface and never reach the run holding the registry, and the
      // registry half of one decision would be undeliverable.
      const withSwitch = await resolveConsoleConfig(
        [
          "--fabric-identity",
          "key.pkcs8",
          "--fabric-space",
          "console-test",
          "--session-db",
          "none",
          "--skills-root",
          "/workspace/skills",
          "--allow-skill-scripts",
        ],
        {},
        "/console",
      );
      const withNeither = await resolveConsoleConfig(
        [
          "--fabric-identity",
          "key.pkcs8",
          "--fabric-space",
          "console-test",
          "--session-db",
          "none",
          "--skills-root",
          "/workspace/skills",
        ],
        {},
        "/console",
      );

      expect(harnessSessionChatPolicy(withSwitch).allowedToolIds).toContain(
        "run_skill_script",
      );
      expect(harnessSessionChatPolicy(withNeither).allowedToolIds).not
        .toContain("run_skill_script");
    });

    it("withholds the skill tools from a session with no registry", async () => {
      const policy = harnessSessionChatPolicy(await config());
      expect(policy.allowedToolIds).not.toContain("search_skills");
      expect(policy.allowedToolIds).not.toContain("acquire_skill");
    });

    it("reads the skills.sh discovery registry from the environment", async () => {
      const resolved = await resolveConsoleConfig(
        [
          "--fabric-identity",
          "key.pkcs8",
          "--fabric-space",
          "console-test",
          "--session-db",
          "none",
        ],
        { CF_HARNESS_SKILLS_REGISTRY_URL: "https://registry.example" },
        "/console",
      );

      expect(resolved.skillsSh).toEqual({
        baseUrl: "https://registry.example",
      });
    });

    it("rejects a skills.sh discovery registry that is not a URL", async () => {
      await expect(
        resolveConsoleConfig(
          [
            "--fabric-identity",
            "key.pkcs8",
            "--fabric-space",
            "console-test",
            "--session-db",
            "none",
            "--skills-registry-url",
            "not a url",
          ],
          {},
          "/console",
        ),
      ).rejects.toThrow("--skills-registry-url must be a valid URL");
    });

    it("reads the named prompt and disables child composition guidance", async () => {
      const directory = await Deno.makeTempDir({
        prefix: "cf-harness-console-prompt-",
      });
      try {
        await Deno.writeTextFile(
          join(directory, "system.txt"),
          "COMPOSE FIRST\n",
        );
        const resolved = await resolveConsoleConfig(
          [
            "--fabric-identity",
            "key.pkcs8",
            "--fabric-space",
            "console-test",
            "--session-db",
            "none",
            "--system-prompt-file",
            "system.txt",
            "--no-child-composition-guidance",
          ],
          {},
          directory,
        );

        expect(resolved.systemPrompt).toBe("COMPOSE FIRST\n");
        expect(resolved.subagentCompositionGuidance).toBe(false);
        const serviceOptions = createConsoleInteractiveServiceOptions(
          resolved,
          {
            modelProvider: "openai-compatible-gateway",
            modelAuthSource: "none",
            gatewayAuthMode: "none",
          },
          () => {},
        );
        expect(serviceOptions.systemPrompt).toBe("COMPOSE FIRST\n");
        expect(
          serviceOptions.basePromptLoopOptions?.subagentCompositionGuidance,
        ).toBe(false);
      } finally {
        await Deno.remove(directory, { recursive: true });
      }
    });

    it("rejects a prompt file that cannot be read", async () => {
      await expect(
        resolveConsoleConfig(
          [
            "--fabric-identity",
            "key.pkcs8",
            "--fabric-space",
            "console-test",
            "--session-db",
            "none",
            "--system-prompt-file",
            "missing.txt",
          ],
          {},
          "/console-prompt-test",
        ),
      ).rejects.toThrow(
        "--system-prompt-file could not be read: /console-prompt-test/missing.txt",
      );
    });

    it("rejects a prompt file containing only whitespace", async () => {
      const directory = await Deno.makeTempDir({
        prefix: "cf-harness-console-prompt-",
      });
      try {
        const promptPath = join(directory, "empty.txt");
        await Deno.writeTextFile(promptPath, " \n\t");

        await expect(
          resolveConsoleConfig(
            [
              "--fabric-identity",
              "key.pkcs8",
              "--fabric-space",
              "console-test",
              "--session-db",
              "none",
              "--system-prompt-file",
              promptPath,
            ],
            {},
            directory,
          ),
        ).rejects.toThrow(`--system-prompt-file is empty: ${promptPath}`);
      } finally {
        await Deno.remove(directory, { recursive: true });
      }
    });
  });

  describe("the module", () => {
    it("loads on a host with no FFI permission", async () => {
      // The console promises a machine without the SQLite native library can
      // serve its page: a run reads its space through that library only as
      // it ends, and only when it holds a cell to ask about. So evaluating
      // this module must not open that library.
      const repoRoot = resolve(import.meta.dirname!, "..", "..", "..", "..");
      const wrapperDir = await Deno.makeTempDir({
        prefix: "cf-harness-console-import-",
      });
      try {
        const wrapper = join(wrapperDir, "import-console-server.ts");
        await Deno.writeTextFile(
          wrapper,
          `import ${
            JSON.stringify(
              toFileUrl(join(repoRoot, "packages/cf-harness/console/server.ts"))
                .href,
            )
          };\n`,
        );
        const output = await runDenoCommandWithTemporaryLock({
          root: repoRoot,
          args: (lock) => [
            "run",
            `--lock=${lock}`,
            // The entry sits outside the workspace, so it names the config
            // rather than finding one beside itself.
            `--config=${join(repoRoot, "deno.jsonc")}`,
            "--allow-env",
            wrapper,
          ],
        });
        if (!output.success) {
          console.error(new TextDecoder().decode(output.stderr));
        }
        expect(output.code).toBe(0);
      } finally {
        await Deno.remove(wrapperDir, { recursive: true });
      }
    });
  });

  describe("GET /api/sessions", () => {
    it("answers with no sessions before a task is started", async () => {
      expect(await listSessions()).toEqual({ sessions: [] });
    });

    it("describes a started session by the task it was given", async () => {
      const started = await startTask({ text: "track my books" });

      const listing = await listSessions();
      expect(listing.sessions).toHaveLength(1);
      expect(listing.sessions[0]).toMatchObject({
        sessionId: started.sessionId,
        status: "idle",
        reusable: true,
        turnCount: 1,
        firstTaskText: "track my books",
      });
    });

    it("orders the most recently touched session first", async () => {
      const first = await startTask({ text: "first task" });
      const second = await startTask({ text: "second task" });

      const listing = await listSessions();
      expect(listing.sessions.map((entry) => entry.sessionId)).toEqual([
        second.sessionId,
        first.sessionId,
      ]);
    });
  });

  describe("GET /api/status", () => {
    it("answers with the configured artifact root before a task is started", async () => {
      const response = await server.handle(
        getRequest("/api/status"),
      );

      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({
        artifactRoot: (await config()).artifactRoot,
        sessions: [],
      });
    });
  });

  describe("GET /api/policy", () => {
    it("returns what a session started here would run under, before any session exists", async () => {
      const response = await server.handle(
        getRequest("/api/policy"),
      );

      expect(response.status).toBe(200);
      const resolved = await config();
      const policy = harnessSessionChatPolicy(resolved);
      expect(await response.json()).toEqual({
        systemPromptSha256: null,
        allowedToolIds: [...policy.allowedToolIds],
        allowedSubagentProfiles: [...policy.allowedSubagentProfiles],
        fabricSpace: resolved.fabricSession.space,
        artifactRoot: resolved.artifactRoot,
        sessionDbPath: null,
      });
    });
  });

  describe("GET /api/health", () => {
    it("reports the configured Fabric API and unverified session liveness without a token", async () => {
      const response = await server.handle(getRequest("/api/health"));

      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({
        ok: true,
        fabricApiUrl: (await config()).fabricSession.apiUrl,
        fabricSession: "unverified",
      });
    });

    it("answers 403 when the request names another host", async () => {
      const response = await server.handle(
        getRequest("/api/health", { host: "evil.test:8100" }),
      );

      expect(response.status).toBe(403);
    });
  });

  describe("GET /api/health/detail", () => {
    it("returns the cached snapshot while a host probe remains pending and applies the existing host restriction", async () => {
      const pending = Promise.withResolvers<readonly ConsoleHealthRow[]>();
      const fact = {
        id: "index.reachable",
        group: "index",
        label: "Index",
        value: "not checked",
        source: "host probe",
      };
      const health = new ConsoleHealth([], [{
        id: fact.id,
        initial: [fact],
        read: () => pending.promise,
        unavailable: () => [],
      }]);
      const healthServer = new ConsoleServer(
        await config(),
        () => server.service,
        undefined,
        health,
      );
      try {
        const response = await healthServer.handle(
          getRequest("/api/health/detail"),
        );
        expect(response.status).toBe(200);
        expect(await response.json()).toMatchObject({
          version: 1,
          rows: [{ ...fact, state: "unknown", checkedAt: null }],
        });
        expect(
          (await healthServer.handle(
            getRequest("/api/health/detail", { host: "evil.test:8100" }),
          )).status,
        ).toBe(403);
        expect(server.service.turns()).toHaveLength(0);
      } finally {
        pending.resolve([]);
        await health.refresh();
      }
    });
  });

  describe("consoleHealthRows()", () => {
    it("keeps shared classes on distinct named stores from the launch environment", async () => {
      const connectorGrants = ["drive", "readwise"].map((connection) => ({
        name: connection,
        cfcClass: "document",
        ref: `/${CELL_ID}`,
        source: { connection, piece: "resources" },
      }));
      const configured = await resolveConsoleConfig(
        [
          "--fabric-identity",
          "key.pkcs8",
          "--fabric-space",
          "console-test",
          "--session-db",
          "none",
        ],
        { CF_HARNESS_CONNECTOR_GRANTS: JSON.stringify(connectorGrants) },
        "/console",
      );
      expect(configured.connectorGrants).toEqual(connectorGrants);
      expect(
        consoleHealthRows(configured).filter((row) =>
          row.id.startsWith("connector.granted.")
        ).map(({ id, value }) => ({ id, value })),
      )
        .toEqual([
          { id: "connector.granted.drive", value: "granted: drive (document)" },
          {
            id: "connector.granted.readwise",
            value: "granted: readwise (document)",
          },
        ]);
    });

    it("keeps index URL credentials out of the configured value and retained launch evidence", async () => {
      const indexUrl =
        "https://user-secret:password-secret@index.test/api/?token=query-secret#fragment-secret";
      const configured = await resolveConsoleConfig(
        [
          "--fabric-identity",
          "key.pkcs8",
          "--fabric-space",
          "console-test",
          "--session-db",
          "none",
        ],
        { CF_HARNESS_PATTERN_INDEX_URL: indexUrl },
        "/console",
      );
      const rows = consoleHealthRows(configured, {
        checkedAt: "2026-09-17T00:00:00.000Z",
        connectors: [],
        resolved: [{ name: "index", value: indexUrl, source: "launch flag" }],
      });
      expect(rows.find((row) => row.id === "config.index")).toMatchObject({
        value: "https://index.test/api/",
        source: "console launch record",
        detail: "launch flag",
      });
      expect(JSON.stringify(rows)).not.toContain("-secret");
      expect(configured.patternIndex?.baseUrl).toBe(indexUrl);
    });

    it("retains the launch record only for inherited active values, including an equal explicit override", async () => {
      const configured = await resolveConsoleConfig([
        "--fabric-identity",
        "key.pkcs8",
        "--fabric-space",
        "console-test",
        "--port",
        "8123",
        "--session-db",
        "none",
      ], {
        MEMORY_DIR: "/data/selected",
        CF_HARNESS_MODEL: "test-model",
        CF_HARNESS_ALLOW_SKILL_SCRIPTS: "1",
      }, "/console");
      const checkedAt = "2026-09-17T00:00:00.000Z";
      const connector = {
        id: "connector.refused.0",
        group: "connectors",
        label: "gmail",
        value: "not granted",
        source: "loom connector receipt + pieces.json (gmail)",
        detail: "/loom/handles.json; /loom/pieces.json",
        state: "degraded" as const,
        reason: "Class already claimed.",
        remedy: "Select a connection.",
      };
      const rows = consoleHealthRows(configured, {
        checkedAt,
        connectors: [connector],
        resolved: [
          { name: "port", value: "8123", source: "launch record" },
          {
            name: "store",
            value: "/data/selected",
            source: "loom toolshed-store-dir",
          },
          { name: "model", value: "other-model", source: "launch record" },
        ],
      });
      expect(rows.find((row) => row.id === "config.port")).toMatchObject({
        label: "Port",
        value: "8123",
        source: "console launch flag",
        detail: "--port",
      });
      expect(rows.find((row) => row.id === "config.store")).toMatchObject({
        value: "/data/selected",
        source: "console launch record",
        detail: "loom toolshed-store-dir",
        checkedAt,
      });
      expect(rows.find((row) => row.id === "config.model")).toMatchObject({
        value: "test-model",
        source: "console configuration",
        detail: "CF_HARNESS_MODEL",
      });
      expect(rows.find((row) => row.id === "config.skill-scripts"))
        .toMatchObject({
          label: "Skill Scripts",
          value: "run in the sandbox",
          source: "console configuration",
          detail: "CF_HARNESS_ALLOW_SKILL_SCRIPTS",
        });
      expect(rows.find((row) => row.id === connector.id)).toEqual({
        ...connector,
        checkedAt,
      });
      expect(
        rows.filter((row) => row.state !== "unknown").every((row) =>
          Number.isFinite(Date.parse(row.checkedAt!))
        ),
      ).toBe(true);
    });

    it("keeps missing inventory, automatic store discovery and unobserved credentials unknown", async () => {
      const rows = consoleHealthRows(await config());
      expect(rows.find((row) => row.id === "connectors.inventory"))
        .toMatchObject({
          state: "unknown",
          value: "0 explicit grants configured",
        });
      expect(rows.find((row) => row.id === "config.store")).toMatchObject({
        state: "unknown",
        value: "automatic discovery",
      });
      expect(rows.find((row) => row.id === "model.auth")).toMatchObject({
        state: "unknown",
        checkedAt: null,
      });
      expect(rows.find((row) => row.id === "config.index")).toMatchObject({
        state: "degraded",
        value: "not configured",
      });
      expect(
        rows.filter((row) => row.id.startsWith("index.")).map((row) =>
          row.state
        ),
      ).toEqual(["unknown", "unknown"]);
    });

    for (const mode of ["missing", "key", "none", "codex"] as const) {
      it(`reports ${mode} credential provenance without publishing a credential`, async () => {
        const options: CreateHarnessPromptLoopOptions = mode === "codex"
          ? {
            modelProvider: "openai-codex",
            modelAuthSource: "cf-harness-local-store",
          }
          : {
            modelProvider: "openai-compatible-gateway",
            gatewayAuthMode: mode === "none" ? "none" : "bearer",
            ...(mode === "key" ? { apiKey: "secret-test-value" } : {}),
          };
        const rows = consoleHealthRows(await config(), undefined, options, {
          CF_HARNESS_API_KEY: mode === "key" ? "secret-test-value" : undefined,
        });
        expect(rows.find((row) => row.id === "model.auth")).toMatchObject({
          label: "Model Authentication",
          state: mode === "missing" ? "failed" : "ok",
          source: mode === "codex"
            ? "harness credential store"
            : "console environment",
          detail: mode === "codex"
            ? "/console/.cf-harness/auth.json"
            : mode === "none"
            ? "CF_HARNESS_GATEWAY_AUTH_MODE"
            : mode === "key"
            ? "CF_HARNESS_API_KEY"
            : "CF_HARNESS_API_KEY / OPENAI_API_KEY",
        });
        expect(JSON.stringify(rows)).not.toContain("secret-test-value");
      });
    }
  });

  describe("task Loom context", () => {
    it("rejects malformed Loom targets before starting a turn", async () => {
      for (const loomId of ["../private", {}, "loom-not-valid"]) {
        const response = await server.handle(
          jsonRequest("/api/task", { text: "Make a Loom", loomId }),
        );
        expect(response.status).toBe(400);
      }
      expect(server.service.turns()).toHaveLength(0);
    });

    it("persists the submitted origin even when the next turn names another Loom", async () => {
      const first = await startTask({
        text: "First",
        loomId: "loom-1111111111111111",
      });
      await startTask({
        text: "Second",
        sessionId: first.sessionId,
        loomId: "loom-2222222222222222",
      });
      expect(
        server.service.turns(first.sessionId).map((entry) =>
          entry.input.loomId
        ),
      ).toEqual(["loom-1111111111111111", "loom-2222222222222222"]);
    });
  });

  describe("GET /api/turns/<turnId>/result", () => {
    it("returns named errors for malformed and unknown turn paths", async () => {
      const malformedRoute = await server.handle(getRequest(
        "/api/turns/not-a-result",
        {},
      ));
      expect(malformedRoute.status).toBe(404);

      const malformedEncoding = await server.handle(getRequest(
        "/api/turns/%/result",
        {},
      ));
      expect(malformedEncoding.status).toBe(404);

      const unknownTurn = await server.handle(getRequest(
        "/api/turns/turn-nobody-started/result",
        {},
      ));
      expect(unknownTurn.status).toBe(404);
      expect(await unknownTurn.json()).toEqual({
        code: "turn_not_found",
        error: "turn turn-nobody-started was not found",
      });
    });

    it("returns a named error when completed-turn artifacts are unavailable", async () => {
      const started = await startTask({ text: "track my books" });

      const response = await server.handle(getRequest(
        `/api/turns/${started.turnId}/result`,
        {},
      ));

      expect(response.status).toBe(404);
      expect(await response.json()).toEqual({
        code: "turn_result_unavailable",
        error: `result for turn ${started.turnId} is unavailable`,
      });
    });

    it("returns the durable result of a completed turn", async () => {
      const artifactRoot = await Deno.makeTempDir({
        prefix: "cf-harness-console-result-route-",
      });
      try {
        const resultConfig = await resolveConsoleConfig(
          [
            "--fabric-identity",
            "key.pkcs8",
            "--fabric-space",
            "console-test",
            "--session-db",
            "none",
            "--artifact-root",
            artifactRoot,
          ],
          {},
          "/console",
        );
        const resultServer = new ConsoleServer(
          resultConfig,
          (onEvent) =>
            new HarnessInteractiveChatService({
              createPromptLoop: answeringLoop,
              now: advancingClock(),
              onEvent,
            }),
        );
        const page = await resultServer.handle(getRequest("/"));
        await page.body?.cancel();
        const startedResponse = await resultServer.handle(
          jsonRequest("/api/task", {
            text: "track my books",
            loomId: "loom-1111111111111111",
          }, {}),
        );
        const started = await startedResponse.json();
        await resultServer.service.waitForTurn(
          started.sessionId,
          started.turnId,
        );
        await writeTurnTranscript(artifactRoot, started.turnId, [
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
          { role: "assistant", content: "built it" },
        ]);

        const response = await resultServer.handle(getRequest(
          `/api/turns/${started.turnId}/result`,
          {},
        ));

        expect(response.status).toBe(200);
        expect(await response.json()).toEqual({
          originLoomId: "loom-1111111111111111",
          looms: [],
          pieces: [{
            slug: "reading-list",
            url: "http://localhost:8000/console-test/reading-list",
          }],
          spaceName: "console-test",
          outcome: "completed",
          sessionId: started.sessionId,
          continuable: true,
          finalText: "built it",
        });
      } finally {
        await Deno.remove(artifactRoot, { recursive: true });
      }
    });

    it("returns a completed turn after its session is restored", async () => {
      const artifactRoot = await Deno.makeTempDir({
        prefix: "cf-harness-console-result-restored-",
      });
      const store = await openSqliteHarnessChatSessionStore({
        url: toFileUrl(join(artifactRoot, "sessions.sqlite")),
      });
      try {
        const resultConfig = await resolveConsoleConfig(
          [
            "--fabric-identity",
            "key.pkcs8",
            "--fabric-space",
            "console-test",
            "--session-db",
            "none",
            "--artifact-root",
            artifactRoot,
          ],
          {},
          "/console",
        );
        const createService = (onEvent: HarnessInteractiveChatEventListener) =>
          new HarnessInteractiveChatService({
            basePromptLoopOptions: { artifactRoot },
            createPromptLoop: artifactLoop([
              { role: "assistant", content: "restored result" },
            ]),
            onEvent,
            runIdForTurn: (_sessionId, turnId) => turnId,
            sessionStore: store,
          });
        const firstServer = new ConsoleServer(
          resultConfig,
          createService,
        );
        const firstPage = await firstServer.handle(getRequest("/"));
        await firstPage.body?.cancel();
        const startedResponse = await firstServer.handle(
          jsonRequest("/api/task", { text: "persist this turn" }, {}),
        );
        const started = await startedResponse.json();
        await firstServer.service.waitForTurn(
          started.sessionId,
          started.turnId,
        );

        const restoredServer = new ConsoleServer(
          resultConfig,
          createService,
        );
        await restoredServer.service.initializeFromStore();
        const restoredPage = await restoredServer.handle(getRequest("/"));
        await restoredPage.body?.cancel();

        const response = await restoredServer.handle(getRequest(
          `/api/turns/${started.turnId}/result`,
          {},
        ));

        expect(response.status).toBe(200);
        expect(await response.json()).toEqual({
          looms: [],
          pieces: [],
          spaceName: "console-test",
          outcome: "completed",
          sessionId: started.sessionId,
          continuable: true,
          finalText: "restored result",
        });
      } finally {
        store.close();
        await Deno.remove(artifactRoot, { recursive: true });
      }
    });

    it("returns a named error for a turn that has not completed", async () => {
      let finish: (() => void) | undefined;
      const gate = new Promise<void>((resolve) => {
        finish = resolve;
      });
      const waitingServer = new ConsoleServer(
        await config(),
        (onEvent) =>
          new HarnessInteractiveChatService({
            createPromptLoop: () => ({
              runTranscript: async (options) => {
                await gate;
                return await answeringLoop({} as never).runTranscript(options);
              },
            }),
            now: advancingClock(),
            onEvent,
          }),
      );
      const page = await waitingServer.handle(getRequest("/"));
      await page.body?.cancel();
      const startedResponse = await waitingServer.handle(
        jsonRequest("/api/task", { text: "keep working" }, {}),
      );
      const started = await startedResponse.json();
      try {
        const response = await waitingServer.handle(getRequest(
          `/api/turns/${started.turnId}/result`,
          {},
        ));

        expect(response.status).toBe(409);
        expect(await response.json()).toEqual({
          code: "turn_not_completed",
          error: `turn ${started.turnId} has not completed`,
        });
      } finally {
        finish!();
        await waitingServer.service.waitForTurn(
          started.sessionId,
          started.turnId,
        );
      }
    });

    it("answers 410 `turn_failed` with the turn's error for a turn that failed", async () => {
      // A failed turn will never have a result, so a poller is told to stop
      // rather than to ask again.
      const failingServer = new ConsoleServer(
        await config(),
        (onEvent) =>
          new HarnessInteractiveChatService({
            createPromptLoop: () => ({
              runTranscript: () =>
                Promise.reject(new Error("model stream returned an error")),
            }),
            now: advancingClock(),
            onEvent,
          }),
      );
      const page = await failingServer.handle(getRequest("/"));
      await page.body?.cancel();
      const startedResponse = await failingServer.handle(
        jsonRequest("/api/task", { text: "build it" }, {}),
      );
      const started = await startedResponse.json();
      await failingServer.service.waitForTurn(
        started.sessionId,
        started.turnId,
      );

      const response = await failingServer.handle(getRequest(
        `/api/turns/${started.turnId}/result`,
        {},
      ));

      expect(response.status).toBe(410);
      expect(await response.json()).toEqual({
        code: "turn_failed",
        error: `turn ${started.turnId} failed`,
        detail: {
          code: "internal_error",
          message: "model stream returned an error",
        },
      });
    });

    it("answers 410 `turn_canceled` for a turn that was canceled", async () => {
      let finish: (() => void) | undefined;
      const gate = new Promise<void>((resolve) => {
        finish = resolve;
      });
      const waitingServer = new ConsoleServer(
        await config(),
        (onEvent) =>
          new HarnessInteractiveChatService({
            createPromptLoop: () => ({
              runTranscript: async (options) => {
                await gate;
                return await answeringLoop({} as never).runTranscript(options);
              },
            }),
            now: advancingClock(),
            onEvent,
          }),
      );
      const page = await waitingServer.handle(getRequest("/"));
      await page.body?.cancel();
      const startedResponse = await waitingServer.handle(
        jsonRequest("/api/task", { text: "keep working" }, {}),
      );
      const started = await startedResponse.json();
      const canceled = await waitingServer.handle(
        jsonRequest("/api/cancel", { sessionId: started.sessionId }, {}),
      );
      expect(canceled.status).toBe(200);
      finish!();
      await waitingServer.service.waitForTurn(
        started.sessionId,
        started.turnId,
      );

      const response = await waitingServer.handle(getRequest(
        `/api/turns/${started.turnId}/result`,
        {},
      ));

      expect(response.status).toBe(410);
      expect(await response.json()).toEqual({
        code: "turn_canceled",
        error: `turn ${started.turnId} was canceled`,
        detail: "canceled from the console page",
      });
    });
  });

  describe("POST /api/task", () => {
    it("starts a follow-up turn in the session the request names", async () => {
      const started = await startTask({ text: "track my books" });

      const followUp = await startTask({
        text: "add a rating",
        sessionId: started.sessionId,
      });

      expect(followUp.sessionId).toBe(started.sessionId);
      expect(followUp.turnId).not.toBe(started.turnId);
      const listing = await listSessions();
      expect(listing.sessions).toHaveLength(1);
      expect(listing.sessions[0].turnCount).toBe(2);
      expect(listing.sessions[0].firstTaskText).toBe("track my books");
    });

    it("answers 404 for a session that does not exist", async () => {
      const response = await server.handle(jsonRequest("/api/task", {
        text: "track my books",
        sessionId: "session-nobody-started",
      }));

      expect(response.status).toBe(404);
      expect((await response.json()).code).toBe("session_not_found");
    });

    it("answers 400 for a sessionId that is not a string", async () => {
      const response = await server.handle(jsonRequest("/api/task", {
        text: "track my books",
        sessionId: 7,
      }));

      expect(response.status).toBe(400);
      expect((await response.json()).error).toBe("sessionId must be a string");
    });

    it("attaches the task's input cells to the run that answers it", async () => {
      // The weaver flow: a caller names cells it wants the task computed
      // over, by reference and under its own names. What reaches the run is
      // the specification; the run mints the tokens the model sees.
      const loopOptions: CreateHarnessPromptLoopOptions[] = [];
      const capturing = new ConsoleServer(
        await config(),
        (onEvent) =>
          new HarnessInteractiveChatService({
            basePromptLoopOptions: {
              engine: {
                config: {},
                fabricSessionAvailable: false,
                startRun: () => undefined,
                establishInputCells: () =>
                  Promise.resolve([{
                    name: "itinerary",
                    token: "cfh:a:itinerary",
                    ref: `/${CELL_ID}/days`,
                  }]),
                establishPatternRefs: () => Promise.resolve([]),
              } as unknown as CfHarnessEngine,
            },
            createPromptLoop: (options) => {
              loopOptions.push(options);
              return answeringLoop(options);
            },
            now: advancingClock(),
            onEvent,
          }),
      );
      const page = await capturing.handle(getRequest("/"));
      await page.body?.cancel();

      const response = await capturing.handle(jsonRequest("/api/task", {
        text: "summarize the trip",
        inputCells: [{ name: "itinerary", ref: `/${CELL_ID}/days` }],
      }));
      expect(response.status).toBe(200);
      const started = await response.json();
      await capturing.service.waitForTurn(started.sessionId, started.turnId);

      expect(loopOptions.at(-1)?.inputCells).toEqual([
        { name: "itinerary", ref: `/${CELL_ID}/days` },
      ]);
    });

    it("honors an explicit empty input list instead of configured defaults", async () => {
      const loopOptions: CreateHarnessPromptLoopOptions[] = [];
      const capturing = new ConsoleServer(
        await config(),
        (onEvent) =>
          new HarnessInteractiveChatService({
            basePromptLoopOptions: {
              inputCells: [{ name: "default", ref: `/${CELL_ID}/days` }],
            },
            createPromptLoop: (options) => {
              loopOptions.push(options);
              return answeringLoop(options);
            },
            now: advancingClock(),
            onEvent,
          }),
      );
      const response = await capturing.handle(jsonRequest("/api/task", {
        text: "Start without an attached piece",
        inputCells: [],
      }));
      expect(response.status).toBe(200);
      const started = await response.json();
      await capturing.service.waitForTurn(started.sessionId, started.turnId);
      expect(loopOptions.at(-1)?.inputCells).toEqual([]);
    });

    it("answers 400 for an input cell the flag's own grammar refuses", async () => {
      const response = await server.handle(jsonRequest("/api/task", {
        text: "summarize the trip",
        inputCells: [{ name: "not a name", ref: `/${CELL_ID}/days` }],
      }));

      expect(response.status).toBe(400);
      expect((await response.json()).error).toContain("--input-cell name");
    });

    it("answers 400 for an input-cell ref that names no entity, before any turn starts", async () => {
      // The mint would refuse this ref; refusing it here costs no turn.
      const response = await server.handle(jsonRequest("/api/task", {
        text: "make a budget dashboard",
        inputCells: [{
          name: "transactions",
          ref: `/fid1:${"A".repeat(43)}/account`,
        }],
      }));

      expect(response.status).toBe(400);
      expect((await response.json()).error).toContain(
        "reference does not parse",
      );
      expect((await listSessions()).sessions).toHaveLength(0);
    });

    it("answers 400 for a piece address naming a space that is not this console's", async () => {
      // The caller cannot see which space this console runs against, so the
      // mismatch is this side's to explain — and it costs no turn to say it.
      const response = await server.handle(jsonRequest("/api/task", {
        text: "make the headings readable",
        inputCells: [{
          name: "pattern_1",
          ref: "pattern:someone-elses-space/bill-inbox",
        }],
      }));

      expect(response.status).toBe(400);
      expect((await response.json()).error).toContain(
        "this session runs in `console-test`",
      );
      expect((await listSessions()).sessions).toHaveLength(0);
    });

    it("answers 400 for a piece address whose slug is malformed", async () => {
      const response = await server.handle(jsonRequest("/api/task", {
        text: "make the headings readable",
        inputCells: [{ name: "pattern_1", ref: "pattern:console-test/Bills!" }],
      }));

      expect(response.status).toBe(400);
      expect((await response.json()).error).toContain(
        "reference does not parse",
      );
      expect((await listSessions()).sessions).toHaveLength(0);
    });

    it("answers 400 for a bare slug the runtime's slug rule refuses", async () => {
      const response = await server.handle(jsonRequest("/api/task", {
        text: "make the headings readable",
        inputCells: [{ name: "pattern_1", ref: "Bill Inbox" }],
      }));

      expect(response.status).toBe(400);
      expect((await response.json()).error).toContain(
        "reference does not parse",
      );
    });

    it("answers 400 for a piece address naming a path under the piece", async () => {
      // A slug names a piece or it names nothing; the general cell case is
      // CT-2319's, and claiming it here would promise what nothing resolves.
      const response = await server.handle(jsonRequest("/api/task", {
        text: "make the headings readable",
        inputCells: [{
          name: "pattern_1",
          ref: "pattern:console-test/bill-inbox/rows",
        }],
      }));

      expect(response.status).toBe(400);
      expect((await response.json()).error).toContain(
        "more than one path segment",
      );
    });

    it("answers 400 for input cells that are not a list of name and ref", async () => {
      const response = await server.handle(jsonRequest("/api/task", {
        text: "summarize the trip",
        inputCells: [{ name: "itinerary" }],
      }));

      expect(response.status).toBe(400);
      expect((await response.json()).error).toBe(
        "each input cell needs a string name and ref",
      );
    });

    it("answers 400 for input cells that are not a list at all", async () => {
      const response = await server.handle(jsonRequest("/api/task", {
        text: "summarize the trip",
        inputCells: { itinerary: `/${CELL_ID}/days` },
      }));

      expect(response.status).toBe(400);
      expect((await response.json()).error).toBe("inputCells must be an array");
    });

    it("answers 400 for an input cell that is not an object", async () => {
      const response = await server.handle(jsonRequest("/api/task", {
        text: "summarize the trip",
        inputCells: [`itinerary=/${CELL_ID}/days`],
      }));

      expect(response.status).toBe(400);
      expect((await response.json()).error).toBe(
        "each input cell must be an object",
      );
    });

    it("answers 400 for a name the request uses twice", async () => {
      // Two references under one name is a request that has not said which
      // cell the model's `itinerary` is.
      const response = await server.handle(jsonRequest("/api/task", {
        text: "summarize the trip",
        inputCells: [
          { name: "itinerary", ref: `/${CELL_ID}/days` },
          { name: "itinerary", ref: `/${CELL_ID}/nights` },
        ],
      }));

      expect(response.status).toBe(400);
      expect((await response.json()).error).toBe(
        "inputCells names `itinerary` twice",
      );
    });

    it("answers 400 for an input cell whose name is already a connector grant", async () => {
      // The caller cannot see the console's grants, so the refusal names the
      // connection the colliding grant came from rather than only the word.

      const granted = new ConsoleServer(
        await resolveConsoleConfig(
          [
            "--fabric-identity",
            "key.pkcs8",
            "--fabric-space",
            "console-test",
            "--session-db",
            "none",
          ],
          {
            CF_HARNESS_CONNECTOR_GRANTS: JSON.stringify([{
              name: "email",
              ref: `/${CELL_ID}`,
              source: {
                connection: "gmail-work",
                piece: "cf-gmail-messages--gmail-work",
              },
            }]),
          },
          "/console",
        ),
        (onEvent) =>
          new HarnessInteractiveChatService({
            createPromptLoop: answeringLoop,
            now: advancingClock(),
            onEvent,
          }),
      );
      const response = await granted.handle(jsonRequest("/api/task", {
        text: "summarize the trip",
        inputCells: [{ name: "email", ref: `/${CELL_ID}/days` }],
      }));

      expect(response.status).toBe(400);
      expect((await response.json()).error).toBe(
        "inputCells names `email`, which is already this console's grant for the `gmail-work` connector handle",
      );
    });

    it("starts a task that names no input cells at all", async () => {
      const started = await startTask({
        text: "track my books",
        inputCells: null,
      });

      expect(started.turnId).toBeDefined();
    });

    it("attaches the task's pattern references to the run that answers it", async () => {
      // The pill's `use <id>` flow: the caller names published patterns by
      // the index's own id. What reaches the run is the id; resolving it
      // against the index is the run's, before its first model turn.
      const loopOptions: CreateHarnessPromptLoopOptions[] = [];
      const artifactRoot = await Deno.makeTempDir({
        prefix: "cf-harness-console-pattern-refs-",
      });
      const capturing = new ConsoleServer(
        await resolveConsoleConfig(
          [
            "--fabric-identity",
            "key.pkcs8",
            "--fabric-space",
            "console-test",
            "--session-db",
            "none",
            "--pattern-index-url",
            "https://index.test/api",
            "--artifact-root",
            artifactRoot,
          ],
          {},
          "/console",
        ),
        (onEvent) =>
          new HarnessInteractiveChatService({
            basePromptLoopOptions: {
              patternIndexClientFactory: () =>
                Promise.resolve(
                  new PatternIndexClient({
                    baseUrl: "https://index.test/api",
                    fetchFn: () =>
                      Promise.resolve(Response.json(INDEXED_PATTERN)),
                    signer,
                  }),
                ),
            },
            createPromptLoop: (options) => {
              loopOptions.push(options);
              return answeringLoop(options);
            },
            now: advancingClock(),
            onEvent,
          }),
      );
      const page = await capturing.handle(getRequest("/"));
      await page.body?.cancel();

      try {
        const response = await capturing.handle(jsonRequest("/api/task", {
          text: "use pat-expenses for a dice roller app",
          patternRefs: [{ patternId: "pat-expenses" }],
        }));
        expect(response.status).toBe(200);
        const started = await response.json();
        await capturing.service.waitForTurn(started.sessionId, started.turnId);

        expect(
          capturing.service.events(started.sessionId).map((envelope) =>
            envelope.event.kind
          ),
        ).toContain("turn_completed");
        expect(loopOptions.at(-1)?.patternRefs).toEqual([
          { patternId: "pat-expenses" },
        ]);
      } finally {
        await Deno.remove(artifactRoot, { recursive: true });
      }
    });

    it("answers 400 for a pattern reference that is not an index id, before any turn starts", async () => {
      // The prose the person typed after `use` is not an id, and an id is
      // the whole of the reference grammar.
      const response = await server.handle(jsonRequest("/api/task", {
        text: "use it for a dice roller app",
        patternRefs: [{ patternId: "it for a dice roller app" }],
      }));

      expect(response.status).toBe(400);
      expect((await response.json()).error).toContain("patternId must match");
      expect((await listSessions()).sessions).toHaveLength(0);
    });

    it("answers 400 for pattern references that are not a list at all", async () => {
      const response = await server.handle(jsonRequest("/api/task", {
        text: "total my spending",
        patternRefs: { patternId: "pat-expenses" },
      }));

      expect(response.status).toBe(400);
      expect((await response.json()).error).toBe(
        "patternRefs must be an array",
      );
    });

    it("answers 400 for a pattern reference that is not an object at all", async () => {
      // A reference is a `{ patternId }`, so a bare id in the list is a
      // spelling the route refuses rather than one it reads through.
      const response = await server.handle(jsonRequest("/api/task", {
        text: "total my spending",
        patternRefs: ["pat-expenses"],
      }));

      expect(response.status).toBe(400);
      expect((await response.json()).error).toBe(
        "each pattern reference must be an object",
      );
    });

    it("answers 400 for a `null` sitting in the reference list", async () => {
      // Distinct from a `null` in place of the list itself, which is how a
      // body says it attaches no patterns and starts an ordinary task.
      const response = await server.handle(jsonRequest("/api/task", {
        text: "total my spending",
        patternRefs: [null],
      }));

      expect(response.status).toBe(400);
      expect((await response.json()).error).toBe(
        "each pattern reference must be an object",
      );
    });

    it("answers 400 for a pattern reference that carries no string patternId", async () => {
      const response = await server.handle(jsonRequest("/api/task", {
        text: "total my spending",
        patternRefs: [{ id: "pat-expenses" }],
      }));

      expect(response.status).toBe(400);
      expect((await response.json()).error).toBe(
        "each pattern reference needs a string patternId",
      );
    });

    it("answers 400 for an id the request names twice", async () => {
      const response = await server.handle(jsonRequest("/api/task", {
        text: "total my spending",
        patternRefs: [
          { patternId: "pat-expenses" },
          { patternId: "pat-expenses" },
        ],
      }));

      expect(response.status).toBe(400);
      expect((await response.json()).error).toBe(
        "patternRefs names `pat-expenses` twice",
      );
    });

    it("answers 400 for more pattern references than a task may attach", async () => {
      const response = await server.handle(jsonRequest("/api/task", {
        text: "total my spending",
        patternRefs: Array.from(
          { length: MAX_HARNESS_PATTERN_REFS + 1 },
          (_unused, index) => ({ patternId: `pat-${index}` }),
        ),
      }));

      expect(response.status).toBe(400);
      expect((await response.json()).error).toContain(
        `at most ${MAX_HARNESS_PATTERN_REFS}`,
      );
    });

    it("starts a task that names no pattern references at all", async () => {
      const started = await startTask({
        text: "track my books",
        patternRefs: null,
      });

      expect(started.turnId).toBeDefined();
    });
  });

  describe("GET /api/events", () => {
    it("replays a past session's whole history from sequence zero", async () => {
      const started = await startTask({ text: "track my books" });

      const response = await server.handle(getRequest(
        `/api/events?sessionId=${started.sessionId}&afterSequence=0`,
        {},
      ));
      expect(response.status).toBe(200);
      expect(response.headers.get("content-type")).toBe("text/event-stream");
      const kinds = await kindsUntil(response, "turn_completed");

      expect(kinds).toEqual([
        "session_started",
        "turn_started",
        "assistant_delta",
        "assistant_completed",
        "turn_completed",
      ]);
    });

    it("adds the durable result to a completed turn", async () => {
      expect(
        await liveTurnResult([
          {
            role: "assistant",
            content: "",
            toolCalls: [{
              id: "call-1",
              type: "function",
              function: { name: "assign_slug", arguments: "{}" },
            }],
          },
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
          { role: "assistant", content: "built it" },
        ]),
      ).toEqual({
        looms: [],
        pieces: [{
          slug: "reading-list",
          url: "http://localhost:8000/console-test/reading-list",
        }],
        spaceName: "console-test",
        outcome: "completed",
        sessionId: expect.any(String),
        continuable: true,
        finalText: "built it",
      });
    });

    it("adds `pieces: []` when a completed turn assigned no slug", async () => {
      expect(
        await liveTurnResult([
          { role: "assistant", content: "calculated it" },
        ]),
      ).toEqual({
        looms: [],
        pieces: [],
        spaceName: "console-test",
        outcome: "completed",
        sessionId: expect.any(String),
        continuable: true,
        finalText: "calculated it",
      });
    });

    it("replays only the session the stream names", async () => {
      await startTask({ text: "first task" });
      const second = await startTask({ text: "second task" });

      const response = await server.handle(getRequest(
        `/api/events?sessionId=${second.sessionId}&afterSequence=0`,
        {},
      ));
      const sessionIds = new Set(
        (await envelopesUntil(response, "turn_completed")).map((envelope) =>
          envelope.sessionId
        ),
      );

      expect([...sessionIds]).toEqual([second.sessionId]);
    });

    it("answers 400 for an afterSequence that is not a sequence", async () => {
      const response = await server.handle(
        getRequest("/api/events?afterSequence=later"),
      );

      expect(response.status).toBe(400);
    });
  });

  describe("resolveConsoleConfig()", () => {
    it("throws naming both ways to supply a fabric session when neither is given", async () => {
      await expect(resolveConsoleConfig([], {}, "/console")).rejects.toThrow(
        "a fabric session is required",
      );
    });

    it("throws naming the flag for a port that is not a positive integer", async () => {
      await expect(
        resolveConsoleConfig(
          ["--fabric-identity", "k", "--fabric-space", "s", "--port", "0"],
          {},
          "/console",
        ),
      ).rejects.toThrow("--port must be a positive integer");
    });

    it("throws naming the variable for a port the environment set wrongly", async () => {
      await expect(
        resolveConsoleConfig(
          ["--fabric-identity", "k", "--fabric-space", "s"],
          { CF_HARNESS_CONSOLE_PORT: "http" },
          "/console",
        ),
      ).rejects.toThrow("CF_HARNESS_CONSOLE_PORT must be a positive integer");
    });
  });

  describe("POST /api/index/call", () => {
    /** Posts one proxied read at a server that has an index. */
    const call = async (
      indexed: { server: ConsoleServer },
      body: unknown,
    ): Promise<Response> =>
      await indexed.server.handle(
        jsonRequest("/api/index/call", body),
      );

    it("passes a `listEvents` read through with the pattern and limit it named", async () => {
      const indexed = await indexServer([Response.json({ events: [] })]);

      const response = await call(indexed, {
        fn: "listEvents",
        body: { patternId: "ss-2w4nQ8", limit: 5 },
      });

      expect(response.status).toBe(200);
      expect(indexed.requests).toHaveLength(1);
      const sent = `${indexed.requests[0].url} ${indexed.requests[0].body}`;
      expect(sent).toContain("ss-2w4nQ8");
      expect(sent).toContain("5");
    });

    it("passes a `listEvents` read naming neither a pattern nor a limit", async () => {
      const indexed = await indexServer([Response.json({ events: [] })]);

      const response = await call(indexed, { fn: "listEvents" });

      expect(response.status).toBe(200);
      expect(indexed.requests).toHaveLength(1);
    });

    it("answers a host-side failure generically, never with its message", async () => {
      // A factory that cannot build its client throws host-side — an
      // unreadable keyfile names the path the operator configured, which the
      // page must not read.
      const server = new ConsoleServer(
        await config(),
        (onEvent) =>
          new HarnessInteractiveChatService({
            createPromptLoop: answeringLoop,
            now: advancingClock(),
            onEvent,
          }),
        () => Promise.reject(new Error("ENOENT: /Users/operator/.secret.key")),
      );
      const page = await server.handle(getRequest("/"));
      await page.body?.cancel();
      const response = await server.handle(
        jsonRequest("/api/index/call", { fn: "listPatterns" }),
      );
      expect(response.status).toBe(502);
      const body = await response.json();
      expect(body.error).not.toContain(".secret.key");
      expect(body.error).toContain("see its log");
    });

    it("answers an allowlisted read with what the index returned", async () => {
      const listing = {
        patterns: [{
          patternId: "pat-1",
          description: "Totals an expense list",
          hashtags: ["expenses"],
          keywords: [],
          ownerDid: "did:key:zOwner",
          createdAt: "2026-08-01T00:00:00.000Z",
          events: { run_succeeded: 2 },
          score: 2,
        }],
        eventTypes: { run_succeeded: 1 },
      };
      const indexed = await indexServer([Response.json(listing)]);

      const response = await call(indexed, { fn: "listPatterns" });

      expect(response.status).toBe(200);
      expect(await response.json()).toEqual(listing);
      expect(indexed.requests[0].url).toBe(
        "https://index.test/api/listPatterns",
      );
      expect(JSON.parse(indexed.requests[0].body)).toEqual({});
    });

    it("sends only the search fields the page supplied", async () => {
      const indexed = await indexServer([Response.json({ results: [] })]);

      await call(indexed, {
        fn: "searchPatterns",
        body: { tags: ["expenses"], text: "totals", limit: 5, mystery: true },
      });

      expect(indexed.requests[0].url).toBe(
        "https://index.test/api/searchPatterns",
      );
      expect(JSON.parse(indexed.requests[0].body)).toEqual({
        tags: ["expenses"],
        text: "totals",
        limit: 5,
      });
    });

    it("asks for a pattern without its source, whatever the page sent", async () => {
      const indexed = await indexServer([
        Response.json({
          patternId: "pat-1",
          ownerDid: "did:key:zOwner",
          createdAt: "2026-08-01T00:00:00.000Z",
          description: "Totals an expense list",
          hashtags: [],
          dependencies: [],
        }),
      ]);

      await call(indexed, {
        fn: "getPattern",
        body: { patternId: "pat-1", includeSource: true },
      });

      expect(JSON.parse(indexed.requests[0].body)).toEqual({
        patternId: "pat-1",
      });
    });

    it("answers 400 for getPattern with no pattern named", async () => {
      const indexed = await indexServer([]);

      const response = await call(indexed, { fn: "getPattern", body: {} });

      expect(response.status).toBe(400);
      expect((await response.json()).error).toBe("patternId is required");
      expect(indexed.requests).toEqual([]);
    });

    it("answers 400 for a function outside the allowlist", async () => {
      const indexed = await indexServer([]);

      for (
        const fn of [
          "recordEvent",
          "publishPattern",
          "retractPattern",
          "deletePattern",
          7,
        ]
      ) {
        const response = await call(indexed, {
          fn,
          body: { patternId: "pat-1", eventType: "thumbs_up" },
        });
        expect(response.status).toBe(400);
        expect((await response.json()).error).toContain("fn must be one of");
      }
      expect(indexed.requests).toEqual([]);
    });

    it("answers 400 for a body that is not JSON", async () => {
      const indexed = await indexServer([]);

      const response = await indexed.server.handle(
        new Request("http://127.0.0.1:8100/api/index/call", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: "not json",
        }),
      );

      expect(response.status).toBe(400);
      expect(indexed.requests).toEqual([]);
    });

    it("passes through the status the index gave a request it faulted", async () => {
      const indexed = await indexServer([
        Response.json({ error: "unknown pattern" }, { status: 404 }),
      ]);

      const response = await call(indexed, {
        fn: "getPattern",
        body: { patternId: "missing" },
      });

      expect(response.status).toBe(404);
      // The message names the function and the status; the index's own body
      // stays behind, as it does everywhere else a failure is rendered.
      expect((await response.json()).error).toBe(
        "pattern index getPattern failed (404)",
      );
    });

    it("answers 502 when the index itself failed", async () => {
      const indexed = await indexServer([
        Response.json({ error: "datastore unavailable" }, { status: 503 }),
      ]);

      const response = await call(indexed, { fn: "listPatterns" });

      expect(response.status).toBe(502);
      expect((await response.json()).error).toContain("listPatterns");
    });

    it("answers 404 when the server was started without an index", async () => {
      const response = await server.handle(
        jsonRequest("/api/index/call", { fn: "listPatterns" }),
      );

      expect(response.status).toBe(404);
      expect((await response.json()).error).toContain(
        "started without a pattern index",
      );
    });
  });

  describe("POST /api/index/feedback", () => {
    /** Posts one verdict at a server that has an index. */
    const vote = async (
      indexed: { server: ConsoleServer },
      body: unknown,
    ): Promise<Response> =>
      await indexed.server.handle(
        jsonRequest("/api/index/feedback", body),
      );

    it("records an up verdict as a thumbs_up under the server's own identity", async () => {
      const indexed = await indexServer([Response.json({ ok: true })]);

      const response = await vote(indexed, {
        patternId: "ss-2w4nQ8",
        verdict: "up",
        did: "did:key:zImpersonated",
      });

      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({
        patternId: "ss-2w4nQ8",
        eventType: "thumbs_up",
        recordedBy: signer.did(),
      });
      expect(indexed.requests[0].url).toBe(
        "https://index.test/api/recordEvent",
      );
      expect(JSON.parse(indexed.requests[0].body)).toEqual({
        patternId: "ss-2w4nQ8",
        eventType: "thumbs_up",
        did: signer.did(),
      });
    });

    it("records a down verdict as a thumbs_down", async () => {
      const indexed = await indexServer([Response.json({ ok: true })]);

      const response = await vote(indexed, {
        patternId: "ss-2w4nQ8",
        verdict: "down",
      });

      expect(response.status).toBe(200);
      expect((await response.json()).eventType).toBe("thumbs_down");
      expect(JSON.parse(indexed.requests[0].body)).toEqual({
        patternId: "ss-2w4nQ8",
        eventType: "thumbs_down",
        did: signer.did(),
      });
    });

    it("answers 400 for a verdict the index has no event for", async () => {
      const indexed = await indexServer([]);

      // `constructor` is the one that passes an unguarded lookup on the
      // verdict map, so it stands beside the ordinary misspellings.
      for (const verdict of ["sideways", "thumbs_up", "constructor", "", 1]) {
        const response = await vote(indexed, {
          patternId: "ss-2w4nQ8",
          verdict,
        });
        expect(response.status).toBe(400);
        expect((await response.json()).error).toBe(
          'verdict must be "up" or "down"',
        );
      }
      expect(indexed.requests).toEqual([]);
    });

    it("answers 400 for a body that names no pattern", async () => {
      const indexed = await indexServer([]);

      for (const patternId of [undefined, "", 7]) {
        const response = await vote(indexed, { patternId, verdict: "up" });
        expect(response.status).toBe(400);
        expect((await response.json()).error).toBe("patternId is required");
      }
      expect(indexed.requests).toEqual([]);
    });

    it("answers 400 for a body that is not JSON", async () => {
      const indexed = await indexServer([]);

      const response = await indexed.server.handle(
        new Request("http://127.0.0.1:8100/api/index/feedback", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: "not json",
        }),
      );

      expect(response.status).toBe(400);
      expect((await response.json()).error).toBe("request body is not JSON");
      expect(indexed.requests).toEqual([]);
    });

    it("answers 400 for a JSON body that is not an object", async () => {
      const indexed = await indexServer([]);

      const response = await vote(indexed, "ss-2w4nQ8");

      expect(response.status).toBe(400);
      expect((await response.json()).error).toBe("patternId is required");
      expect(indexed.requests).toEqual([]);
    });

    it("answers 503 when the server was started without an index", async () => {
      const response = await server.handle(
        jsonRequest("/api/index/feedback", {
          patternId: "ss-2w4nQ8",
          verdict: "up",
        }),
      );

      expect(response.status).toBe(503);
      expect((await response.json()).error).toContain(
        "started without a pattern index",
      );
    });

    it("answers 502 when the index took the request and did not record it", async () => {
      const indexed = await indexServer([Response.json({ ok: false })]);

      const response = await vote(indexed, {
        patternId: "ss-2w4nQ8",
        verdict: "up",
      });

      expect(response.status).toBe(502);
      expect((await response.json()).error).toContain("thumbs_up");
    });

    it("passes through the status the index gave a request it faulted", async () => {
      const indexed = await indexServer([
        Response.json({ error: "unknown pattern" }, { status: 404 }),
      ]);

      const response = await vote(indexed, {
        patternId: "missing",
        verdict: "up",
      });

      expect(response.status).toBe(404);
      expect((await response.json()).error).toBe(
        "pattern index recordEvent failed (404)",
      );
    });
  });

  describe("POST /api/index/retract", () => {
    const request = {
      patternId: "A".repeat(43),
      successorPatternId: "B".repeat(43),
      reason: "Superseded by the corrected reader",
    };

    for (const changed of [true, false]) {
      it(`returns the index receipt with changed=${changed} for the publication id read from an artifact`, async () => {
        const root = await Deno.makeTempDir();
        try {
          const outputRoot = join(root, "run-1.subagent.1", "tool-outputs");
          await Deno.mkdir(outputRoot, { recursive: true });
          await Deno.writeTextFile(
            join(outputRoot, "publication.json"),
            JSON.stringify({
              status: "ok",
              pieceId: CELL_ID,
              patternPublication: {
                status: "queued",
                reason: "recorded-automatically",
                patternId: request.patternId,
              },
            }),
          );
          const receipt = {
            patternId: request.patternId,
            status: "retracted",
            successorPatternId: request.successorPatternId,
            retractionReason: request.reason,
            retractedBy: signer.did(),
            retractedAt: "2026-09-21T00:00:00.000Z",
            discoverable: false,
            changed,
          };
          const indexed = await indexServer([Response.json(receipt)], root);
          const artifact = await indexed.server.handle(getRequest(
            "/api/runs/run-1.subagent.1/tool-outputs/publication.json",
          ));
          expect(artifact.status).toBe(200);
          const publication = (await artifact.json()).patternPublication;
          const response = await indexed.server.handle(
            jsonRequest("/api/index/retract", {
              ...request,
              patternId: publication.patternId,
              ownerDid: "did:key:zOther",
              retractedBy: "did:key:zOther",
              admin: true,
              includeSource: true,
            }),
          );
          expect(response.status).toBe(200);
          expect(await response.json()).toEqual(receipt);
          expect(indexed.requests).toEqual([{
            url: "https://index.test/api/retractPattern",
            body: JSON.stringify(request),
          }]);
        } finally {
          await Deno.remove(root, { recursive: true });
        }
      });
    }

    for (const field of ["patternId", "successorPatternId", "reason"]) {
      it(`returns 400 without contacting the index for an invalid ${field}`, async () => {
        const indexed = await indexServer([]);
        for (const value of [undefined, null, 7, "", "   "]) {
          const response = await indexed.server.handle(
            jsonRequest("/api/index/retract", { ...request, [field]: value }),
          );
          expect(response.status).toBe(400);
          const { error } = await response.json();
          expect(error).toContain(`${field} is required`);
          if (field === "successorPatternId") {
            expect(error).toContain("same-owner direct successor");
            expect(error).toContain("standalone deletion is not supported");
          }
        }
        expect(indexed.requests).toEqual([]);
      });
    }

    it("returns 400 for malformed JSON or a non-object body without contacting the index", async () => {
      const indexed = await indexServer([]);
      for (const body of ["not JSON", "null", "[]", '"pattern"']) {
        const response = await indexed.server.handle(
          new Request("http://127.0.0.1:8100/api/index/retract", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body,
          }),
        );
        expect(response.status).toBe(400);
      }
      expect(indexed.requests).toEqual([]);
    });

    it("returns 503 when the console has no index", async () => {
      const response = await server.handle(
        jsonRequest("/api/index/retract", request),
      );
      expect(response.status).toBe(503);
      expect((await response.json()).error).toContain(
        "without a pattern index",
      );
    });

    for (const status of [400, 403, 404, 409, 500]) {
      it(`preserves the index refusal at ${status} without exposing its body`, async () => {
        const indexed = await indexServer([
          Response.json({ error: "private index detail" }, { status }),
        ]);
        const response = await indexed.server.handle(
          jsonRequest("/api/index/retract", request),
        );
        expect(response.status).toBe(status === 500 ? 502 : status);
        expect(await response.json()).toEqual({
          error: `pattern index retractPattern failed (${status})`,
        });
        expect(indexed.requests).toHaveLength(1);
      });
    }

    it("returns a generic 502 for a host-side failure", async () => {
      const unavailable = new ConsoleServer(
        await configWithIndex(),
        (onEvent) =>
          new HarnessInteractiveChatService({
            createPromptLoop: answeringLoop,
            now: advancingClock(),
            onEvent,
          }),
        () => Promise.reject(new Error("private identity path")),
      );
      const response = await unavailable.handle(
        jsonRequest("/api/index/retract", request),
      );
      expect(response.status).toBe(502);
      expect(await response.json()).toEqual({
        error: "the index request failed on this server; see its log",
      });
    });

    it("refuses a foreign Host before contacting the index", async () => {
      const indexed = await indexServer([]);
      const response = await indexed.server.handle(
        jsonRequest("/api/index/retract", request, { host: "foreign.test" }),
      );
      expect(response.status).toBe(403);
      expect(indexed.requests).toEqual([]);
    });
  });

  describe("the served page", () => {
    it("confines the page to this origin with a content security policy", async () => {
      const response = await server.handle(getRequest("/"));
      await response.body?.cancel();

      const policy = response.headers.get("content-security-policy") ?? "";
      expect(policy).toContain("default-src 'self'");
      expect(policy).toContain("object-src 'none'");
      expect(policy).toContain("frame-ancestors 'none'");
      // The run tree indents a row with a `style` attribute, which a policy
      // without this would refuse; a script has no such exception.
      expect(policy).toContain("style-src 'self' 'unsafe-inline'");
      expect(policy).not.toContain("script-src");
      expect(policy).not.toContain("default-src 'self' 'unsafe-inline'");
    });

    it("carries that policy on every path served from the built page", async () => {
      const response = await server.handle(getRequest("/scripts/index.js"));
      await response.body?.cancel();

      expect(response.headers.get("content-security-policy")).toContain(
        "default-src 'self'",
      );
    });

    it("does not answer an API route with a page policy", async () => {
      const response = await server.handle(
        getRequest("/api/sessions"),
      );
      await response.json();

      expect(response.headers.get("content-security-policy")).toBeNull();
    });
  });

  describe("the live pane", () => {
    it("confines the live pane with the page's content security policy", async () => {
      const response = await server.handle(getRequest("/live/session-1"));
      await response.body?.cancel();

      const policy = response.headers.get("content-security-policy") ?? "";
      expect(policy).toContain("default-src 'self'");
      // The pane is opened at the top level of its own view, never framed.
      expect(policy).toContain("frame-ancestors 'none'");
    });

    it("answers 403 for a live pane request naming another host", async () => {
      const response = await server.handle(
        getRequest("/live/session-1", { host: "evil.test:8100" }),
      );
      await response.body?.cancel();

      expect(response.status).toBe(403);
    });

    it("answers 404 without a token for a path below the session segment", async () => {
      const response = await server.handle(
        getRequest("/live/session-1/turn-1"),
      );
      await response.body?.cancel();

      expect(response.status).toBe(404);
    });

    it("sends the trailing-slash live address to its canonical form, relatively", async () => {
      // The pane's stylesheet and script are `../styles/...` and
      // `../scripts/...`; from `/live/session-1/` they would resolve one level
      // too deep. The Location is relative so it lands under whatever prefix
      // a host fronts the console at, with no rewriting on the host's side.
      const response = await server.handle(getRequest("/live/session-1/"));
      await response.body?.cancel();

      expect(response.status).toBe(308);
      expect(response.headers.get("location")).toBe("../session-1");
    });

    it("keeps the turn and pieces base a trailing-slash live address carries", async () => {
      // `?turn=` narrows the pane and `?piecesBase=` says where a piece
      // renders; a redirect that dropped them would open the pane on the
      // wrong thing.
      const response = await server.handle(getRequest(
        "/live/session-1/?turn=turn-1&piecesBase=http%3A%2F%2Fh%2Fpattern-pane",
      ));
      await response.body?.cancel();

      expect(response.status).toBe(308);
      expect(response.headers.get("location")).toBe(
        "../session-1?turn=turn-1&piecesBase=http%3A%2F%2Fh%2Fpattern-pane",
      );
    });

    it("still refuses the trailing-slash live address naming another host", async () => {
      const response = await server.handle(
        getRequest("/live/session-1/", { host: "evil.test:8100" }),
      );
      await response.body?.cancel();

      expect(response.status).toBe(403);
    });
  });

  describe("the host gate", () => {
    it("answers an API request carrying no cookie", async () => {
      const response = await server.handle(getRequest("/api/sessions"));

      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ sessions: [] });
    });

    it("answers an API request from any other origin", async () => {
      const response = await server.handle(
        getRequest("/api/sessions", { origin: "http://elsewhere.test" }),
      );

      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ sessions: [] });
    });

    it("starts a turn from a request carrying neither cookie nor origin", async () => {
      const response = await server.handle(
        jsonRequest("/api/task", { text: "track my books" }),
      );

      expect(response.status).toBe(200);
      const started = await response.json();
      await server.service.waitForTurn(started.sessionId, started.turnId);
      expect((await listSessions()).sessions).toHaveLength(1);
    });

    it("hands the page no cookie", async () => {
      const response = await server.handle(getRequest("/"));
      await response.body?.cancel();

      expect(response.headers.get("set-cookie")).toBeNull();
    });

    it("answers 403 for a page request naming another host", async () => {
      const response = await server.handle(
        getRequest("/", { host: "evil.test:8100" }),
      );
      await response.body?.cancel();

      expect(response.status).toBe(403);
    });

    it("answers 403 for an API request naming another host", async () => {
      const response = await server.handle(
        getRequest("/api/sessions", { host: "evil.test:8100" }),
      );

      expect(response.status).toBe(403);
    });

    it("answers 415 for a task posted as a form submission", async () => {
      const response = await server.handle(
        new Request("http://127.0.0.1:8100/api/task", {
          method: "POST",
          headers: { "content-type": "text/plain;charset=UTF-8" },
          body: JSON.stringify({ text: "track my books" }),
        }),
      );

      expect(response.status).toBe(415);
    });
  });
});

interface StreamedEnvelope {
  sessionId: string;
  sequence: number;
  event: { kind: string; result?: unknown };
}

/**
 * The envelopes a stream writes up to and including the one of `finalKind`.
 * The reader resolves on each chunk the server enqueues, so the read ends when
 * the replay reaches that event rather than after any span of time.
 */
const envelopesUntil = async (
  response: Response,
  finalKind: string,
): Promise<readonly StreamedEnvelope[]> => {
  const reader = response.body!.pipeThrough(new TextDecoderStream())
    .getReader();
  const envelopes: StreamedEnvelope[] = [];
  let buffered = "";
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) {
        return envelopes;
      }
      buffered += chunk.value;
      const frames = buffered.split("\n\n");
      buffered = frames.pop() ?? "";
      for (const frame of frames) {
        const data = frame.split("\n").find((line) =>
          line.startsWith("data: ")
        );
        if (data === undefined || !frame.startsWith("event: chat")) {
          continue;
        }
        const envelope: StreamedEnvelope = JSON.parse(data.slice(6));
        envelopes.push(envelope);
        if (envelope.event.kind === finalKind) {
          return envelopes;
        }
      }
    }
  } finally {
    await reader.cancel();
  }
};

const kindsUntil = async (
  response: Response,
  finalKind: string,
): Promise<readonly string[]> =>
  (await envelopesUntil(response, finalKind)).map((envelope) =>
    envelope.event.kind
  );
