import { basename, isAbsolute, relative } from "@std/path";

import type { JSONSchema } from "@commonfabric/api";
import type { CfcLabelView, CfcSandboxResult } from "@commonfabric/runner/cfc";
import { isObjectOrArray } from "@commonfabric/utils/types";

import {
  normalizeCdpOrigin,
  redactCdpEndpoint,
  validateBrowserAccessLeaseFreshness,
} from "../contracts/browser-access.ts";
import type {
  HarnessAcquiredSkill,
  HarnessSkillAcquisition,
  HarnessSkillDiagnostic,
  HarnessSkillRecord,
  HarnessSkillResourceRecord,
  HarnessSkillScriptExecution,
  HarnessSkillScriptExecutionErrorCode,
  HarnessSkillScriptExecutionTarget,
  HarnessSkillScriptRuntime,
} from "../contracts/skill.ts";
import type { HarnessToolDescriptor } from "../contracts/tool-descriptor.ts";
import { skillsShValueDigest } from "../skills-sh/acquisition.ts";
import { acquiredSkillMountBacks } from "../skills/acquired-skill-mount.ts";
import { harnessSkillScriptMetadata } from "../skills/registry.ts";
import {
  isSkillScriptAllowlisted,
  normalizeSkillScriptPath,
  parseAcquiredSkillPin,
} from "../skills/scripts.ts";
import { createClearedHostProcessEnv } from "./host-process-env.ts";
import type { HarnessToolContext, HarnessToolDefinition } from "./types.ts";

const DEFAULT_TIMEOUT_MS = 60_000;
const MAX_TIMEOUT_MS = 10 * 60_000;

export interface RunSkillScriptToolInput {
  skill: string;
  path: string;
  args?: readonly string[];
  cwd?: string;
  timeoutMs?: number;
  // Trusted harness/test plumbing for invocation input labels. This is omitted
  // from the public tool schema so model-authored tool calls do not mint labels.
  cfcInputLabels?: CfcLabelView;
}

export interface RunSkillScriptToolError {
  code: HarnessSkillScriptExecutionErrorCode;
  message: string;
}

export interface RunSkillScriptToolOutput {
  type: "cf-harness.run-skill-script-output";
  outputId: string;
  skill: string;
  path: string;
  status: "executed" | "error";
  executionTarget?: HarnessSkillScriptExecutionTarget;
  runtime?: HarnessSkillScriptRuntime;
  argv?: readonly string[];
  args?: readonly string[];
  cwd?: string;
  sandboxResourcePath?: string;
  registryDigest?: string;
  observedDigest?: string;
  digestMatchesRegistry?: boolean;
  registrySizeBytes?: number;
  observedSizeBytes?: number;

  /**
   * Where an acquired script came from, absent for a registry skill's. An
   * acquired script runs through the same machinery, so what says which it
   * was is this rather than the registry fields above — which name a
   * run-start snapshot an acquired script was never in.
   *
   * Present from the point the run resolves which acquisition the pin names;
   * a refusal that could not get that far has the pin in `skill` and no
   * acquisition.
   */
  acquisition?: HarnessSkillAcquisition;

  stdout?: string;
  stderr?: string;
  exitCode?: number;
  cfcResult?: CfcSandboxResult;
  diagnostics: HarnessSkillDiagnostic[];
  error?: RunSkillScriptToolError;
}

export const isRunSkillScriptToolSuccessOutput = (
  output: unknown,
): output is RunSkillScriptToolOutput =>
  isObjectOrArray(output) &&
  "type" in output &&
  output.type === "cf-harness.run-skill-script-output" &&
  "status" in output &&
  output.status === "executed";

export const runSkillScriptToolDescriptor: HarnessToolDescriptor = {
  toolId: "run_skill_script",
  title: "Run Skill Script",
  description:
    "Run a script bundled under scripts/ in a cf-harness skill the run holds, where the operator allows it: either this run runs skill scripts at all, in which case any indexed script of a held skill may run, or that exact script is named. A host-target profile always needs the exact name. Name a configured skill by its registry name, or a skill this run acquired by its pin, owner/repo/slug@<commit sha>. Either way the skill must be activated for this run and the script must still match the digest it was pinned at: the run-start registry snapshot for a configured skill, the bytes the pinned commit served for an acquired one.",
  effectClass: "side-effect",
  inputSchema: {
    type: "object",
    properties: {
      skill: { type: "string" },
      path: {
        type: "string",
        description:
          "Path relative to the skill directory, under scripts/, such as scripts/check.ts.",
      },
      args: {
        type: "array",
        items: { type: "string" },
      },
      cwd: {
        type: "string",
        description:
          "Optional working directory inside the workspace. Defaults to the workspace root.",
      },
      timeoutMs: {
        type: "integer",
        minimum: 0,
        maximum: MAX_TIMEOUT_MS,
      },
    },
    required: ["skill", "path"],
    additionalProperties: false,
  } satisfies JSONSchema,
  outputSchema: {
    type: "object",
    properties: {
      type: { type: "string", const: "cf-harness.run-skill-script-output" },
      outputId: { type: "string" },
      skill: { type: "string" },
      path: { type: "string" },
      status: { type: "string", enum: ["executed", "error"] },
      executionTarget: { type: "string", enum: ["sandbox", "host"] },
      runtime: { type: "string", enum: ["deno", "shebang", "unknown"] },
      argv: { type: "array", items: { type: "string" } },
      args: { type: "array", items: { type: "string" } },
      cwd: { type: "string" },
      sandboxResourcePath: { type: "string" },
      registryDigest: { type: "string" },
      observedDigest: { type: "string" },
      digestMatchesRegistry: { type: "boolean" },
      registrySizeBytes: { type: "integer", minimum: 0 },
      observedSizeBytes: { type: "integer", minimum: 0 },
      acquisition: { type: "object" },
      stdout: { type: "string" },
      stderr: { type: "string" },
      exitCode: { type: "number" },
      cfcResult: { type: "object" },
      diagnostics: { type: "array", items: { type: "object" } },
      error: {
        type: "object",
        properties: {
          code: { type: "string" },
          message: { type: "string" },
        },
        required: ["code", "message"],
        additionalProperties: false,
      },
    },
    required: [
      "type",
      "outputId",
      "skill",
      "path",
      "status",
      "diagnostics",
    ],
    additionalProperties: false,
  } satisfies JSONSchema,
  tags: ["skill", "script", "command"],
};

