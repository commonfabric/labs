#!/usr/bin/env -S deno run -A

/**
 * The console surface: type a task, watch the harness work, open what it
 * built. One HTTP server holding one in-process
 * `HarnessInteractiveChatService`, one static page reading its events over
 * Server-Sent Events, and nothing else.
 *
 *   deno task --cwd packages/cf-harness console
 *   open http://127.0.0.1:8100
 *
 * The server binds 127.0.0.1 and asks one thing of a request: that it names
 * this server's own host. A hostile name that resolves to 127.0.0.1 would
 * otherwise make these routes same-origin to a browser, and that name is
 * visible on the wire. Nothing else is asked, and no client carries a
 * credential — a caller that reaches this socket is a caller the network
 * admitted. So the network is the boundary: run this where reaching it already
 * means being trusted, which on a shared host means a tailnet with an access
 * policy, and not behind a public address.
 *
 * What a task runs under is not decided here. This server resolves flags, the
 * environment and the request body into a `HarnessSessionConfig` — the same
 * description the batch CLI resolves argv into — and `src/session-assembly.ts`
 * turns that into the run. So a capability configurable on the CLI is
 * configurable here by the same name, and the tools a session offers are
 * derived from what it can back rather than listed by this file.
 *
 * The one piece of configuration this surface insists on is the fabric
 * session, whose space has to be a name rather than a `did:key`: `assign_slug`
 * composes a piece's URL from the name and offers none for a DID, and finishing
 * with a link rather than a transcript is what this surface is for.
 */

import { readLoomAuthoringConfig } from "../src/loom-authoring.ts";
import { parseArgs } from "@std/cli/parse-args";
import { isDID } from "@commonfabric/identity/did";
import {
  dirname,
  extname,
  fromFileUrl,
  join,
  resolve,
  toFileUrl,
} from "@std/path";

const moduleDir = dirname(fromFileUrl(import.meta.url));
import {
  defaultHarnessCredentialStorePath,
  FileHarnessCredentialStore,
} from "../src/auth/credential-store.ts";
import {
  OpenAICodexAuthService,
  OpenAICodexCredentialResolver,
} from "../src/auth/openai-codex.ts";
import {
  defaultHarnessProviderSettingsPath,
  FileHarnessProviderSettingsStore,
  resolveHarnessModelProviderPreference,
} from "../src/auth/provider-settings.ts";
import { harnessFabricSessionPostureBanner } from "../src/cfc-posture.ts";
import { parseHarnessForeignSpaces } from "../src/foreign-spaces.ts";
import type {
  HarnessFabricCfcEnforcementMode,
  HarnessFabricCfcFlowLabelsMode,
  HarnessFabricSessionConfig,
  HarnessModelProviderId,
} from "../src/config.ts";
import type { CfcPosture } from "@commonfabric/runner";
import { isObjectOrArray } from "@commonfabric/utils/types";
import {
  type HarnessChatError,
  type HarnessChatEventEnvelope,
  type HarnessChatPolicy,
  type HarnessChatResponse,
} from "../src/contracts/interactive-chat.ts";
import { HARNESS_CREDENTIAL_OWNER_REF_TYPE } from "../src/contracts/run-manifest.ts";
import { createCliPromptSlotBinding } from "../src/contracts/prompt-slot.ts";
import type { HarnessInputCellSpec } from "../src/contracts/input-cells.ts";
import type { HarnessConnectorGrantSpec } from "../src/contracts/well-known-grants.ts";
import {
  connectorGrantLabel,
  connectorGrantName,
} from "../src/well-known-grants.ts";
import {
  DEFAULT_SUBAGENT_PROFILE,
  PATTERN_AUTHOR_SUBAGENT_PROFILE,
} from "../src/contracts/subagent.ts";
import { readHarnessTaskOutcome } from "../src/contracts/task-outcome.ts";
import { parseHostMountSpecs } from "../src/host-mounts.ts";
import {
  checkInputCellSpec,
  parseInputCellArgument,
} from "../src/input-cells.ts";
import type { HarnessPatternRefSpec } from "../src/contracts/pattern-refs.ts";
import {
  checkPatternRefSpec,
  MAX_HARNESS_PATTERN_REFS,
} from "../src/pattern-refs.ts";
import {
  harnessSessionChatPolicy,
  type HarnessSessionConfig,
  harnessSessionEngineOptions,
} from "../src/session-assembly.ts";
import { resolveHarnessSkillsRoot } from "../src/skills/root.ts";
import {
  createHarnessInteractiveChatService,
  type CreateHarnessInteractiveChatServiceOptions,
  type HarnessInteractiveChatEventListener,
  type HarnessInteractiveChatService,
} from "../src/interactive-chat-service.ts";
import { OpenAICodexResponsesClient } from "../src/model/openai-codex-responses.ts";
import {
  cacheHarnessPatternIndexClientFactory,
  createHarnessPatternIndexClientFactory,
  type HarnessPatternIndexClientFactory,
  type PatternIndexClient,
  PatternIndexError,
} from "../src/pattern-index/client.ts";
import {
  feedbackEventType,
  recordPatternFeedback,
} from "../src/tools/record-feedback.ts";
import {
  CFC_INVOCATION_CONTEXT_DIR_ENV,
  CFC_RESULT_DIR_ENV,
} from "../src/sandbox/docker-runsc.ts";
import type { CreateHarnessPromptLoopOptions } from "../src/prompt-loop.ts";
import type { HarnessChatSessionStore } from "../src/session-store.ts";
import { parseConnectorGrants } from "./connector-grants.ts";
import {
  ConsoleHealth,
  type ConsoleHealthRow,
  consoleHealthUrl,
  type ConsoleObservedLaunchHealth,
  type ConsoleResolvedValue,
} from "./health.ts";
import {
  consolePatternIndexHealthProbes,
  consoleSandboxHealthProbe,
} from "./health-probes.ts";
import { type ConsolePolicyReport, consolePolicyReport } from "./policy.ts";
import { liveCanonicalRedirect } from "./src/mount.ts";
import {
  listConsoleRuns,
  readConsoleRun,
  readConsoleRunArtifact,
  readConsoleRunFamilyGraph,
  readConsoleRunFlow,
  readConsoleToolOutput,
} from "./run-store.ts";
import {
  type ConsoleSessionListing,
  summarizeConsoleSessions,
} from "./sessions.ts";
import {
  chatEventFrame,
  envelopesAfter,
  isUndelivered,
  parseAfterSequence,
  pingFrame,
} from "./sse.ts";
import {
  type ConsoleTurnCompletedEvent,
  type ConsoleTurnResult,
  readConsoleTurnResult,
} from "./turn-result.ts";

/** Loopback only. See the module comment on what does and does not protect. */
const HOSTNAME = "127.0.0.1";

/**
 * The host names a request may address this server by: its own loopback
 * addresses at its own port, and the bare forms when the port is the one a
 * browser leaves out. Any other `Host` is a name that resolved here without
 * being this server, which is what a DNS rebinding attack looks like on the
 * wire.
 */
const allowedHosts = (port: number): readonly string[] => [
  `127.0.0.1:${port}`,
  `localhost:${port}`,
  ...(port === 80 ? ["127.0.0.1", "localhost"] : []),
];

/**
 * The paths served from the built page rather than from an API route: the page
 * itself, and the two directories felt emits into.
 */
const ASSET_PATH = /^\/(scripts\/|styles\/|build-manifest\.json$|$)/;

/**
 * The live pane's address, which names the session it shows. It is served the
 * same built page whatever session it names — the page reads the session out
 * of its own address — and it is one of the paths served from the build.
 */
const LIVE_PATH = /^\/live\/[^/]+\/?$/;

/**
 * What the page is allowed to load and where it may send what it holds.
 * Everything it needs comes from this origin, so `'self'` covers its script,
 * its stylesheet, its fetches and its event stream; `style-src` allows inline
 * as well because the run tree indents a row with a `style` attribute. The
 * page renders text a run produced — a model's words, a tool's output, a
 * pattern's source — and this is what keeps markup that reached it that way
 * from loading a script or sending a run's artifacts anywhere else.
 */
const CONTENT_SECURITY_POLICY = [
  "default-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'none'",
].join("; ");

const CONTENT_TYPES: Readonly<Record<string, string>> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".map": "application/json; charset=utf-8",
};

const contentType = (extension: string): string =>
  CONTENT_TYPES[extension] ?? "application/octet-stream";

const DEFAULT_PORT = 8100;
const DEFAULT_FABRIC_API_URL = "http://localhost:8000";

/**
 * The CFC posture a console session runs its fabric session under. This
 * surface exists to show CFC working, so the named bundle is on by default
 * rather than opted into: `max-enforcement` spreads
 * `MAX_ENFORCEMENT_CFC_OPTIONS` over the runtime `run_pattern` deploys into —
 * flow labels `persist`, write floor, policy evaluation, declared monotonicity
 * and label-metadata protection at `enforce`, trigger-read gating on, the
 * standard prompt-caveat policy, and public-only ceilings on the network-fetch
 * sinks. `--fabric-cfc-posture none` turns it off for a run that wants the
 * first-party default instead.
 *
 * The bundle names no enforcement mode, so the session keeps the core's
 * `enforce-strict` pin. Lowering to `enforce-explicit` is a deliberate
 * per-session move, so it has its own flag and no default here.
 */
const DEFAULT_FABRIC_CFC_POSTURE: CfcPosture = "max-enforcement";

/** The CLI's own default model, so both entrypoints bill the same route. */
const DEFAULT_MODEL = "gpt-5.6-sol";

/** How often the stream publishes a liveness tick, in milliseconds. */
const PING_INTERVAL_MS = 15_000;

/**
 * The owner every credential this server reads is filed under. `local` is the
 * key the single-user local host writes, so a harness connected once through
 * `cf-harness config`/Loom Settings is connected here too.
 */
