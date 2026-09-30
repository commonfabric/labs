/**
 * Putting an environment variable into the configuration of the
 * harnesses that run agents. A shell profile reaches an agent whose
 * commands go through that shell; an agent that runs commands some
 * other way is reached only by telling its harness to carry the
 * variable, which is what this does.
 *
 * These are other programs' files. Nothing here writes one that does
 * not parse, writes one whose variable is already set to something
 * else, or writes a file in place: the new text goes to a temporary
 * file beside it and is renamed over it, so an interrupted write leaves
 * the configuration a harness reads either exactly as it was or exactly
 * as it should be, and never half of each.
 */

import { dirname, join } from "@std/path";
import { replaceFile } from "./test-records-atomic-write.ts";
import { type Environment, readEnv } from "@commonfabric/test-support/records";
import { isObjectNotArray } from "@commonfabric/utils/types";

/** A harness whose configuration can carry the variable. */
export interface AgentHarness {
  /** What the harness is called, for what the tool prints. */
  name: string;

  /** The directory whose presence means the harness is installed. */
  home: (home: string) => string;

  /** The configuration file, which need not exist yet. */
  config: (home: string) => string;
}

/**
 * The harnesses this knows how to configure. A harness is left alone
 * unless its own directory is there, so nothing creates configuration
 * for a program the person does not run.
 */
export const AGENT_HARNESSES: readonly AgentHarness[] = [
  {
    name: "Claude Code",
    home: (home) => join(home, ".claude"),
    config: (home) => join(home, ".claude", "settings.json"),
  },
];

/**
 * Replaces a configuration file, answering false where it declined to
 * because the file is no longer the one that was read. Injectable so a
 * test can have it decline.
 */
export type ConfigWriter = (
  path: string,
  config: Record<string, unknown>,
  before: string | undefined,
) => Promise<boolean>;

/** What one harness configuration's update did. */
export type AgentConfigOutcome =

  /** The variable was written into the configuration. */
  | "added"
  /** The configuration already carries the variable with this value. */
  | "present"
  /** It carries the variable with another value; nothing was written. */
  | "conflict"
  /** The file does not parse, so nothing was written. */
  | "unreadable"
  /** The file changed while this was writing, so nothing was written. */
  | "changed";

export interface AgentConfigUpdate {
  harness: string;
  path: string;
  outcome: AgentConfigOutcome;

  /** The value already there, for a conflict. */
  existing?: string;
}

/** What one harness configuration's removal did. */
export type AgentConfigRemoval = {
  harness: string;
  path: string;
  outcome: "removed" | "kept" | "unreadable" | "changed";
  existing?: string;
};

/** A configuration value as a person should see it quoted back. */
function describe(value: unknown): string {
  return typeof value === "string" ? value : JSON.stringify(value) ?? "nothing";
}

function homeDirectory(env: Environment): string | undefined {
  return readEnv("HOME", env) ?? readEnv("USERPROFILE", env);
}

/** The harnesses installed for this person. */
export async function installedHarnesses(
  env: Environment = Deno.env.get,
  harnesses: readonly AgentHarness[] = AGENT_HARNESSES,
): Promise<{ harness: AgentHarness; config: string }[]> {
  const home = homeDirectory(env);
  if (home === undefined || home.length === 0) return [];
  const installed: { harness: AgentHarness; config: string }[] = [];
  for (const harness of harnesses) {
    try {
      const stat = await Deno.stat(harness.home(home));
      if (stat.isDirectory) {
        installed.push({ harness, config: harness.config(home) });
      }
    } catch {
      // A harness that is not installed has nothing to configure.
    }
  }
  return installed;
}

/** What a configuration file holds, and the text it was read from. */
type ConfigRead =
  | { kind: "missing" }
  | { kind: "unreadable" }
  | {
    kind: "config";
    config: Record<string, unknown>;
    text: string;
  };

async function readConfig(path: string): Promise<ConfigRead> {
  let text: string;
  try {
    text = await Deno.readTextFile(path);
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) return { kind: "missing" };
    return { kind: "unreadable" };
  }
  if (text.trim().length === 0) return { kind: "config", config: {}, text };
  try {
    const parsed = JSON.parse(text);
    return isObjectNotArray(parsed)
      ? { kind: "config", config: parsed as Record<string, unknown>, text }
      : { kind: "unreadable" };
  } catch {
    return { kind: "unreadable" };
  }
}

/**
 * Writes a configuration, in one step or not at all: the replacement
 * itself is `replaceFile`, which keeps the file's permissions and any
 * link leading to it.
 *
 * The text the configuration was read from is checked again first. A
 * harness writing its own settings in between is rare, and losing what
 * it wrote would be silent, so the write stands down and says so.
 * Between that check and the rename there is a moment this cannot
 * account for, and no portable way to close it; what it buys is that
 * the ordinary case of a harness writing while a person runs setup
 * does not quietly lose a setting.
 */
