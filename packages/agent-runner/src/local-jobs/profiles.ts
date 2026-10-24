/**
 * Host-approved profiles for local jobs: the authority a job runs with,
 * chosen by name. A profile says which tools a job may use, which host
 * configurations back them, how many model turns it gets, and the
 * prompt-slot role its task binds as, whether a job may bring a browser
 * host, and the fabric session, pattern index and subagent profiles its
 * tools run against. The host writes the file; a caller names a profile and
 * may only narrow it — fewer tools, fewer turns, no browser — never widen
 * it, and never set its role or its fabric.
 *
 * A profile is refused when it is read if it grants a tool nothing in it
 * backs, the same contradiction `cf-harness` refuses a run for, so a bad
 * grant stops the runner's start rather than failing every job.
 */

import { isAbsolute } from "@std/path";

import { parseCfHarnessCliToolId } from "@commonfabric/cf-harness/cli";
import type { HarnessModelLimits } from "@commonfabric/cf-harness/model/client";
import type { PromptSlotRole } from "@commonfabric/cf-harness/contracts/prompt-slot";
import {
  BROWSER_SUBAGENT_PROFILE,
  HARNESS_SUBAGENT_PROFILES,
  type HarnessSubagentProfile,
  PATTERN_AUTHOR_SUBAGENT_PROFILE,
} from "@commonfabric/cf-harness/contracts/subagent";
import {
  type BuiltinToolId,
  type HarnessToolBackingAvailability,
  withheldToolIds,
} from "@commonfabric/cf-harness/contracts/tool-descriptor";
import { validateHarnessForeignSpaces } from "@commonfabric/cf-harness/foreign-spaces";
import { parseHandleRef } from "@commonfabric/cf-harness/handle-table";
import {
  checkInputCellSpec,
  parseNamedPieceAddress,
} from "@commonfabric/cf-harness/input-cells";
import { isDID } from "@commonfabric/identity/did";
import type { MemorySpace } from "@commonfabric/runner";
import { isObjectNotArray } from "@commonfabric/utils/types";

/** One profile, as the host file states it. */
export interface LocalJobProfile extends HarnessModelLimits {
  /** The tools a job may use; `submit_result` is always added. */
  tools: string[];

  /** The most model turns a job may take. */
  maxModelTurns: number;

  /** The prompt-slot role a job's task binds as. */
  taskRole: PromptSlotRole;

  /**
   * What happens to a job a stop or a crash cut off. `never`: it ends
   * `interrupted` and is not run again.
   */
  retry: "never";

  /** The host file backing the read-only Loom tools, when a tool needs it. */
  loomRetrievalConfig?: string;

  /** The host file naming the command broker, when a tool needs it. */
  loomCommandsConfig?: string;

  /** Model name passed to `cf-harness`. */
  model?: string;

  /**
   * The reasoning effort a job runs at, and the most a request may ask for;
   * the provider's default when absent, and then a request may name none. It
   * sets the effort of the job's own model calls and of children that share
   * its model. The research tool runs at the runner's research effort, and a
   * child on another model at that provider's default, so it does not bound
   * every model call in the job.
   */
  reasoningEffort?: ReasoningEffort;

  /**
   * Whether a job may declare a browser host. A job that does browses
   * through it: the lane adds `delegate_task` and the `browser` subagent
   * profile to that job alone, so a job without a host never gains them.
   * The console's operator flag, `--allow-browser-host`, is the same grant.
   */
  browserHost?: boolean;

  /**
   * The fabric session a job's fabric tools (`run_pattern` and its kin) run
   * against: the toolshed, the space, and the key of the identity the job
   * reads and writes as. Its read ceiling is the host's, resolved per job.
   */
  fabric?: LocalJobFabric;

  /**
   * The pattern index `search_patterns`, `record_feedback` and a
   * `pattern-author` child search; signed with the fabric identity, so it
   * needs `fabric`.
   */
  patternIndexUrl?: string;