const CONSOLE_CREDENTIAL_OWNER = {
  type: HARNESS_CREDENTIAL_OWNER_REF_TYPE,
  version: 1,
  ownerKey: "local",
} as const;

/**
 * The index functions the Index view may reach through the proxy. Every one of
 * them reads: this surface inspects what the index holds and never writes to
 * it, so a caller that asked for `publishPattern` or `recordEvent` is refused
 * by name rather than by the index. `getPattern` is called without
 * `includeSource`, which is why a pattern's source cannot arrive at the page
 * whatever the page sends.
 *
 * Index writes have dedicated routes: `/api/index/feedback` composes a vote,
 * and `/api/index/retract` submits an owner retraction. Each composes its own
 * request under the console's signer; neither widens this read allowlist.
 */
const INDEX_FUNCTIONS = [
  "searchPatterns",
  "listPatterns",
  "listEvents",
  "getPattern",
] as const;

type IndexFunction = typeof INDEX_FUNCTIONS[number];

/** What a server with no pattern index tells a caller who wanted one. */
const NO_PATTERN_INDEX =
  "this server was started without a pattern index; restart it with --pattern-index-url or CF_HARNESS_PATTERN_INDEX_URL";

const isIndexFunction = (value: unknown): value is IndexFunction =>
  typeof value === "string" &&
  (INDEX_FUNCTIONS as readonly string[]).includes(value);

const stringList = (value: unknown): readonly string[] | undefined =>
  Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === "string")
    : undefined;

/**
 * Dispatches one allowlisted read at the typed client. The request is rebuilt
 * field by field rather than forwarded, so what reaches the index is what this
 * server composed — a page cannot smuggle `includeSource`, or any other field,
 * past the allowlist by putting it in the body.
 */
const callPatternIndex = (
  client: PatternIndexClient,
  fn: IndexFunction,
  body: Readonly<Record<string, unknown>>,
): Promise<unknown> => {
  switch (fn) {
    case "searchPatterns": {
      const tags = stringList(body.tags);
      return client.searchPatterns({
        ...(tags !== undefined ? { tags } : {}),
        ...(typeof body.text === "string" ? { text: body.text } : {}),
        ...(typeof body.limit === "number" ? { limit: body.limit } : {}),
      });
    }
    case "listPatterns":
      return client.listPatterns();
    case "listEvents":
      return client.listEvents({
        ...(typeof body.patternId === "string"
          ? { patternId: body.patternId }
          : {}),
        ...(typeof body.limit === "number" ? { limit: body.limit } : {}),
      });
    case "getPattern":
      return client.getPattern({ patternId: body.patternId as string });
  }
};

/**
 * The input cells a `/api/task` body attaches to the turn it starts, each a
 * `{ name, ref }` pair. The name is what the model is told, the reference is
 * the cell it stands for, and neither the value nor the address ever reaches
 * the page — the run mints a token for the reference and the model works
 * through that.
 *
 * The grammar is the flag's, checked by the flag's own parser, so a spelling
 * the CLI refuses is refused here too. A body that names no cells yields
 * none, which is the ordinary task.
 *
 * A reference may also be a piece's NAME — `pattern:<space>/<slug>`, or a bare
 * slug meaning this console's own space — which is what a surface showing a
 * rendered piece holds. `spaceName` is this console's space, and an address
 * naming another one is refused here: the caller cannot see which space this
 * console runs against, so a mismatch is this side's to explain. Whether the
 * space holds the slug is the turn's to find out, like every other reference
 * that parses and may still not mint.
 *
 * @throws Error naming the defect, which the route answers 400 with.
 */
const parseTaskInputCells = (
  value: unknown,
  spaceName: string,
): readonly HarnessInputCellSpec[] => {
  if (value === undefined || value === null) {
    return [];
  }
  if (!Array.isArray(value)) {
    throw new Error("inputCells must be an array");
  }
  const specs: HarnessInputCellSpec[] = [];
  const names = new Set<string>();
  for (const entry of value) {
    if (!isObjectOrArray(entry)) {
      throw new Error("each input cell must be an object");
    }
    const { name, ref } = entry as { name?: unknown; ref?: unknown };
    if (typeof name !== "string" || typeof ref !== "string") {
      throw new Error("each input cell needs a string name and ref");
    }
    // Checked through the flag's own parser, so the two surfaces cannot come
    // to accept different references under the same name.
    const spec = parseInputCellArgument(`${name}=${ref}`);
    // And then once more against this console's own space, which the flag's
    // parser cannot know. A named piece address spelling another space is a
    // caller mistake decidable from the text alone, so it is answered now
    // rather than spent on a turn; whether this space HOLDS the slug is not
    // decidable from the text, and the turn answers that one.
    checkInputCellSpec(spec, undefined, spaceName);
    if (names.has(spec.name)) {
      throw new Error(`inputCells names \`${spec.name}\` twice`);
    }
    names.add(spec.name);
    specs.push(spec);
  }
  return specs;
};

/**
 * Refuses a task whose input cells collide with the console's own connector
 * grants. Both reach the model as a name paired with a token, so two of the
 * same name is a prompt that says one word for two references — and the caller
 * cannot see the grants to avoid them, which is why the refusal names the
 * connection the grant came from rather than only the word.
 *
 * @throws Error naming both sides, which the route answers 400 with.
 */
const checkTaskInputCellNames = (
  inputCells: readonly HarnessInputCellSpec[],
  connectorGrants: readonly HarnessConnectorGrantSpec[],
): void => {
  for (const cell of inputCells) {
    const grant = connectorGrants.find((entry) => entry.name === cell.name);
    if (grant !== undefined) {
      throw new Error(
        `inputCells names \`${cell.name}\`, which is already this console's ` +
          `grant for the \`${grant.source.connection}\` connector handle`,
      );
    }
  }
};

/**
 * The pattern references a `/api/task` body attaches to the turn it starts,
 * each a `{ patternId }`. An id is the index's own — the content-addressed
 * identity of published source — so it names an entry the index holds or it
 * names nothing, and the reference is the whole of what the caller says.
 *
 * The grammar is the run's, checked by the run's own parser, so a spelling
 * the run refuses is refused here too, before a turn is spent on the read.
 * Whether the index holds the id is the run's to find out. A body that names
 * no patterns yields none, which is the ordinary task.
 *
 * @throws Error naming the defect, which the route answers 400 with.
 */
const parseTaskPatternRefs = (
  value: unknown,
): readonly HarnessPatternRefSpec[] => {
  if (value === undefined || value === null) {
    return [];
  }
  if (!Array.isArray(value)) {
    throw new Error("patternRefs must be an array");
  }
  if (value.length > MAX_HARNESS_PATTERN_REFS) {
    throw new Error(
      `patternRefs takes at most ${MAX_HARNESS_PATTERN_REFS} references`,
    );
  }
  const specs: HarnessPatternRefSpec[] = [];
  const ids = new Set<string>();
  for (const entry of value) {
    if (!isObjectOrArray(entry)) {
      throw new Error("each pattern reference must be an object");
    }
    const { patternId } = entry as { patternId?: unknown };
    if (typeof patternId !== "string") {
      throw new Error("each pattern reference needs a string patternId");
    }
    const spec = { patternId };
    checkPatternRefSpec(spec);
    if (ids.has(patternId)) {
      throw new Error(`patternRefs names \`${patternId}\` twice`);
    }
    ids.add(patternId);
    specs.push(spec);
  }
  return specs;
};

/**
 * Everything the server needs before it can serve a single request: the
 * session every task runs under, plus what belongs to this surface alone.
 *
 * The session half is {@link HarnessSessionConfig}, the same description the
 * batch CLI resolves argv into, so a capability configurable there is
 * configurable here by the same name. This surface adds only what an HTTP
 * server has and a command does not — a port, a durable session store, a
 * seeded system prompt.
 */
interface ConsoleConfig extends HarnessSessionConfig {
  port: number;
  harnessHome: string;

  /** Active configuration values and the source selected by this resolver. */
  healthFacts: readonly ConsoleResolvedValue[];

  /** A fabric session is required here; see `resolveConsoleConfig`. */
  fabricSession: HarnessFabricSessionConfig;

  /**
   * The sandbox's two CFC sidecar transports, always sited: this surface
   * creates them under its own data directory rather than asking an operator
   * to name a path before their first run.
   */
  cfcResultDir: string;
  cfcInvocationContextDir: string;

  sessionDbPath?: string;

  /**
   * System prompt seeded into every console session, read from the file named
   * by `--system-prompt-file`. Absent, a session runs with no system message,
   * which is this surface's default: the parent's only standing guidance is
   * its tool descriptors.
   */
  systemPrompt?: string;
}

/**
 * Reads the seeded system prompt off disk. A named file that is empty or
 * unreadable is a startup failure rather than a session that quietly runs
 * without the prompt the operator asked for — a variant measured against a
 * prompt that never loaded is a variant that measured nothing.
 */
