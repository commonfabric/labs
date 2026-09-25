import {
  assertEquals,
  assertRejects,
  assertStringIncludes,
} from "@std/assert";
import { fromFileUrl, join } from "@std/path";
import { readHarnessRunArtifacts } from "../src/artifacts.ts";
import { InMemoryHarnessCredentialStore } from "../src/auth/credential-store.ts";
import type { HarnessProviderSettingsState } from "../src/auth/provider-settings.ts";
import type { HarnessModelProviderId } from "../src/config.ts";
import {
  HARNESS_CHAT_PROTOCOL_VERSION,
  HARNESS_CHAT_REQUEST_TYPE,
  type HarnessChatEventEnvelope,
  type HarnessChatResponse,
} from "../src/contracts/interactive-chat.ts";
import {
  createLoomLocalCfHarnessHost,
  runLoomLocalInteractiveFailureStdio,
} from "../src/loom-local-host.ts";
import {
  runHarnessInteractiveChatStdio,
  type RunHarnessInteractiveChatStdioOptions,
} from "../src/interactive-chat-stdio.ts";
import {
  CFC_INVOCATION_CONTEXT_DIR_ENV,
  CFC_RESULT_DIR_ENV,
} from "../src/sandbox/docker-runsc.ts";

type InteractiveEnvelope = HarnessChatEventEnvelope | HarnessChatResponse;

const providerStore = (state: HarnessProviderSettingsState) => ({
  inspect: () => Promise.resolve(state),
});

const configured = (provider: HarnessModelProviderId) =>
  providerStore({
    state: "configured",
    settings: { version: 1, modelProvider: provider },
  });

const encodeInput = (lines: readonly string[]): ReadableStream<Uint8Array> => {
  const encoder = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      for (const line of lines) controller.enqueue(encoder.encode(`${line}\n`));
      controller.close();
    },
  });
};

const captureOutput = (): {
  output: WritableStream<Uint8Array>;
  envelopes: () => InteractiveEnvelope[];
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
    envelopes: () =>
      text.split("\n").filter((line) => line.trim() !== "").map((line) =>
        JSON.parse(line) as InteractiveEnvelope
      ),
  };
};

const statusRequest = (requestId: string): string =>
  JSON.stringify({
    type: HARNESS_CHAT_REQUEST_TYPE,
    protocolVersion: HARNESS_CHAT_PROTOCOL_VERSION,
    requestId,
    method: "status",
    params: {},
  });

const turnRequests = (workspace: string, artifactRoot?: string): string[] => [
  JSON.stringify({
    type: HARNESS_CHAT_REQUEST_TYPE,
    protocolVersion: HARNESS_CHAT_PROTOCOL_VERSION,
    requestId: "start-session",
    method: "start_session",
    params: {
      sessionId: "session-1",
      workspace: { hostPath: workspace },
      model: "gpt-5.6-terra",
      ...(artifactRoot !== undefined ? { artifactRoot } : {}),
      policy: {
        type: "cf-harness.chat-policy",
        toolMode: "workspace-write",
        allowedToolIds: [],
        allowedSubagentProfiles: [],
      },
    },
  }),
  JSON.stringify({
    type: HARNESS_CHAT_REQUEST_TYPE,
    protocolVersion: HARNESS_CHAT_PROTOCOL_VERSION,
    requestId: "start-turn",
    method: "start_turn",
    params: {
      sessionId: "session-1",
      turnId: "turn-1",
      input: { text: "hello" },
    },
  }),
];

/**
 * The two sidecar directories a runsc sandbox exchanges CFC invocation
 * contexts and CFC results through. A run that mediates observations refuses
 * to start unless both are named.
 */
