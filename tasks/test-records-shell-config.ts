/**
 * Putting an environment variable into the shell profiles a person's
 * terminals actually read. The key tool uses it to finish the opt-in:
 * installing a key file does nothing on its own, because recording turns
 * on when CF_TEST_RECORDS_KEY_FILE names it in the environment every
 * later shell inherits.
 *
 * The lines carry a marker comment, so a second run recognizes its own
 * work and appends nothing. A line that sets the variable to something
 * else, or sets it without exporting it, is reported and left alone: a
 * profile is a person's file, and the tool's job there is to say what it
 * found.
 */

import { dirname, join } from "@std/path";
import { replaceFile } from "./test-records-atomic-write.ts";
import { type Environment, readEnv } from "@commonfabric/test-support/records";

/** The comment that marks the lines this tool wrote. */
export const MARKER = "# common-fabric test-records reporting key";

/** Shell families with their own profile paths and assignment syntax. */
export type ShellKind = "zsh" | "bash" | "fish" | "posix";

/** What one profile file's update did. */
export type ProfileOutcome =

  /** The line was appended. */
  | "added"
  /** The variable is already exported with this value. */
  | "present"
  /** The variable is already set to something else; nothing was written. */
  | "conflict"
  /**
   * The variable is set to this value but never exported, so the
   * programs the shell starts do not see it; nothing was written.
   */
  | "unexported"
  /**
   * A login shell reads this file first and it does not exist. Creating
   * it would stop the shell reading the file it falls back to, so the
   * person is told rather than the file written.
   */
  | "absent";

export interface ProfileUpdate {
  path: string;
  outcome: ProfileOutcome;

  /** The line already in the file, for a conflict or an unexported set. */
  existing?: string;
}

/** An assignment of one variable found in a profile. */
export interface ProfileSetting {
  /** The line, as the profile carries it. */
  line: string;

  /** Whether the assignment reaches the programs the shell starts. */
  exported: boolean;

  /** The path it names, read the way the shell reads it. */
  value: string;
}

/** The login shell's family, read from SHELL. */
export function shellKind(env: Environment = Deno.env.get): ShellKind {
  const shell = readEnv("SHELL", env) ?? "";
  const name = shell.split("/").pop() ?? "";
  if (name.includes("zsh")) return "zsh";
  if (name.includes("fish")) return "fish";
  if (name.includes("bash")) return "bash";
  return "posix";
}

/**
 * The profile files to hold the export, the one a login shell reads
 * first at the head. Every one of these that exists is updated, because
 * bash splits its startup between two files differently on macOS than on
 * Linux and a person whose terminal reads only one of them would
 * otherwise get a line that never runs.
 *
 * For zsh this is .zshenv rather than .zshrc. A test run started by
 * something other than a person typing — an agent's shell, a script, an
 * editor's task runner — is not an interactive shell, and .zshrc is
 * only read by interactive ones. Recording has to survive that, so the
 * export goes in the file every zsh reads.
 */
export function profileCandidates(
  env: Environment = Deno.env.get,
  os: string = Deno.build.os,
): string[] {
  const home = readEnv("HOME", env) ?? readEnv("USERPROFILE", env);
  if (home === undefined || home.length === 0) return [];
  switch (shellKind(env)) {
    case "zsh":
      return [join(zshDir(env, home), ".zshenv")];
    case "bash":
      return os === "darwin"
        ? [join(home, ".bash_profile"), join(home, ".bashrc")]
        : [join(home, ".bashrc"), join(home, ".bash_profile")];
    case "fish": {
      const xdg = readEnv("XDG_CONFIG_HOME", env);
      const dir = xdg !== undefined && xdg.length > 0
        ? xdg
        : join(home, ".config");
      return [join(dir, "fish", "config.fish")];
    }
    case "posix":
      return [join(home, ".profile")];
  }
}

function zshDir(env: Environment, home: string): string {
  const zdotdir = readEnv("ZDOTDIR", env);
  return zdotdir !== undefined && zdotdir.length > 0 ? zdotdir : home;
}

/**
 * Profiles that are not written but are read for a setting already
 * there, because a shell reads them after the one written and what they
 * say would win. A zsh reads .zshenv first and then, depending on how
 * the shell was started, .zprofile, .zshrc, and .zlogin.
 */