const readSystemPromptFile = (path: string, cwd: string): string => {
  const resolved = resolve(cwd, path);
  let contents: string;
  try {
    contents = Deno.readTextFileSync(resolved);
  } catch (error) {
    throw new Error(
      `--system-prompt-file could not be read: ${resolved}: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
  if (contents.trim() === "") {
    throw new Error(`--system-prompt-file is empty: ${resolved}`);
  }
  return contents;
};

const nonEmpty = (value: string | undefined): string | undefined =>
  value === undefined || value.trim() === "" ? undefined : value.trim();

const requiredUrl = (value: string, flag: string): string => {
  try {
    new URL(value);
  } catch {
    throw new Error(`${flag} must be a valid URL: ${value}`);
  }
  return value;
};

const positiveInteger = (value: string, flag: string): number => {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error(`${flag} must be a positive integer: ${value}`);
  }
  return parsed;
};

/**
 * Resolves configuration from flags over environment over defaults. The space
 * is rejected when it is a `did:key`: a run in such a space can build a piece
 * and never hand back an address for it, which is the one outcome this surface
 * exists to avoid.
 */
export const resolveConsoleConfig = async (
  args: readonly string[],
  env: Record<string, string | undefined>,
  cwd: string,
): Promise<ConsoleConfig> => {
  const parsed = parseArgs(args, {
    string: [
      "port",
      "workspace",
      "artifact-root",
      "model",
      "reasoning-effort",
      "research-reasoning-effort",
      "loom-authoring-config",
      "fabric-api-url",
      "fabric-identity",
      "fabric-space",
      "fabric-foreign-spaces",
      "pattern-index-url",
      "skills-registry-url",
      "skills-root",
      "host-mount",
      "session-db",
      "space-db",
      "max-model-turns",
      "fabric-cfc-enforcement-mode",
      "fabric-cfc-flow-labels",
      "fabric-cfc-posture",
      "system-prompt-file",
    ],
    boolean: [
      "no-child-composition-guidance",
      "no-pattern-index-publish",
      "pattern-index-publish-discoverable",
      "allow-skill-scripts",
    ],
    collect: ["host-mount"],
  });
  const flag = (name: string): string | undefined =>
    typeof parsed[name] === "string" ? nonEmpty(parsed[name]) : undefined;

  const loomAuthoring = await readLoomAuthoringConfig(
    flag("loom-authoring-config") ??
      nonEmpty(env.CF_HARNESS_LOOM_AUTHORING_CONFIG),
  );
  const systemPromptFile = flag("system-prompt-file") ??
    nonEmpty(env.CF_HARNESS_CONSOLE_SYSTEM_PROMPT_FILE);

  const port = flag("port") !== undefined
    ? positiveInteger(flag("port")!, "--port")
    : nonEmpty(env.CF_HARNESS_CONSOLE_PORT) !== undefined
    ? positiveInteger(env.CF_HARNESS_CONSOLE_PORT!, "CF_HARNESS_CONSOLE_PORT")
    : DEFAULT_PORT;

  const dataDir = resolve(
    cwd,
    nonEmpty(env.CF_HARNESS_CONSOLE_DIR) ?? ".cf-harness-console",
  );
  const workspacePath = resolve(
    cwd,
    flag("workspace") ?? nonEmpty(env.CF_HARNESS_CONSOLE_WORKSPACE) ??
      join(dataDir, "workspace"),
  );
  const artifactRoot = resolve(
    cwd,
    flag("artifact-root") ?? nonEmpty(env.CF_HARNESS_ARTIFACT_ROOT) ??
      join(dataDir, "runs"),
  );

  // The sandbox's two CFC sidecar transports. The harness refuses to start an
  // enforcing run without them, and they are scratch directories the host and
  // the sandbox exchange files through, so this surface sites them itself
  // rather than asking an operator to name a path before their first run.
  const cfcResultDir = resolve(
    cwd,
    nonEmpty(env[CFC_RESULT_DIR_ENV]) ?? join(dataDir, "cfc", "results"),
  );
  const cfcInvocationContextDir = resolve(
    cwd,
    nonEmpty(env[CFC_INVOCATION_CONTEXT_DIR_ENV]) ??
      join(dataDir, "cfc", "invocation-context"),
  );

  const identityKeyPath = flag("fabric-identity") ??
    nonEmpty(env.CF_HARNESS_FABRIC_IDENTITY);
  const space = flag("fabric-space") ?? nonEmpty(env.CF_HARNESS_FABRIC_SPACE);
  if (identityKeyPath === undefined || space === undefined) {
    throw new Error(
      "a fabric session is required: set --fabric-identity/CF_HARNESS_FABRIC_IDENTITY and --fabric-space/CF_HARNESS_FABRIC_SPACE",
    );
  }
  if (isDID(space)) {
    throw new Error(
      `--fabric-space must be a space name rather than a DID: assign_slug composes a URL from the name, and offers none for ${space}`,
    );
  }
  const posture = flag("fabric-cfc-posture") ??
    nonEmpty(env.CF_HARNESS_FABRIC_CFC_POSTURE);
  if (
    posture !== undefined && posture !== "none" && posture !== "max-enforcement"
  ) {
    throw new Error(
      `--fabric-cfc-posture must be max-enforcement or none: ${posture}`,
    );
  }
  const flowLabels = flag("fabric-cfc-flow-labels") ??
    nonEmpty(env.CF_HARNESS_FABRIC_CFC_FLOW_LABELS);
  if (
    flowLabels !== undefined &&
    !["off", "observe", "persist"].includes(flowLabels)
  ) {
    throw new Error(
      `--fabric-cfc-flow-labels must be off, observe, or persist: ${flowLabels}`,
    );
  }
  const fabricEnforcement = flag("fabric-cfc-enforcement-mode") ??
    nonEmpty(env.CF_HARNESS_FABRIC_CFC_ENFORCEMENT_MODE);
  if (
    fabricEnforcement !== undefined &&
    !["enforce-explicit", "enforce-strict"].includes(fabricEnforcement)
  ) {
    throw new Error(
      `--fabric-cfc-enforcement-mode must be enforce-explicit or enforce-strict: ${fabricEnforcement}`,
    );
  }
  const fabricSession: HarnessFabricSessionConfig = {
    apiUrl: requiredUrl(
      flag("fabric-api-url") ?? nonEmpty(env.CF_HARNESS_FABRIC_API_URL) ??
        DEFAULT_FABRIC_API_URL,
      "--fabric-api-url",
    ),
    identityKeyPath: resolve(cwd, identityKeyPath),
    space,
    foreignSpaces: parseHarnessForeignSpaces(
      flag("fabric-foreign-spaces") ??
        nonEmpty(env.CF_HARNESS_FABRIC_FOREIGN_SPACES),
    ),
    ...(posture === "none"
      ? {}
      : { cfcPosture: (posture ?? DEFAULT_FABRIC_CFC_POSTURE) as CfcPosture }),
    ...(flowLabels !== undefined
      ? { cfcFlowLabels: flowLabels as HarnessFabricCfcFlowLabelsMode }
      : {}),
    ...(fabricEnforcement !== undefined
      ? {
        cfcEnforcementMode:
          fabricEnforcement as HarnessFabricCfcEnforcementMode,
      }
      : {}),
  };

  // The checkout's skills/ tree gives the pattern-author subagent its
  // preloaded pattern-dev + pattern-schema skills; without a skills root the
  // parent model authors patterns blind and burns turns on idiom errors. The
  // default is found the same way the CLI finds it, so the two surfaces scan
  // one tree.
  const skillsRootRecord = resolveHarnessSkillsRoot(
    flag("skills-root") ?? nonEmpty(env.CF_HARNESS_CONSOLE_SKILLS_ROOT),
  );

  const patternIndexUrl = flag("pattern-index-url") ??
    nonEmpty(env.CF_HARNESS_PATTERN_INDEX_URL);
  // Publishing posture reads exactly as it does on the CLI: on unless turned
  // off, and recorded-only unless discoverability is asked for.
  const patternIndexPublish = parsed["no-pattern-index-publish"] !== true &&
    nonEmpty(env.CF_HARNESS_PATTERN_INDEX_PUBLISH) !== "0";
  const patternIndexPublishDiscoverable =
    parsed["pattern-index-publish-discoverable"] === true ||
    nonEmpty(env.CF_HARNESS_PATTERN_INDEX_PUBLISH_DISCOVERABLE) === "1";
  const skillsRegistryUrl = flag("skills-registry-url") ??
    nonEmpty(env.CF_HARNESS_SKILLS_REGISTRY_URL);
  const sessionDb = flag("session-db") ??
    nonEmpty(env.CF_HARNESS_CONSOLE_SESSION_DB) ??
    join(dataDir, "sessions.sqlite");
  // Pattern-building sessions routinely spend a turn per author/run/fix
  // round; the interactive default of 8 strands a session mid-build.
  const maxModelTurns = flag("max-model-turns") ??
    nonEmpty(env.CF_HARNESS_CONSOLE_MAX_MODEL_TURNS) ?? "32";
  // Unset, a turn names no effort and the provider applies its own default.
  const reasoningEffort = flag("reasoning-effort") ??
    nonEmpty(env.CF_HARNESS_REASONING_EFFORT);
  const researchReasoningEffort = flag("research-reasoning-effort") ??
    nonEmpty(env.CF_HARNESS_RESEARCH_REASONING_EFFORT);

  const spaceDb = flag("space-db") ?? nonEmpty(env.CF_HARNESS_SPACE_DB);
  const spaceDbPath = spaceDb === undefined ? undefined : resolve(cwd, spaceDb);

  const config: Omit<ConsoleConfig, "healthFacts"> = {
    port,
    workspace: workspacePath,
    artifactRoot,
    cfcResultDir,
    cfcInvocationContextDir,
    harnessHome: resolve(
      nonEmpty(env.CF_HARNESS_HOME) ??
        join(nonEmpty(env.HOME) ?? cwd, ".cf-harness"),
    ),
    model: flag("model") ?? nonEmpty(env.CF_HARNESS_MODEL) ?? DEFAULT_MODEL,
    ...(reasoningEffort !== undefined ? { reasoningEffort } : {}),
    ...(researchReasoningEffort !== undefined
      ? { researchReasoningEffort }
      : {}),
    fabricSession,
    ...(loomAuthoring !== undefined ? { loomAuthoring } : {}),
    ...(spaceDbPath !== undefined ? { spaceDbPath } : {}),
    ...(patternIndexUrl !== undefined
      ? {
        patternIndex: {
          baseUrl: requiredUrl(patternIndexUrl, "--pattern-index-url"),
          ...(patternIndexPublish ? {} : { publish: false }),
          ...(patternIndexPublishDiscoverable
            ? { publishDiscoverable: true }
            : {}),
        },
      }
      : {}),
    ...(skillsRegistryUrl !== undefined
      ? {
        skillsSh: {
          baseUrl: requiredUrl(
            skillsRegistryUrl,
            "--skills-registry-url",
          ),
        },
      }
      : {}),
    // `none` turns the durable store off and keeps sessions in memory, which
    // is what a throwaway run wants and what a machine without the SQLite
    // native library can still do.
    ...(sessionDb === "none" ? {} : { sessionDbPath: resolve(cwd, sessionDb) }),
    maxModelTurns: positiveInteger(maxModelTurns, "--max-model-turns"),
    ...(skillsRootRecord !== undefined
      ? { skillsRoot: skillsRootRecord.hostPath, skillsRootRecord }
      : {}),
    ...(systemPromptFile !== undefined
      ? { systemPrompt: readSystemPromptFile(systemPromptFile, cwd) }
      : {}),
    hostMounts: await parseHostMountSpecs(
      parsed["host-mount"] as string[] | undefined,
      cwd,
    ),
    // Whether a skill this console holds may have its scripts run in the
    // sandbox: the operator's one decision, taken at launch rather than per
    // task, since it is about the server rather than about the work.
    allowSkillScripts: parsed["allow-skill-scripts"] === true ||
      nonEmpty(env.CF_HARNESS_ALLOW_SKILL_SCRIPTS) === "1",
    // The rest of the session description this surface does not vary. Skills
    // are scanned rather than preloaded by name, no individual script is
    // named, handles materialize nowhere, and a task's input cells and pattern
    // references arrive per task on `/api/task` rather than at startup.
    skillNames: [],
    allowedSkillScripts: [],
    skillScriptExecutionTarget: "sandbox",
    handleValueOrigins: [],
    inputCells: [],
    // The exception: the connector handles the launcher resolved off the loom
    // instance behind this fabric. They belong to the console rather than to a
    // task, so every session it runs is granted them at start.
    connectorGrants: parseConnectorGrants(
      nonEmpty(env.CF_HARNESS_CONNECTOR_GRANTS),
    ),
    patternRefs: [],
    // The tool surface is left to the session's own backing rather than
    // listed here, so a tool the harness gains reaches this surface with it.
    allowedSubagentProfiles: [
      DEFAULT_SUBAGENT_PROFILE,
      PATTERN_AUTHOR_SUBAGENT_PROFILE,
    ],
    // Stated only when it is being turned off: guidance is what the profile
    // ships with, so saying so restates a default rather than configuring one.
    ...(parsed["no-child-composition-guidance"] === true
      ? { subagentCompositionGuidance: false }
      : {}),
  };
  const source = (name: string, variable: string): string =>
    flag(name) !== undefined
      ? `--${name}`
      : nonEmpty(env[variable]) !== undefined
      ? variable
      : "console default";
  return {
    ...config,
    healthFacts: [{
      name: "port",
      value: String(port),
      source: source("port", "CF_HARNESS_CONSOLE_PORT"),
    }, {
      name: "space",
      value: space,
      source: source("fabric-space", "CF_HARNESS_FABRIC_SPACE"),
    }, {
      name: "store",
      value: spaceDbPath ?? nonEmpty(env.MEMORY_DIR) ?? "automatic discovery",
      source: spaceDbPath !== undefined
        ? source("space-db", "CF_HARNESS_SPACE_DB")
        : nonEmpty(env.MEMORY_DIR) !== undefined
        ? "MEMORY_DIR"
        : "space database discovery at read time",
    }, {
      name: "skill scripts",
      value: config.allowSkillScripts ? "run in the sandbox" : "not run",
      source: parsed["allow-skill-scripts"] === true
        ? "--allow-skill-scripts"
        : nonEmpty(env.CF_HARNESS_ALLOW_SKILL_SCRIPTS) === "1"
        ? "CF_HARNESS_ALLOW_SKILL_SCRIPTS"
        : "console default",
    }, {
      name: "index",
      value: patternIndexUrl ?? "not configured",
      source: source("pattern-index-url", "CF_HARNESS_PATTERN_INDEX_URL"),
    }, {
      name: "model",
      value: config.model ?? DEFAULT_MODEL,
      source: source("model", "CF_HARNESS_MODEL"),
    }, {
      name: "reasoning effort",
      value: reasoningEffort ?? "provider default",
      // An unnamed effort is the provider's choice rather than a console
      // default, so its source says so.
      source: reasoningEffort === undefined
        ? "provider default"
        : source("reasoning-effort", "CF_HARNESS_REASONING_EFFORT"),
    }, {
      name: "research reasoning effort",
      value: researchReasoningEffort ?? "provider default",
      source: researchReasoningEffort === undefined
        ? "provider default"
        : source(
          "research-reasoning-effort",
          "CF_HARNESS_RESEARCH_REASONING_EFFORT",
        ),
    }],
  };
};

/**
 * The prompt slot a console turn is bound under. The page's textarea is the
 * user typing the command themselves — the same standing the batch CLI's
 * prompt argument has, and what authorizes effectful tools under CFC enforce
 * modes.
 */
const CONSOLE_PROMPT_SLOT = createCliPromptSlotBinding({
  kernelName: "cf-harness",
  surface: "console-web",
  role: "direct-command",
});

/**
 * The provider binding, resolved the way the local single-user host resolves
 * it: the persisted preference names the provider, and a Codex provider is
 * preflighted so an unconnected harness is a startup failure rather than a
 * turn that fails after the page said it had started.
 */
const resolveModelOptions = async (
  config: ConsoleConfig,
  env: Record<string, string | undefined>,
): Promise<CreateHarnessPromptLoopOptions> => {
  const providerSettingsStore = new FileHarnessProviderSettingsStore({
    path: defaultHarnessProviderSettingsPath(config.harnessHome),
  });
  const provider: HarnessModelProviderId =
    (await resolveHarnessModelProviderPreference({
      store: providerSettingsStore,
    })).provider;
  if (provider === "openai-compatible-gateway") {
    const apiKey = nonEmpty(env.CF_HARNESS_API_KEY) ??
      nonEmpty(env.OPENAI_API_KEY);
    const gatewayAuthMode = nonEmpty(env.CF_HARNESS_GATEWAY_AUTH_MODE) ===
        "none"
      ? "none" as const
      : "bearer" as const;
    return {
      modelProvider: provider,
      modelAuthSource: gatewayAuthMode === "none" ? "none" : "api-key",
      gatewayAuthMode,
      ...(nonEmpty(env.CF_HARNESS_GATEWAY_BASE_URL) !== undefined
        ? { gatewayBaseUrl: env.CF_HARNESS_GATEWAY_BASE_URL! }
        : {}),
      ...(apiKey !== undefined ? { apiKey } : {}),
    };
  }
  const credentialStore = new FileHarnessCredentialStore({
    path: defaultHarnessCredentialStorePath(config.harnessHome),
  });
  const status = await new OpenAICodexAuthService(
    credentialStore,
    CONSOLE_CREDENTIAL_OWNER.ownerKey,
  ).status();
  if (status.status !== "connected") {
    throw new Error(
      `cf-harness Codex is ${status.status}; connect it with \`cf-harness auth\` before starting the console server`,
    );
  }
  return {
    modelProvider: provider,
    modelAuthSource: "cf-harness-local-store",
    credentialOwner: CONSOLE_CREDENTIAL_OWNER,
    credentialOwnerKey: CONSOLE_CREDENTIAL_OWNER.ownerKey,
    modelClient: new OpenAICodexResponsesClient({
      credentialResolver: new OpenAICodexCredentialResolver({
        store: credentialStore,
        ownerKey: CONSOLE_CREDENTIAL_OWNER.ownerKey,
        credentialOwner: CONSOLE_CREDENTIAL_OWNER,
      }),
      credentialOwner: CONSOLE_CREDENTIAL_OWNER,
    }),
  };
};

