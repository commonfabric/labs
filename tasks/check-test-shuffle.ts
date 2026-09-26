#!/usr/bin/env -S deno run --allow-read --allow-run=git

/**
 * Fails when a command that starts a test runner does not shuffle the
 * order its tests run in.
 *
 * A test that quietly needs another test to have run before it passes
 * for as long as nothing disturbs the order, and a runner left to itself
 * walks its tests in declaration order. Shuffling disturbs the order on
 * a schedule, which turns such a dependence into a failed run rather
 * than a surprise the next time someone moves a test. That is worth
 * nothing if one path out of forty still runs in declaration order, so
 * this holds every path to it.
 *
 * `deno test` is handed `--shuffle=<seed>`. A runner this repository
 * owns shuffles in its own code or forwards the flag to the `deno test`
 * it starts; each one is listed in {@link RUNNERS} with which of the two
 * it does. A command that runs tests in an order that is the test —
 * where each step acts on what the step before it left — is listed in
 * {@link EXEMPTIONS} with that reason.
 *
 * Two halves. Every command written in a task, a workflow, or a shell
 * script is held to carrying the flag where it needs one. Every
 * workspace member is held to reaching a runner named here at all, which
 * is what a member arriving with a runner nobody decided about fails.
 * A member's task may run other commands beside its runner — a type
 * check, a baseline capture — and a second test runner hidden among
 * those is left to review.
 *
 * Usage: deno run --allow-read --allow-run=git ./tasks/check-test-shuffle.ts
 */

import { basename, dirname, fromFileUrl, join } from "@std/path";
import { parse as parseJsonc } from "@std/jsonc";
import { readInvocation } from "./run-member-tests.ts";

const REPO_ROOT = dirname(dirname(fromFileUrl(import.meta.url)));

/** How a runner this repository owns comes by its order. */
type RunnerKind =
  /** It shuffles in its own code, so its callers write no flag. */
  | "shuffles"
  /** It hands its own trailing flags to `deno test`, which needs one. */
  | "forwards";

/** A runner this repository owns, and how it comes by its order. */
interface Runner {
  /** What a command naming it contains, as written. */
  command: string;

  kind: RunnerKind;

  /** The module that does the shuffling, or that forwards the flag. */
  implementation: string;
}

/**
 * The runners this repository owns. A `forwards` entry needs the flag
 * written beside it in the command that starts it; a `shuffles` entry
 * needs no flag anywhere, because the module named does it.
 */
const RUNNERS: readonly Runner[] = [
  {
    command: "run-test-batches.ts",
    kind: "forwards",
    implementation: "tasks/run-test-batches.ts",
  },
  {
    command: "deno-web-test/cli.ts",
    kind: "shuffles",
    implementation: "packages/deno-web-test/runner.ts",
  },
  {
    command: "cf test",
    kind: "shuffles",
    implementation: "packages/cli/lib/test-runner.ts",
  },
];

/** A test runner whose order is the test rather than an accident of it. */
interface Exemption {
  /** The runner, as a repository-relative path. */
  path: string;

  reason: string;
}

/**
 * Commands whose order is the test rather than an accident of it. Each
 * is one scenario whose every step acts on the state the step before it
 * left, so a reordering does not find a bug, it invents one.
 */
const EXEMPTIONS: readonly Exemption[] = [
  {
    path: "packages/cli/integration/integration.sh",
    reason:
      "one scenario driven end to end: it creates a space, writes to it, " +
      "and reads back what it wrote, so every step acts on what the step " +
      "before it left",
  },
  {
    path: "packages/cli/integration/acl.sh",
    reason: "one scenario driven end to end: each grant it checks is one an " +
      "earlier step made",
  },
  {
    path: "packages/cli/integration/fuse-exec.sh",
    reason:
      "one scenario driven end to end, in phases that mount a filesystem " +
      "and then act through the mount",
  },
];

/** Where a command that needs the flag and does not carry it was found. */
export interface Violation {
  /** The file and, for a manifest, the task inside it. */
  where: string;

  command: string;
  problem: string;
}

/**
 * A command's text split in two: the text with every command
 * substitution taken out, and the body of each substitution. What a
 * substitution produces is an argument to the command around it, but
 * the shell runs its body as commands of their own, so both halves are
 * read.
 */
