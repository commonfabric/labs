/**
 * Host-approved profiles for local jobs: the authority a job runs with,
 * chosen by name. A profile says which tools a job may use, which host
 * configurations back them, how many model turns it gets, and the
 * prompt-slot role its task binds as. The host writes the file; a caller
 * names a profile and may only narrow it — fewer tools, fewer turns —
 * never widen it, and never set its role.
 */

import { isAbsolute } from "@std/path";

import type { PromptSlotRole } from "@commonfabric/cf-harness/contracts/prompt-slot";
import { isObjectNotArray } from "@commonfabric/utils/types";

/** One profile, as the host file states it. */
export interface LocalJobProfile {
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
}

/** The profiles a host file names, by name. */
export type LocalJobProfiles = ReadonlyMap<string, LocalJobProfile>;

/** What a caller may ask of a profile. */
export interface LocalJobNarrowing {
  tools?: readonly string[];
  maxModelTurns?: number;
}

const ROLES: readonly PromptSlotRole[] = ["direct-command", "context", "quote"];

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
    taskRole,
    retry,
    loomRetrievalConfig,
    loomCommandsConfig,
    model,
  } = record;
  if (
    !Array.isArray(tools) || !tools.every((tool) => typeof tool === "string")
  ) {
    fail("`tools` must be a list of tool names");
  }
  if (
    typeof maxModelTurns !== "number" || !Number.isInteger(maxModelTurns) ||
    maxModelTurns < 1
  ) {
    fail("`maxModelTurns` must be a whole number of 1 or more");
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
  return {
    tools: [...(tools as string[])],
    maxModelTurns: maxModelTurns as number,
    taskRole: taskRole as PromptSlotRole,
    retry: "never",
    ...(loomRetrievalConfig !== undefined
      ? { loomRetrievalConfig: loomRetrievalConfig as string }
      : {}),
    ...(loomCommandsConfig !== undefined
      ? { loomCommandsConfig: loomCommandsConfig as string }
      : {}),
    ...(model !== undefined ? { model: model as string } : {}),
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

/**
 * The profile a caller's request runs under: `profile` narrowed to the tools
 * and turns the caller asked for, or the reason the request asks for more
 * than the profile allows.
 */
export const narrowLocalJobProfile = (
  profile: LocalJobProfile,
  narrowing: LocalJobNarrowing,
): { profile: LocalJobProfile } | { refusal: string } => {
  const { tools, maxModelTurns } = narrowing;
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
  return {
    profile: {
      ...profile,
      ...(tools !== undefined ? { tools: [...tools] } : {}),
      ...(maxModelTurns !== undefined ? { maxModelTurns } : {}),
    },
  };
};
