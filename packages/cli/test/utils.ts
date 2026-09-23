import { expect } from "@std/expect/expect";
import { join } from "@std/path";

import { decode, encode } from "@commonfabric/utils/encoding";
import { isPerfDiagnosticWarnKey } from "../lib/perf-diagnostic-logs.ts";

// Decodes a `Uint8Array` into an array of strings for each line.
export function bytesToLines(stream: Uint8Array): string[] {
  return decode(stream).split("\n").filter(Boolean);
}

// deno-lint-ignore no-control-regex
const ANSI_RE = /\x1b\[[0-9;]*m/g;

export function stripAnsi(text: string): string {
  return text.replace(ANSI_RE, "");
}

// A tagged logger writes `[WARN][<logger>::<HH:MM:SS.mmm>] <key> <message…>`,
// straight to stderr under LOG_TO_STDERR and through `console.warn` otherwise,
// which Deno also sends to stderr.
const TAGGED_WARN_LINE = /^\[WARN\]\[(.+)::\d\d:\d\d:\d\d\.\d\d\d\] (.*)$/;

// True when `line` is one a logger wrote at warn level for a perf diagnostic.
function isPerfDiagnosticLogLine(line: string): boolean {
  const match = TAGGED_WARN_LINE.exec(line);
  if (match === null) return false;
  const [, loggerName, keyAndMessage] = match;
  return isPerfDiagnosticWarnKey(loggerName, keyAndMessage);
}

// True when `line`, which comes with its ANSI escapes stripped, opens a record
// a test has no business asserting on: noise Deno itself writes, and the
// runtime's perf diagnostics. Neither says anything about the command that ran
// — Deno's lines report the state of the module cache, and a perf diagnostic
// reports how loaded the machine was — so a test counting them would pass or
// fail on a fact about the machine.
function isIgnorableStderrLine(line: string): boolean {
  const trimmed = line.trimStart();
  return trimmed.startsWith(
    "Warning The following peer dependency issues were found:",
  ) ||
    trimmed.startsWith("╭ Warning") ||
    trimmed.startsWith("╰─") ||
    trimmed.startsWith("│") ||
    // Deno prints one of these per module it fetches whenever the module cache
    // is cold, which happens on a fresh machine and after any change that
    // invalidates the cache, such as a Deno version bump.
    trimmed.startsWith("Download ") ||
    /^[└├]/u.test(trimmed) ||
    isPerfDiagnosticLogLine(trimmed);
}

// A console handed a value too wide for one line spills it over several, and
// the shape of that spill is what says which lines below a record belong to
// it. The bracket the console opens ends the line it opened on, every line of
// the value is indented, and the bracket closes alone at column 0. Text the
// value holds passes for neither end, because a console prints a string in its
// quotes: a `[` in one never ends the line, and a `}` in one is indented and
// quoted rather than standing alone.
const OPENS_SPILLED_VALUE = /[[({]$/;
const INSIDE_SPILLED_VALUE = /^\s/;
const CLOSES_SPILLED_VALUE = /^[)\]}]+$/;

/**
 * The lines of `stderr` a test has business asserting on: everything left
 * once the ignorable records are dropped.
 *
 * A record rather than a line, so that an ignorable line takes with it the
 * lines a console spilled inspecting a value it was handed. Only a line ending
 * in the bracket that opens such a value starts a record, and the record ends
 * at the bracket closing it, so an ignorable line a console fitted on its own
 * takes nothing with it whatever the line beneath happens to look like.
 *
 * A record a console shaped some other way is under-consumed rather than
 * over-consumed: where something follows the value on the line closing it,
 * that line is left for the budget, which fails the test reading it rather
 * than hiding whatever the command wrote next.
 */
export function relevantStderr(stderr: string[]): string[] {
  const relevant: string[] = [];
  let spilling = false;
  for (const line of stderr) {
    const plain = stripAnsi(line);
    if (spilling) {
      if (CLOSES_SPILLED_VALUE.test(plain)) {
        spilling = false;
        continue;
      }
      if (INSIDE_SPILLED_VALUE.test(plain)) continue;
      spilling = false;
    }
    if (isIgnorableStderrLine(plain)) {
      spilling = OPENS_SPILLED_VALUE.test(plain);
      continue;
    }
    relevant.push(line);
  }
  return relevant;
}

/**
 * Asserts that the only thing the command wrote to stderr is the line
 * `deno task` echoes naming what it ran.
 */
export function checkStderr(stderr: string[]) {
  const relevant = relevantStderr(stderr);
  try {
    expect(relevant.length).toBe(1);
  } catch (e) {
    console.error(stderr);
    throw e;
  }
  expect(relevant[0]).toMatch(/deno run /);
}

/**
 * Collects what `body` writes to `console.error`, restoring the console
 * afterwards even where `body` throws.
 *
 * Every argument is stringified, so a `null` or an `undefined` among them
 * reads as its own name rather than as the empty string `join` alone would
 * give it.
 */
export async function captureStderr(
  body: () => Promise<void>,
): Promise<string[]> {
  const lines: string[] = [];
  const original = console.error;
  console.error = (...args: unknown[]) => {
    lines.push(args.map(String).join(" "));
  };
  try {
    await body();
  } finally {
    console.error = original;
  }
  return lines;
}

export interface CliResult {
  code: number;
  stdout: string[];
  stderr: string[];
}

export interface CliOptions {
  // Text or bytes written to the command's standard input.
  stdin?: string | Uint8Array;
  // Names the command's environment holds. A name mapped to `undefined` is
  // absent from it. The CLI's own configuration comes from here and from
  // nowhere else, so a configuration name this map leaves out is absent too;
  // every other name the command takes from this process.
  env?: Record<string, string | undefined>;
}

// The names the CLI reads as its own configuration: the `CF_` variables, the
// experimental flags, and the two that point at a local memory store.
const CONFIG_ENV_PREFIXES = ["CF_", "EXPERIMENTAL_"];
const CONFIG_ENV_NAMES = ["DB_PATH", "MEMORY_DIR"];

function isConfigEnvName(name: string): boolean {
  return CONFIG_ENV_PREFIXES.some((prefix) => name.startsWith(prefix)) ||
    CONFIG_ENV_NAMES.includes(name);
}

// The environment a spawned command runs with: `inherited` without the CLI's
// own configuration, and then `declared` applied over that, where a value of
// `undefined` leaves the name absent.
//
// `deno test --parallel` runs each test file on its own thread of a single
// process, and those threads share one environment. Configuration a command
// inherited would therefore be whatever the file running beside this one had
// set, so the call decides it instead.
export function commandEnv(
  inherited: Record<string, string>,
  declared: Record<string, string | undefined>,
): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [name, value] of Object.entries(inherited)) {
    if (!isConfigEnvName(name)) env[name] = value;
  }
  for (const [name, value] of Object.entries(declared)) {
    if (value === undefined) delete env[name];
    else env[name] = value;
  }
  return env;
}