  /**
   * Whether a job contributes what it authors to the pattern index. Present
   * exactly when `patternIndexUrl` is, `true` unless the file says `false`,
   * as the harness defaults.
   */
  patternIndexPublish?: boolean;

  /**
   * The subagent profiles `delegate_task` may spawn, which the profile's
   * `tools` must then name. `browser` is not among them: a job gains it only
   * by declaring a browser host (`browserHost`).
   */
  subagentProfiles?: HarnessSubagentProfile[];
}

/** A profile's fabric session, as the host file states it. */
export interface LocalJobFabric {
  /** The origin of the toolshed serving the space. */
  host: string;

  /** The space the session opens. */
  space: string;

  /** The absolute path of the PKCS#8 key the job reads and writes as. */
  identityKeyPath: string;
}

/** The profiles a host file names, by name. */
export type LocalJobProfiles = ReadonlyMap<string, LocalJobProfile>;

/** What a caller may ask of a profile. */
export interface LocalJobNarrowing extends HarnessModelLimits {
  tools?: readonly string[];
  maxModelTurns?: number;
  reasoningEffort?: ReasoningEffort;

  /** The request's browser host declaration, when it made one. */
  browserHost?: unknown;

  /** The pieces the request hands the job, by name. */
  inputs?: Readonly<Record<string, string>>;

  /** Where each space an input names outside the profile's is served. */
  foreignSpaces?: Readonly<Record<string, string>>;
}

const ROLES: readonly PromptSlotRole[] = ["direct-command", "context", "quote"];

/**
 * Reasoning efforts from least to most, as the providers the harness speaks
 * to name them; a model may support only some of them.
 */
export const REASONING_EFFORTS = [
  "none",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
] as const;

export type ReasoningEffort = typeof REASONING_EFFORTS[number];

/** `value` as a reasoning effort, or undefined when it names none. */
export const reasoningEffortOf = (
  value: unknown,
): ReasoningEffort | undefined =>
  REASONING_EFFORTS.find((effort) => effort === value);

/** The tool that spawns a subagent. */
const DELEGATE_TOOL: BuiltinToolId = "delegate_task";

/**
 * The tools a profile's fabric session and pattern index back, read off the
 * harness's own backing table: what it withholds without the one, every
 * other backing granted.
 */
const toolsBackedBy = (
  missing: "fabricSessionAvailable" | "patternIndexAvailable",
): ReadonlySet<BuiltinToolId> => {
  const all: HarnessToolBackingAvailability = {
    fabricSessionAvailable: true,
    patternIndexAvailable: true,
    skillsShSearchAvailable: true,
    skillsShAcquisitionAvailable: true,
    skillRegistryAvailable: true,
    acquiredSkillsAvailable: true,
    docsCorpusAvailable: true,
    loomAuthoringAvailable: true,
    loomRetrievalAvailable: true,
    loomCommandsAvailable: true,
    structuredResultAvailable: true,
    clientActionsAvailable: true,
  };
  return withheldToolIds({ ...all, [missing]: false });
};
const FABRIC_TOOLS = toolsBackedBy("fabricSessionAvailable");
const PATTERN_INDEX_TOOLS = toolsBackedBy("patternIndexAvailable");

/** Helper for reading, which says whether `value` is an absolute URL. */
const isUrl = (value: unknown): value is string => {
  if (typeof value !== "string") return false;
  try {
    new URL(value);
    return true;
  } catch {
    return false;
  }
};

