import { type ConsoleHandler } from "@commonfabric/runner";
import { NodeConsole, Writable } from "./deps.ts";

const textEncoder = new TextEncoder();
const stderrStream = new Writable({
  write(chunk, _encoding, callback) {
    try {
      const bytes = typeof chunk === "string"
        ? textEncoder.encode(chunk)
        : chunk;
      Deno.stderr.writeSync(bytes);
      callback();
    } catch (error) {
      callback(error instanceof Error ? error : new Error(String(error)));
    }
  },
});
const stderrConsole = new NodeConsole({
  stdout: stderrStream,
  stderr: stderrStream,
}) as unknown as Console;
stderrConsole.timeStamp = () => {};

export function hasJsonArgument(args: readonly string[]): boolean {
  return args.some((arg) =>
    arg === "--json" || arg.startsWith("--json=") ||
    arg === "--json-file" || arg.startsWith("--json-file=")
  );
}

/** The shared target options that take a value, by long name. */
const TARGET_VALUE_OPTIONS = new Set([
  "--url",
  "--api-url",
  "--identity",
  "--space",
]);

/** The same options as the single letters a short bundle spells them with. */
const TARGET_VALUE_SHORT_FLAGS = new Set(["u", "a", "i", "s"]);

/**
 * The nouns whose subcommands carry the shared target options, and so share
 * this argument shape.
 */
const TARGET_NOUNS = new Set(["piece", "cell"]);

/**
 * Whether a short-option token takes the token after it as its value.
 *
 * Cliffy reads a short token as a bundle of letters, so arity belongs to the
 * run rather than to the token: `-qs team` is `-q` and `-s team`. The value is
 * the next token only when the last value-taking letter ends the bundle —
 * anything after it is more letters, which is what `-qsteam` is refused for.
 */
function shortBundleTakesNextToken(token: string): boolean {
  let lastValueTaking = -1;
  for (let index = 1; index < token.length; index++) {
    if (TARGET_VALUE_SHORT_FLAGS.has(token[index])) lastValueTaking = index;
  }
  return lastValueTaking === token.length - 1;
}

/**
 * The subcommand a target noun's line names, or `undefined` when it names
 * none.
 *
 * Read off argv rather than asked of the parser, because what this decides is
 * where a refusal may be written and a refusal is what happens when parsing
 * failed. So the walk carries each option's arity itself: miss one, and the
 * option's value is read as the subcommand — `cf piece -qs team call` reads as
 * `piece team`, which reserves nothing, and the usage page lands on the stream
 * the caller is parsing.
 */
function nounSubcommand(args: readonly string[]): string | undefined {
  if (!TARGET_NOUNS.has(args[0] ?? "")) return undefined;

  for (let index = 1; index < args.length; index++) {
    const argument = args[index];
    if (argument === "--") return undefined;
    // A lone `-` is the stdin sentinel, which is a value rather than a name.
    if (argument === "-") continue;
    if (!argument.startsWith("-")) return argument;

    const equalsIndex = argument.indexOf("=");
    if (equalsIndex !== -1) continue;

    if (argument.startsWith("--")) {
      if (TARGET_VALUE_OPTIONS.has(argument)) index++;
      continue;
    }
    if (shortBundleTakesNextToken(argument)) index++;
  }

  return undefined;
}

export function reservesStdoutForCommandOutput(
  args: readonly string[],
): boolean {
  if (
    hasJsonArgument(args) ||
    args.some((arg) =>
      arg === "--pattern-json" || arg.startsWith("--pattern-json=") ||
      arg === "--show-transformed" || arg.startsWith("--show-transformed=")
    )
  ) {
    return true;
  }
  if (args[0] === "exec") return true;
  if (args[0] === "wish") return true;
  const subcommand = nounSubcommand(args);
  if (subcommand === undefined) return false;
  // Keyed by the whole path where the noun decides the answer, and by the
  // subcommand alone where it does not. `cell set` is absent because it
  // writes prose, not a machine surface.
  const path = `${args[0]} ${subcommand}`;
  return path === "cell get" || path === "piece call" ||
    path === "cell get-label" ||
    path === "cell set-label" ||
    subcommand === "survey" || subcommand === "repair" ||
    subcommand === "retarget" || subcommand === "rollback" ||
    subcommand === "restore";
}

export const stderrConsoleHandler: ConsoleHandler = ({ method, args }) => ({
  target: stderrConsole,
  method,
  args,
});