const openSessionStore = async (
  sessionDbPath: string,
): Promise<HarnessChatSessionStore> => {
  // The SQLite session store opens its native library as it loads, and only a
  // durable server needs it.
  // deno-lint-ignore cf-imports/no-inline-module-import
  const { openSqliteHarnessChatSessionStore } = await import(
    "../src/sqlite-session-store.ts"
  );
  return await openSqliteHarnessChatSessionStore({
    url: toFileUrl(sessionDbPath),
  });
};

/** Projects the active configuration and retained launch decisions for operators. */
export const consoleHealthRows = (
  config: ConsoleConfig,
  launch?: ConsoleObservedLaunchHealth,
  modelOptions?: CreateHarnessPromptLoopOptions,
  env: Record<string, string | undefined> = {},
): readonly ConsoleHealthRow[] => {
  const checkedAt = new Date().toISOString();
  const groups: Readonly<Record<string, string>> = {
    "skill scripts": "skills",
    index: "index",
    model: "model",
  };
  const rows: ConsoleHealthRow[] = config.healthFacts.map((fact) => {
    // A server flag can override a launch value. Only an equal active value
    // retains the launch record as its source.
    const original = fact.source.startsWith("--")
      ? undefined
      : launch?.resolved.find((entry) =>
        entry.name === fact.name && entry.value === fact.value
      );
    return {
      id: `config.${fact.name.replaceAll(" ", "-")}`,
      group: groups[fact.name] ?? "console",
      label: fact.name.split(" ").map((word) =>
        word.charAt(0).toUpperCase() + word.slice(1)
      ).join(" "),
      value: fact.name === "index" && config.patternIndex !== undefined
        ? consoleHealthUrl(fact.value)
        : fact.value,
      source: original !== undefined
        ? "console launch record"
        : fact.source.startsWith("--")
        ? "console launch flag"
        : "console configuration",
      detail: original?.source ?? fact.source,
      state: fact.name === "store" && fact.value === "automatic discovery"
        ? "unknown"
        : fact.name === "index" && config.patternIndex === undefined
        ? "degraded"
        : "ok",
      checkedAt: original === undefined
        ? checkedAt
        : launch?.checkedAt ?? checkedAt,
      ...(fact.name === "index" && config.patternIndex === undefined
        ? {
          remedy:
            "Start the console with --pattern-index-url or CF_HARNESS_PATTERN_INDEX_URL.",
        }
        : {}),
    };
  });
  rows.unshift({
    id: "console.base",
    group: "console",
    label: "Console Address",
    value: `http://${HOSTNAME}:${config.port}`,
    source: "console listen configuration",
    state: "ok",
    checkedAt,
  });
  if (config.patternIndex === undefined) {
    for (const name of ["reachable", "enrolled"]) {
      rows.push({
        id: `index.${name}`,
        group: "index",
        label: name === "reachable"
          ? "Pattern Index Reachability"
          : "Pattern Index Enrollment",
        value: "not verified",
        source: "console index configuration",
        state: "unknown",
        checkedAt,
        reason: "No pattern index URL is configured.",
      });
    }
  }
  if (launch !== undefined && launch.connectors.length > 0) {
    rows.push(...launch.connectors.map((row): ConsoleHealthRow => ({
      ...row,
      checkedAt: launch.checkedAt,
    })));
  } else {
    rows.push({
      id: "connectors.inventory",
      group: "connectors",
      label: "Connector Inventory",
      state: "unknown",
      checkedAt,
      value: `${config.connectorGrants.length} explicit grants configured`,
      source: "console connector configuration",
      detail: "CF_HARNESS_CONNECTOR_GRANTS; no Loom launch decision record",
      reason:
        "Refused or uninjected connectors cannot be enumerated from the accepted grants alone.",
      remedy:
        "Launch the console for its Loom instance to retain the full connector decision report.",
    });
    rows.push(...config.connectorGrants.map((grant): ConsoleHealthRow => ({
      id: `connector.granted.${grant.name}`,
      group: "connectors",
      label: connectorGrantName(grant.source),
      value: `granted: ${connectorGrantLabel(grant)}`,
      source: "console connector configuration",
      detail: "CF_HARNESS_CONNECTOR_GRANTS",
      state: "ok",
      checkedAt,
    })));
  }
  if (modelOptions === undefined) {
    rows.push({
      id: "model.auth",
      group: "model",
      label: "Model Authentication",
      value: "not checked",
      source: "model credential preflight",
      state: "unknown",
      checkedAt: null,
    });
  } else {
    const provider = modelOptions.modelProvider ?? "openai-compatible-gateway";
    const missingKey = provider === "openai-compatible-gateway" &&
      modelOptions.gatewayAuthMode !== "none" &&
      modelOptions.apiKey === undefined;
    rows.push({
      id: "model.provider",
      group: "model",
      label: "Model Provider",
      value: provider,
      source: "harness provider settings",
      detail: defaultHarnessProviderSettingsPath(config.harnessHome),
      state: "ok",
      checkedAt,
    }, {
      id: "model.auth",
      group: "model",
      label: "Model Authentication",
      value: missingKey
        ? "bearer API key not configured"
        : provider === "openai-codex"
        ? "cf-harness-local-store connected"
        : modelOptions.gatewayAuthMode === "none"
        ? "gateway authentication disabled"
        : "API key configured; provider acceptance not checked",
      source: provider === "openai-codex"
        ? "harness credential store"
        : "console environment",
      detail: provider === "openai-codex"
        ? defaultHarnessCredentialStorePath(config.harnessHome)
        : modelOptions.gatewayAuthMode === "none"
        ? "CF_HARNESS_GATEWAY_AUTH_MODE"
        : missingKey
        ? "CF_HARNESS_API_KEY / OPENAI_API_KEY"
        : nonEmpty(env.CF_HARNESS_API_KEY) !== undefined
        ? "CF_HARNESS_API_KEY"
        : "OPENAI_API_KEY",
      state: missingKey ? "failed" : "ok",
      checkedAt,
      ...(missingKey
        ? {
          remedy:
            "Set CF_HARNESS_API_KEY for the configured model gateway, then restart the console.",
        }
        : {}),
    });
  }
  return rows;
};