/** Helper for reading, which checks one profile and returns it. */
const profileOf = (name: string, value: unknown): LocalJobProfile => {
  const fail = (what: string): never => {
    throw new Error(`Local job profile \`${name}\`: ${what}.`);
  };
  if (!isObjectNotArray(value)) fail("it is not an object");
  const record = value as Record<string, unknown>;
  const {
    tools,
    maxModelTurns,
    maxInputBytes,
    maxOutputTokens,
    taskRole,
    retry,
    loomRetrievalConfig,
    loomCommandsConfig,
    model,
    reasoningEffort,
    browserHost,
    fabric,
    patternIndexUrl,
    patternIndexPublish,
    subagentProfiles,
  } = record;
  if (
    !Array.isArray(tools) || !tools.every((tool) => typeof tool === "string")
  ) {
    fail("`tools` must be a list of tool names");
  }
  for (const tool of tools as string[]) {
    if (parseCfHarnessCliToolId(tool) === undefined) {
      fail(`\`tools\` names an unknown CLI tool: ${tool}`);
    }
  }
  if (
    typeof maxModelTurns !== "number" || !Number.isInteger(maxModelTurns) ||
    maxModelTurns < 1
  ) {
    fail("`maxModelTurns` must be a whole number of 1 or more");
  }
  for (
    const [field, limit] of [["maxInputBytes", maxInputBytes], [
      "maxOutputTokens",
      maxOutputTokens,
    ]]
  ) {
    const minimum = field === "maxOutputTokens" ? 16 : 1;
    if (
      limit !== undefined &&
      (typeof limit !== "number" || !Number.isSafeInteger(limit) ||
        limit < minimum)
    ) {
      fail(`\`${field}\` must be a safe whole number of ${minimum} or more`);
    }
  }
  if (!ROLES.includes(taskRole as PromptSlotRole)) {
    fail(`\`taskRole\` must be one of ${ROLES.join(", ")}`);
  }
  if (retry !== "never") fail("`retry` must be `never`");
  for (
    const [key, path] of [
      ["loomRetrievalConfig", loomRetrievalConfig],
      ["loomCommandsConfig", loomCommandsConfig],
    ] as const
  ) {
    if (
      path !== undefined && (typeof path !== "string" || !isAbsolute(path))
    ) {
      fail(`\`${key}\` must be an absolute path`);
    }
  }
  if (model !== undefined && typeof model !== "string") {
    fail("`model` must be a string");
  }
  const effort = reasoningEffortOf(reasoningEffort);
  if (reasoningEffort !== undefined && effort === undefined) {
    fail(`\`reasoningEffort\` must be one of ${REASONING_EFFORTS.join(", ")}`);
  }
  if (browserHost !== undefined && typeof browserHost !== "boolean") {
    fail("`browserHost` must be true or false");
  }
  const session = fabric === undefined ? undefined : fabricOf(fabric, fail);
  if (patternIndexUrl !== undefined && !isUrl(patternIndexUrl)) {
    fail("`patternIndexUrl` must be a URL");
  }
  if (
    patternIndexPublish !== undefined &&
    typeof patternIndexPublish !== "boolean"
  ) {
    fail("`patternIndexPublish` must be true or false");
  }
  if (patternIndexPublish !== undefined && patternIndexUrl === undefined) {
    fail("`patternIndexPublish` needs `patternIndexUrl`");
  }
  if (patternIndexUrl !== undefined && session === undefined) {
    fail("`patternIndexUrl` needs `fabric`: the index signs as its identity");
  }
  if (
    subagentProfiles !== undefined &&
    (!Array.isArray(subagentProfiles) ||
      !subagentProfiles.every((profile) =>
        (HARNESS_SUBAGENT_PROFILES as readonly unknown[]).includes(profile)
      ))
  ) {
    fail(
      `\`subagentProfiles\` must be a list of ${
        HARNESS_SUBAGENT_PROFILES.join(", ")
      }`,
    );
  }
  const children = [
    ...new Set((subagentProfiles ?? []) as HarnessSubagentProfile[]),
  ];
  if (children.includes(BROWSER_SUBAGENT_PROFILE)) {
    fail(
      "`subagentProfiles` may not name `browser`; `browserHost` grants it to a job that declares a host",
    );
  }
  const granted = (tools as string[]).map((tool) =>
    parseCfHarnessCliToolId(tool)!
  );
  if (children.length > 0 && !granted.includes(DELEGATE_TOOL)) {
    fail("`subagentProfiles` needs `delegate_task` in `tools`");
  }
  if (
    children.includes(PATTERN_AUTHOR_SUBAGENT_PROFILE) &&
    (session === undefined || patternIndexUrl === undefined)
  ) {
    fail(
      "`subagentProfiles` names `pattern-author`, which needs `fabric` and `patternIndexUrl`",
    );
  }
  for (const [index, tool] of granted.entries()) {
    const named = (tools as string[])[index];
    if (FABRIC_TOOLS.has(tool) && session === undefined) {
      fail(`\`tools\` names \`${named}\`, which needs \`fabric\``);
    }
    if (PATTERN_INDEX_TOOLS.has(tool) && patternIndexUrl === undefined) {
      fail(`\`tools\` names \`${named}\`, which needs \`patternIndexUrl\``);
    }
  }
  return {
    tools: [...(tools as string[])],
    maxModelTurns: maxModelTurns as number,
    ...(typeof maxInputBytes === "number" ? { maxInputBytes } : {}),
    ...(typeof maxOutputTokens === "number" ? { maxOutputTokens } : {}),
    taskRole: taskRole as PromptSlotRole,
    retry: "never",
    ...(loomRetrievalConfig !== undefined
      ? { loomRetrievalConfig: loomRetrievalConfig as string }
      : {}),
    ...(loomCommandsConfig !== undefined
      ? { loomCommandsConfig: loomCommandsConfig as string }
      : {}),
    ...(model !== undefined ? { model: model as string } : {}),
    ...(effort !== undefined ? { reasoningEffort: effort } : {}),
    ...(browserHost === true ? { browserHost: true } : {}),
    ...(session !== undefined ? { fabric: session } : {}),
    ...(patternIndexUrl !== undefined
      ? {
        patternIndexUrl: patternIndexUrl as string,
        patternIndexPublish: patternIndexPublish !== false,
      }
      : {}),
    ...(children.length > 0 ? { subagentProfiles: children } : {}),
  };
};