function splitSubstitutions(
  command: string,
): { outer: string; bodies: string[] } {
  let outer = "";
  const bodies: string[] = [];
  let depth = 0;
  let body = "";
  for (let index = 0; index < command.length; index++) {
    if (command.startsWith("$(", index)) {
      if (depth > 0) body += "$(";
      depth++;
      index++;
      continue;
    }
    if (depth > 0) {
      if (command[index] === "(") depth++;
      else if (command[index] === ")") depth--;
      if (depth === 0) {
        bodies.push(body);
        body = "";
      } else {
        body += command[index];
      }
      continue;
    }
    outer += command[index];
  }
  return { outer, bodies };
}

/**
 * The separate commands a task line runs: those joined at its top level,
 * and those inside each command substitution, found the same way.
 */
export function commandsOf(task: string): string[] {
  const { outer, bodies } = splitSubstitutions(task);
  return [
    ...outer
      .split(/&&|\|\||;|(?<!\|)\|(?!\|)/)
      .map((part) => part.trim())
      .filter((part) => part.length > 0),
    ...bodies.flatMap(commandsOf),
  ];
}

/**
 * Whether a command runs a shell test harness. Such a harness holds its
 * own assertions and its own order, so it answers to this check as a
 * runner rather than as an ordinary command. An `integration/` directory
 * is where this repository keeps them, and is the same boundary
 * `deno task check-no-waitfor` reads; one written anywhere else is left
 * to review.
 */
function startsShellHarness(command: string): boolean {
  return /(^|\s)[\w./-]*integration\/[\w.-]+\.sh(\s|$)/.test(command);
}

/** Whether a command starts `deno test`. */
function startsDenoTest(command: string): boolean {
  return /(^|\s)deno test(\s|$)/.test(command);
}

/** Whether a command carries a seeded shuffle. */
function carriesShuffle(command: string): boolean {
  return command.includes("--shuffle=");
}

/** The runner a command names, where it names one. */
function runnerOf(command: string): Runner | undefined {
  return RUNNERS.find((runner) => command.includes(runner.command));
}

/**
 * The exemption covering a command, where one does. A command names a
 * harness by a path relative to wherever it runs, so the file name is
 * what the two have in common; {@link staleRecords} is what holds a
 * recorded name to belonging to one file.
 */
function exemptionOf(command: string): Exemption | undefined {
  return EXEMPTIONS.find((entry) => command.includes(basename(entry.path)));
}

/**
 * What is wrong with one command, or nothing where it is fine. A command
 * this does not recognize as starting a test runner is fine: the gate is
 * over the runners, not over every command written anywhere.
 */
export function problemWith(command: string): string | undefined {
  if (exemptionOf(command) !== undefined) return undefined;
  if (startsDenoTest(command)) {
    return carriesShuffle(command)
      ? undefined
      : "a `deno test` with no `--shuffle=`; write " +
        "`--shuffle=$(deno task -q test-seed)` after `deno test`";
  }
  if (startsShellHarness(command)) {
    return "a shell test harness whose order nobody decided about; " +
      "record in EXEMPTIONS in tasks/check-test-shuffle.ts why its " +
      "order is the test";
  }
  const runner = runnerOf(command);
  if (runner === undefined) return undefined;
  if (runner.kind === "shuffles") return undefined;
  return carriesShuffle(command)
    ? undefined
    : `${runner.implementation} hands its trailing flags to the \`deno ` +
      "test\` it starts, so write `--shuffle=$(deno task -q test-seed)` " +
      "among them";
}

/** Whether a line of a workflow or a shell script is a comment. */
function isComment(line: string): boolean {
  return line.trimStart().startsWith("#");
}

/** Every command written in a text file, with the line it was written on. */
export function writtenCommands(
  contents: string,
): { line: number; command: string }[] {
  const found: { line: number; command: string }[] = [];
  const lines = contents.split("\n");
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index]!;
    if (isComment(line)) continue;
    for (const command of commandsOf(line)) {
      found.push({ line: index + 1, command });
    }
  }
  return found;
}

/** Lists the repository-relative paths of every tracked file. */
async function trackedFiles(root: string): Promise<string[]> {
  const { success, stdout, stderr } = await new Deno.Command("git", {
    args: ["ls-files", "-z"],
    cwd: root,
    stdout: "piped",
    stderr: "piped",
  }).output();
  if (!success) {
    throw new Error(
      `git ls-files failed: ${new TextDecoder().decode(stderr).trim()}`,
    );
  }
  return new TextDecoder().decode(stdout).split("\0").filter((p) => p !== "");
}

/** Whether a file is a manifest, whose commands are read from its tasks. */
function isManifest(file: string): boolean {
  return /(^|\/)deno\.jsonc?$/.test(file);
}