export function profilesToInspect(
  env: Environment = Deno.env.get,
): string[] {
  const home = readEnv("HOME", env) ?? readEnv("USERPROFILE", env);
  if (home === undefined || home.length === 0) return [];
  if (shellKind(env) !== "zsh") return [];
  const dir = zshDir(env, home);
  return [".zprofile", ".zshrc", ".zlogin"].map((name) => join(dir, name));
}

/** A path split at the home directory, when it sits under one. */
function splitHome(
  path: string,
  home: string | undefined,
): { underHome: boolean; rest: string } {
  if (home === undefined || home.length === 0) {
    return { underHome: false, rest: path };
  }
  const separators = /[\\/]/g;
  const root = home.replace(/[\\/]+$/, "");
  const normalized = path.replace(separators, "/");
  const normalizedRoot = root.replace(separators, "/");
  if (normalized === normalizedRoot) return { underHome: true, rest: "" };
  return normalized.startsWith(`${normalizedRoot}/`)
    ? { underHome: true, rest: path.slice(root.length) }
    : { underHome: false, rest: path };
}

/** A path under the home directory written through $HOME. */
export function homeRelative(path: string, home: string | undefined): string {
  const split = splitHome(path, home);
  return split.underHome ? `$HOME${split.rest}` : split.rest;
}

/**
 * A value inside double quotes, with everything the shell would still
 * act on there escaped, so a path holding a dollar sign, a quote, a
 * backslash, or a backtick names the file it says.
 */