const makeCfcTransportDirs = async (): Promise<{
  cfcInvocationContextDir: string;
  cfcResultDir: string;
}> => {
  const root = await Deno.makeTempDir();
  const cfcInvocationContextDir = join(root, "cfc-invocation-context");
  const cfcResultDir = join(root, "cfc-result");
  await Deno.mkdir(cfcInvocationContextDir);
  await Deno.mkdir(cfcResultDir);
  return { cfcInvocationContextDir, cfcResultDir };
};

/** Names those directories on the options an interactive stdio run carries. */
const withCfcTransport = async (
  options: RunHarnessInteractiveChatStdioOptions,
): Promise<RunHarnessInteractiveChatStdioOptions> => ({
  ...options,
  basePromptLoopOptions: {
    ...options.basePromptLoopOptions,
    ...(await makeCfcTransportDirs()),
  },
});

/** Names those directories in the environment a batch run reads them from. */
const cfcTransportEnv = async (): Promise<Record<string, string>> => {
  const dirs = await makeCfcTransportDirs();
  return {
    [CFC_INVOCATION_CONTEXT_DIR_ENV]: dirs.cfcInvocationContextDir,
    [CFC_RESULT_DIR_ENV]: dirs.cfcResultDir,
  };
};

const protocolRunner = (
  lines: readonly string[],
  capture: ReturnType<typeof captureOutput>,
) =>
async (options: RunHarnessInteractiveChatStdioOptions): Promise<void> =>
  await runHarnessInteractiveChatStdio({
    ...(await withCfcTransport(options)),
    input: encodeInput(lines),
    output: capture.output,
  });

const completedTurn = (envelopes: readonly InteractiveEnvelope[]): boolean =>
  envelopes.some((envelope) =>
    "event" in envelope && envelope.event.kind === "turn_completed"
  );

const codexCompletion = (): Response =>
  new Response(
    `data: ${
      JSON.stringify({
        type: "response.completed",
        response: {
          id: "resp_interactive",
          status: "completed",
          output: [{
            type: "message",
            id: "msg_interactive",
            role: "assistant",
            content: [{ type: "output_text", text: "codex interactive" }],
          }],
        },
      })
    }\n\n`,
    { status: 200, headers: { "content-type": "text/event-stream" } },
  );

const gatewayCompletion = (): Response =>
  new Response(
    JSON.stringify({
      id: "resp_gateway_interactive",
      object: "response",
      status: "completed",
      output: [{
        type: "message",
        id: "msg_gateway_interactive",
        role: "assistant",
        status: "completed",
        content: [{
          type: "output_text",
          text: "gateway interactive",
          annotations: [],
        }],
      }],
    }),
    { status: 200, headers: { "content-type": "application/json" } },
  );

const onlyRunRoot = async (artifactRoot: string): Promise<string> => {
  const entries: string[] = [];
  for await (const entry of Deno.readDir(artifactRoot)) {
    if (entry.isDirectory) entries.push(entry.name);
  }
  assertEquals(entries.length, 1);
  return join(artifactRoot, entries[0]);
};

Deno.test("local Loom interactive stdio sends Codex traffic without gateway fallback", async () => {
  const home = await Deno.makeTempDir();
  const workspace = await Deno.makeTempDir();
  const credentials = new InMemoryHarnessCredentialStore();
  await credentials.set("local", "openai-codex", {
    type: "oauth",
    providerId: "openai-codex",
    accessToken: "access-secret",
    refreshToken: "refresh-secret",
    expiresAt: Date.now() + 60 * 60_000,
    accountId: "account-secret",
  });
  let codexRequests = 0;
  let gatewayRequests = 0;
  const capture = captureOutput();
  const host = await createLoomLocalCfHarnessHost({
    harnessHome: home,
    env: {
      CF_HARNESS_GATEWAY_BASE_URL: "https://gateway.invalid/",
      CF_HARNESS_GATEWAY_AUTH_MODE: "none",
      CF_HARNESS_API_KEY: "gateway-secret",
    },
    credentialStore: credentials,
    providerSettingsStore: configured("openai-codex"),
    fetchFn: (input) => {
      if (String(input).includes("chatgpt.com/backend-api/codex/responses")) {
        codexRequests += 1;
        return Promise.resolve(codexCompletion());
      }
      gatewayRequests += 1;
      return Promise.reject(new Error("unexpected gateway request"));
    },
    interactiveStdioRunner: protocolRunner(turnRequests(workspace), capture),
  });

  await host.runInteractive([]);

  assertEquals(codexRequests, 1);
  assertEquals(gatewayRequests, 0);
  assertEquals(completedTurn(capture.envelopes()), true);
});