const isPathWithinRoot = (root: string, path: string): boolean => {
  const relativePath = relative(root, path);
  return relativePath === "" ||
    (!relativePath.startsWith("..") && relativePath !== ".." &&
      !isAbsolute(relativePath));
};

const sha256Digest = async (content: Uint8Array): Promise<string> => {
  const digestInput = content.buffer.slice(
    content.byteOffset,
    content.byteOffset + content.byteLength,
  ) as ArrayBuffer;
  const digest = await crypto.subtle.digest("SHA-256", digestInput);
  return `sha256:${
    [...new Uint8Array(digest)].map((byte) =>
      byte.toString(16).padStart(2, "0")
    ).join("")
  }`;
};

const findSkill = (
  skills: readonly HarnessSkillRecord[],
  name: string,
): HarnessSkillRecord | undefined =>
  skills.find((skill) => skill.name === name);

const findResource = (
  skill: HarnessSkillRecord,
  path: string,
): HarnessSkillResourceRecord | undefined =>
  skill.resources.find((resource) => resource.path === path);

const normalizeArgs = (args: readonly string[] | undefined): string[] => {
  if (args === undefined) {
    return [];
  }
  if (!Array.isArray(args)) {
    throw new Error("run_skill_script args must be an array of strings");
  }
  for (const arg of args) {
    if (typeof arg !== "string") {
      throw new Error("run_skill_script args must be an array of strings");
    }
    if (arg.includes("\0")) {
      throw new Error("run_skill_script args must not contain null bytes");
    }
  }
  return [...args];
};

const normalizeTimeoutMs = (timeoutMs: number | undefined): number => {
  const resolved = timeoutMs ?? DEFAULT_TIMEOUT_MS;
  if (
    !Number.isSafeInteger(resolved) ||
    resolved < 0 ||
    resolved > MAX_TIMEOUT_MS
  ) {
    throw new Error(
      `run_skill_script timeoutMs must be an integer from 0 to ${MAX_TIMEOUT_MS}`,
    );
  }
  return resolved;
};

/**
 * The lease origin a host agent-browser script runs against, or why there is
 * none. The endpoint is harness-side state the model does not hold, so the
 * scripts receive it through `AGENT_BROWSER_CDP` in their cleared environment
 * rather than as an argument — and an argument that tries to supply one is
 * refused, because the only endpoint a script may attach to is the lease's.
 */
const resolveHostAgentBrowserLeaseOrigin = (
  args: readonly string[],
  expectedCdpUrl: string | undefined,
  browserAccessExpiresAt: string | undefined,
): { origin: string; error?: undefined } | {
  origin?: undefined;
  error: string;
} => {
  const expiryError = validateBrowserAccessLeaseFreshness(
    browserAccessExpiresAt,
  );
  if (expiryError !== undefined) {
    return { error: expiryError };
  }
  const origin = normalizeCdpOrigin(expectedCdpUrl);
  if (origin === undefined) {
    return {
      error:
        "host agent-browser skill scripts require a Browser Access lease endpoint",
    };
  }
  if (args.some((arg) => arg === "--cdp" || arg.startsWith("--cdp="))) {
    return {
      error:
        "host agent-browser skill scripts must not pass --cdp; the harness attaches the Browser Access lease endpoint itself",
    };
  }
  return { origin };
};

const splitShebangWords = (shebang: string): string[] =>
  shebang.replace(/^#!/, "").trim().split(/\s+/).filter((word) =>
    word.length > 0
  );

const isDenoWord = (word: string): boolean =>
  basename(word).toLowerCase() === "deno";

const isBashWord = (word: string): boolean =>
  basename(word).toLowerCase() === "bash";

const commandWordsFromShebang = (shebang: string): string[] => {
  const words = splitShebangWords(shebang);
  if (words.length >= 3 && basename(words[0] ?? "").toLowerCase() === "env") {
    return words[1] === "-S" ? words.slice(2) : words.slice(1);
  }
  if (words.length >= 2 && basename(words[0] ?? "").toLowerCase() === "env") {
    return words.slice(1);
  }
  return words;
};

const denoRunFlagsFromShebang = (shebang: string | undefined): string[] => {
  if (shebang === undefined) {
    return [];
  }
  const commandWords = commandWordsFromShebang(shebang);
  const denoIndex = commandWords.findIndex(isDenoWord);
  if (denoIndex < 0 || commandWords[denoIndex + 1] !== "run") {
    return [];
  }
  const flags: string[] = [];
  for (const word of commandWords.slice(denoIndex + 2)) {
    if (!word.startsWith("-")) {
      break;
    }
    flags.push(word);
  }
  return flags;
};

interface ScriptExecution {
  runtime: HarnessSkillScriptRuntime;
  argv: string[];
  stdinText?: string;
}

type ScriptExecutionPlan =
  | { ok: true; execution: ScriptExecution }
  | { ok: false; error: RunSkillScriptToolError };

const decodeUtf8Script = (content: Uint8Array): string | undefined => {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(content);
  } catch {
    return undefined;
  }
};

interface SourceToken {
  kind: "word" | "string" | "punct";
  value: string;
}

const isIdentifierStart = (character: string): boolean =>
  /[A-Za-z_$]/.test(character);

const isIdentifierContinue = (character: string): boolean =>
  /[A-Za-z0-9_$]/.test(character);

const readStringToken = (
  source: string,
  start: number,
  quote: string,
): { value: string; end: number } => {
  let value = "";
  for (let index = start + 1; index < source.length; index += 1) {
    const character = source[index] ?? "";
    if (character === "\\") {
      const escaped = source[index + 1];
      if (escaped !== undefined) {
        value += escaped;
        index += 1;
      }
      continue;
    }
    if (character === quote) {
      return { value, end: index + 1 };
    }
    value += character;
  }
  return { value, end: source.length };
};