/** Whether a file is a script, whose commands are read from its lines. */
function isScript(file: string): boolean {
  return /^\.github\/workflows\/.*\.ya?ml$/.test(file) ||
    file.endsWith(".sh");
}

/** Every workspace member, as the root manifest lists it. */
async function workspaceMembers(root: string): Promise<string[]> {
  const manifest = parseJsonc(
    await Deno.readTextFile(join(root, "deno.jsonc")),
  ) as { workspace: string[] };
  return manifest.workspace;
}

/** A member's tasks, or nothing where it declares none. */
async function memberTasks(
  root: string,
  member: string,
): Promise<Record<string, unknown> | undefined> {
  for (const name of ["deno.json", "deno.jsonc"]) {
    try {
      const manifest = parseJsonc(
        await Deno.readTextFile(join(root, member, name)),
      ) as { tasks?: Record<string, unknown> };
      return manifest.tasks ?? {};
    } catch (error) {
      if (!(error instanceof Deno.errors.NotFound)) throw error;
    }
  }
  return undefined;
}

/** The tasks a manifest declares, or nothing where it declares none. */
async function manifestTasks(
  path: string,
): Promise<Record<string, unknown> | undefined> {
  try {
    const manifest = parseJsonc(await Deno.readTextFile(path)) as {
      tasks?: Record<string, unknown>;
    };
    return manifest.tasks;
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) return undefined;
    throw error;
  }
}

/** The commands one task runs itself, without following the names it calls. */
function ownCommands(
  tasks: Record<string, unknown>,
  name: string,
): string[] {
  const task = tasks[name];
  if (typeof task === "string") return commandsOf(task);
  if (task !== null && typeof task === "object") {
    const shape = task as { command?: string };
    if (typeof shape.command === "string") return commandsOf(shape.command);
  }
  return [];
}

/** The script every member's `test` task runs its other tasks through. */
const MEMBER_TEST_SCRIPT = "run-member-tests.ts";

/** The commands one of a member's tasks runs, following its own names. */
function taskCommands(
  tasks: Record<string, unknown>,
  name: string,
  seen: Set<string> = new Set(),
): string[] {
  if (seen.has(name)) return [];
  seen.add(name);
  const task = tasks[name];
  const commands: string[] = [];
  const follow = (command: string) => {
    const named = /^deno task (?:-q |--quiet )?([\w:.-]+)/.exec(command);
    if (named !== null && named[1]! in tasks) {
      commands.push(...taskCommands(tasks, named[1]!, seen));
      return;
    }
    // A member's `test` task hands its task names to the script that runs
    // them in order, which is where the member's runners are.
    const words = command.split(/\s+/);
    const script = words.findIndex((word) => word.endsWith(MEMBER_TEST_SCRIPT));
    if (script !== -1) {
      const { tasks: names } = readInvocation(words.slice(script + 1));
      for (const next of names) {
        if (next in tasks) commands.push(...taskCommands(tasks, next, seen));
      }
      return;
    }
    commands.push(command);
  };
  if (typeof task === "string") {
    for (const command of commandsOf(task)) follow(command);
  } else if (task !== null && typeof task === "object") {
    const shape = task as { command?: string; dependencies?: string[] };
    for (const dependency of shape.dependencies ?? []) {
      commands.push(...taskCommands(tasks, dependency, seen));
    }
    if (typeof shape.command === "string") {
      for (const command of commandsOf(shape.command)) follow(command);
    }
  }
  return commands;
}

/**
 * Whether a command says the member has no tests to run. A member
 * without tests declares a `test` task all the same, so that the
 * workspace runner does not fall through to the root's and run the whole
 * suite inside itself.
 */