export async function writeConfig(
  path: string,
  config: Record<string, unknown>,
  before: string | undefined,
): Promise<boolean> {
  if (!await unchanged(path, before)) return false;
  await Deno.mkdir(dirname(path), { recursive: true });
  await replaceFile(path, JSON.stringify(config, null, 2) + "\n");
  return true;
}

/**
 * Whether a file still holds the text it was read from. A file that
 * cannot be read now is not a file this can say that about, so it
 * answers no: standing down loses nothing, and writing anyway would
 * lose whatever put it out of reach.
 */
async function unchanged(
  path: string,
  before: string | undefined,
): Promise<boolean> {
  try {
    return await Deno.readTextFile(path) === before;
  } catch (error) {
    return error instanceof Deno.errors.NotFound && before === undefined;
  }
}

/** The env block a configuration carries, when it carries a usable one. */
function envBlock(
  config: Record<string, unknown>,
): Record<string, unknown> | undefined {
  const env = config.env;
  if (env === undefined) return {};
  return isObjectNotArray(env) ? env as Record<string, unknown> : undefined;
}

/**
 * Carries one variable into every installed harness's configuration,
 * returning what each one's update did.
 */
export async function exportFromAgentConfigs(
  name: string,
  value: string,
  env: Environment = Deno.env.get,
  harnesses: readonly AgentHarness[] = AGENT_HARNESSES,
  write: ConfigWriter = writeConfig,
): Promise<AgentConfigUpdate[]> {
  const updates: AgentConfigUpdate[] = [];
  for (
    const { harness, config: path } of await installedHarnesses(
      env,
      harnesses,
    )
  ) {
    const read = await readConfig(path);
    if (read.kind === "unreadable") {
      updates.push({ harness: harness.name, path, outcome: "unreadable" });
      continue;
    }
    const held = read.kind === "config" ? read.config : {};
    const before = read.kind === "config" ? read.text : undefined;
    const block = envBlock(held);
    if (block === undefined) {
      updates.push({ harness: harness.name, path, outcome: "unreadable" });
      continue;
    }
    const existing = block[name];
    if (existing === value) {
      updates.push({ harness: harness.name, path, outcome: "present" });
      continue;
    }
    if (existing !== undefined) {
      // Whatever it is — another path, a null, a number — it is not what
      // this tool wrote, and writing over it would take away something
      // nothing here can put back.
      updates.push({
        harness: harness.name,
        path,
        outcome: "conflict",
        existing: describe(existing),
      });
      continue;
    }
    const wrote = await write(
      path,
      { ...held, env: { ...block, [name]: value } },
      before,
    );
    updates.push({
      harness: harness.name,
      path,
      outcome: wrote ? "added" : "changed",
    });
  }
  return updates;
}

/**
 * Takes one variable back out of every installed harness's
 * configuration, leaving a value naming anything else in place. An env
 * block with nothing left in it goes too, so the file returns to the
 * shape it had.
 *
 * What comes out is decided by the value, not by a record of who wrote
 * it: an entry naming the key file is removed whether this tool put it
 * there or a person did. That is the same answer either way, because
 * the key file is being deleted in the same breath, and an entry naming
 * a file that is gone would hand every command the harness runs a
 * variable pointing at nothing.
 */
export async function unexportFromAgentConfigs(
  name: string,
  value: string,
  env: Environment = Deno.env.get,
  harnesses: readonly AgentHarness[] = AGENT_HARNESSES,
  write: ConfigWriter = writeConfig,
): Promise<AgentConfigRemoval[]> {
  const removals: AgentConfigRemoval[] = [];
  for (
    const { harness, config: path } of await installedHarnesses(
      env,
      harnesses,
    )
  ) {
    const read = await readConfig(path);
    if (read.kind === "missing") continue;
    if (read.kind === "unreadable") {
      removals.push({ harness: harness.name, path, outcome: "unreadable" });
      continue;
    }
    const config = read.config;
    const block = envBlock(config);
    if (block === undefined || !(name in block)) continue;
    const existing = block[name];
    if (existing !== value) {
      removals.push({
        harness: harness.name,
        path,
        outcome: "kept",
        existing: describe(existing),
      });
      continue;
    }
    const { [name]: _removed, ...rest } = block;
    const written = { ...config };
    if (Object.keys(rest).length === 0) {
      delete written.env;
    } else {
      written.env = rest;
    }
    const wrote = await write(path, written, read.text);
    removals.push({
      harness: harness.name,
      path,
      outcome: wrote ? "removed" : "changed",
    });
  }
  return removals;
}