/** Helper for reading, which checks a profile's fabric session. */
const fabricOf = (
  value: unknown,
  fail: (what: string) => never,
): LocalJobFabric => {
  if (!isObjectNotArray(value)) fail("`fabric` must be an object");
  const { host, space, identityKeyPath } = value as Record<string, unknown>;
  if (!isUrl(host)) fail("`fabric.host` must be a URL");
  if (typeof space !== "string" || space === "") {
    fail("`fabric.space` must name a space");
  }
  if (typeof identityKeyPath !== "string" || !isAbsolute(identityKeyPath)) {
    fail("`fabric.identityKeyPath` must be an absolute path");
  }
  return {
    host: host as string,
    space: space as string,
    identityKeyPath: identityKeyPath as string,
  };
};

/**
 * Reads the host's profile file: a JSON object naming each profile.
 *
 * @throws Error naming the profile and field the file gets wrong.
 */
export const readLocalJobProfiles = async (
  path: string,
  readTextFile: (path: string) => Promise<string> = Deno.readTextFile,
): Promise<LocalJobProfiles> => {
  if (!isAbsolute(path)) {
    throw new Error("The local job profile file path must be absolute.");
  }
  const value: unknown = JSON.parse(await readTextFile(path));
  if (!isObjectNotArray(value)) {
    throw new Error("The local job profile file must hold a JSON object.");
  }
  return new Map(
    Object.entries(value as Record<string, unknown>).map((
      [name, profile],
    ) => [name, profileOf(name, profile)]),
  );
};

/** The space a link input names by DID, or `undefined` for any other input. */
const spaceOf = (ref: string): string | undefined => {
  try {
    if (parseNamedPieceAddress(ref) !== undefined) return undefined;
    const space = parseHandleRef(ref).space;
    return space !== undefined && isDID(space) ? space : undefined;
  } catch {
    return undefined;
  }
};