function announcesNoTests(command: string): boolean {
  return /^echo (['"])No tests defined\.\1$/.test(command);
}

/** Runs the check over `root`, reporting what it found. */
export async function scan(root: string): Promise<Violation[]> {
  const violations: Violation[] = [];
  const files = await trackedFiles(root);
  const manifests = files.filter(isManifest);
  const scripts = files.filter(isScript);

  // A manifest's commands are read from its tasks rather than from its
  // lines: a task is a JSON string, so the command inside it starts
  // after a quote and a line scan would take the quote for part of the
  // first word.
  for (const file of manifests) {
    const tasks = await manifestTasks(join(root, file));
    if (tasks === undefined) continue;
    for (const name of Object.keys(tasks)) {
      for (const command of ownCommands(tasks, name)) {
        const problem = problemWith(command);
        if (problem === undefined) continue;
        violations.push({
          where: `${file} (task \`${name}\`)`,
          command: command.trim(),
          problem,
        });
      }
    }
  }

  for (const file of scripts) {
    let contents: string;
    try {
      contents = await Deno.readTextFile(join(root, file));
    } catch (error) {
      if (error instanceof Deno.errors.NotFound) continue;
      throw error;
    }
    for (const { line, command } of writtenCommands(contents)) {
      const problem = problemWith(command);
      if (problem === undefined) continue;
      violations.push({
        where: `${file}:${line}`,
        command: command.trim(),
        problem,
      });
    }
  }

  // Every member is held to reaching a runner this knows shuffles, which
  // is what keeps a new member from arriving with a runner nobody
  // decided about. A member's task may run other commands beside it — a
  // type check, a baseline capture — and those are not this check's to
  // recognize.
  for (const member of await workspaceMembers(root)) {
    const tasks = await memberTasks(root, member);
    if (tasks === undefined) continue;
    const commands = taskCommands(tasks, "test");
    const reaches = commands.some((command) =>
      announcesNoTests(command) || startsDenoTest(command) ||
      startsShellHarness(command) || runnerOf(command) !== undefined
    );
    if (reaches) continue;
    violations.push({
      where: `${member.replace(/^\.\//, "")} (task \`test\`)`,
      command: commands.join(" && ") || "(no `test` task)",
      problem:
        "a `test` task reaching no runner this check knows to shuffle; " +
        "add the runner to RUNNERS in tasks/check-test-shuffle.ts",
    });
  }

  return violations;
}

/** The records of this file, held against the tree under `root`. */
export async function staleRecordsIn(root: string): Promise<Violation[]> {
  const files = await trackedFiles(root);
  const written = await Promise.all(
    files.filter((file) => isManifest(file) || isScript(file)).map((file) =>
      Deno.readTextFile(join(root, file)).catch(() => "")
    ),
  );
  return staleRecords(files, written);
}

/**
 * The records that have stopped describing the tree, which is the way
 * one of these goes wrong quietly: a runner nothing starts any more, and
 * an exemption for a harness the tree no longer holds, both read as
 * decisions somebody made about code that is there.
 */
export function staleRecords(
  trackedFiles: readonly string[],
  written: readonly string[],
): Violation[] {
  const violations: Violation[] = [];
  const tracked = new Set(trackedFiles);
  const named = (command: string, problem: string) =>
    violations.push({
      where: "tasks/check-test-shuffle.ts",
      command,
      problem,
    });
  for (const runner of RUNNERS) {
    if (!written.some((contents) => contents.includes(runner.command))) {
      named(runner.command, "a RUNNERS entry no command names any more");
    }
    if (!tracked.has(runner.implementation)) {
      named(
        runner.implementation,
        "a RUNNERS entry whose implementation the tree no longer holds",
      );
    }
  }
  for (const entry of EXEMPTIONS) {
    if (!tracked.has(entry.path)) {
      named(
        entry.path,
        "an EXEMPTIONS entry naming a file the tree no longer holds",
      );
      continue;
    }
    // An exemption is recognized by the file name a command writes,
    // which a second harness of that name elsewhere would answer to as
    // well, under a reason written about this one.
    const sharing = trackedFiles.filter((file) =>
      file.endsWith(`/${basename(entry.path)}`)
    );
    if (sharing.length > 1) {
      named(
        entry.path,
        `an EXEMPTIONS entry whose file name ${sharing.length} files share ` +
          `(${sharing.join(", ")}); a reason written about one of them ` +
          "exempts all of them",
      );
    }
  }
  return violations;
}

/** Runs the check over `root`, reports, and returns a process code. */
export async function main(root: string = REPO_ROOT): Promise<number> {
  const violations = [...await scan(root), ...await staleRecordsIn(root)];
  if (violations.length === 0) {
    console.log("Every test runner in the workspace shuffles its order.");
    return 0;
  }
  console.error("\nCommands that start a test runner without shuffling:\n");
  for (const violation of violations) {
    console.error(`  ${violation.where}`);
    console.error(`    ${violation.command}`);
    console.error(`    ${violation.problem}`);
  }
  console.error(
    "\nThe seed comes from `deno task test-seed`, which reads the Pacific " +
      "day the\ncommit under test was committed on. " +
      "docs/development/TESTING.md covers it.\n",
  );
  return 1;
}

if (import.meta.main) Deno.exit(await main());
