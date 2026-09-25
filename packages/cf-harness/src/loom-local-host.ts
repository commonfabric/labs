import { isAbsolute, resolve } from "@std/path";
import {
  type HarnessRunArtifacts,
  readHarnessRunArtifacts,
} from "./artifacts.ts";
import {
  defaultHarnessCredentialStorePath,
  FileHarnessCredentialStore,
  type HarnessCredentialStore,
} from "./auth/credential-store.ts";
import {
  OpenAICodexAuthService,
  OpenAICodexCredentialResolver,
} from "./auth/openai-codex.ts";
import {
  defaultHarnessProviderSettingsPath,
  FileHarnessProviderSettingsStore,
  resolveHarnessModelProviderPreference,
} from "./auth/provider-settings.ts";
import {
  cfHarnessCliCommandName,
  cfHarnessCliInformationalControl,
  type CfHarnessCliIO,
  type CfHarnessHostFailure,
  createCfHarnessHostFailure,
  runCfHarnessCli,
  type RunCfHarnessCliDependencies,
} from "./cli.ts";
import type {
  HarnessGatewayAuthMode,
  HarnessModelProviderId,
} from "./config.ts";
import { HarnessControlError } from "./control-errors.ts";
import {
  createHarnessChatErrorResponse,
  type HarnessChatError,
} from "./contracts/interactive-chat.ts";
import type { HarnessFetch } from "./contracts/http-fetch.ts";
import {
  HARNESS_CREDENTIAL_OWNER_REF_TYPE,
  harnessCredentialOwnersEqual,
  type LoomLocalHostBinding,
  type LoomRunManifest,
} from "./contracts/run-manifest.ts";
import {
  harnessInteractiveChatStdioUsageText,
  parseHarnessInteractiveChatStdioCliOptions,
  runHarnessInteractiveChatStdio,
  type RunHarnessInteractiveChatStdioOptions,
} from "./interactive-chat-stdio.ts";
import { resolveInteractiveProvisioning } from "./host-mounts.ts";
import { OpenAICodexResponsesClient } from "./model/openai-codex-responses.ts";

export const LOOM_LOCAL_CREDENTIAL_OWNER = {
  type: HARNESS_CREDENTIAL_OWNER_REF_TYPE,
  version: 1,
  ownerKey: "local",
} as const;

export const LOOM_LOCAL_AUTH_SOURCE = "cf-harness-local-store" as const;

const CODEX_INCOMPATIBLE_ENV_KEYS = [
  "CF_HARNESS_API_KEY",
  "OPENAI_API_KEY",
  "CF_HARNESS_GATEWAY_BASE_URL",
  "CF_HARNESS_GATEWAY_AUTH_MODE",
  "CF_HARNESS_PROMPT_CACHE_MODE",
] as const;

const nonEmpty = (value: string | undefined): string | undefined =>
  value === undefined || value.trim() === "" ? undefined : value;

const canonicalHarnessHome = async (input: string): Promise<string> => {
  if (input.trim() === "" || !isAbsolute(input)) {
    throw new HarnessControlError(
      "provider-configuration-required",
      "CF_HARNESS_HOME must be an absolute canonical path",
    );
  }
  const canonical = resolve(input);
  if (canonical !== input) {
    throw new HarnessControlError(
      "provider-configuration-required",
      "CF_HARNESS_HOME must already be normalized",
    );
  }
  try {
    const real = await Deno.realPath(canonical);
    if (!(await Deno.stat(real)).isDirectory) {
      throw new Error("not a directory");
    }
    return real;
  } catch {
    throw new HarnessControlError(
      "provider-configuration-required",
      "CF_HARNESS_HOME must resolve to an existing directory",
    );
  }
};

const homeIdentity = async (home: string): Promise<string> => {
  const bytes = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(home),
  );
  return `sha256:${
    [...new Uint8Array(bytes)].map((value) =>
      value.toString(16).padStart(2, "0")
    ).join("")
  }`;
};

