import { assertEquals, assertRejects, assertStringIncludes } from "@std/assert";
import { fromFileUrl } from "@std/path";
import { InMemoryHarnessCredentialStore } from "../src/auth/credential-store.ts";
import type { HarnessProviderSettingsState } from "../src/auth/provider-settings.ts";
import type { CfHarnessCliIO } from "../src/cli.ts";
import type { HarnessModelProviderId } from "../src/config.ts";
import type { HarnessRunArtifacts } from "../src/artifacts.ts";
import {
  createLoomLocalCfHarnessHost,
  LOOM_LOCAL_AUTH_SOURCE,
  LOOM_LOCAL_CREDENTIAL_OWNER,
  runLoomLocalInteractiveFailureStdio,
} from "../src/loom-local-host.ts";
import { HarnessControlError } from "../src/control-errors.ts";
import type {
  CreateHarnessPromptLoopOptions,
  HarnessPromptLoopResult,
} from "../src/prompt-loop.ts";
import type { RunHarnessInteractiveChatStdioOptions } from "../src/interactive-chat-stdio.ts";

const providerStore = (state: HarnessProviderSettingsState) => ({
  inspect: () => Promise.resolve(state),
});

const configured = (provider: HarnessModelProviderId) =>
  providerStore({
    state: "configured",
    settings: { version: 1, modelProvider: provider },
  });

const ioBuffers = (): {
  io: CfHarnessCliIO;
  stdout: string[];
  stderr: string[];
} => {
  const stdout: string[] = [];
  const stderr: string[] = [];
  return {
    io: {
      stdout: (text) => stdout.push(text),
      stderr: (text) => stderr.push(text),
    },
    stdout,
    stderr,
  };
};

const sseCompletion = (): Response =>
  new Response(
    `data: ${
      JSON.stringify({
        type: "response.completed",
        response: {
          id: "resp_local",
          status: "completed",
          output: [{
            type: "message",
            id: "msg_local",
            role: "assistant",
            content: [{ type: "output_text", text: "local response" }],
          }],
        },
      })
    }\n\n`,
    { status: 200, headers: { "content-type": "text/event-stream" } },
  );

const jwt = (accountId: string): string => {
  const encode = (value: unknown) =>
    btoa(JSON.stringify(value)).replaceAll("+", "-").replaceAll("/", "_")
      .replace(/=+$/, "");
  return `${encode({ alg: "none" })}.${
    encode({
      "https://api.openai.com/auth": { chatgpt_account_id: accountId },
    })
  }.`;
};

const completedResult = (
  options: CreateHarnessPromptLoopOptions,
  text: string,
): HarnessPromptLoopResult => ({
  model: options.model ?? "gpt-5.6-terra",
  finalAssistantText: text,
  transcript: [
    { role: "user", content: "hello" },
    { role: "assistant", content: text },
  ],
  modelTurns: 1,
  runState: options.engine!.getRunState(),
});

const localRunArtifacts = (options: {
  harnessHomeIdentity: string;
  provider?: HarnessModelProviderId;
  authSource?: "api-key" | "none" | typeof LOOM_LOCAL_AUTH_SOURCE;
  model?: string;
  source?: string;
}): HarnessRunArtifacts => {
  const provider = options.provider ?? "openai-compatible-gateway";
  const authSource = options.authSource ??
    (provider === "openai-codex" ? LOOM_LOCAL_AUTH_SOURCE : "none");
  const model = options.model ?? "gpt-5.6-terra";
  return {
    runRoot: "/runs/one",
    runStatePath: "/runs/one/run-state.json",
    runState: {
      runId: "one",
      status: "completed",
      createdAt: "2026-08-13T00:00:00Z",
      updatedAt: "2026-08-13T00:00:01Z",
      cfcEnforcementMode: "disabled",
      currentDir: "/workspace",
      model,
      modelProvider: provider,
      modelAuthSource: authSource,
      credentialOwnerKey: "local",
      credentialOwner: LOOM_LOCAL_CREDENTIAL_OWNER,
      harnessHomeIdentity: options.harnessHomeIdentity,
      runManifest: {
        type: "cf-harness.loom-run-manifest",
        version: 1,
        source: (options.source ?? "loom") as "loom",
        model,
        modelProvider: provider,
        modelAuthSource: authSource,
        credentialOwner: LOOM_LOCAL_CREDENTIAL_OWNER,
        harnessHomeIdentity: options.harnessHomeIdentity,
      },
      policyEvents: [],
      toolOutputs: [],
    },
    transcript: [{ role: "user", content: "resume me" }],
  };
};

Deno.test("local Loom host sends authenticated Codex traffic and never gateway traffic", async () => {
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
  let observed: CreateHarnessPromptLoopOptions | undefined;
  let batchResultJson = "";
  const io = ioBuffers();
  const host = await createLoomLocalCfHarnessHost({
    harnessHome: home,
    env: {
      CF_HARNESS_GATEWAY_BASE_URL: "https://gateway.invalid/",
      CF_HARNESS_GATEWAY_AUTH_MODE: "none",
      CF_HARNESS_API_KEY: "gateway-secret",
      CF_HARNESS_PROMPT_CACHE_MODE: "explicit",
    },
    credentialStore: credentials,
    providerSettingsStore: configured("openai-codex"),
    fetchFn: (input) => {
      if (String(input).includes("chatgpt.com/backend-api/codex/responses")) {
        codexRequests += 1;
        return Promise.resolve(sseCompletion());
      }
      gatewayRequests += 1;
      return Promise.reject(new Error("unexpected gateway request"));
    },
    cliDependencies: {
      cwd: workspace,
      io: io.io,
      writeTextFile: (_path, text) => {
        batchResultJson = text;
        return Promise.resolve();
      },
      createPromptLoop: (options) => {
        observed = options;
        return {
          runPrompt: async () => {
            const response = await options.modelClient!.complete({
              model: options.model ?? "gpt-5.6-terra",
              transcript: [{ role: "user", content: "hello" }],
              tools: [],
              nativeModelToolIds: [],
              runId: options.engine!.getRunState().runId,
            });
            return completedResult(options, response.assistant.content);
          },
          runTranscript: () => Promise.reject(new Error("unexpected resume")),
        };
      },
    },
  });

  assertEquals(
    await host.runBatch([
      "--prompt",
      "hello",
      "--result-json-path",
      "result.json",
    ]),
    0,
  );
  assertEquals(codexRequests, 1);
  assertEquals(gatewayRequests, 0);
  assertEquals(observed?.promptCacheMode, undefined);
  assertEquals(observed?.engine?.getRunState().modelProvider, "openai-codex");
  assertEquals(
    observed?.engine?.getRunState().modelAuthSource,
    LOOM_LOCAL_AUTH_SOURCE,
  );
  assertEquals(
    observed?.engine?.getRunState().credentialOwner,
    LOOM_LOCAL_CREDENTIAL_OWNER,
  );
  assertEquals(
    JSON.stringify(observed?.engine?.getRunState()).includes(home),
    false,
  );
  const batchResult = JSON.parse(batchResultJson);
  assertEquals(batchResult.model_provider, "openai-codex");
  assertEquals(batchResult.model_auth_source, LOOM_LOCAL_AUTH_SOURCE);
  assertEquals(batchResult.credential_owner, LOOM_LOCAL_CREDENTIAL_OWNER);
  assertEquals(io.stderr, []);
});