Deno.test("local Loom interactive stdio reports credential loss after preflight before traffic", async () => {
  const home = await Deno.makeTempDir();
  const workspace = await Deno.makeTempDir();
  const credentials = new InMemoryHarnessCredentialStore();
  await credentials.set("local", "openai-codex", {
    type: "oauth",
    providerId: "openai-codex",
    accessToken: "access-secret",
    refreshToken: "refresh-secret",
    expiresAt: Date.now() + 60 * 60_000,
    accountId: "account-secret",
  });
  let providerRequests = 0;
  const capture = captureOutput();
  const host = await createLoomLocalCfHarnessHost({
    harnessHome: home,
    env: {},
    credentialStore: credentials,
    providerSettingsStore: configured("openai-codex"),
    fetchFn: () => {
      providerRequests += 1;
      return Promise.reject(new Error("must not request"));
    },
    interactiveStdioRunner: async (options) => {
      await credentials.delete("local", "openai-codex");
      await runHarnessInteractiveChatStdio({
        ...(await withCfcTransport(options)),
        input: encodeInput(turnRequests(workspace)),
        output: capture.output,
      });
    },
  });

  await host.runInteractive([]);

  const errors = capture.envelopes().flatMap((envelope) =>
    "event" in envelope && envelope.event.kind === "turn_failed"
      ? [envelope.event.error]
      : []
  );
  assertEquals(errors, [{
    code: "provider-auth-required",
    message: "OpenAI Codex is not connected for this credential owner",
  }]);
  assertEquals(providerRequests, 0);
});