// Splits a command string into arguments on spaces outside of double quotes,
// then strips the quotes.
function parseCliCommand(command: string): string[] {
  const match = command.match(/(?:[^\s"]+|"[^"]*")+/g);
  if (!match || match.length === 0) {
    throw new Error(`Could not parse command: ${command}.`);
  }
  return match.map((arg) => arg.replace(/"/g, ""));
}

async function spawnCli(
  executable: string,
  args: string[],
  options: CliOptions,
): Promise<CliResult> {
  const { stdin } = options;
  const child = new Deno.Command(executable, {
    cwd: join(import.meta.dirname!, ".."),
    args,
    clearEnv: true,
    env: commandEnv(Deno.env.toObject(), options.env ?? {}),
    // `.output()` requires stdout/stderr to be piped; `.spawn()` would
    // otherwise default them to "inherit".
    stdout: "piped",
    stderr: "piped",
    stdin: stdin === undefined ? "null" : "piped",
  }).spawn();

  if (stdin !== undefined) {
    const writer = child.stdin.getWriter();
    await writer.write(typeof stdin === "string" ? encode(stdin) : stdin);
    await writer.close();
  }

  const { code, stdout, stderr } = await child.output();
  return {
    code,
    stdout: bytesToLines(stdout),
    stderr: bytesToLines(stderr),
  };
}

async function runCliTask(
  task: "cli-no-pwd-override",
  command: string,
  options: CliOptions,
): Promise<CliResult> {
  return await spawnCli(
    Deno.execPath(),
    [
      "task",
      // Deno tasks run with PWD set to wherever the deno.jsonc manifest is.
      // The `cli` task in this package overrides that to use the shell's PWD.
      // As these tests run within a test task, we can't override that PWD.
      // For tests, use a version of the cli task that does *not* override
      // user/deno's PWD.
      task,
      ...parseCliCommand(command),
    ],
    options,
  );
}

// Executes the `cf` command via CLI
// `const { stdout, stderr, code } = cf("check --no-run ./pattern.tsx")`
// Pass `stdin` to feed the command's standard input, and `env` to give it
// fabric configuration; it starts with none.
export async function cf(
  command: string,
  options: CliOptions = {},
): Promise<CliResult> {
  return await runCliTask("cli-no-pwd-override", command, options);
}

let cfBinaryProbe: Promise<boolean> | undefined;

// True when integration tests should run the prebuilt `cf` binary from PATH:
// CF_CLI_INTEGRATION_USE_LOCAL is unset (the same override integration.sh
// honors) and a `cf` on PATH answers `id --help`, a subcommand other tools
// that install a `cf` binary reject. Probed once per process.
function cfBinaryAvailable(): Promise<boolean> {
  cfBinaryProbe ??= (async () => {
    if (Deno.env.get("CF_CLI_INTEGRATION_USE_LOCAL")) {
      return false;
    }
    try {
      const { success } = await new Deno.Command("cf", {
        args: ["id", "--help"],
        stdout: "null",
        stderr: "null",
        stdin: "null",
      }).output();
      return success;
    } catch {
      return false;
    }
  })();
  return cfBinaryProbe;
}

// Executes the `cf` command for integration tests: the prebuilt `cf` binary
// from PATH when one is available (as in the CI integration jobs, which put
// the built binaries on PATH), the source-tree CLI task otherwise. Set
// CF_CLI_INTEGRATION_USE_LOCAL=1 to force the source-tree CLI.
export async function integrationCf(
  command: string,
  options: CliOptions = {},
): Promise<CliResult> {
  if (await cfBinaryAvailable()) {
    return await spawnCli("cf", parseCliCommand(command), options);
  }
  return await cf(command, options);
}

// Runs `fn` with `name` set on this process. Every test file in a
// `deno test --parallel` run shares one environment, so a file that calls
// this cannot run beside one that reads the same name: name it
// `*.serial.test.ts`, which the package's `deno-test` task runs on its own.
// Configuring a spawned CLI needs none of this — pass `env` to `cf` instead.
export async function withEnv(
  name: string,
  value: string | undefined,
  fn: () => Promise<void> | void,
): Promise<void> {
  const previous = Deno.env.get(name);
  if (value === undefined) {
    Deno.env.delete(name);
  } else {
    Deno.env.set(name, value);
  }

  try {
    await fn();
  } finally {
    if (previous === undefined) {
      Deno.env.delete(name);
    } else {
      Deno.env.set(name, previous);
    }
  }
}