/** Combines retained decisions with independently cached host probes. */
const createConsoleHealth = (
  config: ConsoleConfig,
  launch?: ConsoleObservedLaunchHealth,
  modelOptions?: CreateHarnessPromptLoopOptions,
  env?: Record<string, string | undefined>,
  indexFactory?: HarnessPatternIndexClientFactory,
): ConsoleHealth =>
  new ConsoleHealth(consoleHealthRows(config, launch, modelOptions, env), [
    consoleSandboxHealthProbe(),
    ...(indexFactory !== undefined && config.patternIndex !== undefined
      ? consolePatternIndexHealthProbes(
        config.patternIndex.baseUrl,
        indexFactory,
      )
      : []),
  ]);

/**
 * One connected browser. `deliveredSequence` is what it has been written so
 * far, and `pending` holds envelopes that arrived while its backfill was still
 * being read — a stream is registered before its backfill is fetched, so no
 * event can fall between the two, and the sequence check makes the overlap
 * harmless.
 */
interface StreamClient {
  controller: ReadableStreamDefaultController<Uint8Array>;
  sessionId?: string;
  deliveredSequence: number;
  ready: boolean;
  pending: HarnessChatEventEnvelope[];
}

const encoder = new TextEncoder();

/**
 * The events that close a turn. The run behind one is settled on disk once it
 * is emitted, and the page re-reads the run when it arrives.
 */
const TERMINAL_TURN_EVENT_KINDS: ReadonlySet<string> = new Set([
  "turn_completed",
  "turn_failed",
  "turn_canceled",
]);

/** The live event fan-out, and the routes that read and write through it. */
export class ConsoleServer {
  readonly #clients = new Set<StreamClient>();
  readonly #config: ConsoleConfig;
  readonly #service: HarnessInteractiveChatService;
  readonly #health: ConsoleHealth;
  readonly #patternIndexClientFactory:
    | HarnessPatternIndexClientFactory
    | undefined;

  /**
   * The tail of the fan-out a terminal event is holding, or `undefined` when
   * nothing is waiting — which is the ordinary case, and the one where an
   * envelope reaches the streams on the call that broadcast it.
   */
  #heldFanOut: Promise<void> | undefined;

  #beats = 0;