Deno.test("local Loom interactive artifacts bind their selected model and resume for both providers", async () => {
  for (
    const provider of [
      "openai-compatible-gateway",
      "openai-codex",
    ] as const
  ) {
    const home = await Deno.makeTempDir();
    const workspace = await Deno.makeTempDir();
    const artifactRoot = await Deno.makeTempDir();
    const credentials = new InMemoryHarnessCredentialStore();
    if (provider === "openai-codex") {
      await credentials.set("local", "openai-codex", {
        type: "oauth",
        providerId: "openai-codex",
        accessToken: "access-secret",
        refreshToken: "refresh-secret",
        expiresAt: Date.now() + 60 * 60_000,
        accountId: "account-secret",
      });
    }
    let providerRequests = 0;
    let wrongProviderRequests = 0;
    const fetchFn = (input: Request | URL | string): Promise<Response> => {
      const isCodex = String(input).includes(
        "chatgpt.com/backend-api/codex/responses",
      );
      if (isCodex !== (provider === "openai-codex")) {
        wrongProviderRequests += 1;
        return Promise.reject(new Error("unexpected provider route"));
      }
      providerRequests += 1;
      return Promise.resolve(
        provider === "openai-codex" ? codexCompletion() : gatewayCompletion(),
      );
    };
    const env = {
      ...(await cfcTransportEnv()),
      ...(provider === "openai-codex"
        ? {
          CF_HARNESS_GATEWAY_BASE_URL: "https://must-not-be-used.invalid/",
          CF_HARNESS_GATEWAY_AUTH_MODE: "none",
        }
        : {
          CF_HARNESS_GATEWAY_BASE_URL: "https://gateway.example/",
          CF_HARNESS_GATEWAY_AUTH_MODE: "none",
        }),
    };
    const capture = captureOutput();
    const host = await createLoomLocalCfHarnessHost({
      harnessHome: home,
      env,
      credentialStore: credentials,
      providerSettingsStore: configured(provider),
      fetchFn,
      interactiveStdioRunner: protocolRunner(
        turnRequests(workspace, artifactRoot),
        capture,
      ),
    });

    await host.runInteractive([]);
    assertEquals(completedTurn(capture.envelopes()), true, provider);
    const runRoot = await onlyRunRoot(artifactRoot);
    const artifacts = await readHarnessRunArtifacts(runRoot);
    const persistedManifest = JSON.parse(
      await Deno.readTextFile(join(runRoot, "run-manifest.json")),
    );
    assertEquals(artifacts.runState.model, "gpt-5.6-terra", provider);
    assertEquals(
      artifacts.runState.runManifest?.model,
      "gpt-5.6-terra",
      provider,
    );
    assertEquals(persistedManifest.model, "gpt-5.6-terra", provider);
    assertEquals(artifacts.runState.modelProvider, provider, provider);
    assertEquals(
      artifacts.runState.runManifest?.modelProvider,
      provider,
      provider,
    );

    const resumeStdout: string[] = [];
    const resumeStderr: string[] = [];
    const resumeHost = await createLoomLocalCfHarnessHost({
      harnessHome: home,
      env,
      credentialStore: credentials,
      providerSettingsStore: configured(provider),
      fetchFn,
      cliDependencies: {
        cwd: workspace,
        io: {
          stdout: (text) => resumeStdout.push(text),
          stderr: (text) => resumeStderr.push(text),
        },
      },
    });
    assertEquals(
      await resumeHost.runBatch([
        "--resume-run",
        runRoot,
        "--output-mode",
        "batch",
      ]),
      0,
      provider,
    );
    assertEquals(providerRequests, 2, provider);
    assertEquals(wrongProviderRequests, 0, provider);
    assertEquals(resumeStdout.length, 1, provider);
    assertEquals(resumeStderr, [], provider);
  }
});

Deno.test("local Loom interactive stdio sends gateway traffic without credential reads", async () => {
  const home = await Deno.makeTempDir();
  const workspace = await Deno.makeTempDir();
  const credentials = new InMemoryHarnessCredentialStore();
  const originalGetRecord = credentials.getRecord.bind(credentials);
  let credentialReads = 0;
  credentials.getRecord = (...args) => {
    credentialReads += 1;
    return originalGetRecord(...args);
  };
  let gatewayRequests = 0;
  let codexRequests = 0;
  const capture = captureOutput();
  const host = await createLoomLocalCfHarnessHost({
    harnessHome: home,
    env: {
      CF_HARNESS_GATEWAY_BASE_URL: "https://gateway.example/",
      CF_HARNESS_GATEWAY_AUTH_MODE: "none",
    },
    credentialStore: credentials,
    providerSettingsStore: configured("openai-compatible-gateway"),
    fetchFn: (input) => {
      if (String(input).includes("chatgpt.com")) {
        codexRequests += 1;
        return Promise.reject(new Error("unexpected Codex request"));
      }
      gatewayRequests += 1;
      return Promise.resolve(gatewayCompletion());
    },
    interactiveStdioRunner: protocolRunner(turnRequests(workspace), capture),
  });

  await host.runInteractive([]);

  assertEquals(gatewayRequests, 1);
  assertEquals(codexRequests, 0);
  assertEquals(credentialReads, 0);
  assertEquals(completedTurn(capture.envelopes()), true);
});