/**
 * The space each of `inputs` names by DID, other than `ownSpace`: the spaces
 * a job handed those pieces reaches beyond its own. An input naming no space,
 * naming one by name, or not parsing at all adds none here; the input check
 * reports the last.
 */
const inputSpaces = (
  inputs: Readonly<Record<string, string>> | undefined,
  ownSpace: string,
): Set<string> => {
  const spaces = new Set<string>();
  for (const ref of Object.values(inputs ?? {})) {
    const space = spaceOf(ref);
    if (space !== undefined && space !== ownSpace) spaces.add(space);
  }
  return spaces;
};

/**
 * The foreign spaces a job's session is admitted to: each space an input
 * names outside `ownSpace`, routed to the origin the request names for it.
 * Only those the inputs name are passed, so nothing the request lists beyond
 * them widens the run — {@link narrowLocalJobProfile} has refused such a
 * request already.
 */
export const localJobForeignSpaces = (
  inputs: Readonly<Record<string, string>> | undefined,
  foreignSpaces: Readonly<Record<string, string>> | undefined,
  ownSpace: string,
): Record<string, string> => {
  const routes = validateHarnessForeignSpaces(foreignSpaces ?? {});
  const admitted: Record<string, string> = {};
  for (const space of inputSpaces(inputs, ownSpace)) {
    if (Object.hasOwn(routes, space)) admitted[space] = routes[space];
  }
  return admitted;
};

/**
 * Why `profile` cannot hold `inputs` with `foreignSpaces`, or `undefined`
 * when it can: each input is held to the rule the harness mints an input cell
 * under. A link may name a piece in another space by DID, provided the
 * request says which origin serves that space — the profile's own host is
 * never assumed to, since a space it does not serve reads as empty and
 * nothing reports it — and every space `foreignSpaces` lists must be one an
 * input names. A piece address names a slug, which resolves only in the
 * profile's own space, so one naming another space is refused. Under a profile
 * naming its space by DID, an address names it by that DID, and one qualified
 * by a name is refused, since that space has none. Under a profile naming its
 * space by a legacy name, an address naming a space by DID is left to the
 * session, which alone knows the DID that name resolves to.
 */
const refuseInputs = (
  profile: LocalJobProfile,
  inputs: Readonly<Record<string, string>> | undefined,
  foreignSpaces: Readonly<Record<string, string>> | undefined,
): string | undefined => {
  const listed = Object.keys(foreignSpaces ?? {});
  if (
    (inputs === undefined || Object.keys(inputs).length === 0) &&
    listed.length === 0
  ) {
    return undefined;
  }
  const { fabric } = profile;
  if (fabric === undefined) {
    return "The profile has no fabric session, so it can hold no inputs.";
  }
  let routes: Readonly<Record<string, string>>;
  try {
    routes = validateHarnessForeignSpaces(foreignSpaces ?? {});
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
  const named = inputSpaces(inputs, fabric.space);
  const unused = listed.filter((space) => !named.has(space));
  if (unused.length > 0) {
    return `\`foreignSpaces\` lists ${
      unused.map((space) => `\`${space}\``).join(", ")
    }, which no input names.`;
  }
  const byDid = isDID(fabric.space);
  for (const [name, ref] of Object.entries(inputs ?? {})) {
    // Asked first, in the request's own terms: the harness check below would
    // otherwise refuse the same input in the vocabulary of its command line.
    if (
      named.has(spaceOf(ref) ?? "") && !Object.hasOwn(routes, spaceOf(ref)!)
    ) {
      return `Input \`${name}\` names a piece in \`${
        spaceOf(ref)
      }\`; pass the origin serving that space in \`foreignSpaces\`.`;
    }
    let address;
    try {
      address = parseNamedPieceAddress(ref);
    } catch {
      // A malformed address is the harness check's to describe, below.
    }
    if (
      byDid && address?.spaceName !== undefined && !isDID(address.spaceName)
    ) {
      return `Input \`${name}\` names its space by name, and the profile names its space by DID; name the space by its DID, or send the space-relative /of:<id> form.`;
    }
    try {
      checkInputCellSpec(
        { name, ref },
        byDid ? fabric.space as MemorySpace : undefined,
        byDid ? undefined : fabric.space,
        routes,
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return message.includes(`\`${name}\``)
        ? message
        : `Input \`${name}\`: ${message}`;
    }
  }
  return undefined;
};