  /**
   * The service is built here rather than handed in because it is built
   * around this server's own fan-out: `onEvent` is where a turn's events
   * become the page's feed, and the two have no order to be constructed in
   * otherwise. This is the seam the NDJSON stdio transport keeps for the same
   * reason.
   *
   * The index client is the other way round: it reads the fabric identity from
   * disk to sign with, so it is built lazily, cached once healthy, and handed
   * in by a test that has no keyfile to read.
   */
  constructor(
    config: ConsoleConfig,
    createService: (
      onEvent: HarnessInteractiveChatEventListener,
    ) => HarnessInteractiveChatService,
    patternIndexClientFactory?: HarnessPatternIndexClientFactory,
    health?: ConsoleHealth,
  ) {
    this.#config = config;
    this.#service = createService((envelope) => this.broadcast(envelope));
    const factory = patternIndexClientFactory ??
      (config.patternIndex !== undefined
        ? createHarnessPatternIndexClientFactory(
          config.patternIndex,
          config.fabricSession.identityKeyPath,
        )
        : undefined);
    this.#patternIndexClientFactory = factory === undefined
      ? undefined
      : cacheHarnessPatternIndexClientFactory(factory);
    this.#health = health ?? createConsoleHealth(
      config,
      undefined,
      undefined,
      undefined,
      this.#patternIndexClientFactory,
    );
  }

  /** The chat service this server fronts, for startup and shutdown. */
  get service(): HarnessInteractiveChatService {
    return this.#service;
  }

  /**
   * Writes one envelope to every stream that has not already seen it.
   *
   * The event that closes a turn carries the turn's result, which is read
   * from the run's artifacts, so that event is held while the read runs.
   * Nothing of the turn waits behind the event that closes it, and an
   * envelope broadcast while one is held queues behind it, so the stream
   * stays in sequence order — which is the order it delivers in or not at
   * all.
   */
  broadcast(envelope: HarnessChatEventEnvelope): Promise<void> {
    if (
      !TERMINAL_TURN_EVENT_KINDS.has(envelope.event.kind) &&
      this.#heldFanOut === undefined
    ) {
      this.#fanOut(envelope);
      return Promise.resolve();
    }
    const held = (this.#heldFanOut ?? Promise.resolve())
      .then(async () => this.#fanOut(await this.#consoleEnvelope(envelope)));
    this.#heldFanOut = held;
    void held.finally(() => {
      if (this.#heldFanOut === held) {
        this.#heldFanOut = undefined;
      }
    });
    return held;
  }

  async #consoleEnvelope(
    envelope: HarnessChatEventEnvelope,
  ): Promise<HarnessChatEventEnvelope> {
    if (envelope.event.kind !== "turn_completed") {
      return envelope;
    }
    const result = await this.#readTurnResult(
      envelope.sessionId,
      envelope.event.turnId,
    ) ?? {
      ...(envelope.event.outcome === "question"
        ? { outcome: "question" as const, question: envelope.event.question }
        : envelope.event.outcome === "gave-up"
        ? { outcome: "gave-up" as const, reason: envelope.event.reason }
        : { outcome: "completed" as const }),
      sessionId: envelope.sessionId,
      continuable: this.#sessionContinuable(envelope.sessionId),
      pieces: [],
      looms: [],
      spaceName: this.#config.fabricSession.space,
      finalText: envelope.event.finalText ?? "",
    };
    const taskOutcome = readHarnessTaskOutcome(result);
    if (taskOutcome === undefined) {
      throw new Error("console result contains an invalid task outcome");
    }
    const event: ConsoleTurnCompletedEvent = {
      ...envelope.event,
      ...taskOutcome,
      result,
    };
    return {
      ...envelope,
      event,
    };
  }

  #sessionContinuable(sessionId: string): boolean {
    const [session] = this.#service.status(sessionId).sessions;
    return session?.status === "idle" && session.reusable;
  }

  async #readTurnResult(
    sessionId: string,
    turnId: string,
  ): Promise<ConsoleTurnResult | undefined> {
    const [session] = this.#service.status(sessionId).sessions;
    const turns = await this.#service.listTurnsForReplay({ sessionId });
    const turn = turns.turns.find((entry) => entry.turn.turnId === turnId);
    const originLoomId = turn?.input.loomId;
    return await readConsoleTurnResult({
      sessionId,
      continuable: this.#sessionContinuable(sessionId),
      ...(originLoomId !== undefined ? { originLoomId } : {}),
      artifactRoot: session?.artifactRoot ?? this.#config.artifactRoot,
      turnId,
      spaceName: this.#config.fabricSession.space,
      timing: turn?.turn,
    });
  }

  #fanOut(envelope: HarnessChatEventEnvelope): void {
    for (const client of this.#clients) {
      if (
        client.sessionId !== undefined &&
        client.sessionId !== envelope.sessionId
      ) {
        continue;
      }
      if (!client.ready) {
        client.pending.push(envelope);
        continue;
      }
      this.#write(client, envelope);
    }
  }

  /** Publishes a liveness tick so a quiet session still reads as alive. */
  ping(): void {
    const frame = encoder.encode(pingFrame(++this.#beats));
    for (const client of this.#clients) {
      this.#enqueue(client, frame);
    }
  }

  async handle(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const refusal = this.#refuse(request, url);
    if (refusal !== undefined) {
      return refusal;
    }
    // The live pane's assets are written relative to `/live/<sessionId>`
    // (`./src/mount.ts`), so the trailing-slash form is sent to the
    // canonical one rather than served with a stylesheet that cannot load.
    // Relative `Location`: it resolves under any host prefix on the client.
    // The query rides along: `?turn=` and `?piecesBase=` are the address.
    const canonical = request.method === "GET"
      ? liveCanonicalRedirect(url.pathname, url.search)
      : undefined;
    if (canonical !== undefined) {
      return new Response(null, {
        status: 308,
        headers: { location: canonical },
      });
    }
    if (request.method === "GET" && url.pathname === "/api/health") {
      return Response.json({
        ok: true,
        fabricApiUrl: this.#config.fabricSession.apiUrl,
        fabricSession: "unverified",
      });
    }
    if (request.method === "GET" && url.pathname === "/api/health/detail") {
      return Response.json(this.#health.snapshot());
    }
    if (
      request.method === "GET" &&
      (ASSET_PATH.test(url.pathname) || LIVE_PATH.test(url.pathname))
    ) {
      const response = await this.#asset(url.pathname);
      response.headers.set(
        "content-security-policy",
        CONTENT_SECURITY_POLICY,
      );
      return response;
    }
    if (request.method === "POST" && url.pathname === "/api/task") {
      return await this.#startTask(request);
    }
    if (request.method === "POST" && url.pathname === "/api/index/call") {
      return await this.#indexCall(request);
    }
    if (request.method === "POST" && url.pathname === "/api/index/feedback") {
      return await this.#indexFeedback(request);
    }
    if (request.method === "POST" && url.pathname === "/api/index/retract") {
      return await this.#indexRetract(request);
    }
    if (request.method === "POST" && url.pathname === "/api/cancel") {
      return await this.#cancel(request);
    }
    if (request.method === "GET" && url.pathname === "/api/sessions") {
      return Response.json(await this.#sessions());
    }
    if (request.method === "GET" && url.pathname === "/api/status") {
      return Response.json({
        artifactRoot: this.#config.artifactRoot,
        ...this.#service.status(url.searchParams.get("sessionId") ?? undefined),
      });
    }
    if (request.method === "GET" && url.pathname === "/api/policy") {
      return Response.json(this.#policy());
    }
    if (
      request.method === "GET" && url.pathname.startsWith("/api/turns/")
    ) {
      return await this.#turnResult(url);
    }
    if (request.method === "GET" && url.pathname === "/api/events") {
      return this.#events(url);
    }
    if (request.method === "GET" && url.pathname === "/api/runs") {
      return Response.json({
        runs: await listConsoleRuns(this.#config.artifactRoot),
      });
    }
    if (request.method === "GET" && url.pathname.startsWith("/api/runs/")) {
      return await this.#run(url);
    }
    return new Response("not found", { status: 404 });
  }

  /**
   * What stands between this socket and the rest of the web, or nothing when
   * the request may proceed. One gate, covering every route including the
   * page: a request that arrived under another name was addressed to somewhere
   * else, whatever it asks for.
   */
  #refuse(request: Request, url: URL): Response | undefined {
    const port = this.#config.port;
    // The `Host` header is what an HTTP/1.1 client addressed; an HTTP/2 client
    // sends `:authority` instead, which is the authority the request URL was
    // built from.
    const host = request.headers.get("host") ?? url.host;
    if (!allowedHosts(port).includes(host)) {
      return new Response("forbidden", { status: 403 });
    }
    if (!url.pathname.startsWith("/api/")) {
      return undefined;
    }
    if (
      request.method === "POST" &&
      !(request.headers.get("content-type") ?? "").startsWith(
        "application/json",
      )
    ) {
      return new Response("unsupported media type", { status: 415 });
    }
    return undefined;
  }

  /**
   * One turn's durable external result, or where the turn stands instead.
   * The answer follows the turn's status: a turn still running is 409, and a
   * poller asks again; a completed turn is its result, or 404 when the
   * artifacts cannot supply one; a failed or canceled turn is 410, because
   * its result will never exist. A poller stops on anything but 409.
   */
  async #turnResult(url: URL): Promise<Response> {
    const match = /^\/api\/turns\/([^/]+)\/result$/.exec(url.pathname);
    if (match === null) {
      return new Response("not found", { status: 404 });
    }
    let turnId: string;
    try {
      turnId = decodeURIComponent(match[1]);
    } catch {
      return new Response("not found", { status: 404 });
    }
    const turns = await this.#service.listTurnsForReplay({});
    const turn = turns.turns.find((entry) => entry.turn.turnId === turnId);
    if (turn === undefined) {
      return Response.json({
        code: "turn_not_found",
        error: `turn ${turnId} was not found`,
      }, { status: 404 });
    }
    switch (turn.turn.status) {
      case "running":
      case "canceling":
        return Response.json({
          code: "turn_not_completed",
          error: `turn ${turnId} has not completed`,
        }, { status: 409 });
      case "failed":
        return Response.json({
          code: "turn_failed",
          error: `turn ${turnId} failed`,
          ...(turn.turn.error !== undefined ? { detail: turn.turn.error } : {}),
        }, { status: 410 });
      case "canceled":
        return Response.json({
          code: "turn_canceled",
          error: `turn ${turnId} was canceled`,
          ...(turn.turn.cancelReason !== undefined
            ? { detail: turn.turn.cancelReason }
            : {}),
        }, { status: 410 });
      case "completed":
        break;
    }
    const result = await this.#readTurnResult(turn.sessionId, turnId);
    return result === undefined
      ? Response.json({
        code: "turn_result_unavailable",
        error: `result for turn ${turnId} is unavailable`,
      }, { status: 404 })
      : Response.json(result);
  }

  /**
   * One run's artifacts: the run whole, one named artifact of it, or one tool
   * output. The path is read rather than pattern-matched because a run id is
   * a path segment and the store is what decides whether it is a legal one —
   * a name this cannot resolve is a 404 rather than a read of somewhere else.
   */
  async #run(url: URL): Promise<Response> {
    const [runId, kind, name, ...rest] = url.pathname
      .slice("/api/runs/".length)
      .split("/")
      .map(decodeURIComponent);
    if (runId === undefined || runId === "" || rest.length > 0) {
      return new Response("not found", { status: 404 });
    }
    const root = this.#config.artifactRoot;
    if (kind === undefined || kind === "") {
      const detail = await readConsoleRun(root, runId);
      return detail === undefined
        ? new Response("not found", { status: 404 })
        : Response.json(detail);
    }
    // `flow` and `graph` take no name, so a trailing segment is a URL this
    // server does not serve rather than one to answer anyway.
    if ((kind === "flow" || kind === "graph") && name !== undefined) {
      return new Response("not found", { status: 404 });
    }
    if (kind === "flow") {
      const flow = await readConsoleRunFlow(root, runId);
      return flow === undefined
        ? new Response("not found", { status: 404 })
        : Response.json(flow);
    }
    if (kind === "graph") {
      const graph = await readConsoleRunFamilyGraph(root, runId);
      return graph === undefined
        ? new Response("not found", { status: 404 })
        : Response.json(graph);
    }
    if (name === undefined || name === "") {
      return new Response("not found", { status: 404 });
    }
    const text = kind === "artifacts"
      ? await readConsoleRunArtifact(root, runId, name)
      : kind === "tool-outputs"
      ? await readConsoleToolOutput(root, runId, name)
      : undefined;
    return text === undefined
      ? new Response("not found", { status: 404 })
      : new Response(text, {
        headers: { "content-type": "application/json; charset=utf-8" },
      });
  }

  /**
   * One file of the built pages. They are a felt build under `dist/`, so a
   * server started before `deno task console:build` has nothing to serve and
   * says which command produces it rather than answering an empty 404.
   */
  async #asset(pathname: string): Promise<Response> {
    const live = LIVE_PATH.test(pathname);
    const page = pathname === "/" || live;
    const relativePath = pathname === "/"
      ? "index.html"
      : live
      ? "live.html"
      : pathname.slice(1);
    if (relativePath.split("/").some((segment) => segment === "..")) {
      return new Response("not found", { status: 404 });
    }
    const path = join(moduleDir, "dist", relativePath);
    try {
      const body = await Deno.readFile(path);
      return new Response(body, {
        headers: { "content-type": contentType(extname(path)) },
      });
    } catch {
      return new Response(
        page
          ? "the console page is not built; run `deno task --cwd packages/cf-harness console:build`"
          : "not found",
        {
          status: 404,
          headers: { "content-type": "text/plain; charset=utf-8" },
        },
      );
    }
  }

  /**
   * Every session this server knows, described well enough to choose one from.
   * The turns are read for replay so a session recovered from the store on
   * startup is named by the task it was given rather than by its identifier.
   */
  async #sessions(): Promise<ConsoleSessionListing> {
    const turns = await this.#service.listTurnsForReplay({});
    return summarizeConsoleSessions(this.#service.status(), turns.turns);
  }

  /**
   * The policy every new session here is started with. One expression rather
   * than two because `/api/policy` answers for the sessions `/api/task`
   * creates, and a client that acts on the answer is owed the same object the
   * next session actually gets.
   */
  #sessionPolicy(): HarnessChatPolicy {
    return harnessSessionChatPolicy(this.#config, CONSOLE_PROMPT_SLOT);
  }

  /**
   * What a new session would run under. The seeded system prompt crosses as a
   * digest, so a client can check that this console holds the prompt it was
   * told to measure without the prompt's text leaving the process.
   */
  #policy(): ConsolePolicyReport {
    return consolePolicyReport({
      policy: this.#sessionPolicy(),
      fabricSpace: this.#config.fabricSession.space,
      artifactRoot: this.#config.artifactRoot,
      ...(this.#config.systemPrompt !== undefined
        ? { systemPrompt: this.#config.systemPrompt }
        : {}),
      ...(this.#config.sessionDbPath !== undefined
        ? { sessionDbPath: this.#config.sessionDbPath }
        : {}),
    });
  }

  /**
   * Starts a turn, in the session the request names or in a new one. One
   * request rather than two because a session with no turn is not a thing
   * anyone asked for, and the page needs both identifiers before it can
   * subscribe or cancel. A named session that cannot take another turn — it
   * was closed, or its transcript did not survive a restart — is the service's
   * refusal to report, not this server's to anticipate.
   */
  async #startTask(request: Request): Promise<Response> {
    let parsed: unknown;
    try {
      parsed = await request.json();
    } catch {
      return Response.json({ error: "request body is not JSON" }, {
        status: 400,
      });
    }
    const body: {
      text?: unknown;
      sessionId?: unknown;
      inputCells?: unknown;
      patternRefs?: unknown;
      loomId?: unknown;
    } = isObjectOrArray(parsed) ? parsed : {};
    if (
      body.loomId !== undefined &&
      (typeof body.loomId !== "string" ||
        !/^loom-[a-f0-9]{16}$/.test(body.loomId))
    ) {
      return Response.json({
        error: "loomId must be a canonical Loom identifier",
      }, { status: 400 });
    }
    const text = body.text;
    if (typeof text !== "string" || text.trim() === "") {
      return Response.json({ error: "text is required" }, { status: 400 });
    }
    if (body.sessionId !== undefined && typeof body.sessionId !== "string") {
      return Response.json({ error: "sessionId must be a string" }, {
        status: 400,
      });
    }
    let inputCells: readonly HarnessInputCellSpec[];
    let patternRefs: readonly HarnessPatternRefSpec[];
    try {
      inputCells = parseTaskInputCells(
        body.inputCells,
        this.#config.fabricSession.space,
      );
      checkTaskInputCellNames(inputCells, this.#config.connectorGrants);
      patternRefs = parseTaskPatternRefs(body.patternRefs);
    } catch (error) {
      return Response.json({
        error: error instanceof Error ? error.message : String(error),
      }, { status: 400 });
    }
    let sessionId = body.sessionId;
    if (sessionId === undefined) {
      const session = await this.#service.startSession(crypto.randomUUID(), {
        workspace: { hostPath: this.#config.workspace },
        model: this.#config.model,
        artifactRoot: this.#config.artifactRoot,
        policy: this.#sessionPolicy(),
      });
      if (!session.ok) {
        return chatErrorResponse(session);
      }
      sessionId = session.result.sessionId;
    }
    const turn = await this.#service.startTurn(crypto.randomUUID(), {
      sessionId,
      input: {
        text,
        ...(typeof body.loomId === "string" ? { loomId: body.loomId } : {}),
      },
      ...(body.inputCells !== undefined && body.inputCells !== null
        ? { inputCells }
        : {}),
      ...(patternRefs.length > 0 ? { patternRefs } : {}),
    });
    if (!turn.ok) {
      return chatErrorResponse(turn);
    }
    return Response.json({ sessionId, turnId: turn.result.turnId });
  }

  async #cancel(request: Request): Promise<Response> {
    let body: { sessionId?: unknown; turnId?: unknown };
    try {
      body = await request.json();
    } catch {
      return Response.json({ error: "request body is not JSON" }, {
        status: 400,
      });
    }
    if (typeof body.sessionId !== "string") {
      return Response.json({ error: "sessionId is required" }, { status: 400 });
    }
    const response = await this.#service.cancelTurn(
      crypto.randomUUID(),
      body.sessionId,
      typeof body.turnId === "string" ? body.turnId : undefined,
      "canceled from the console page",
    );
    return response.ok
      ? Response.json(response.result)
      : chatErrorResponse(response);
  }

  /**
   * One read of the pattern index, signed with this server's fabric identity.
   * The page holds no key and reaches no other host: it names a function from
   * `INDEX_FUNCTIONS` and this composes the request, so what the index sees is
   * the operator's own identity and nothing the page could have addressed
   * elsewhere. The route sits under `/api/`, so the `Host` gate has already
   * refused a request that addressed this server by another name.
   */
  async #indexCall(request: Request): Promise<Response> {
    const factory = this.#patternIndexClientFactory;
    if (factory === undefined) {
      return Response.json({ error: NO_PATTERN_INDEX }, { status: 404 });
    }
    let parsed: unknown;
    try {
      parsed = await request.json();
    } catch {
      return Response.json({ error: "request body is not JSON" }, {
        status: 400,
      });
    }
    const envelope: { fn?: unknown; body?: unknown } = isObjectOrArray(parsed)
      ? parsed
      : {};
    if (!isIndexFunction(envelope.fn)) {
      return Response.json({
        error: `fn must be one of ${INDEX_FUNCTIONS.join(", ")}`,
      }, { status: 400 });
    }
    const body: Record<string, unknown> = isObjectOrArray(envelope.body)
      ? envelope.body as Record<string, unknown>
      : {};
    if (envelope.fn === "getPattern" && typeof body.patternId !== "string") {
      return Response.json({ error: "patternId is required" }, { status: 400 });
    }
    try {
      const client = await factory();
      return Response.json(await callPatternIndex(client, envelope.fn, body));
    } catch (error) {
      return this.#indexFailure(error, "index proxy");
    }
  }

  /**
   * One vote on a pattern, recorded against the index under this server's
   * fabric identity. The caller supplies a pattern id and a verdict and
   * nothing else: the event is composed here, from the same verdict mapping
   * the `record_feedback` tool records through, so the two surfaces cannot
   * come to vote differently.
   *
   * This dedicated write route leaves `#indexCall`'s allowlist read-only.
   */
  async #indexFeedback(request: Request): Promise<Response> {
    const factory = this.#patternIndexClientFactory;
    if (factory === undefined) {
      return Response.json({ error: NO_PATTERN_INDEX }, { status: 503 });
    }
    let parsed: unknown;
    try {
      parsed = await request.json();
    } catch {
      return Response.json({ error: "request body is not JSON" }, {
        status: 400,
      });
    }
    const { patternId, verdict } = (isObjectOrArray(parsed) ? parsed : {}) as {
      patternId?: unknown;
      verdict?: unknown;
    };
    if (typeof patternId !== "string" || patternId === "") {
      return Response.json({ error: "patternId is required" }, { status: 400 });
    }
    const eventType = feedbackEventType(verdict);
    if (eventType === undefined) {
      return Response.json({ error: 'verdict must be "up" or "down"' }, {
        status: 400,
      });
    }
    try {
      const client = await factory();
      const recorded = await recordPatternFeedback(client, {
        patternId,
        eventType,
      });
      return recorded.ok
        ? Response.json({ patternId, eventType, recordedBy: client.did })
        : Response.json({ error: recorded.message }, { status: 502 });
    } catch (error) {
      return this.#indexFailure(error, "index feedback");
    }
  }

  /**
   * Retracts one owned generation through the index's existing authorization
   * and successor checks. Identity and timestamps come from the signed call
   * and index receipt, while the caller supplies only the two ids and reason.
   */
  async #indexRetract(request: Request): Promise<Response> {
    const factory = this.#patternIndexClientFactory;
    if (factory === undefined) {
      return Response.json({ error: NO_PATTERN_INDEX }, { status: 503 });
    }
    let parsed: unknown;
    try {
      parsed = await request.json();
    } catch {
      return Response.json({ error: "request body is not JSON" }, {
        status: 400,
      });
    }
    const { patternId, successorPatternId, reason } =
      (isObjectOrArray(parsed) ? parsed : {}) as {
        patternId?: unknown;
        successorPatternId?: unknown;
        reason?: unknown;
      };
    if (typeof patternId !== "string" || patternId.trim() === "") {
      return Response.json({ error: "patternId is required" }, { status: 400 });
    }
    if (
      typeof successorPatternId !== "string" || successorPatternId.trim() === ""
    ) {
      return Response.json({
        error:
          "successorPatternId is required: retraction needs an existing same-owner direct successor; standalone deletion is not supported",
      }, {
        status: 400,
      });
    }
    if (typeof reason !== "string" || reason.trim() === "") {
      return Response.json({ error: "reason is required" }, { status: 400 });
    }
    try {
      const client = await factory();
      return Response.json(
        await client.retractPattern({
          patternId,
          successorPatternId,
          reason,
        }),
      );
    } catch (error) {
      return this.#indexFailure(error, "index retraction");
    }
  }

  /**
   * Renders one failed index call for whoever asked. The index's own status is
   * passed through when it named a fault in the request — a pattern that is
   * not there, an identity it will not take — and anything else reads as this
   * server failing to reach it.
   *
   * Only the typed index error's stable message crosses the wire. A
   * `PatternIndexError`'s detail is the index's body, which is not what an
   * operator page renders; and a host-side failure — an unreadable identity
   * keyfile among them — can name paths this machine's operator configured,
   * which the caller has no business reading. `where` says which route was
   * being served, for the log alone.
   */
  #indexFailure(error: unknown, where: string): Response {
    if (error instanceof PatternIndexError) {
      const status = error.status >= 400 && error.status < 500
        ? error.status
        : 502;
      return Response.json({ error: error.message }, { status });
    }
    // The generic answer promises the log carries the detail, so it must.
    console.error(`${where} failed host-side:`, error);
    return Response.json(
      { error: "the index request failed on this server; see its log" },
      { status: 502 },
    );
  }

  /**
   * Opens one event stream. The backfill is read after the stream is
   * registered, so an envelope emitted in between is buffered rather than
   * lost, and written in sequence order once the backfill has been sent.
   */
  #events(url: URL): Response {
    const sessionId = url.searchParams.get("sessionId") ?? undefined;
    let afterSequence: number | undefined;
    try {
      afterSequence = parseAfterSequence(url.searchParams.get("afterSequence"));
    } catch (error) {
      return Response.json({
        error: error instanceof Error ? error.message : String(error),
      }, { status: 400 });
    }
    const resumeFrom = afterSequence ?? 0;
    let client: StreamClient | undefined;
    const stream = new ReadableStream<Uint8Array>({
      start: (controller) => {
        client = {
          controller,
          ...(sessionId !== undefined ? { sessionId } : {}),
          deliveredSequence: resumeFrom,
          ready: false,
          pending: [],
        };
        this.#clients.add(client);
        controller.enqueue(encoder.encode(": connected\n\n"));
        this.#backfill(client, sessionId, resumeFrom);
      },
      cancel: () => {
        if (client !== undefined) {
          this.#clients.delete(client);
        }
      },
    });
    return new Response(stream, {
      headers: {
        "content-type": "text/event-stream",
        "cache-control": "no-cache",
      },
    });
  }

  #backfill(
    client: StreamClient,
    sessionId: string | undefined,
    afterSequence: number,
  ): void {
    this.#service.listEventsForReplay({
      ...(sessionId !== undefined ? { sessionId } : {}),
      afterSequence,
    }).then(async (replay) => {
      for (const envelope of envelopesAfter(replay.events, afterSequence)) {
        this.#write(client, await this.#consoleEnvelope(envelope));
      }
      for (const envelope of envelopesAfter(client.pending, afterSequence)) {
        this.#write(client, await this.#consoleEnvelope(envelope));
      }
      client.pending.length = 0;
      client.ready = true;
    }).catch((error: unknown) => {
      this.#clients.delete(client);
      try {
        client.controller.error(error);
      } catch {
        // The browser closed the stream first; nothing left to report to.
      }
    });
  }

  #write(client: StreamClient, envelope: HarnessChatEventEnvelope): void {
    if (!isUndelivered(envelope, client.deliveredSequence)) {
      return;
    }
    if (this.#enqueue(client, encoder.encode(chatEventFrame(envelope)))) {
      client.deliveredSequence = envelope.sequence;
    }
  }

  #enqueue(client: StreamClient, frame: Uint8Array): boolean {
    try {
      client.controller.enqueue(frame);
      return true;
    } catch {
      // A dead controller is dropped rather than retried, so the set of
      // clients cannot grow without bound.
      this.#clients.delete(client);
      return false;
    }
  }
}