interface ParsedBindingArgs {
  resumeRun?: string;
  modelProvider?: HarnessModelProviderId;
  model?: string;
  gatewayAuthMode?: HarnessGatewayAuthMode;
  hasGatewayOptions: boolean;
}

const optionValue = (
  argv: readonly string[],
  index: number,
  name: string,
): { value: string; consumed: number } => {
  const argument = argv[index];
  const prefix = `${name}=`;
  if (argument.startsWith(prefix)) {
    const value = argument.slice(prefix.length);
    if (value.trim() === "") throw new Error(`${name} requires a value`);
    return { value, consumed: 0 };
  }
  const value = argv[index + 1];
  if (value === undefined || value.startsWith("--")) {
    throw new Error(`${name} requires a value`);
  }
  return { value, consumed: 1 };
};

const parseBindingArgs = (argv: readonly string[]): ParsedBindingArgs => {
  let resumeRun: string | undefined;
  let modelProvider: HarnessModelProviderId | undefined;
  let model: string | undefined;
  let parsedGatewayAuthMode: HarnessGatewayAuthMode | undefined;
  let hasGatewayOptions = false;
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--") {
      if (index === 0) continue;
      break;
    }
    if (
      argument === "--gateway-base-url" ||
      argument.startsWith("--gateway-base-url=")
    ) {
      hasGatewayOptions = true;
      const parsed = optionValue(argv, index, "--gateway-base-url");
      index += parsed.consumed;
      continue;
    }
    if (
      argument === "--prompt-cache-mode" ||
      argument.startsWith("--prompt-cache-mode=")
    ) {
      hasGatewayOptions = true;
      const parsed = optionValue(argv, index, "--prompt-cache-mode");
      index += parsed.consumed;
      continue;
    }
    if (
      argument === "--gateway-auth-mode" ||
      argument.startsWith("--gateway-auth-mode=")
    ) {
      hasGatewayOptions = true;
      if (parsedGatewayAuthMode !== undefined) {
        throw new Error("duplicate --gateway-auth-mode");
      }
      const parsed = optionValue(argv, index, "--gateway-auth-mode");
      index += parsed.consumed;
      if (parsed.value !== "bearer" && parsed.value !== "none") {
        throw new Error("--gateway-auth-mode must be bearer or none");
      }
      parsedGatewayAuthMode = parsed.value;
      continue;
    }
    for (const name of ["--resume-run", "--model-provider", "--model"]) {
      if (argument !== name && !argument.startsWith(`${name}=`)) continue;
      const parsed = optionValue(argv, index, name);
      index += parsed.consumed;
      if (name === "--resume-run") {
        if (resumeRun !== undefined) throw new Error("duplicate --resume-run");
        resumeRun = parsed.value;
      } else if (name === "--model") {
        if (model !== undefined) throw new Error("duplicate --model");
        model = parsed.value;
      } else {
        if (modelProvider !== undefined) {
          throw new Error("duplicate --model-provider");
        }
        if (
          parsed.value !== "openai-compatible-gateway" &&
          parsed.value !== "openai-codex"
        ) {
          throw new Error("unsupported --model-provider");
        }
        modelProvider = parsed.value;
      }
      break;
    }
  }
  return {
    ...(resumeRun !== undefined ? { resumeRun } : {}),
    ...(modelProvider !== undefined ? { modelProvider } : {}),
    ...(model !== undefined ? { model } : {}),
    ...(parsedGatewayAuthMode !== undefined
      ? { gatewayAuthMode: parsedGatewayAuthMode }
      : {}),
    hasGatewayOptions,
  };
};

const gatewayAuthMode = (
  env: Record<string, string | undefined>,
): HarnessGatewayAuthMode => {
  const raw = nonEmpty(env.CF_HARNESS_GATEWAY_AUTH_MODE);
  if (raw === undefined || raw === "bearer") return "bearer";
  if (raw === "none") return "none";
  throw new HarnessControlError(
    "provider-configuration-required",
    "CF_HARNESS_GATEWAY_AUTH_MODE must be bearer or none",
  );
};