/**
 * The profile a caller's request runs under: `profile` narrowed to the tools
 * and turns the caller asked for, and to a browser host only when the
 * request declared one, or the reason the request asks for more than the
 * profile allows.
 */
export const narrowLocalJobProfile = (
  profile: LocalJobProfile,
  narrowing: LocalJobNarrowing,
): { profile: LocalJobProfile } | { refusal: string } => {
  const {
    tools,
    maxModelTurns,
    reasoningEffort,
    browserHost,
    maxInputBytes,
    maxOutputTokens,
  } = narrowing;
  for (const name of ["maxInputBytes", "maxOutputTokens"] as const) {
    const value = narrowing[name];
    const maximum = profile[name];
    if (
      value !== undefined &&
      (!Number.isSafeInteger(value) ||
        value < (name === "maxOutputTokens" ? 16 : 1) ||
        (maximum !== undefined && value > maximum))
    ) {
      return {
        refusal:
          `The request exceeds or invalidates the profile ${name} bound.`,
      };
    }
  }
  const beyond = tools?.filter((tool) => !profile.tools.includes(tool)) ?? [];
  if (beyond.length > 0) {
    return {
      refusal: `The profile does not allow ${
        beyond.map((tool) => `\`${tool}\``).join(", ")
      }.`,
    };
  }
  if (maxModelTurns !== undefined && maxModelTurns > profile.maxModelTurns) {
    return {
      refusal:
        `The profile allows at most ${profile.maxModelTurns} model turns.`,
    };
  }
  if (reasoningEffort !== undefined) {
    if (profile.reasoningEffort === undefined) {
      return {
        refusal:
          "The profile sets no reasoning effort, so a request may not name one.",
      };
    }
    if (
      REASONING_EFFORTS.indexOf(reasoningEffort) >
        REASONING_EFFORTS.indexOf(profile.reasoningEffort)
    ) {
      return {
        refusal:
          `The profile allows at most \`${profile.reasoningEffort}\` reasoning effort.`,
      };
    }
  }
  if (browserHost !== undefined && profile.browserHost !== true) {
    return { refusal: "The profile does not admit a browser host." };
  }
  const inputRefusal = refuseInputs(
    profile,
    narrowing.inputs,
    narrowing.foreignSpaces,
  );
  if (inputRefusal !== undefined) return { refusal: inputRefusal };
  const { browserHost: _admitted, subagentProfiles, ...rest } = profile;
  // Narrowed away from `delegate_task`, a job has nothing to spawn its
  // subagents with, and so is granted none.
  const delegates = (tools ?? profile.tools).some((tool) =>
    parseCfHarnessCliToolId(tool) === DELEGATE_TOOL
  );
  return {
    profile: {
      ...rest,
      ...(subagentProfiles !== undefined && delegates
        ? { subagentProfiles }
        : {}),
      ...(tools !== undefined ? { tools: [...tools] } : {}),
      ...(maxModelTurns !== undefined ? { maxModelTurns } : {}),
      ...(maxInputBytes !== undefined ? { maxInputBytes } : {}),
      ...(maxOutputTokens !== undefined ? { maxOutputTokens } : {}),
      ...(reasoningEffort !== undefined ? { reasoningEffort } : {}),
      ...(browserHost !== undefined ? { browserHost: true } : {}),
    },
  };
};