Deno.test("local Loom interactive startup blockers use protocol errors before traffic", async () => {
  const reconnectCredentials = new InMemoryHarnessCredentialStore();
  await reconnectCredentials.updateRecord("local", "openai-codex", () => ({
    credential: {
      type: "oauth",
      providerId: "openai-codex",
      accessToken: "expired-secret",
      refreshToken: "revoked-secret",
      expiresAt: 0,
      accountId: "account-secret",
    },
    health: { status: "reconnect-required", reason: "revoked" },
  }));
  const cases: Array<{
    name: string;
    settings: HarnessProviderSettingsState;
    credentials?: InMemoryHarnessCredentialStore;
    code: string;
  }> = [
    {
      name: "missing config",
      settings: { state: "missing" },
      code: "provider-configuration-required",
    },
    {
      name: "invalid config",
      settings: { state: "invalid", detail: "invalid JSON" },
      code: "provider-configuration-required",
    },
    {
      name: "disconnected Codex",
      settings: {
        state: "configured",
        settings: { version: 1, modelProvider: "openai-codex" },
      },
      credentials: new InMemoryHarnessCredentialStore(),
      code: "provider-auth-required",
    },
    {
      name: "reconnect-required Codex",
      settings: {
        state: "configured",
        settings: { version: 1, modelProvider: "openai-codex" },
      },
      credentials: reconnectCredentials,
      code: "provider-auth-required",
    },
  ];

  for (const testCase of cases) {
    const home = await Deno.makeTempDir();
    let requests = 0;
    let runnerCalls = 0;
    const host = await createLoomLocalCfHarnessHost({
      harnessHome: home,
      env: {},
      credentialStore: testCase.credentials,
      providerSettingsStore: providerStore(testCase.settings),
      fetchFn: () => {
        requests += 1;
        return Promise.reject(new Error("must not request"));
      },
      interactiveStdioRunner: () => {
        runnerCalls += 1;
        return Promise.resolve();
      },
    });
    const capture = captureOutput();
    try {
      await host.runInteractive([]);
      throw new Error(`${testCase.name} unexpectedly started`);
    } catch (error) {
      await runLoomLocalInteractiveFailureStdio(error, {
        input: encodeInput([statusRequest(`status-${testCase.name}`)]),
        output: capture.output,
      });
    }
    const response = capture.envelopes()[0];
    assertEquals("ok" in response && response.ok, false, testCase.name);
    assertEquals(
      "ok" in response && !response.ok ? response.error.code : undefined,
      testCase.code,
      testCase.name,
    );
    assertEquals(requests, 0, testCase.name);
    assertEquals(runnerCalls, 0, testCase.name);
  }
});

Deno.test("local Loom interactive entrypoint returns disconnected Codex on stdout protocol", async () => {
  const home = await Deno.makeTempDir();
  await Deno.writeTextFile(
    `${home}/config.json`,
    JSON.stringify({ version: 1, modelProvider: "openai-codex" }),
    { mode: 0o600 },
  );
  const requestId = "entrypoint-disconnected";
  const child = new Deno.Command(Deno.execPath(), {
    args: [
      "run",
      "--quiet",
      "--no-lock",
      "-A",
      fromFileUrl(new URL("../src/loom-local-host-main.ts", import.meta.url)),
      "interactive",
    ],
    env: {
      CF_HARNESS_HOME: home,
      CF_HARNESS_MODEL_PROVIDER: "",
    },
    stdin: "piped",
    stdout: "piped",
    stderr: "piped",
  }).spawn();
  const writer = child.stdin.getWriter();
  await writer.write(new TextEncoder().encode(`${statusRequest(requestId)}\n`));
  await writer.close();
  const result = await child.output();
  const response = JSON.parse(
    new TextDecoder().decode(result.stdout),
  ) as HarnessChatResponse;

  assertEquals(result.code, 1);
  assertEquals(response.requestId, requestId);
  assertEquals(response.ok, false);
  assertEquals(
    response.ok ? undefined : response.error.code,
    "provider-auth-required",
  );
  assertEquals(new TextDecoder().decode(result.stderr), "");
});