const CHAT_ERROR_STATUS: Readonly<Record<HarnessChatError["code"], number>> = {
  invalid_request: 400,
  session_exists: 409,
  session_not_found: 404,
  turn_exists: 409,
  turn_not_found: 404,
  turn_already_running: 409,
  turn_canceled: 409,
  session_closed: 409,
  incomplete_transcript: 409,
  browser_access_required: 409,
  policy_denied: 403,
  "provider-configuration-required": 503,
  "provider-auth-required": 503,
  "provider-mismatch": 409,
  "provider-unavailable": 503,
  internal_error: 500,
};

const chatErrorResponse = (response: HarnessChatResponse): Response =>
  response.ok ? Response.json(response.result) : Response.json(
    { error: response.error.message, code: response.error.code },
    { status: CHAT_ERROR_STATUS[response.error.code] },
  );

/**
 * Carries resolved console configuration into each interactive chat session.
 */
export const createConsoleInteractiveServiceOptions = (
  config: ConsoleConfig,
  modelOptions: CreateHarnessPromptLoopOptions,
  onEvent: HarnessInteractiveChatEventListener,
  sessionStore?: HarnessChatSessionStore,
): CreateHarnessInteractiveChatServiceOptions => ({
  basePromptLoopOptions: {
    ...harnessSessionEngineOptions(config),
    ...modelOptions,
  },
  ...(config.systemPrompt !== undefined
    ? { systemPrompt: config.systemPrompt }
    : {}),
  ...(modelOptions.credentialOwner !== undefined
    ? { credentialOwner: modelOptions.credentialOwner }
    : {}),
  ...(sessionStore !== undefined ? { sessionStore } : {}),
  // Console turn ids are process-generated UUIDs and name the durable run
  // directory that its result route reads. Other interactive transports keep
  // their existing run-id policy.
  runIdForTurn: (_sessionId, turnId) => turnId,
  onEvent,
});