Deno.test("local Loom host rejects explicit gateway cache options for Codex before traffic", async () => {
  const home = await Deno.makeTempDir();
  let requests = 0;
  const io = ioBuffers();
  const host = await createLoomLocalCfHarnessHost({
    harnessHome: home,
    env: {},
    credentialStore: new InMemoryHarnessCredentialStore(),
    providerSettingsStore: configured("openai-codex"),
    fetchFn: () => {
      requests += 1;
      return Promise.reject(new Error("must not request"));
    },
    cliDependencies: { cwd: home, io: io.io },
  });

  assertEquals(
    await host.runBatch(["--prompt-cache-mode", "explicit", "hello"]),
    1,
  );
  assertEquals(requests, 0);
  assertEquals(JSON.parse(io.stderr.join("")).error.code, "provider-mismatch");
});

Deno.test("local Loom host blocks disconnected Codex before all provider traffic", async () => {
  const home = await Deno.makeTempDir();
  let requests = 0;
  const io = ioBuffers();
  const host = await createLoomLocalCfHarnessHost({
    harnessHome: home,
    env: {},
    credentialStore: new InMemoryHarnessCredentialStore(),
    providerSettingsStore: configured("openai-codex"),
    fetchFn: () => {
      requests += 1;
      return Promise.reject(new Error("must not request"));
    },
    cliDependencies: { cwd: home, io: io.io },
  });

  assertEquals(await host.runBatch(["--prompt", "hello"]), 1);
  assertEquals(requests, 0);
  const failure = JSON.parse(io.stderr.join(""));
  assertEquals(failure.error.code, "provider-auth-required");
  assertEquals(JSON.stringify(failure).includes(home), false);
});