const tokenizeModuleSource = (source: string): SourceToken[] => {
  const tokens: SourceToken[] = [];
  for (let index = 0; index < source.length;) {
    const character = source[index] ?? "";
    const next = source[index + 1];
    if (/\s/.test(character)) {
      index += 1;
      continue;
    }
    if (character === "/" && next === "/") {
      index += 2;
      while (index < source.length && source[index] !== "\n") {
        index += 1;
      }
      continue;
    }
    if (character === "/" && next === "*") {
      index += 2;
      while (
        index < source.length &&
        !(source[index] === "*" && source[index + 1] === "/")
      ) {
        index += 1;
      }
      index = Math.min(index + 2, source.length);
      continue;
    }
    if (character === '"' || character === "'" || character === "`") {
      const stringToken = readStringToken(source, index, character);
      tokens.push({ kind: "string", value: stringToken.value });
      index = stringToken.end;
      continue;
    }
    if (isIdentifierStart(character)) {
      let end = index + 1;
      while (
        end < source.length && isIdentifierContinue(source[end] ?? "")
      ) {
        end += 1;
      }
      tokens.push({ kind: "word", value: source.slice(index, end) });
      index = end;
      continue;
    }
    tokens.push({ kind: "punct", value: character });
    index += 1;
  }
  return tokens;
};

const isRelativeModuleSpecifier = (specifier: string): boolean =>
  specifier === "." ||
  specifier === ".." ||
  specifier.startsWith("./") ||
  specifier.startsWith("../");

const isRelativePathSpecifier = (specifier: string): boolean =>
  specifier === "." ||
  specifier === ".." ||
  specifier.startsWith("./") ||
  specifier.startsWith("../");

const findRelativeFromSpecifier = (
  tokens: readonly SourceToken[],
  start: number,
): string | undefined => {
  const maxEnd = Math.min(tokens.length, start + 128);
  for (let index = start; index < maxEnd; index += 1) {
    const token = tokens[index];
    if (token?.kind === "punct" && token.value === ";") {
      return undefined;
    }
    if (
      token?.kind === "word" &&
      (token.value === "import" || token.value === "export") &&
      index > start
    ) {
      return undefined;
    }
    if (token?.kind === "word" && token.value === "from") {
      const specifier = tokens[index + 1];
      if (
        specifier?.kind === "string" &&
        isRelativeModuleSpecifier(specifier.value)
      ) {
        return specifier.value;
      }
    }
  }
  return undefined;
};

const findRelativeModuleSpecifier = (source: string): string | undefined => {
  const tokens = tokenizeModuleSource(source);
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (token?.kind !== "word") {
      continue;
    }
    if (token.value === "import") {
      const next = tokens[index + 1];
      if (
        next?.kind === "string" && isRelativeModuleSpecifier(next.value)
      ) {
        return next.value;
      }
      if (next?.kind === "punct" && next.value === "(") {
        const specifier = tokens[index + 2];
        if (
          specifier?.kind === "string" &&
          isRelativeModuleSpecifier(specifier.value)
        ) {
          return specifier.value;
        }
        continue;
      }
      if (next?.kind === "punct" && next.value === ".") {
        continue;
      }
      const fromSpecifier = findRelativeFromSpecifier(tokens, index + 1);
      if (fromSpecifier !== undefined) {
        return fromSpecifier;
      }
      continue;
    }
    if (token.value === "export") {
      const fromSpecifier = findRelativeFromSpecifier(tokens, index + 1);
      if (fromSpecifier !== undefined) {
        return fromSpecifier;
      }
    }
  }
  return undefined;
};

const stripUnquotedShellComment = (line: string): string => {
  let quote: '"' | "'" | undefined;
  for (let index = 0; index < line.length; index += 1) {
    const character = line[index] ?? "";
    if (character === "\\" && quote !== "'") {
      index += 1;
      continue;
    }
    if ((character === '"' || character === "'") && quote === undefined) {
      quote = character;
      continue;
    }
    if (character === quote) {
      quote = undefined;
      continue;
    }
    if (character === "#" && quote === undefined) {
      return line.slice(0, index);
    }
  }
  return line;
};