const bindingFromRecordedRun = (
  artifacts: HarnessRunArtifacts,
  expectedHomeIdentity: string,
): LoomLocalHostBinding => {
  const state = artifacts.runState;
  const manifest = state.runManifest;
  const provider = state.modelProvider;
  const model = state.model;
  const authSource = state.modelAuthSource;
  const owner = state.credentialOwner;
  const recordedHome = state.harnessHomeIdentity;
  const manifestProvider = manifest?.modelProvider;
  const manifestModel = manifest?.model;
  const manifestAuthSource = manifest?.modelAuthSource;
  const manifestOwner = manifest?.credentialOwner;
  const manifestHome = manifest?.harnessHomeIdentity;
  if (
    manifest?.source !== "loom" ||
    (provider !== "openai-compatible-gateway" &&
      provider !== "openai-codex") ||
    manifestProvider !== provider ||
    typeof model !== "string" || model.trim() === "" ||
    manifestModel !== model ||
    (authSource !== "api-key" && authSource !== "none" &&
      authSource !== LOOM_LOCAL_AUTH_SOURCE) ||
    manifestAuthSource !== authSource ||
    owner === undefined || manifestOwner === undefined ||
    !harnessCredentialOwnersEqual(owner, manifestOwner) ||
    recordedHome === undefined || manifestHome !== recordedHome ||
    (state.credentialOwnerKey !== undefined &&
      state.credentialOwnerKey !== owner.ownerKey) ||
    !harnessCredentialOwnersEqual(owner, LOOM_LOCAL_CREDENTIAL_OWNER) ||
    recordedHome !== expectedHomeIdentity ||
    (provider === "openai-codex" && authSource !== LOOM_LOCAL_AUTH_SOURCE) ||
    (provider === "openai-compatible-gateway" &&
      authSource !== "api-key" && authSource !== "none")
  ) {
    throw new HarnessControlError(
      "provider-mismatch",
      "resumed run does not match the local Loom provider binding",
    );
  }
  return {
    source: "loom",
    modelProvider: provider,
    modelAuthSource: authSource,
    credentialOwner: LOOM_LOCAL_CREDENTIAL_OWNER,
    harnessHomeIdentity: expectedHomeIdentity,
  };
};

const assertRequestedBinding = (
  parsed: ParsedBindingArgs,
  binding: LoomLocalHostBinding,
  recordedModel?: string,
): void => {
  if (
    parsed.modelProvider !== undefined &&
    parsed.modelProvider !== binding.modelProvider
  ) {
    throw new HarnessControlError(
      "provider-mismatch",
      `requested provider ${parsed.modelProvider} does not match ${binding.modelProvider}`,
    );
  }
  if (
    recordedModel !== undefined && parsed.model !== undefined &&
    parsed.model !== recordedModel
  ) {
    throw new HarnessControlError(
      "provider-mismatch",
      `requested model ${parsed.model} does not match resumed model ${recordedModel}`,
    );
  }
  if (binding.modelProvider === "openai-codex" && parsed.hasGatewayOptions) {
    throw new HarnessControlError(
      "provider-mismatch",
      "gateway options cannot be used with the local Loom Codex binding",
    );
  }
};

export interface CreateLoomLocalCfHarnessHostOptions {
  harnessHome: string;
  env?: Record<string, string | undefined>;
  credentialStore?: HarnessCredentialStore;
  providerSettingsStore?: Pick<FileHarnessProviderSettingsStore, "inspect">;
  readRunArtifacts?: typeof readHarnessRunArtifacts;
  fetchFn?: HarnessFetch;
  interactiveStdioRunner?: (
    options: RunHarnessInteractiveChatStdioOptions,
  ) => Promise<void>;
  cliDependencies?: Omit<
    RunCfHarnessCliDependencies,
    | "env"
    | "loomLocalHostBinding"
    | "credentialStore"
    | "providerSettingsStore"
    | "openAICodexCredentialResolver"
    | "fetchFn"
    | "structuredHostFailures"
  >;
}