Deno.test("local Loom interactive help does not require provider configuration or authentication", async () => {
  const home = await Deno.makeTempDir();
  const result = await new Deno.Command(Deno.execPath(), {
    args: [
      "run",
      "--quiet",
      "--no-lock",
      "-A",
      fromFileUrl(new URL("../src/loom-local-host-main.ts", import.meta.url)),
      "interactive",
      "--help",
    ],
    env: {
      CF_HARNESS_HOME: home,
      CF_HARNESS_MODEL_PROVIDER: "",
    },
    stdout: "piped",
    stderr: "piped",
  }).output();

  const stderr = new TextDecoder().decode(result.stderr);
  assertEquals(result.code, 0);
  assertEquals(new TextDecoder().decode(result.stdout), "");
  assertStringIncludes(stderr, "Usage:");
  assertStringIncludes(stderr, "--chat-session-db");
  assertStringIncludes(stderr, "--chat-max-in-memory-events");
  assertEquals(stderr.includes("provider-configuration-required"), false);
  assertEquals(stderr.includes("provider-auth-required"), false);
});

Deno.test("local Loom interactive host selects the sandbox runtime its environment names", async () => {
  // The batch entrypoint derived the runsc runtime from
  // CF_HARNESS_SANDBOX_RUNTIME and its companions; the interactive host read
  // none of them. Loom's chat lane launched this host with the native
  // environment set and every turn built a docker engine anyway — the same
  // "second entrypoint, no provisioning" defect the host-mount work removed,
  // one layer over. This is the entrypoint Loom runs
  // (`loom-local-host-main.ts interactive`), so the assertion is on what it
  // forwards, not on the parser.
  const home = await Deno.makeTempDir();
  const runWith = async (
    env: Record<string, string>,
  ): Promise<RunHarnessInteractiveChatStdioOptions> => {
    const seen: RunHarnessInteractiveChatStdioOptions[] = [];
    const host = await createLoomLocalCfHarnessHost({
      harnessHome: home,
      env: {
        CF_HARNESS_GATEWAY_BASE_URL: "https://gateway.example/",
        CF_HARNESS_GATEWAY_AUTH_MODE: "none",
        ...env,
      },
      credentialStore: new InMemoryHarnessCredentialStore(),
      providerSettingsStore: configured("openai-compatible-gateway"),
      fetchFn: () => Promise.reject(new Error("must not request")),
      interactiveStdioRunner: (options) => {
        seen.push(options);
        return Promise.resolve();
      },
    });
    await host.runInteractive([]);
    assertEquals(seen.length, 1);
    return seen[0];
  };

  const native = (await runWith({
    CF_HARNESS_SANDBOX_RUNTIME: "runsc",
    CF_HARNESS_SANDBOX_ROOTFS: "/images/kitchensink",
    CF_HARNESS_RUNSC_CFC_POLICY: "/policy.json",
    CF_HARNESS_RUNSC_BINARY: "/opt/runsc",
    CF_HARNESS_DOCKER_NETWORK_MODE: "bridge",
  })).basePromptLoopOptions;
  assertEquals(native?.sandboxRuntimeKind, "runsc");
  assertEquals(native?.sandboxRootfs, "/images/kitchensink");
  assertEquals(native?.sandboxCfcPolicy, "/policy.json");
  assertEquals(native?.sandboxRunscBinary, "/opt/runsc");
  // docker's network vocabulary maps onto runsc's, as it does for a batch run.
  assertEquals(native?.sandboxRunscNetworkMode, "sandbox");

  // Nothing named: the docker runtime, exactly as before.
  const unset = (await runWith({})).basePromptLoopOptions;
  assertEquals(unset?.sandboxRuntimeKind, undefined);
  assertEquals(unset?.sandboxRootfs, undefined);
  assertEquals(unset?.sandboxRunscNetworkMode, undefined);

  // A runtime nobody has is refused up front, not read as docker.
  await assertRejects(
    () => runWith({ CF_HARNESS_SANDBOX_RUNTIME: "podman" }),
    Error,
    "sandbox runtime must be one of docker, runsc",
  );
});