Deno.test("local Loom host blocks reconnect-required Codex before all provider traffic", async () => {
  const home = await Deno.makeTempDir();
  const credentials = new InMemoryHarnessCredentialStore();
  await credentials.updateRecord("local", "openai-codex", () => ({
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
  let requests = 0;
  const io = ioBuffers();
  const host = await createLoomLocalCfHarnessHost({
    harnessHome: home,
    env: {},
    credentialStore: credentials,
    providerSettingsStore: configured("openai-codex"),
    fetchFn: () => {
      requests += 1;
      return Promise.reject(new Error("must not request"));
    },
    cliDependencies: { cwd: home, io: io.io },
  });

  assertEquals(await host.runBatch(["--prompt", "hello"]), 1);
  assertEquals(requests, 0);
  assertEquals(
    JSON.parse(io.stderr.join("")).error.code,
    "provider-auth-required",
  );
});

Deno.test("local Loom host leaves refresh to the resolver immediately before Codex traffic", async () => {
  const home = await Deno.makeTempDir();
  const workspace = await Deno.makeTempDir();
  const credentials = new InMemoryHarnessCredentialStore();
  await credentials.set("local", "openai-codex", {
    type: "oauth",
    providerId: "openai-codex",
    accessToken: "expired-access",
    refreshToken: "refresh-old",
    expiresAt: 0,
    accountId: "account-1",
  });
  let refreshes = 0;
  let codexRequests = 0;
  const io = ioBuffers();
  const host = await createLoomLocalCfHarnessHost({
    harnessHome: home,
    env: {},
    credentialStore: credentials,
    providerSettingsStore: configured("openai-codex"),
    fetchFn: (input) => {
      if (String(input).includes("/oauth/token")) {
        refreshes += 1;
        return Promise.resolve(
          new Response(JSON.stringify({
            access_token: jwt("account-1"),
            refresh_token: "refresh-new",
            expires_in: 3600,
          })),
        );
      }
      codexRequests += 1;
      return Promise.resolve(sseCompletion());
    },
    cliDependencies: {
      cwd: workspace,
      io: io.io,
      createPromptLoop: (options) => ({
        runPrompt: async () => {
          const response = await options.modelClient!.complete({
            model: options.model ?? "gpt-5.6-terra",
            transcript: [{ role: "user", content: "hello" }],
            tools: [],
            nativeModelToolIds: [],
            runId: options.engine!.getRunState().runId,
          });
          return completedResult(options, response.assistant.content);
        },
        runTranscript: () => Promise.reject(new Error("unexpected resume")),
      }),
    },
  });

  assertEquals(refreshes, 0, "preflight must not refresh");
  assertEquals(await host.runBatch(["--prompt", "hello"]), 0);
  assertEquals(refreshes, 1);
  assertEquals(codexRequests, 1);
  assertEquals(
    (await credentials.get("local", "openai-codex"))?.refreshToken,
    "refresh-new",
  );
});

Deno.test("local Loom host requires valid persistent provider configuration", async () => {
  for (
    const state of [
      { state: "missing" } as const,
      { state: "invalid", detail: "bad JSON" } as const,
    ]
  ) {
    const home = await Deno.makeTempDir();
    let requests = 0;
    const io = ioBuffers();
    const host = await createLoomLocalCfHarnessHost({
      harnessHome: home,
      env: {},
      providerSettingsStore: providerStore(state),
      fetchFn: () => {
        requests += 1;
        return Promise.reject(new Error("must not request"));
      },
      cliDependencies: { cwd: home, io: io.io },
    });
    assertEquals(await host.runBatch(["--prompt", "hello"]), 1);
    assertEquals(requests, 0);
    assertEquals(
      JSON.parse(io.stderr.join("")).error.code,
      "provider-configuration-required",
    );
  }
});

Deno.test("local Loom host pins a symlinked home to one real directory", async () => {
  const root = await Deno.makeTempDir();
  const first = `${root}/first`;
  const second = `${root}/second`;
  const alias = `${root}/current`;
  await Deno.mkdir(first, { mode: 0o700 });
  await Deno.mkdir(second, { mode: 0o700 });
  await Deno.writeTextFile(
    `${first}/config.json`,
    JSON.stringify({
      version: 1,
      modelProvider: "openai-compatible-gateway",
    }),
    { mode: 0o600 },
  );
  await Deno.writeTextFile(
    `${second}/config.json`,
    JSON.stringify({ version: 1, modelProvider: "openai-codex" }),
    { mode: 0o600 },
  );
  await Deno.symlink(first, alias);
  const io = ioBuffers();
  let observedProvider: HarnessModelProviderId | undefined;
  const aliasedHost = await createLoomLocalCfHarnessHost({
    harnessHome: alias,
    env: { CF_HARNESS_GATEWAY_AUTH_MODE: "none" },
    cliDependencies: {
      cwd: root,
      io: io.io,
      createPromptLoop: (options) => ({
        runPrompt: () => {
          observedProvider = options.modelProvider;
          return Promise.resolve(completedResult(options, "pinned"));
        },
        runTranscript: () => Promise.reject(new Error("unexpected resume")),
      }),
    },
  });
  const directHost = await createLoomLocalCfHarnessHost({
    harnessHome: first,
    env: { CF_HARNESS_GATEWAY_AUTH_MODE: "none" },
  });
  assertEquals(
    aliasedHost.harnessHomeIdentity,
    directHost.harnessHomeIdentity,
  );

  await Deno.remove(alias);
  await Deno.symlink(second, alias);
  assertEquals(await aliasedHost.runBatch(["--prompt", "hello"]), 0);
  assertEquals(observedProvider, "openai-compatible-gateway");
  assertEquals(io.stderr, []);
});

Deno.test("local Loom host sends explicit gateway traffic only for persisted gateway", async () => {
  const home = await Deno.makeTempDir();
  let gatewayRequests = 0;
  let credentialReads = 0;
  const credentials = new InMemoryHarnessCredentialStore();
  const originalGetRecord = credentials.getRecord.bind(credentials);
  credentials.getRecord = (...args) => {
    credentialReads += 1;
    return originalGetRecord(...args);
  };
  const io = ioBuffers();
  const host = await createLoomLocalCfHarnessHost({
    harnessHome: home,
    env: {
      CF_HARNESS_GATEWAY_BASE_URL: "https://gateway.example/",
      CF_HARNESS_API_KEY: "gateway-secret",
      CF_HARNESS_PROMPT_CACHE_MODE: "explicit",
    },
    credentialStore: credentials,
    providerSettingsStore: configured("openai-compatible-gateway"),
    fetchFn: (input) => {
      assertStringIncludes(String(input), "gateway.example");
      gatewayRequests += 1;
      return Promise.resolve(new Response("{}"));
    },
    cliDependencies: {
      cwd: home,
      io: io.io,
      createPromptLoop: (options) => ({
        runPrompt: async () => {
          assertEquals(options.promptCacheMode, "explicit");
          assertEquals(options.gatewayAuthMode, "bearer");
          assertEquals(options.apiKey, "gateway-secret");
          await options.fetchFn!(options.gatewayBaseUrl!);
          return completedResult(options, "gateway response");
        },
        runTranscript: () => Promise.reject(new Error("unexpected resume")),
      }),
    },
  });

  assertEquals(
    await host.runBatch([
      "--model-provider=openai-compatible-gateway",
      "--prompt",
      "hello",
    ]),
    0,
  );
  assertEquals(gatewayRequests, 1);
  assertEquals(credentialReads, 0);
  assertEquals(io.stderr, []);
});

Deno.test("local Loom interactive host uses the same fixed Codex binding", async () => {
  const home = await Deno.makeTempDir();
  const credentials = new InMemoryHarnessCredentialStore();
  await credentials.set("local", "openai-codex", {
    type: "oauth",
    providerId: "openai-codex",
    accessToken: "access-secret",
    refreshToken: "refresh-secret",
    expiresAt: Date.now() + 60 * 60_000,
    accountId: "account-secret",
  });
  let observed: RunHarnessInteractiveChatStdioOptions | undefined;
  const host = await createLoomLocalCfHarnessHost({
    harnessHome: home,
    env: {
      CF_HARNESS_GATEWAY_BASE_URL: "https://must-not-be-used.invalid/",
      CF_HARNESS_GATEWAY_AUTH_MODE: "none",
      CF_HARNESS_CHAT_ARTIFACT_ROOT: home + "/private-runs",
    },
    credentialStore: credentials,
    providerSettingsStore: configured("openai-codex"),
    interactiveStdioRunner: (options) => {
      observed = options;
      return Promise.resolve();
    },
  });

  await host.runInteractive([]);
  assertEquals(observed?.basePromptLoopOptions?.finalizeOnTurnLimit, true);
  assertEquals(
    observed?.basePromptLoopOptions?.artifactRoot,
    home + "/private-runs",
  );
  assertEquals(observed?.basePromptLoopOptions?.modelProvider, "openai-codex");
  assertEquals(
    observed?.basePromptLoopOptions?.modelAuthSource,
    LOOM_LOCAL_AUTH_SOURCE,
  );
  assertEquals(observed?.credentialOwner, LOOM_LOCAL_CREDENTIAL_OWNER);
  assertEquals(
    observed?.basePromptLoopOptions?.runManifest?.harnessHomeIdentity,
    host.harnessHomeIdentity,
  );
  assertEquals(
    "gatewayBaseUrl" in (observed?.basePromptLoopOptions ?? {}),
    false,
  );
});

Deno.test("local Loom host rejects resume binding switches before provider traffic", async () => {
  const home = await Deno.makeTempDir();
  let requests = 0;
  const io = ioBuffers();
  const identityHost = await createLoomLocalCfHarnessHost({
    harnessHome: home,
    env: {},
    providerSettingsStore: configured("openai-codex"),
    credentialStore: new InMemoryHarnessCredentialStore(),
    cliDependencies: { cwd: home, io: io.io },
  });
  const host = await createLoomLocalCfHarnessHost({
    harnessHome: home,
    env: {},
    providerSettingsStore: configured("openai-compatible-gateway"),
    readRunArtifacts: () =>
      Promise.resolve({
        runRoot: "/runs/one",
        runStatePath: "/runs/one/run-state.json",
        runState: {
          runId: "one",
          status: "completed",
          createdAt: "2026-08-13T00:00:00Z",
          updatedAt: "2026-08-13T00:00:01Z",
          cfcEnforcementMode: "disabled",
          currentDir: "/workspace",
          model: "gpt-5.6-terra",
          modelProvider: "openai-codex",
          modelAuthSource: LOOM_LOCAL_AUTH_SOURCE,
          credentialOwnerKey: "local",
          credentialOwner: LOOM_LOCAL_CREDENTIAL_OWNER,
          harnessHomeIdentity: identityHost.harnessHomeIdentity,
          runManifest: {
            type: "cf-harness.loom-run-manifest",
            version: 1,
            source: "loom",
            model: "gpt-5.6-terra",
            modelProvider: "openai-codex",
            modelAuthSource: LOOM_LOCAL_AUTH_SOURCE,
            credentialOwner: LOOM_LOCAL_CREDENTIAL_OWNER,
            harnessHomeIdentity: identityHost.harnessHomeIdentity,
          },
          policyEvents: [],
          toolOutputs: [],
        },
      }),
    fetchFn: () => {
      requests += 1;
      return Promise.reject(new Error("must not request"));
    },
    cliDependencies: { cwd: home, io: io.io },
  });

  assertEquals(
    await host.runBatch([
      "--resume-run",
      "run-one",
      "--model-provider",
      "openai-compatible-gateway",
    ]),
    1,
  );
  assertEquals(requests, 0);
  assertEquals(JSON.parse(io.stderr.join("")).error.code, "provider-mismatch");
});

Deno.test("local Loom host resumes one exact artifact snapshot with its recorded gateway auth", async () => {
  const home = await Deno.makeTempDir();
  const workspace = await Deno.makeTempDir();
  const identityHost = await createLoomLocalCfHarnessHost({
    harnessHome: home,
    env: {},
    providerSettingsStore: configured("openai-compatible-gateway"),
  });
  const artifacts = localRunArtifacts({
    harnessHomeIdentity: identityHost.harnessHomeIdentity,
    authSource: "none",
  });
  let artifactReads = 0;
  let providerRequests = 0;
  let observed: CreateHarnessPromptLoopOptions | undefined;
  let observedTranscript: unknown;
  const io = ioBuffers();
  const host = await createLoomLocalCfHarnessHost({
    harnessHome: home,
    env: {
      CF_HARNESS_GATEWAY_BASE_URL: "https://gateway.example/",
      CF_HARNESS_GATEWAY_AUTH_MODE: "bearer",
    },
    providerSettingsStore: configured("openai-codex"),
    readRunArtifacts: () => {
      artifactReads += 1;
      return Promise.resolve(artifacts);
    },
    fetchFn: (input) => {
      assertStringIncludes(String(input), "gateway.example");
      providerRequests += 1;
      return Promise.resolve(new Response("{}"));
    },
    cliDependencies: {
      cwd: workspace,
      io: io.io,
      createPromptLoop: (options) => {
        observed = options;
        return {
          runPrompt: () => Promise.reject(new Error("unexpected prompt")),
          runTranscript: async ({ transcript }) => {
            observedTranscript = transcript;
            await options.fetchFn!(options.gatewayBaseUrl!);
            return completedResult(options, "resumed gateway response");
          },
        };
      },
    },
  });

  assertEquals(await host.runBatch(["--resume-run", "run-one"]), 0);
  assertEquals(artifactReads, 1);
  assertEquals(providerRequests, 1);
  assertEquals(observedTranscript, artifacts.transcript);
  assertEquals(observed?.gatewayAuthMode, "none");
  assertEquals(observed?.engine?.getRunState().modelAuthSource, "none");
  assertEquals(io.stderr, []);
});

Deno.test("local Loom host positively resumes an authenticated Codex binding", async () => {
  const home = await Deno.makeTempDir();
  const credentials = new InMemoryHarnessCredentialStore();
  await credentials.set("local", "openai-codex", {
    type: "oauth",
    providerId: "openai-codex",
    accessToken: "access-secret",
    refreshToken: "refresh-secret",
    expiresAt: Date.now() + 60 * 60_000,
    accountId: "account-secret",
  });
  const identityHost = await createLoomLocalCfHarnessHost({
    harnessHome: home,
    env: {},
    credentialStore: credentials,
    providerSettingsStore: configured("openai-codex"),
  });
  let codexRequests = 0;
  let gatewayRequests = 0;
  const io = ioBuffers();
  const host = await createLoomLocalCfHarnessHost({
    harnessHome: home,
    env: {
      CF_HARNESS_GATEWAY_BASE_URL: "https://must-not-be-used.invalid/",
      CF_HARNESS_GATEWAY_AUTH_MODE: "none",
    },
    credentialStore: credentials,
    providerSettingsStore: configured("openai-compatible-gateway"),
    readRunArtifacts: () =>
      Promise.resolve(localRunArtifacts({
        harnessHomeIdentity: identityHost.harnessHomeIdentity,
        provider: "openai-codex",
        authSource: LOOM_LOCAL_AUTH_SOURCE,
      })),
    fetchFn: (input) => {
      if (String(input).includes("chatgpt.com/backend-api/codex/responses")) {
        codexRequests += 1;
        return Promise.resolve(sseCompletion());
      }
      gatewayRequests += 1;
      return Promise.reject(new Error("unexpected gateway request"));
    },
    cliDependencies: {
      cwd: home,
      io: io.io,
      createPromptLoop: (options) => ({
        runPrompt: () => Promise.reject(new Error("unexpected prompt")),
        runTranscript: async ({ transcript }) => {
          const response = await options.modelClient!.complete({
            model: options.model ?? "gpt-5.6-terra",
            transcript,
            tools: [],
            nativeModelToolIds: [],
            runId: options.engine!.getRunState().runId,
          });
          return completedResult(options, response.assistant.content);
        },
      }),
    },
  });

  assertEquals(await host.runBatch(["--resume-run", "run-one"]), 0);
  assertEquals(codexRequests, 1);
  assertEquals(gatewayRequests, 0);
  assertEquals(io.stderr, []);
});

Deno.test("local Loom host positively resumes a gateway API-key binding", async () => {
  const home = await Deno.makeTempDir();
  const identityHost = await createLoomLocalCfHarnessHost({
    harnessHome: home,
    env: {},
    providerSettingsStore: configured("openai-compatible-gateway"),
  });
  const credentials = new InMemoryHarnessCredentialStore();
  let credentialReads = 0;
  const originalGetRecord = credentials.getRecord.bind(credentials);
  credentials.getRecord = (...args) => {
    credentialReads += 1;
    return originalGetRecord(...args);
  };
  let gatewayRequests = 0;
  const io = ioBuffers();
  const host = await createLoomLocalCfHarnessHost({
    harnessHome: home,
    env: {
      CF_HARNESS_GATEWAY_BASE_URL: "https://gateway.example/",
      CF_HARNESS_GATEWAY_AUTH_MODE: "bearer",
      CF_HARNESS_API_KEY: "gateway-secret",
    },
    credentialStore: credentials,
    providerSettingsStore: configured("openai-codex"),
    readRunArtifacts: () =>
      Promise.resolve(localRunArtifacts({
        harnessHomeIdentity: identityHost.harnessHomeIdentity,
        authSource: "api-key",
      })),
    fetchFn: (input) => {
      assertStringIncludes(String(input), "gateway.example");
      gatewayRequests += 1;
      return Promise.resolve(new Response("{}"));
    },
    cliDependencies: {
      cwd: home,
      io: io.io,
      createPromptLoop: (options) => ({
        runPrompt: () => Promise.reject(new Error("unexpected prompt")),
        runTranscript: async () => {
          assertEquals(options.gatewayAuthMode, "bearer");
          assertEquals(options.apiKey, "gateway-secret");
          await options.fetchFn!(options.gatewayBaseUrl!);
          return completedResult(options, "resumed gateway response");
        },
      }),
    },
  });

  assertEquals(await host.runBatch(["--resume-run", "run-one"]), 0);
  assertEquals(gatewayRequests, 1);
  assertEquals(credentialReads, 0);
  assertEquals(io.stderr, []);
});

Deno.test("local Loom host rejects resumed gateway auth overrides before provider traffic", async () => {
  const home = await Deno.makeTempDir();
  const identityHost = await createLoomLocalCfHarnessHost({
    harnessHome: home,
    env: {},
    providerSettingsStore: configured("openai-compatible-gateway"),
  });
  let providerRequests = 0;
  const io = ioBuffers();
  const host = await createLoomLocalCfHarnessHost({
    harnessHome: home,
    env: {
      CF_HARNESS_GATEWAY_BASE_URL: "https://gateway.example/",
      CF_HARNESS_GATEWAY_AUTH_MODE: "bearer",
      CF_HARNESS_API_KEY: "must-not-be-used",
    },
    providerSettingsStore: configured("openai-compatible-gateway"),
    readRunArtifacts: () =>
      Promise.resolve(localRunArtifacts({
        harnessHomeIdentity: identityHost.harnessHomeIdentity,
        authSource: "none",
      })),
    fetchFn: () => {
      providerRequests += 1;
      return Promise.reject(new Error("must not request"));
    },
    cliDependencies: { cwd: home, io: io.io },
  });

  assertEquals(
    await host.runBatch([
      "--resume-run",
      "run-one",
      "--gateway-auth-mode",
      "bearer",
    ]),
    1,
  );
  assertEquals(providerRequests, 0);
  assertEquals(JSON.parse(io.stderr.join("")).error.code, "provider-mismatch");
});

Deno.test("local Loom host ignores literal binding flags after the option terminator", async () => {
  const home = await Deno.makeTempDir();
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
  let observed: CreateHarnessPromptLoopOptions | undefined;
  let observedPrompt = "";
  const io = ioBuffers();
  const host = await createLoomLocalCfHarnessHost({
    harnessHome: home,
    env: {},
    credentialStore: credentials,
    providerSettingsStore: configured("openai-codex"),
    fetchFn: () => {
      providerRequests += 1;
      return Promise.resolve(sseCompletion());
    },
    cliDependencies: {
      cwd: home,
      io: io.io,
      createPromptLoop: (options) => {
        observed = options;
        return {
          runPrompt: async ({ prompt }) => {
            observedPrompt = prompt;
            const response = await options.modelClient!.complete({
              model: options.model ?? "gpt-5.6-terra",
              transcript: [{ role: "user", content: prompt }],
              tools: [],
              nativeModelToolIds: [],
              runId: options.engine!.getRunState().runId,
            });
            return completedResult(options, response.assistant.content);
          },
          runTranscript: () => Promise.reject(new Error("unexpected resume")),
        };
      },
    },
  });

  assertEquals(
    await host.runBatch([
      "--output-mode",
      "batch",
      "--",
      "--model-provider",
      "openai-compatible-gateway",
      "--gateway-auth-mode",
      "none",
    ]),
    0,
  );
  assertEquals(observed?.modelProvider, "openai-codex");
  assertEquals(
    observedPrompt,
    "--model-provider openai-compatible-gateway --gateway-auth-mode none",
  );
  assertEquals(providerRequests, 1);
  assertEquals(io.stderr, []);
});

Deno.test("local Loom host rejects inconsistent recorded bindings before provider traffic", async () => {
  const home = await Deno.makeTempDir();
  const identityHost = await createLoomLocalCfHarnessHost({
    harnessHome: home,
    env: {},
    providerSettingsStore: configured("openai-compatible-gateway"),
  });
  const cases: Array<{
    name: string;
    mutate?: (artifacts: HarnessRunArtifacts) => void;
    args?: readonly string[];
    requestedManifest?: Record<string, unknown>;
  }> = [
    {
      name: "provider",
      mutate: (artifacts) => {
        artifacts.runState.modelProvider = "openai-codex";
      },
    },
    {
      name: "model",
      mutate: (artifacts) => {
        artifacts.runState.model = "other-model";
      },
    },
    {
      name: "owner",
      mutate: (artifacts) => {
        artifacts.runState.credentialOwner = {
          ...LOOM_LOCAL_CREDENTIAL_OWNER,
          ownerKey: "other",
        };
      },
    },
    {
      name: "home",
      mutate: (artifacts) => {
        artifacts.runState.harnessHomeIdentity = "sha256:other";
      },
    },
    {
      name: "source",
      mutate: (artifacts) => {
        artifacts.runState.runManifest!.source = "other" as "loom";
      },
    },
    {
      name: "auth source",
      mutate: (artifacts) => {
        artifacts.runState.modelAuthSource = "api-key";
      },
    },
    {
      name: "manifest provider",
      mutate: (artifacts) => {
        artifacts.runState.runManifest!.modelProvider = "openai-codex";
      },
    },
    {
      name: "manifest model",
      mutate: (artifacts) => {
        artifacts.runState.runManifest!.model = "other-model";
      },
    },
    {
      name: "manifest owner",
      mutate: (artifacts) => {
        artifacts.runState.runManifest!.credentialOwner = {
          ...LOOM_LOCAL_CREDENTIAL_OWNER,
          ownerKey: "other",
        };
      },
    },
    {
      name: "manifest home",
      mutate: (artifacts) => {
        artifacts.runState.runManifest!.harnessHomeIdentity = "sha256:other";
      },
    },
    {
      name: "manifest auth source",
      mutate: (artifacts) => {
        artifacts.runState.runManifest!.modelAuthSource = "api-key";
      },
    },
    {
      name: "CLI model",
      args: ["--model", "other-model"],
    },
    {
      name: "supplied run-manifest model",
      args: ["--run-manifest", "requested-run.json"],
      requestedManifest: {
        type: "cf-harness.loom-run-manifest",
        version: 1,
        source: "loom",
        model: "other-model",
      },
    },
  ];

  for (const testCase of cases) {
    const artifacts = localRunArtifacts({
      harnessHomeIdentity: identityHost.harnessHomeIdentity,
      authSource: "none",
    });
    testCase.mutate?.(artifacts);
    let providerRequests = 0;
    let artifactReads = 0;
    const io = ioBuffers();
    const host = await createLoomLocalCfHarnessHost({
      harnessHome: home,
      env: {
        CF_HARNESS_GATEWAY_BASE_URL: "https://gateway.example/",
        CF_HARNESS_GATEWAY_AUTH_MODE: "none",
      },
      providerSettingsStore: configured("openai-compatible-gateway"),
      readRunArtifacts: () => {
        artifactReads += 1;
        return Promise.resolve(artifacts);
      },
      fetchFn: () => {
        providerRequests += 1;
        return Promise.reject(new Error("must not request"));
      },
      cliDependencies: {
        cwd: home,
        io: io.io,
        readTextFile: () =>
          Promise.resolve(JSON.stringify(testCase.requestedManifest)),
      },
    });

    assertEquals(
      await host.runBatch([
        "--resume-run",
        "run-one",
        ...(testCase.args ?? []),
      ]),
      1,
      testCase.name,
    );
    assertEquals(artifactReads, 1, testCase.name);
    assertEquals(providerRequests, 0, testCase.name);
    assertEquals(
      JSON.parse(io.stderr.join("")).error.code,
      "provider-mismatch",
      testCase.name,
    );
  }
});

Deno.test("local Loom host rejects every incomplete recorded binding before provider traffic", async () => {
  const home = await Deno.makeTempDir();
  const identityHost = await createLoomLocalCfHarnessHost({
    harnessHome: home,
    env: {},
    providerSettingsStore: configured("openai-compatible-gateway"),
  });
  const fields = [
    "modelProvider",
    "model",
    "modelAuthSource",
    "credentialOwner",
    "harnessHomeIdentity",
  ] as const;
  const cases = [
    ...fields.map((field) => ({ surface: "state" as const, field })),
    ...fields.map((field) => ({ surface: "manifest" as const, field })),
    { surface: "manifest" as const, field: "source" as const },
  ];

  for (const testCase of cases) {
    const artifacts = localRunArtifacts({
      harnessHomeIdentity: identityHost.harnessHomeIdentity,
      authSource: "none",
    });
    const surface = testCase.surface === "state"
      ? artifacts.runState
      : artifacts.runState.runManifest!;
    Reflect.deleteProperty(surface, testCase.field);
    let providerRequests = 0;
    const io = ioBuffers();
    const host = await createLoomLocalCfHarnessHost({
      harnessHome: home,
      env: {
        CF_HARNESS_GATEWAY_BASE_URL: "https://gateway.example/",
        CF_HARNESS_GATEWAY_AUTH_MODE: "none",
      },
      providerSettingsStore: configured("openai-compatible-gateway"),
      readRunArtifacts: () => Promise.resolve(artifacts),
      fetchFn: () => {
        providerRequests += 1;
        return Promise.reject(new Error("must not request"));
      },
      cliDependencies: { cwd: home, io: io.io },
    });
    const label = `${testCase.surface}.${testCase.field}`;

    assertEquals(
      await host.runBatch(["--resume-run", "run-one"]),
      1,
      label,
    );
    assertEquals(providerRequests, 0, label);
    assertEquals(
      JSON.parse(io.stderr.join("")).error.code,
      "provider-mismatch",
      label,
    );
  }
});

Deno.test("local Loom host fails closed for legacy resume artifacts without a binding", async () => {
  const home = await Deno.makeTempDir();
  const identityHost = await createLoomLocalCfHarnessHost({
    harnessHome: home,
    env: {},
    providerSettingsStore: configured("openai-compatible-gateway"),
  });
  const artifacts = localRunArtifacts({
    harnessHomeIdentity: identityHost.harnessHomeIdentity,
    authSource: "none",
  });
  delete artifacts.runState.runManifest;
  let providerRequests = 0;
  const io = ioBuffers();
  const host = await createLoomLocalCfHarnessHost({
    harnessHome: home,
    env: {
      CF_HARNESS_GATEWAY_BASE_URL: "https://gateway.example/",
      CF_HARNESS_GATEWAY_AUTH_MODE: "none",
    },
    providerSettingsStore: configured("openai-compatible-gateway"),
    readRunArtifacts: () => Promise.resolve(artifacts),
    fetchFn: () => {
      providerRequests += 1;
      return Promise.reject(new Error("must not request"));
    },
    cliDependencies: { cwd: home, io: io.io },
  });

  assertEquals(await host.runBatch(["--resume-run", "run-one"]), 1);
  assertEquals(providerRequests, 0);
  assertEquals(JSON.parse(io.stderr.join("")).error.code, "provider-mismatch");
});

Deno.test("local Loom host classifies invalid, internal, and unavailable failures", async () => {
  const invalidIo = ioBuffers();
  let invalidRequests = 0;
  const invalidHome = await Deno.makeTempDir();
  const invalidHost = await createLoomLocalCfHarnessHost({
    harnessHome: invalidHome,
    env: {},
    providerSettingsStore: configured("openai-compatible-gateway"),
    fetchFn: () => {
      invalidRequests += 1;
      return Promise.reject(new Error("must not request"));
    },
    cliDependencies: { cwd: invalidHome, io: invalidIo.io },
  });
  assertEquals(await invalidHost.runBatch(["--model-provider"]), 1);
  assertEquals(invalidRequests, 0);
  assertEquals(
    JSON.parse(invalidIo.stderr.join("")).error.code,
    "invalid-request",
  );

  const internalIo = ioBuffers();
  let internalRequests = 0;
  const internalHome = await Deno.makeTempDir();
  const internalHost = await createLoomLocalCfHarnessHost({
    harnessHome: internalHome,
    env: {
      CF_HARNESS_GATEWAY_BASE_URL: "https://gateway.example/",
      CF_HARNESS_GATEWAY_AUTH_MODE: "none",
    },
    providerSettingsStore: configured("openai-compatible-gateway"),
    fetchFn: () => {
      internalRequests += 1;
      return Promise.reject(new Error("must not request"));
    },
    cliDependencies: {
      cwd: internalHome,
      io: internalIo.io,
      createPromptLoop: () => ({
        runPrompt: () => Promise.reject(new Error("injected secret failure")),
        runTranscript: () => Promise.reject(new Error("unexpected resume")),
      }),
    },
  });
  assertEquals(await internalHost.runBatch(["--prompt", "hello"]), 1);
  assertEquals(internalRequests, 0);
  const internalFailure = JSON.parse(internalIo.stderr.join(""));
  assertEquals(internalFailure.error.code, "internal-error");
  assertEquals(JSON.stringify(internalFailure).includes("secret"), false);

  const unavailableIo = ioBuffers();
  let unavailableRequests = 0;
  const unavailableHome = await Deno.makeTempDir();
  const unavailableHost = await createLoomLocalCfHarnessHost({
    harnessHome: unavailableHome,
    env: {
      CF_HARNESS_GATEWAY_BASE_URL: "https://gateway.example/",
      CF_HARNESS_GATEWAY_AUTH_MODE: "none",
    },
    providerSettingsStore: configured("openai-compatible-gateway"),
    fetchFn: (input) => {
      assertStringIncludes(String(input), "gateway.example");
      unavailableRequests += 1;
      return Promise.resolve(
        new Response("upstream secret failure", { status: 400 }),
      );
    },
    cliDependencies: { cwd: unavailableHome, io: unavailableIo.io },
  });
  assertEquals(
    await unavailableHost.runBatch([
      "--prompt",
      "hello",
      "--cfc-enforcement-mode",
      "disabled",
    ]),
    1,
  );
  assertEquals(unavailableRequests, 2, unavailableIo.stderr.join(""));
  const unavailableFailure = JSON.parse(unavailableIo.stderr.join(""));
  assertEquals(unavailableFailure.error.code, "provider-unavailable");
  assertEquals(JSON.stringify(unavailableFailure).includes("secret"), false);
});

Deno.test("interactive startup blockers use the chat protocol", async () => {
  const request = JSON.stringify({
    type: "cf-harness.chat.request",
    protocolVersion: 1,
    requestId: "request-1",
    method: "status",
    params: {},
  });
  let output = "";
  await runLoomLocalInteractiveFailureStdio(
    new HarnessControlError(
      "provider-auth-required",
      "connect cf-harness Codex",
    ),
    {
      input: new Response(`${request}\n`).body!,
      output: new WritableStream({
        write(chunk: Uint8Array) {
          output += new TextDecoder().decode(chunk);
        },
      }),
    },
  );
  const response = JSON.parse(output);
  assertEquals(response.requestId, "request-1");
  assertEquals(response.ok, false);
  assertEquals(response.error.code, "provider-auth-required");
});

Deno.test("only an unreachable provider marks a startup blocker retryable", async () => {
  // `retryable` reads as `Retry-After` does: waiting alone can clear this one.
  // A blocker that needs a provider connected, configured, or matched does not
  // become true because an operator could go and do that.
  const blockers: Array<{
    error: HarnessControlError;
    code: string;
    retryable: boolean | undefined;
  }> = [
    {
      error: new HarnessControlError("provider-unavailable", "codex is down"),
      code: "provider-unavailable",
      retryable: true,
    },
    {
      error: new HarnessControlError("provider-auth-required", "connect codex"),
      code: "provider-auth-required",
      retryable: undefined,
    },
    {
      error: new HarnessControlError(
        "provider-configuration-required",
        "configure a provider",
      ),
      code: "provider-configuration-required",
      retryable: undefined,
    },
    {
      error: new HarnessControlError("provider-mismatch", "resume mismatch"),
      code: "provider-mismatch",
      retryable: undefined,
    },
    {
      error: new Error("something broke") as HarnessControlError,
      code: "internal_error",
      retryable: undefined,
    },
  ];

  for (const blocker of blockers) {
    const request = JSON.stringify({
      type: "cf-harness.chat.request",
      protocolVersion: 1,
      requestId: "request-1",
      method: "status",
      params: {},
    });
    let output = "";
    await runLoomLocalInteractiveFailureStdio(blocker.error, {
      input: new Response(`${request}\n`).body!,
      output: new WritableStream({
        write(chunk: Uint8Array) {
          output += new TextDecoder().decode(chunk);
        },
      }),
    });
    const error = JSON.parse(output).error;
    assertEquals(error.code, blocker.code);
    assertEquals(error.retryable, blocker.retryable, blocker.code);
  }
});

Deno.test("local Loom interactive entrypoint returns missing config on stdout protocol", async () => {
  const home = await Deno.makeTempDir();
  const request = JSON.stringify({
    type: "cf-harness.chat.request",
    protocolVersion: 1,
    requestId: "request-entrypoint",
    method: "status",
    params: {},
  });
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
  await writer.write(new TextEncoder().encode(`${request}\n`));
  await writer.close();
  const result = await child.output();
  const response = JSON.parse(new TextDecoder().decode(result.stdout));

  assertEquals(result.code, 1);
  assertEquals(response.type, "cf-harness.chat.response");
  assertEquals(response.protocolVersion, 1);
  assertEquals(response.requestId, "request-entrypoint");
  assertEquals(response.ok, false);
  assertEquals(response.error.code, "provider-configuration-required");
  assertEquals(new TextDecoder().decode(result.stderr), "");
});

Deno.test("local Loom host rejects non-canonical credential homes and provider overrides", async () => {
  const root = await Deno.makeTempDir();
  const file = `${root}/not-a-directory`;
  await Deno.writeTextFile(file, "not a directory");
  const missing = `${root}/missing`;
  const cases = [
    { home: "relative/home", message: "absolute canonical path" },
    { home: `${root}/../${root.split("/").at(-1)}`, message: "normalized" },
    { home: missing, message: "existing directory" },
    { home: file, message: "existing directory" },
  ];

  for (const testCase of cases) {
    await assertRejects(
      () => createLoomLocalCfHarnessHost({ harnessHome: testCase.home }),
      HarnessControlError,
      testCase.message,
    );
  }

  await assertRejects(
    () =>
      createLoomLocalCfHarnessHost({
        harnessHome: root,
        env: { CF_HARNESS_MODEL_PROVIDER: "openai-codex" },
      }),
    HarnessControlError,
    "do not accept CF_HARNESS_MODEL_PROVIDER overrides",
  );
});

Deno.test("local Loom host classifies malformed binding options before configuration or traffic", async () => {
  const home = await Deno.makeTempDir();
  const cases: Array<{ args: readonly string[]; message: string }> = [
    { args: ["--model="], message: "--model requires a value" },
    {
      args: ["--gateway-base-url"],
      message: "--gateway-base-url requires a value",
    },
    {
      args: ["--prompt-cache-mode="],
      message: "--prompt-cache-mode requires a value",
    },
    {
      args: [
        "--gateway-auth-mode",
        "none",
        "--gateway-auth-mode",
        "bearer",
      ],
      message: "duplicate --gateway-auth-mode",
    },
    {
      args: ["--", "--gateway-auth-mode", "invalid"],
      message: "--gateway-auth-mode must be bearer or none",
    },
    {
      args: ["--resume-run", "one", "--resume-run", "two"],
      message: "duplicate --resume-run",
    },
    {
      args: ["--model", "one", "--model", "two"],
      message: "duplicate --model",
    },
    {
      args: [
        "--model-provider",
        "openai-codex",
        "--model-provider",
        "openai-codex",
      ],
      message: "duplicate --model-provider",
    },
    {
      args: ["--model-provider", "unsupported"],
      message: "unsupported --model-provider",
    },
  ];

  for (const testCase of cases) {
    let providerReads = 0;
    let providerRequests = 0;
    const io = ioBuffers();
    const host = await createLoomLocalCfHarnessHost({
      harnessHome: home,
      env: {},
      providerSettingsStore: {
        inspect: () => {
          providerReads += 1;
          return Promise.resolve({
            state: "configured" as const,
            settings: {
              version: 1 as const,
              modelProvider: "openai-compatible-gateway" as const,
            },
          });
        },
      },
      fetchFn: () => {
        providerRequests += 1;
        return Promise.reject(new Error("must not request"));
      },
      cliDependencies: { cwd: home, io: io.io },
    });

    assertEquals(await host.runBatch(testCase.args), 1, testCase.message);
    assertEquals(providerReads, 0, testCase.message);
    assertEquals(providerRequests, 0, testCase.message);
    const failure = JSON.parse(io.stderr.join(""));
    assertEquals(failure.error.code, "invalid-request", testCase.message);
    assertStringIncludes(failure.error.message, testCase.message);
  }
});

Deno.test("local Loom host validates gateway environment and credential-store availability", async () => {
  const home = await Deno.makeTempDir();
  const invalidGatewayIo = ioBuffers();
  const invalidGatewayHost = await createLoomLocalCfHarnessHost({
    harnessHome: home,
    env: { CF_HARNESS_GATEWAY_AUTH_MODE: "invalid" },
    providerSettingsStore: configured("openai-compatible-gateway"),
    cliDependencies: { cwd: home, io: invalidGatewayIo.io },
  });
  assertEquals(await invalidGatewayHost.runBatch(["--prompt", "hello"]), 1);
  assertEquals(
    JSON.parse(invalidGatewayIo.stderr.join("")).error.code,
    "provider-configuration-required",
  );

  const unavailableCredentials = new InMemoryHarnessCredentialStore();
  unavailableCredentials.getRecord = () =>
    Promise.reject(new Error("secret-bearing storage failure"));
  const unavailableIo = ioBuffers();
  const unavailableHost = await createLoomLocalCfHarnessHost({
    harnessHome: home,
    env: {},
    credentialStore: unavailableCredentials,
    providerSettingsStore: configured("openai-codex"),
    cliDependencies: { cwd: home, io: unavailableIo.io },
  });
  assertEquals(await unavailableHost.runBatch(["--prompt", "hello"]), 1);
  const unavailableFailure = JSON.parse(unavailableIo.stderr.join(""));
  assertEquals(unavailableFailure.error.code, "provider-unavailable");
  assertEquals(
    JSON.stringify(unavailableFailure).includes("secret-bearing"),
    false,
  );

  const defaultIoHost = await createLoomLocalCfHarnessHost({
    harnessHome: home,
    env: {},
    providerSettingsStore: configured("openai-compatible-gateway"),
  });
  assertEquals(await defaultIoHost.runBatch(["--model-provider"]), 1);
});

Deno.test("interactive startup failure protocol handles malformed requests and bounded internal errors", async () => {
  const input = new Response(
    `\nnot-json\n${JSON.stringify({ requestId: 42 })}\n${
      JSON.stringify({ requestId: "known" })
    }\n`,
  ).body!;
  let output = "";
  await runLoomLocalInteractiveFailureStdio(
    new HarnessControlError("invalid-request", "bounded invalid request"),
    {
      input,
      output: new WritableStream({
        write(chunk: Uint8Array) {
          output += new TextDecoder().decode(chunk);
        },
      }),
    },
  );
  const responses = output.trim().split("\n").map((line) => JSON.parse(line));
  assertEquals(responses.map((response) => response.requestId), [
    "invalid",
    "invalid",
    "known",
  ]);
  assertEquals(
    responses.map((response) => response.error.code),
    ["internal_error", "internal_error", "internal_error"],
  );

  let unknownOutput = "";
  await runLoomLocalInteractiveFailureStdio(
    new Error("secret-bearing unexpected failure"),
    {
      input: new Response(`${JSON.stringify({ requestId: "unknown" })}\n`)
        .body!,
      output: new WritableStream({
        write(chunk: Uint8Array) {
          unknownOutput += new TextDecoder().decode(chunk);
        },
      }),
    },
  );
  const unknown = JSON.parse(unknownOutput);
  assertEquals(unknown.error.code, "internal_error");
  assertEquals(JSON.stringify(unknown).includes("secret-bearing"), false);
});