export interface LoomLocalCfHarnessHost {
  readonly harnessHomeIdentity: string;
  runBatch(argv: readonly string[]): Promise<number>;
  runInteractive(args?: readonly string[]): Promise<void>;
}

/** Creates the fixed-owner execution boundary used by local single-user Loom. */
export const createLoomLocalCfHarnessHost = async (
  options: CreateLoomLocalCfHarnessHostOptions,
): Promise<LoomLocalCfHarnessHost> => {
  const harnessHome = await canonicalHarnessHome(options.harnessHome);
  const identity = await homeIdentity(harnessHome);
  const processEnv = { ...(options.env ?? Deno.env.toObject()) };
  if (nonEmpty(processEnv.CF_HARNESS_MODEL_PROVIDER) !== undefined) {
    throw new HarnessControlError(
      "provider-configuration-required",
      "local Loom runs do not accept CF_HARNESS_MODEL_PROVIDER overrides",
    );
  }
  processEnv.CF_HARNESS_HOME = harnessHome;
  processEnv.HOME = undefined;
  processEnv.CF_HARNESS_MODEL_PROVIDER = undefined;
  const providerStore = options.providerSettingsStore ??
    new FileHarnessProviderSettingsStore({
      path: defaultHarnessProviderSettingsPath(harnessHome),
    });
  const credentialStore = options.credentialStore ??
    new FileHarnessCredentialStore({
      path: defaultHarnessCredentialStorePath(harnessHome),
    });
  const readArtifacts = options.readRunArtifacts ?? readHarnessRunArtifacts;

  const configuredProvider = async (): Promise<HarnessModelProviderId> =>
    (await resolveHarnessModelProviderPreference({
      store: providerStore,
    })).provider;

  const preflightCodex = async (): Promise<OpenAICodexCredentialResolver> => {
    let status;
    try {
      status = await new OpenAICodexAuthService(
        credentialStore,
        LOOM_LOCAL_CREDENTIAL_OWNER.ownerKey,
      ).status();
    } catch {
      throw new HarnessControlError(
        "provider-unavailable",
        "cf-harness Codex credential status could not be read",
      );
    }
    if (status.status === "disconnected") {
      throw new HarnessControlError(
        "provider-auth-required",
        "cf-harness Codex is not connected; connect it in Loom Settings → Harnesses",
      );
    }
    if (status.status === "reconnect-required") {
      throw new HarnessControlError(
        "provider-auth-required",
        "cf-harness Codex must be reconnected in Loom Settings → Harnesses",
      );
    }
    return new OpenAICodexCredentialResolver({
      store: credentialStore,
      ownerKey: LOOM_LOCAL_CREDENTIAL_OWNER.ownerKey,
      credentialOwner: LOOM_LOCAL_CREDENTIAL_OWNER,
      fetchFn: options.fetchFn,
    });
  };

  const resolveBinding = async (
    argv: readonly string[],
  ): Promise<
    {
      binding: LoomLocalHostBinding;
      resolver?: OpenAICodexCredentialResolver;
      artifacts?: HarnessRunArtifacts;
      forcedGatewayAuthMode?: HarnessGatewayAuthMode;
    }
  > => {
    let parsed: ParsedBindingArgs;
    try {
      parsed = parseBindingArgs(argv);
    } catch (error) {
      throw new HarnessControlError(
        "invalid-request",
        error instanceof Error ? error.message : "invalid host arguments",
      );
    }
    const persistedProvider = await configuredProvider();
    let binding: LoomLocalHostBinding;
    let recordedModel: string | undefined;
    let artifacts: HarnessRunArtifacts | undefined;
    let forcedGatewayAuthMode: HarnessGatewayAuthMode | undefined;
    if (parsed.resumeRun !== undefined) {
      artifacts = await readArtifacts(resolve(
        options.cliDependencies?.cwd ?? Deno.cwd(),
        parsed.resumeRun,
      ));
      binding = bindingFromRecordedRun(artifacts, identity);
      recordedModel = artifacts.runState.model;
      if (binding.modelProvider === "openai-compatible-gateway") {
        forcedGatewayAuthMode = binding.modelAuthSource === "none"
          ? "none"
          : "bearer";
        if (
          parsed.gatewayAuthMode !== undefined &&
          parsed.gatewayAuthMode !== forcedGatewayAuthMode
        ) {
          throw new HarnessControlError(
            "provider-mismatch",
            "requested gateway auth mode does not match the resumed run",
          );
        }
      }
    } else {
      const provider = persistedProvider;
      const authMode = provider === "openai-compatible-gateway"
        ? parsed.gatewayAuthMode ?? gatewayAuthMode(processEnv)
        : undefined;
      binding = {
        source: "loom",
        modelProvider: provider,
        modelAuthSource: provider === "openai-codex"
          ? LOOM_LOCAL_AUTH_SOURCE
          : authMode === "none"
          ? "none"
          : "api-key",
        credentialOwner: LOOM_LOCAL_CREDENTIAL_OWNER,
        harnessHomeIdentity: identity,
      };
    }
    assertRequestedBinding(parsed, binding, recordedModel);
    const resolver = binding.modelProvider === "openai-codex"
      ? await preflightCodex()
      : undefined;
    return {
      binding,
      ...(resolver !== undefined ? { resolver } : {}),
      ...(artifacts !== undefined ? { artifacts } : {}),
      ...(forcedGatewayAuthMode !== undefined ? { forcedGatewayAuthMode } : {}),
    };
  };

  const cliEnv = (
    provider: HarnessModelProviderId,
  ): Record<string, string | undefined> => {
    const env = { ...processEnv };
    if (provider === "openai-codex") {
      for (const key of CODEX_INCOMPATIBLE_ENV_KEYS) env[key] = undefined;
    }
    return env;
  };

  return {
    harnessHomeIdentity: identity,
    async runBatch(argv: readonly string[]): Promise<number> {
      if (cfHarnessCliInformationalControl(argv) !== undefined) {
        return await runCfHarnessCli(argv, {
          ...options.cliDependencies,
          env: processEnv,
          structuredHostFailures: true,
        });
      }
      const io = options.cliDependencies?.io ?? defaultHostIo();
      // Batch argv reaches the CLI behind a prepended --model-provider, which
      // shifts a leading subcommand out of the CLI's own dispatch and into the
      // prompt text. Reject it here rather than bill a run for it. Positional
      // text opening on one of those words is caught too, so the message names
      // the flag that says "prompt" unambiguously.
      const command = cfHarnessCliCommandName(argv);
      if (command !== "prompt") {
        io.stderr(`${
          JSON.stringify(createCfHarnessHostFailure(
            new HarnessControlError(
              "invalid-request",
              `the local Loom host runs prompts only; a leading "${command}" is a cf-harness CLI command — use --prompt to send it as prompt text`,
            ),
          ))
        }\n`);
        return 1;
      }
      let resolved;
      try {
        resolved = await resolveBinding(argv);
      } catch (error) {
        io.stderr(`${JSON.stringify(createCfHarnessHostFailure(error))}\n`);
        return 1;
      }
      let args = parsedProviderPresent(argv)
        ? [...argv]
        : ["--model-provider", resolved.binding.modelProvider, ...argv];
      if (
        resolved.forcedGatewayAuthMode !== undefined &&
        !bindingOptionPresent(args, "--gateway-auth-mode")
      ) {
        args = [
          "--gateway-auth-mode",
          resolved.forcedGatewayAuthMode,
          ...args,
        ];
      }
      return await runCfHarnessCli(args, {
        ...options.cliDependencies,
        ...(resolved.artifacts !== undefined
          ? { readRunArtifacts: () => Promise.resolve(resolved.artifacts!) }
          : {}),
        env: cliEnv(resolved.binding.modelProvider),
        loomLocalHostBinding: resolved.binding,
        credentialStore,
        ...(resolved.resolver !== undefined
          ? { openAICodexCredentialResolver: resolved.resolver }
          : {}),
        ...(options.fetchFn !== undefined ? { fetchFn: options.fetchFn } : {}),
        structuredHostFailures: true,
      });
    },
    async runInteractive(args: readonly string[] = []): Promise<void> {
      const parsed = parseHarnessInteractiveChatStdioCliOptions(
        args,
        processEnv,
        options.cliDependencies?.cwd ?? Deno.cwd(),
      );
      if (parsed.help) {
        Deno.stderr.writeSync(
          new TextEncoder().encode(harnessInteractiveChatStdioUsageText()),
        );
        return;
      }
      // Resolved here rather than in the option parser because resolution is
      // async (realpath + stat per source) and the parser is sync. Same parser,
      // same grammar, same validation as `cf-harness run --host-mount`.
      const provisioning = await resolveInteractiveProvisioning(
        parsed,
        // Same base the batch path resolves relative sources against, so a
        // spec means the same thing on either entrypoint.
        options.cliDependencies?.cwd ?? Deno.cwd(),
        // The sandbox runtime is read from the same environment the batch
        // path hands its CLI, so both lanes of one Loom instance execute in
        // the sandbox the instance selected.
        processEnv,
      );
      const provider = await configuredProvider();
      const binding: LoomLocalHostBinding = {
        source: "loom",
        modelProvider: provider,
        modelAuthSource: provider === "openai-codex"
          ? LOOM_LOCAL_AUTH_SOURCE
          : gatewayAuthMode(processEnv) === "none"
          ? "none"
          : "api-key",
        credentialOwner: LOOM_LOCAL_CREDENTIAL_OWNER,
        harnessHomeIdentity: identity,
      };
      const resolver = provider === "openai-codex"
        ? await preflightCodex()
        : undefined;
      const runManifest: LoomRunManifest = {
        type: "cf-harness.loom-run-manifest",
        version: 1,
        ...binding,
      };
      const modelClient = resolver === undefined
        ? undefined
        : new OpenAICodexResponsesClient({
          credentialResolver: resolver,
          credentialOwner: LOOM_LOCAL_CREDENTIAL_OWNER,
          fetchFn: options.fetchFn,
        });
      await (options.interactiveStdioRunner ?? runHarnessInteractiveChatStdio)({
        ...(parsed.sessionDbPath !== undefined
          ? { sessionDbPath: parsed.sessionDbPath }
          : {}),
        ...(parsed.maxInMemoryEvents !== undefined
          ? { maxInMemoryEvents: parsed.maxInMemoryEvents }
          : {}),
        credentialOwner: LOOM_LOCAL_CREDENTIAL_OWNER,
        basePromptLoopOptions: {
          finalizeOnTurnLimit: true,
          ...(processEnv.CF_HARNESS_CHAT_ARTIFACT_ROOT
            ? { artifactRoot: processEnv.CF_HARNESS_CHAT_ARTIFACT_ROOT }
            : {}),
          modelProvider: provider,
          modelAuthSource: binding.modelAuthSource,
          credentialOwner: LOOM_LOCAL_CREDENTIAL_OWNER,
          credentialOwnerKey: LOOM_LOCAL_CREDENTIAL_OWNER.ownerKey,
          harnessHomeIdentity: identity,
          runManifest,
          // Provisioning reaches the sandbox exactly as it does for a batch
          // run: CreateHarnessPromptLoopOptions extends
          // CreateHarnessEngineOptions, and the loop builds its engine from
          // these when the caller passes none. The interactive service spreads
          // this object into every turn's options, so what is set here holds
          // for the whole session.
          ...provisioning,
          ...(provider === "openai-compatible-gateway"
            ? {
              gatewayBaseUrl: processEnv.CF_HARNESS_GATEWAY_BASE_URL,
              gatewayAuthMode: gatewayAuthMode(processEnv),
              apiKey: processEnv.CF_HARNESS_API_KEY ??
                processEnv.OPENAI_API_KEY,
              fetchFn: options.fetchFn,
            }
            : { modelClient }),
        },
      });
    },
  };
};