const unquoteShellToken = (token: string): string =>
  token.replace(/^(['"])(.*)\1$/, "$2");

const findRelativeShellSourceSpecifier = (
  source: string,
): string | undefined => {
  for (const rawLine of source.split(/\r?\n/)) {
    const line = stripUnquotedShellComment(rawLine).trim();
    if (line.length === 0) {
      continue;
    }
    const match = /^(?:source|\.)\s+([^;&|<>()\s]+)/.exec(line);
    const specifier = match === null
      ? undefined
      : unquoteShellToken(match[1] ?? "");
    if (
      specifier !== undefined && isRelativePathSpecifier(specifier)
    ) {
      return specifier;
    }
  }
  return undefined;
};

const bashExecutionForShebang = (
  shebang: string | undefined,
  args: readonly string[],
  stdinText: string,
): ScriptExecution | undefined => {
  if (shebang === undefined) {
    return undefined;
  }
  const commandWords = commandWordsFromShebang(shebang);
  if (!isBashWord(commandWords[0] ?? "")) {
    return undefined;
  }
  if (commandWords.length > 1) {
    return undefined;
  }
  return {
    runtime: "shebang",
    argv: ["bash", "-s", "--", ...args],
    stdinText,
  };
};

const executionForScript = (
  resource: HarnessSkillResourceRecord,
  args: readonly string[],
  content: Uint8Array,
): ScriptExecutionPlan => {
  const runtime = resource.script?.runtime ?? "unknown";
  if (runtime === "deno") {
    const stdinText = decodeUtf8Script(content);
    if (stdinText === undefined) {
      return {
        ok: false,
        error: {
          code: "unsupported_runtime",
          message:
            `Deno skill script is not valid UTF-8 text: ${resource.path}`,
        },
      };
    }
    const relativeSpecifier = findRelativeModuleSpecifier(stdinText);
    if (relativeSpecifier !== undefined) {
      return {
        ok: false,
        error: {
          code: "unsupported_runtime",
          message:
            `Deno skill scripts must be standalone in v1; relative module specifier ${
              JSON.stringify(relativeSpecifier)
            } is not supported by run_skill_script.`,
        },
      };
    }
    return {
      ok: true,
      execution: {
        runtime,
        argv: [
          "deno",
          "run",
          ...denoRunFlagsFromShebang(resource.script?.shebang),
          "-",
          ...args,
        ],
        stdinText,
      },
    };
  }
  if (runtime === "shebang") {
    const stdinText = decodeUtf8Script(content);
    if (stdinText === undefined) {
      return {
        ok: false,
        error: {
          code: "unsupported_runtime",
          message:
            `Bash skill script is not valid UTF-8 text: ${resource.path}`,
        },
      };
    }
    const bashExecution = bashExecutionForShebang(
      resource.script?.shebang,
      args,
      stdinText,
    );
    if (bashExecution === undefined) {
      return {
        ok: false,
        error: {
          code: "unsupported_runtime",
          message:
            `unsupported skill script runtime for ${resource.path}: only Deno scripts and Bash shebang scripts without interpreter flags are supported in v1`,
        },
      };
    }
    const relativeSourceSpecifier = findRelativeShellSourceSpecifier(
      stdinText,
    );
    if (relativeSourceSpecifier !== undefined) {
      return {
        ok: false,
        error: {
          code: "unsupported_runtime",
          message:
            `Bash skill scripts must be standalone in v1; relative source specifier ${
              JSON.stringify(relativeSourceSpecifier)
            } is not supported by run_skill_script.`,
        },
      };
    }
    return { ok: true, execution: bashExecution };
  }
  return {
    ok: false,
    error: {
      code: "unsupported_runtime",
      message: `unsupported skill script runtime for ${resource.path}: ${
        resource.script?.runtime ?? "unknown"
      }`,
    },
  };
};

/**
 * A script one `run_skill_script` call resolved, with where it may be read
 * from and how its bytes were pinned.
 *
 * A registry skill's script and an acquired skill's are executed by the same
 * code below, so both arrive here as one shape. What separates them is
 * {@link ResolvedSkillScript.acquisition}: a registry script's digest was
 * pinned by the run-start registry snapshot, an acquired script's by the bytes
 * the pinned commit served, and the record has to say which.
 */
interface ResolvedSkillScript {
  /** What the allowlist, the record and the model all call this skill. */
  skillName: string;

  /** The skill's directory on the host, for a script that runs there. */
  hostSkillDir: string;

  /** The same directory, as the sandbox that runs the script sees it. */
  sandboxSkillDir: string;

  resource: HarnessSkillResourceRecord;

  /** Directories the script's real path must still resolve inside. */
  containmentRoots: readonly string[];

  /**
   * The digest of the file as it stands, taken the way the pin in
   * {@link ResolvedSkillScript.resource} was taken.
   *
   * Two digests compare only when one function produced both, and the two
   * sources disagree on encoding: a registry snapshot records hexadecimal, an
   * acquisition records unpadded base64url. The encoding is part of the value,
   * so the comparison carries its function rather than assuming one.
   */
  observedDigestOf(content: Uint8Array): Promise<string>;

  /** Where an acquired script came from; absent for a registry skill's. */
  acquisition?: HarnessSkillAcquisition;
}

type SkillScriptResolution =
  | { ok: true; resolved: ResolvedSkillScript }
  | {
    ok: false;
    error: RunSkillScriptToolError;
    resource?: HarnessSkillResourceRecord;
    acquisition?: HarnessSkillAcquisition;
  };

const resolveRegistrySkillScript = (
  context: HarnessToolContext,
  skillName: string,
  path: string,
): SkillScriptResolution => {
  if (context.skillRegistry === undefined) {
    return {
      ok: false,
      error: {
        code: "skill_registry_missing",
        message:
          "run_skill_script requires a run-start skill registry; configure --skills-root before using this tool",
      },
    };
  }
  if (context.skillActivations === undefined) {
    return {
      ok: false,
      error: {
        code: "skill_activations_missing",
        message:
          "run_skill_script requires an explicitly activated skill; configure --skill before using this tool",
      },
    };
  }
  const skill = findSkill(context.skillRegistry.skills, skillName);
  if (skill === undefined) {
    return {
      ok: false,
      error: {
        code: "skill_not_found",
        message: `skill not found in registry: ${skillName}`,
      },
    };
  }
  if (
    !context.skillActivations.activations.some((activation) =>
      activation.name === skill.name
    )
  ) {
    return {
      ok: false,
      error: {
        code: "skill_not_activated",
        message: `skill is not activated for this run: ${skill.name}`,
      },
    };
  }
  // The switch is about running scripts in the SANDBOX, so it does not reach
  // a profile whose target is the host: host execution stays exactly-named,
  // which is what the `browser` profile's two entries are. Widening it here
  // would let any activated script run outside the sandbox on the strength of
  // a decision that never mentioned the host.
  if (
    !(context.allowSkillScripts === true &&
      context.skillScriptExecutionTarget !== "host") &&
    !isSkillScriptAllowlisted(context.allowedSkillScripts, {
      skill: skillName,
      path,
    })
  ) {
    return {
      ok: false,
      error: {
        code: "script_not_allowlisted",
        message: context.skillScriptExecutionTarget === "host"
          ? `this run runs no host skill script that is not named exactly: ` +
            `${skill.name}:${path}`
          : `this run does not run skill scripts: ${skill.name}:${path}. ` +
            `Skill scripts run in the sandbox when the operator allows them`,
      },
    };
  }
  const resource = findResource(skill, path);
  if (resource === undefined) {
    return {
      ok: false,
      error: {
        code: "script_not_indexed",
        message:
          `script not found in run-start registry for skill ${skill.name}: ${path}`,
      },
    };
  }
  if (resource.kind !== "script") {
    return {
      ok: false,
      error: {
        code: "resource_not_script",
        message: `resource is not a script resource: ${path}`,
      },
      resource,
    };
  }
  return {
    ok: true,
    resolved: {
      skillName: skill.name,
      hostSkillDir: skill.skillDir,
      sandboxSkillDir: skill.sandboxSkillDir,
      resource,
      containmentRoots: [skill.skillDir, context.skillRegistry.skillsRoot],
      observedDigestOf: sha256Digest,
    },
  };
};

/**
 * The acquired skill a pin names, among the ones this run holds.
 *
 * The pin is the whole identity: an acquired skill has no registry name, and
 * two acquisitions of one skill at two commits are two different sets of bytes
 * for the operator to decide about separately.
 */
const findAcquiredSkill = (
  acquiredSkills: readonly HarnessAcquiredSkill[] | undefined,
  pin: string,
): HarnessAcquiredSkill | undefined =>
  acquiredSkills?.find((skill) => skill.pin === pin);

const resolveAcquiredSkillScript = (
  context: HarnessToolContext,
  pin: { readonly id: string; readonly commitSha: string },
  skillName: string,
  path: string,
): SkillScriptResolution => {
  const acquired = findAcquiredSkill(context.acquiredSkills, skillName);
  if (acquired === undefined) {
    return {
      ok: false,
      error: {
        code: "skill_not_found",
        message: `no skill acquired by this run at pin: ${skillName}`,
      },
    };
  }
  // Activation by the acquisition rather than by a name. A skill handed over
  // as a handle activates under `handle:<token>`, so there is no registry name
  // to match; what the run holds is the pin the bytes were read at, and that
  // is what says this run was given this skill rather than merely knowing of
  // it. A run that activated nothing at all reaches the same answer by the
  // same route, so there is no separate no-activations arm here as there is on
  // the registry side, where the registry's own absence is a different fact.
  const activation = context.skillActivations?.activations.find((candidate) =>
    candidate.acquisition?.registryId === pin.id &&
    candidate.acquisition?.commitSha === pin.commitSha
  );
  if (activation === undefined) {
    return {
      ok: false,
      error: {
        code: "skill_not_activated",
        message: `acquired skill is not activated for this run: ${skillName}`,
      },
    };
  }
  // Holding the bytes is not being able to run them. An acquired script is
  // addressed by the path its mount puts it at, so a run whose own sandbox
  // does not carry that mount has nothing to execute — the acquiring parent,
  // which deliberately never mounts what it acquired, and a child sharing a
  // handed-in sandbox runtime, which had no configuration to extend. Asked of
  // the sandbox that would run the script rather than of a configuration
  // beside it, because the sandbox is what the path resolves in.
  if (
    !acquiredSkillMountBacks(
      context.sandbox.describe().cfc?.mounts,
      acquired,
    )
  ) {
    return {
      ok: false,
      error: {
        code: "script_not_mounted",
        message:
          `this run holds ${skillName} but its sandbox does not mount the skill, so there is nothing at ${acquired.sandboxRoot} to run`,
      },
      acquisition: activation.acquisition,
    };
  }
  if (
    context.allowSkillScripts !== true &&
    !isSkillScriptAllowlisted(context.allowedSkillScripts, {
      skill: skillName,
      path,
    })
  ) {
    return {
      ok: false,
      error: {
        code: "script_not_allowlisted",
        message: `this run does not run skill scripts: ${skillName}:${path}. ` +
          `Skill scripts run in the sandbox when the operator allows them`,
      },
      acquisition: activation.acquisition,
    };
  }
  const script = acquired.scripts.find((candidate) => candidate.path === path);
  if (script === undefined) {
    return {
      ok: false,
      error: {
        code: "script_not_indexed",
        message: `script not acquired at pin ${skillName}: ${path}`,
      },
      acquisition: activation.acquisition,
    };
  }
  return {
    ok: true,
    resolved: {
      skillName,
      hostSkillDir: acquired.hostRoot,
      sandboxSkillDir: acquired.sandboxRoot,
      resource: {
        path: script.path,
        kind: "script",
        resourcePath: script.hostPath,
        sandboxResourcePath: script.sandboxPath,
        sizeBytes: script.sizeBytes,
        // The digest taken at acquisition, over the bytes the pinned commit
        // served. The execution re-checks the file against it, so a host-side
        // edit between acquisition and execution refuses — the same guarantee
        // the run-start snapshot gives a registry script.
        digest: script.valueDigest,
        contentKind: "text",
        diagnostics: [],
      },
      containmentRoots: [acquired.hostRoot],
      observedDigestOf: (content) =>
        Promise.resolve(skillsShValueDigest(content)),
      acquisition: activation.acquisition,
    },
  };
};

/**
 * The script a `skill` and a `path` name, from the registry or from what this
 * run acquired.
 *
 * Which of the two is asked is decided by the form of `skill` alone: a pin is
 * an acquired skill's whole name, and a registry name can never be one.
 */
const resolveSkillScript = (
  context: HarnessToolContext,
  skillName: string,
  path: string,
): SkillScriptResolution => {
  const pin = parseAcquiredSkillPin(skillName);
  if (pin !== undefined) {
    return resolveAcquiredSkillScript(context, pin, skillName, path);
  }
  const resolution = resolveRegistrySkillScript(context, skillName, path);
  if (
    !resolution.ok && (context.acquiredSkills?.length ?? 0) > 0 &&
    (resolution.error.code === "skill_registry_missing" ||
      resolution.error.code === "skill_not_found")
  ) {
    return {
      ...resolution,
      error: {
        ...resolution.error,
        message: `run_skill_script could not resolve ${
          JSON.stringify(skillName)
        } as a configured skill; name an acquired skill by its full pin (owner/repo/slug@<commit sha>), shown in acquire_skill output or the skill_context pin attribute`,
      },
    };
  }
  return resolution;
};

const baseOutput = (
  options: {
    outputId: string;
    skill: string;
    path: string;
    status: RunSkillScriptToolOutput["status"];
    executionTarget?: HarnessSkillScriptExecutionTarget;
    diagnostics?: HarnessSkillDiagnostic[];
  },
): RunSkillScriptToolOutput => ({
  type: "cf-harness.run-skill-script-output",
  outputId: options.outputId,
  skill: options.skill,
  path: options.path,
  status: options.status,
  ...(options.executionTarget !== undefined
    ? { executionTarget: options.executionTarget }
    : {}),
  diagnostics: options.diagnostics ?? [],
});

const errorOutput = (
  options: {
    outputId: string;
    skill: string;
    path: string;
    code: HarnessSkillScriptExecutionErrorCode;
    message: string;
    executionTarget?: HarnessSkillScriptExecutionTarget;
    diagnostics?: HarnessSkillDiagnostic[];
    resource?: HarnessSkillResourceRecord;
    acquisition?: HarnessSkillAcquisition;
    observedDigest?: string;
    observedSizeBytes?: number;
  },
): RunSkillScriptToolOutput => ({
  ...baseOutput({
    outputId: options.outputId,
    skill: options.skill,
    path: options.path,
    status: "error",
    executionTarget: options.executionTarget,
    diagnostics: options.diagnostics,
  }),
  ...(options.resource !== undefined
    ? {
      runtime: options.resource.script?.runtime,
      sandboxResourcePath: options.resource.sandboxResourcePath,
    }
    : {}),
  // The registry fields name the run-start snapshot, which an acquired script
  // was never in; `acquisition` is what stands in their place, so a reader
  // never finds both set and never finds neither.
  ...(options.acquisition !== undefined
    ? { acquisition: options.acquisition }
    : options.resource !== undefined
    ? {
      registryDigest: options.resource.digest,
      registrySizeBytes: options.resource.sizeBytes,
      ...(options.observedDigest !== undefined
        ? {
          digestMatchesRegistry:
            options.observedDigest === options.resource.digest,
        }
        : {}),
    }
    : {}),
  ...(options.observedDigest !== undefined
    ? { observedDigest: options.observedDigest }
    : {}),
  ...(options.observedSizeBytes !== undefined
    ? { observedSizeBytes: options.observedSizeBytes }
    : {}),
  error: {
    code: options.code,
    message: options.message,
  },
});

const buildExecutionRecord = (
  options: {
    output: RunSkillScriptToolOutput;
    runId: string;
    executedAt: string;
    resourcePath?: string;
  },
): HarnessSkillScriptExecution => ({
  type: "cf-harness.skill-script-execution",
  outputId: options.output.outputId,
  runId: options.runId,
  skillName: options.output.skill,
  path: options.output.path,
  status: options.output.status,
  executedAt: options.executedAt,
  ...(options.output.executionTarget !== undefined
    ? { executionTarget: options.output.executionTarget }
    : {}),
  ...(options.output.runtime !== undefined
    ? { runtime: options.output.runtime }
    : {}),
  ...(options.output.argv !== undefined ? { argv: options.output.argv } : {}),
  ...(options.output.args !== undefined ? { args: options.output.args } : {}),
  ...(options.output.cwd !== undefined ? { cwd: options.output.cwd } : {}),
  ...(options.resourcePath !== undefined
    ? { resourcePath: options.resourcePath }
    : {}),
  ...(options.output.sandboxResourcePath !== undefined
    ? { sandboxResourcePath: options.output.sandboxResourcePath }
    : {}),
  ...(options.output.acquisition !== undefined
    ? { acquisition: options.output.acquisition }
    : {}),
  ...(options.output.registryDigest !== undefined
    ? { registryDigest: options.output.registryDigest }
    : {}),
  ...(options.output.observedDigest !== undefined
    ? { observedDigest: options.output.observedDigest }
    : {}),
  ...(options.output.digestMatchesRegistry !== undefined
    ? { digestMatchesRegistry: options.output.digestMatchesRegistry }
    : {}),
  ...(options.output.registrySizeBytes !== undefined
    ? { registrySizeBytes: options.output.registrySizeBytes }
    : {}),
  ...(options.output.observedSizeBytes !== undefined
    ? { observedSizeBytes: options.output.observedSizeBytes }
    : {}),
  ...(options.output.exitCode !== undefined
    ? { exitCode: options.output.exitCode }
    : {}),
  diagnostics: options.output.diagnostics,
  ...(options.output.error !== undefined
    ? { error: options.output.error }
    : {}),
});

export const runSkillScriptTool: HarnessToolDefinition<
  RunSkillScriptToolInput,
  RunSkillScriptToolOutput
> = {
  descriptor: runSkillScriptToolDescriptor,
  async invoke(context, input) {
    const outputId = context.nextOutputId("run_skill_script");
    const executedAt = context.now();
    const executionTarget = context.skillScriptExecutionTarget;
    let normalizedPath: string;
    let args: string[];
    let timeoutMs: number;
    try {
      normalizedPath = normalizeSkillScriptPath(input.path);
      args = normalizeArgs(input.args);
      timeoutMs = normalizeTimeoutMs(input.timeoutMs);
    } catch (error) {
      const output = errorOutput({
        outputId,
        skill: input.skill,
        path: input.path,
        code: "script_path_invalid",
        message: error instanceof Error ? error.message : String(error),
      });
      await context.recordSkillScriptExecution(
        buildExecutionRecord({ output, runId: context.runId, executedAt }),
      );
      return output;
    }

    const resolution = resolveSkillScript(context, input.skill, normalizedPath);
    if (!resolution.ok) {
      const output = errorOutput({
        outputId,
        skill: input.skill,
        path: normalizedPath,
        code: resolution.error.code,
        message: resolution.error.message,
        resource: resolution.resource,
        acquisition: resolution.acquisition,
      });
      await context.recordSkillScriptExecution(
        buildExecutionRecord({
          output,
          runId: context.runId,
          executedAt,
          resourcePath: resolution.resource?.resourcePath,
        }),
      );
      return output;
    }
    const { acquisition, skillName } = resolution.resolved;
    let resource = resolution.resolved.resource;

    if (acquisition !== undefined && executionTarget === "host") {
      // The sandbox is the whole of what bounds an acquired script: bytes a
      // publisher wrote, admitted because the operator allowlisted a pin. The
      // host target exists for the browser profile's own bundled scripts,
      // which need a host CLI, and running fetched code there would put it
      // outside every boundary this path rests on.
      const output = errorOutput({
        outputId,
        skill: skillName,
        path: normalizedPath,
        executionTarget,
        code: "permission_denied",
        message:
          "an acquired skill's script runs in the sandbox; this run executes skill scripts on the host",
        resource,
        acquisition,
      });
      await context.recordSkillScriptExecution(
        buildExecutionRecord({
          output,
          runId: context.runId,
          executedAt,
          resourcePath: resource.resourcePath,
        }),
      );
      return output;
    }

    let resolvedContainmentRoots: string[];
    let resolvedResourcePath: string;
    try {
      resolvedContainmentRoots = await Promise.all(
        resolution.resolved.containmentRoots.map((root) => Deno.realPath(root)),
      );
      resolvedResourcePath = await Deno.realPath(resource.resourcePath);
    } catch (error) {
      const code = error instanceof Deno.errors.NotFound
        ? "script_not_found"
        : error instanceof Deno.errors.PermissionDenied
        ? "permission_denied"
        : "unknown";
      const output = errorOutput({
        outputId,
        skill: skillName,
        path: normalizedPath,
        code,
        message: error instanceof Error ? error.message : String(error),
        resource,
        acquisition,
      });
      await context.recordSkillScriptExecution(
        buildExecutionRecord({
          output,
          runId: context.runId,
          executedAt,
          resourcePath: resource.resourcePath,
        }),
      );
      return output;
    }
    if (
      !resolvedContainmentRoots.every((root) =>
        isPathWithinRoot(root, resolvedResourcePath)
      )
    ) {
      const output = errorOutput({
        outputId,
        skill: skillName,
        path: normalizedPath,
        code: "script_outside_root",
        message: acquisition === undefined
          ? `script no longer resolves inside the skill directory and configured skills root: ${normalizedPath}`
          : `script no longer resolves inside the acquired skill's directory: ${normalizedPath}`,
        resource,
        acquisition,
      });
      await context.recordSkillScriptExecution(
        buildExecutionRecord({
          output,
          runId: context.runId,
          executedAt,
          resourcePath: resource.resourcePath,
        }),
      );
      return output;
    }

    let content: Uint8Array;
    try {
      const stat = await Deno.stat(resolvedResourcePath);
      if (!stat.isFile) {
        const output = errorOutput({
          outputId,
          skill: skillName,
          path: normalizedPath,
          code: "script_not_file",
          message: `script is not a file: ${normalizedPath}`,
          resource,
          acquisition,
        });
        await context.recordSkillScriptExecution(
          buildExecutionRecord({
            output,
            runId: context.runId,
            executedAt,
            resourcePath: resource.resourcePath,
          }),
        );
        return output;
      }
      content = await Deno.readFile(resolvedResourcePath);
    } catch (error) {
      const code = error instanceof Deno.errors.NotFound
        ? "script_not_found"
        : error instanceof Deno.errors.PermissionDenied
        ? "permission_denied"
        : "unknown";
      const output = errorOutput({
        outputId,
        skill: skillName,
        path: normalizedPath,
        code,
        message: error instanceof Error ? error.message : String(error),
        resource,
        acquisition,
      });
      await context.recordSkillScriptExecution(
        buildExecutionRecord({
          output,
          runId: context.runId,
          executedAt,
          resourcePath: resource.resourcePath,
        }),
      );
      return output;
    }

    const observedDigest = await resolution.resolved.observedDigestOf(content);
    const observedSizeBytes = content.byteLength;
    if (
      observedDigest !== resource.digest ||
      observedSizeBytes !== resource.sizeBytes
    ) {
      const output = errorOutput({
        outputId,
        skill: skillName,
        path: normalizedPath,
        code: "script_snapshot_mismatch",
        message: acquisition === undefined
          ? "Skill script differs from the run-start registry snapshot; refusing to execute active code."
          : "Skill script differs from the bytes acquired at this pin; refusing to execute active code.",
        resource,
        acquisition,
        observedDigest,
        observedSizeBytes,
      });
      await context.recordSkillScriptExecution(
        buildExecutionRecord({
          output,
          runId: context.runId,
          executedAt,
          resourcePath: resource.resourcePath,
        }),
      );
      return output;
    }

    if (acquisition !== undefined) {
      // An acquired script has no registry scan behind it to have derived
      // this. What decides a script's runtime is its shebang and its
      // extension, and the registry's own derivation is what reads them, so
      // the same file gets the same runtime whichever path it arrived by.
      resource = {
        ...resource,
        script: harnessSkillScriptMetadata({
          path: resource.path,
          executable: false,
          content,
          contentKind: resource.contentKind,
        }),
      };
    }

    const scriptExecutionPlan = executionForScript(resource, args, content);
    if (!scriptExecutionPlan.ok) {
      const output = errorOutput({
        outputId,
        skill: skillName,
        path: normalizedPath,
        code: scriptExecutionPlan.error.code,
        message: scriptExecutionPlan.error.message,
        resource,
        acquisition,
        observedDigest,
        observedSizeBytes,
      });
      await context.recordSkillScriptExecution(
        buildExecutionRecord({
          output,
          runId: context.runId,
          executedAt,
          resourcePath: resource.resourcePath,
        }),
      );
      return output;
    }
    const scriptExecution = scriptExecutionPlan.execution;

    let hostAgentBrowserCdpOrigin: string | undefined;
    if (executionTarget === "host" && skillName === "agent-browser") {
      const browserLease = resolveHostAgentBrowserLeaseOrigin(
        args,
        context.browserAccess?.cdpUrl,
        context.browserAccess?.expiresAt,
      );
      if (browserLease.error !== undefined) {
        const output = errorOutput({
          outputId,
          skill: skillName,
          path: normalizedPath,
          executionTarget,
          code: "permission_denied",
          message: browserLease.error,
          resource,
          acquisition,
          observedDigest,
          observedSizeBytes,
        });
        await context.recordSkillScriptExecution(
          buildExecutionRecord({
            output,
            runId: context.runId,
            executedAt,
            resourcePath: resource.resourcePath,
          }),
        );
        return output;
      }
      hostAgentBrowserCdpOrigin = browserLease.origin;
    }

    const cwd = input.cwd !== undefined
      ? context.resolvePath(input.cwd)
      : context.sandbox.defaultWorkingDirectory();
    const hostCwd = executionTarget === "host"
      ? context.resolveHostPath(cwd)
      : undefined;
    if (
      hostCwd !== undefined &&
      (!(await context.isHostPathWithinWorkspace(hostCwd)) ||
        await context.isHostPathWithinArtifactRoot(hostCwd, {
          allowMissing: true,
        }))
    ) {
      const output = errorOutput({
        outputId,
        skill: skillName,
        path: normalizedPath,
        executionTarget,
        code: "permission_denied",
        message:
          "host skill scripts must execute from a workspace path outside cf-harness artifacts",
        resource,
        acquisition,
        observedDigest,
        observedSizeBytes,
      });
      await context.recordSkillScriptExecution(
        buildExecutionRecord({
          output,
          runId: context.runId,
          executedAt,
          resourcePath: resource.resourcePath,
        }),
      );
      return output;
    }
    const sandboxEnv = {
      CF_HARNESS_RUN_ID: context.runId,
      SKILL_NAME: skillName,
      SKILL_DIR: resolution.resolved.sandboxSkillDir,
      SKILL_SCRIPT: resource.sandboxResourcePath,
      CF_HARNESS_SKILL_SCRIPT_EXECUTION_TARGET: executionTarget,
    };
    const result = executionTarget === "host"
      ? await context.hostProcessRunner.run({
        command: scriptExecution.argv[0]!,
        args: scriptExecution.argv.slice(1),
        cwd: hostCwd,
        clearEnv: true,
        env: createClearedHostProcessEnv({
          CF_HARNESS_RUN_ID: context.runId,
          SKILL_NAME: skillName,
          SKILL_DIR: resolution.resolved.hostSkillDir,
          SKILL_SCRIPT: resource.resourcePath,
          CF_HARNESS_SKILL_SCRIPT_EXECUTION_TARGET: executionTarget,
          ...(hostAgentBrowserCdpOrigin !== undefined
            ? { AGENT_BROWSER_CDP: hostAgentBrowserCdpOrigin }
            : {}),
        }),
        ...(scriptExecution.stdinText !== undefined
          ? { stdinText: scriptExecution.stdinText }
          : {}),
        timeoutMs,
      })
      : await context.sandbox.run({
        argv: scriptExecution.argv,
        cwd,
        env: sandboxEnv,
        ...(scriptExecution.stdinText !== undefined
          ? { stdinText: scriptExecution.stdinText }
          : {}),
        timeoutMs,
        cfcInvocationContext: await context.createCfcInvocationContext({
          toolId: "run_skill_script",
          toolOutputId: outputId,
          operation: "command",
          cwd,
          argv: scriptExecution.argv,
          args,
          env: sandboxEnv,
          ...(scriptExecution.stdinText !== undefined
            ? { stdinText: scriptExecution.stdinText }
            : {}),
          // Confidentiality only, and no integrity — including for an
          // acquired script, whose acquisition minted an ExternalIngest atom
          // that would otherwise belong on this invocation. A non-empty
          // `integrity` array in `cfcInputLabels` makes the sandbox fail to
          // start (CT-2302), so an acquired script labeled with its own
          // provenance would not run at all. The provenance rides the output
          // instead, in `acquisition`, and the execution record with it.
          ...(input.cfcInputLabels !== undefined
            ? { cfcInputLabels: input.cfcInputLabels }
            : {}),
          cfcInputLabelPaths: input.cwd !== undefined
            ? [["argv"], ["args"], ["cwd"], ["env"]]
            : [["argv"], ["args"], ["env"]],
        }),
      });

    const cfcResult = (result as { cfcResult?: CfcSandboxResult }).cfcResult;
    const output: RunSkillScriptToolOutput = {
      ...baseOutput({
        outputId,
        skill: skillName,
        path: normalizedPath,
        status: "executed",
        executionTarget,
      }),
      runtime: scriptExecution.runtime,
      argv: scriptExecution.argv,
      args,
      cwd,
      sandboxResourcePath: resource.sandboxResourcePath,
      // Exactly one of the two, as on a refusal: the registry fields name the
      // run-start snapshot an acquired script was never in, and `acquisition`
      // names the pin whose bytes an acquired script was checked against.
      ...(acquisition !== undefined ? { acquisition } : {
        registryDigest: resource.digest,
        digestMatchesRegistry: true,
        registrySizeBytes: resource.sizeBytes,
      }),
      observedDigest,
      observedSizeBytes,
      // A host agent-browser script holds the lease endpoint in its
      // environment and may echo it, so echoes are scrubbed from what the
      // model reads. The scrub is a backstop: what keeps the endpoint out of
      // model reach is that only the digest-pinned bundled script holds it.
      stdout: hostAgentBrowserCdpOrigin !== undefined
        ? redactCdpEndpoint(result.stdout, hostAgentBrowserCdpOrigin)
        : result.stdout,
      stderr: hostAgentBrowserCdpOrigin !== undefined
        ? redactCdpEndpoint(result.stderr, hostAgentBrowserCdpOrigin)
        : result.stderr,
      exitCode: result.exitCode,
      ...(cfcResult !== undefined ? { cfcResult } : {}),
    };
    await context.recordSkillScriptExecution(
      buildExecutionRecord({
        output,
        runId: context.runId,
        executedAt,
        resourcePath: resource.resourcePath,
      }),
    );
    return output;
  },
};