function escapeInDoubleQuotes(kind: ShellKind, text: string): string {
  // Backticks open a command substitution in every shell here except
  // fish, which has none.
  const special = kind === "fish" ? /[\\"$]/g : /[\\"$`]/g;
  return text.replace(special, (character) => `\\${character}`);
}

/**
 * The line that exports one variable in a shell's own syntax, writing
 * the home directory as $HOME so the line survives a move between
 * machines.
 */
export function exportLine(
  kind: ShellKind,
  name: string,
  value: string,
  home?: string,
): string {
  const split = splitHome(value, home);
  const escaped = escapeInDoubleQuotes(kind, split.rest);
  const quoted = split.underHome ? `"$HOME${escaped}"` : `"${escaped}"`;
  return kind === "fish"
    ? `set -gx ${name} ${quoted}`
    : `export ${name}=${quoted}`;
}

/** A value with any comment that follows it on the line taken off. */
function stripComment(text: string): string {
  let quote: string | undefined;
  for (let index = 0; index < text.length; index += 1) {
    const character = text[index];
    if (character === "\\" && quote !== "'") {
      index += 1;
      continue;
    }
    if (quote !== undefined) {
      if (character === quote) quote = undefined;
      continue;
    }
    if (character === '"' || character === "'") {
      quote = character;
      continue;
    }
    const preceding = text[index - 1];
    if (
      character === "#" &&
      (index === 0 || preceding === undefined || /\s/.test(preceding))
    ) {
      return text.slice(0, index);
    }
  }
  return text;
}

/**
 * The path an assignment names, read the way the shell reads it: single
 * quotes hold their contents literally, double quotes and bare text
 * expand $HOME and act on backslashes, and an escaped dollar sign is a
 * dollar sign.
 */
export function effectiveValue(
  text: string,
  home: string | undefined,
): string {
  const trimmed = stripComment(text).trim();
  if (
    trimmed.length >= 2 && trimmed.startsWith("'") && trimmed.endsWith("'")
  ) {
    return trimmed.slice(1, -1);
  }
  const body = trimmed.length >= 2 && trimmed.startsWith('"') &&
      trimmed.endsWith('"')
    ? trimmed.slice(1, -1)
    : trimmed;
  const root = home === undefined || home.length === 0
    ? undefined
    : home.replace(/[\\/]+$/, "");
  let value = "";
  for (let index = 0; index < body.length; index += 1) {
    const character = body[index]!;
    if (character === "\\") {
      value += body[index + 1] ?? "";
      index += 1;
      continue;
    }
    // A name only ends at $HOME when what follows cannot continue it,
    // which is what keeps $HOMEBREW from reading as $HOME plus BREW.
    const home$ = body.slice(index).match(
      /^\$(?:\{HOME\}|HOME(?![A-Za-z0-9_]))/,
    );
    if (home$ !== null && root !== undefined) {
      value += root;
      index += home$[0].length - 1;
      continue;
    }
    value += character;
  }
  return value;
}

/** Whether the flags of a fish `set` export the variable. */
function fishExports(flags: string): boolean {
  let exported = false;
  for (const flag of flags.trim().split(/\s+/)) {
    if (flag.startsWith("--")) {
      if (flag === "--export") exported = true;
      if (flag === "--unexport") exported = false;
      continue;
    }
    if (!flag.startsWith("-")) continue;
    const letters = flag.slice(1);
    if (letters.includes("x")) exported = true;
    if (letters.includes("u")) exported = false;
  }
  return exported;
}

/** The assignment of a variable a profile already carries, if any. */
export function parseSetting(
  text: string,
  name: string,
  home?: string,
): ProfileSetting | undefined {
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (line.startsWith("#")) continue;
    const assignment = line.match(new RegExp(`^(export\\s+)?${name}=(.*)$`));
    if (assignment !== null) {
      return {
        line,
        exported: assignment[1] !== undefined,
        value: effectiveValue(assignment[2] ?? "", home),
      };
    }
    const set = line.match(
      new RegExp(`^set\\s+((?:-\\S+\\s+)*)${name}\\s+(.*)$`),
    );
    if (set !== null) {
      return {
        line,
        exported: fishExports(set[1] ?? ""),
        value: effectiveValue(set[2] ?? "", home),
      };
    }
  }
  return undefined;
}

async function readIfPresent(path: string): Promise<string | undefined> {
  try {
    return await Deno.readTextFile(path);
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) return undefined;
    throw error;
  }
}

/** What a profile that already sets the variable amounts to. */
function verdict(
  path: string,
  existing: ProfileSetting,
  value: string,
): ProfileUpdate {
  if (existing.value !== value) {
    return { path, outcome: "conflict", existing: existing.line };
  }
  return existing.exported
    ? { path, outcome: "present" }
    : { path, outcome: "unexported", existing: existing.line };
}

async function updateOne(
  path: string,
  name: string,
  line: string,
  value: string,
  home: string | undefined,
  create: boolean,
): Promise<ProfileUpdate | undefined> {
  const text = await readIfPresent(path);
  if (text === undefined && !create) return undefined;
  const existing = parseSetting(text ?? "", name, home);
  if (existing !== undefined) return verdict(path, existing, value);
  const separator = text === undefined || text.length === 0
    ? ""
    : text.endsWith("\n")
    ? "\n"
    : "\n\n";
  await Deno.mkdir(dirname(path), { recursive: true });
  await Deno.writeTextFile(path, `${separator}${MARKER}\n${line}\n`, {
    append: true,
  });
  return { path, outcome: "added" };
}

/**
 * Exports one variable from the login shell's profiles, returning what
 * each file's update did. Every profile that exists is written; when
 * none does, the one a login shell reads first is created. A first
 * profile that is missing while a later one exists is reported and not
 * created, since creating it is what stops a login shell reading the
 * file it falls back to.
 */
export async function exportFromProfiles(
  name: string,
  value: string,
  env: Environment = Deno.env.get,
  os: string = Deno.build.os,
): Promise<ProfileUpdate[]> {
  const candidates = profileCandidates(env, os);
  if (candidates.length === 0) return [];
  const home = readEnv("HOME", env) ?? readEnv("USERPROFILE", env);
  const line = exportLine(shellKind(env), name, value, home);
  const updates: ProfileUpdate[] = [];
  for (const path of profilesToInspect(env)) {
    const text = await readIfPresent(path);
    if (text === undefined) continue;
    const existing = parseSetting(text, name, home);
    if (existing === undefined) continue;
    updates.push(verdict(path, existing, value));
  }
  for (const path of candidates) {
    const update = await updateOne(path, name, line, value, home, false);
    if (update !== undefined) updates.push(update);
  }
  if (!updates.some((update) => candidates.includes(update.path))) {
    const created = await updateOne(
      candidates[0]!,
      name,
      line,
      value,
      home,
      true,
    );
    if (created !== undefined) updates.push(created);
    return updates;
  }
  const first = candidates[0]!;
  if (!updates.some((update) => update.path === first)) {
    updates.unshift({ path: first, outcome: "absent" });
  }
  return updates;
}

/** What one profile file's removal did. */
export type RemovalOutcome =

  /** The line this tool wrote was taken out. */
  | "removed"
  /** The variable is set by a line this tool did not write. */
  | "kept";

export interface ProfileRemoval {
  path: string;
  outcome: RemovalOutcome;

  /** The line left in place, for one this tool did not write. */
  existing?: string;
}

/**
 * Takes the marked block out of a profile's text. Only a block whose
 * line is word for word the one this tool writes comes out: a marker
 * over something a person has since edited names their line now,
 * whatever the comment above it says. The blank line this tool put in
 * front of the marker goes with it, so removing what was added leaves
 * the file as it stood.
 */
export function stripMarkedBlock(
  text: string,
  written: string,
): { text: string; removed: boolean } {
  const lines = text.split("\n");
  const kept: string[] = [];
  let removed = false;
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]!;
    const next = lines[index + 1];
    if (
      line.trim() === MARKER && next !== undefined && next.trim() === written
    ) {
      if (kept.length > 0 && kept[kept.length - 1]!.trim() === "") kept.pop();
      index += 1;
      removed = true;
      continue;
    }
    kept.push(line);
  }
  return { text: kept.join("\n"), removed };
}

/**
 * Takes this tool's export back out of every profile it writes or
 * reads, returning what each file's removal did. A line setting the
 * variable that this tool did not write is reported and left alone: it
 * is a person's own, whatever it says.
 */
export async function unexportFromProfiles(
  name: string,
  value: string,
  env: Environment = Deno.env.get,
  os: string = Deno.build.os,
): Promise<ProfileRemoval[]> {
  const removals: ProfileRemoval[] = [];
  const home = readEnv("HOME", env) ?? readEnv("USERPROFILE", env);
  const written = exportLine(shellKind(env), name, value, home);
  const paths = [...profileCandidates(env, os), ...profilesToInspect(env)];
  for (const path of paths) {
    const text = await readIfPresent(path);
    if (text === undefined) continue;
    const stripped = stripMarkedBlock(text, written);
    if (stripped.removed) {
      await replaceFile(path, stripped.text);
      removals.push({ path, outcome: "removed" });
      continue;
    }
    const existing = parseSetting(text, name);
    if (existing !== undefined) {
      removals.push({ path, outcome: "kept", existing: existing.line });
    }
  }
  return removals;
}

/**
 * Points this tool's export of a variable at a new value in every
 * profile it writes or reads, returning the profiles it changed. Only a
 * marked line that is word for word the one this tool writes for the
 * old value changes; any other line is a person's own.
 */
export async function reexportFromProfiles(
  name: string,
  from: string,
  to: string,
  env: Environment = Deno.env.get,
  os: string = Deno.build.os,
): Promise<string[]> {
  const home = readEnv("HOME", env) ?? readEnv("USERPROFILE", env);
  const kind = shellKind(env);
  const written = exportLine(kind, name, from, home);
  const replacement = exportLine(kind, name, to, home);
  const changed: string[] = [];
  for (
    const path of [...profileCandidates(env, os), ...profilesToInspect(env)]
  ) {
    const text = await readIfPresent(path);
    if (text === undefined) continue;
    const lines = text.split("\n");
    let found = false;
    for (let index = 1; index < lines.length; index += 1) {
      if (
        lines[index - 1]!.trim() === MARKER && lines[index]!.trim() === written
      ) {
        lines[index] = lines[index]!.replace(written, replacement);
        found = true;
      }
    }
    if (!found) continue;
    await replaceFile(path, lines.join("\n"));
    changed.push(path);
  }
  return changed;
}

/** The command that loads a profile into the shell already running. */
export function reloadHint(path: string, kind: ShellKind): string {
  return kind === "fish" ? `source ${path}` : `. ${path}`;
}