const bindingOptionPresent = (
  argv: readonly string[],
  name: string,
): boolean => {
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--" && index !== 0) return false;
    if (argument === name || argument.startsWith(`${name}=`)) return true;
  }
  return false;
};

const parsedProviderPresent = (argv: readonly string[]): boolean =>
  bindingOptionPresent(argv, "--model-provider");

const defaultHostIo = (): CfHarnessCliIO => ({
  stdout: (text) => Deno.stdout.writeSync(new TextEncoder().encode(text)),
  stderr: (text) => Deno.stderr.writeSync(new TextEncoder().encode(text)),
});

/**
 * A startup blocker as the chat protocol states it. Only the provider codes
 * and `internal-error` reach here: this answers a failure raised before the
 * host was serving, while `invalid-request` and `operation-canceled` belong to
 * the batch and control paths, which answer on stderr instead. The provider
 * codes carry across by name, so the remaining branch totals the mapping
 * rather than choosing between codes. A malformed chat request is a separate
 * matter and has the protocol's own `invalid_request`, raised where the
 * request is read.
 *
 * `retryable` carries HTTP's `Retry-After` sense: it is set only where waiting
 * is known to help, so a provider that is unreachable now and may answer later
 * is the one blocker that gets it. The rest need someone to change something
 * first — connect a provider, configure one, resume the run it was recorded
 * against — and an unauthenticated provider is no more retryable here than a
 * 401 is, whatever the operator can go on to do about it. Absent means
 * unknown, which is the honest answer for a host that broke unexpectedly.
 */