/**
 * Builds the service and starts serving. The fabric session and the pattern
 * index reach the engine as resolved configuration on the base prompt-loop
 * options: `CreateHarnessPromptLoopOptions` extends the engine's options,
 * which extend the config resolver's, and the interactive service spreads this
 * object into every turn — so what is set here holds for the whole session,
 * and the engine builds both lazily-cached client factories from it.
 */
export const startConsoleServer = async (
  args: readonly string[] = Deno.args,
  env: Record<string, string | undefined> = Deno.env.toObject(),
  cwd: string = Deno.cwd(),
  launchHealth?: ConsoleObservedLaunchHealth,
): Promise<void> => {
  const config = await resolveConsoleConfig(args, env, cwd);
  for (
    const directory of [
      config.workspace,
      config.artifactRoot,
      config.cfcResultDir,
      config.cfcInvocationContextDir,
    ]
  ) {
    await Deno.mkdir(directory, { recursive: true });
  }
  const modelOptions = await resolveModelOptions(config, env);
  const sessionStore = config.sessionDbPath === undefined
    ? undefined
    : await openSessionStore(config.sessionDbPath);

  const indexFactory = config.patternIndex === undefined
    ? undefined
    : cacheHarnessPatternIndexClientFactory(
      createHarnessPatternIndexClientFactory(
        config.patternIndex,
        config.fabricSession.identityKeyPath,
      ),
    );

  const server = new ConsoleServer(
    config,
    (onEvent) =>
      createHarnessInteractiveChatService(
        createConsoleInteractiveServiceOptions(
          config,
          modelOptions,
          onEvent,
          sessionStore,
        ),
      ),
    indexFactory,
    createConsoleHealth(config, launchHealth, modelOptions, env, indexFactory),
  );
  await server.service.initializeFromStore();

  const beat = setInterval(() => server.ping(), PING_INTERVAL_MS);
  Deno.serve({
    hostname: HOSTNAME,
    port: config.port,
    onListen: () => {
      console.log(`\n  cf-harness console: http://${HOSTNAME}:${config.port}`);
      console.log(`  space:      ${config.fabricSession.space}`);
      console.log(`  fabric:     ${config.fabricSession.apiUrl}`);
      console.log(
        `  index:      ${config.patternIndex?.baseUrl ?? "(not configured)"}`,
      );
      console.log(
        `  skills:     ${config.skillsSh?.baseUrl ?? "(not configured)"}`,
      );
      for (
        const line of harnessFabricSessionPostureBanner(config.fabricSession)
      ) {
        console.log(line);
      }
      // The two sidecar transports a run's mediation moves over. The engine's
      // guard asks only that they are named, so a console pointed at
      // directories no sandbox sidecar writes starts cleanly and then denies
      // every observation of the run; printing them is what lets an operator
      // read at startup which directories that depends on, for the same
      // reason the posture is printed rather than left to be inferred.
      console.log(`  results:    ${config.cfcResultDir}`);
      console.log(`  contexts:   ${config.cfcInvocationContextDir}`);
      console.log(`  workspace:  ${config.workspace}`);
      console.log(`  artifacts:  ${config.artifactRoot}\n`);
    },
    onError: (error) => {
      console.error(error instanceof Error ? error.message : String(error));
      return new Response("internal error", { status: 500 });
    },
  }, (request) => server.handle(request)).finished.finally(() => {
    clearInterval(beat);
  });
};

// Running the file serves; importing it (the tests do) serves nothing.
if (import.meta.main) {
  try {
    await startConsoleServer();
  } catch (error) {
    // A misconfigured server is an operator's problem to fix, and the message
    // is the whole of what they need; the stack behind it is noise.
    console.error(error instanceof Error ? error.message : String(error));
    Deno.exit(1);
  }
}