const chatError = (failure: CfHarnessHostFailure): HarnessChatError => ({
  code: failure.error.code === "provider-configuration-required" ||
      failure.error.code === "provider-auth-required" ||
      failure.error.code === "provider-mismatch" ||
      failure.error.code === "provider-unavailable"
    ? failure.error.code
    : "internal_error",
  message: failure.error.message,
  ...(failure.error.code === "provider-unavailable" ? { retryable: true } : {}),
});

/** Keeps the interactive protocol alive long enough to return startup blockers. */
export const runLoomLocalInteractiveFailureStdio = async (
  error: unknown,
  options: {
    input?: ReadableStream<Uint8Array>;
    output?: WritableStream<Uint8Array>;
  } = {},
): Promise<void> => {
  const failure = createCfHarnessHostFailure(error);
  const reader = (options.input ?? Deno.stdin.readable).getReader();
  const writer = (options.output ?? Deno.stdout.writable).getWriter();
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  let buffered = "";
  try {
    while (true) {
      const { value, done } = await reader.read();
      buffered += decoder.decode(value, { stream: !done });
      let newline;
      while ((newline = buffered.indexOf("\n")) >= 0) {
        const line = buffered.slice(0, newline).trim();
        buffered = buffered.slice(newline + 1);
        if (line === "") continue;
        let requestId = "invalid";
        try {
          const parsed = JSON.parse(line) as Record<string, unknown>;
          if (typeof parsed.requestId === "string") {
            requestId = parsed.requestId;
          }
        } catch {
          // The typed host failure is more useful than a second parse failure.
        }
        const response = createHarnessChatErrorResponse(
          requestId,
          chatError(failure),
        );
        await writer.write(encoder.encode(`${JSON.stringify(response)}\n`));
      }
      if (done) break;
    }
  } finally {
    reader.releaseLock();
    writer.releaseLock();
  }
};
