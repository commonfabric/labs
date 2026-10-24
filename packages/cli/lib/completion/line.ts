/**
 * Pure command-line resolution for shell completion.
 *
 * The shell hands over either its own tokenized words (zsh) or the raw buffer
 * (bash); both converge here on `(words, cword)`. Resolution walks Cliffy's
 * live `Command` tree rather than a hand-maintained table, so a newly
 * registered subcommand or flag is completable the moment it exists — the
 * completion surface cannot drift from the CLI.
 *
 * Nothing in this module performs I/O. The slot it returns is what
 * `providers.ts` turns into live candidates.
 */

import type { Argument, Command, Option } from "@cliffy/command";
// Free at completion time: walking the tree means loading the command tree,
// which already resolves this module.
import { isReference } from "../llm-friendly-ref.ts";

/**
 * A command of any option/argument parameterization.
 *
 * Completion walks the tree structurally and never invokes an action, so the
 * per-command generics carry no information here — and the root command's
 * inferred type is not assignable to the bare `Command`. This mirrors Cliffy's
 * own `getCommands(): Array<Command<any>>`.
 */
export type AnyCommand = Command<any>;

/** What the word under the cursor is a position for. */
export type CompletionSlot =

  /** A subcommand name of `command`. */
  | { readonly kind: "subcommand" }
  /** An option flag (the word starts with `-`). */
  | { readonly kind: "option-name" }
  /** The value of `option`, either after a space or after `=`. */
  | {
    readonly kind: "option-value";
    readonly option: Option;

    /** Set when completing `--name=value`; candidates must carry the prefix. */
    readonly inlinePrefix?: string;
  }
  /** A positional argument. `index` counts positionals already supplied. */
  | {
    readonly kind: "argument";
    readonly argument: Argument;
    readonly index: number;
  }
  /**
   * A word after `--`, which on `cf piece call` and `cf exec` is the read step's
   * section: `--select`, `--schema` and `--filter`, and `--help` reaching the
   * callable. Item 6 of
   * [CLI completion coverage](../../../../docs/plans/cli-completion-coverage.md)
   * is what fills it, from the verb's declared result.
   */
  | { readonly kind: "passthrough"; readonly index: number }
  /** The value of a pre-parse global such as `--log-level`. */
  | {
    readonly kind: "global-option-value";
    readonly option: PreParseGlobal;
    readonly inlinePrefix?: string;
  };

/**
 * A flag stripped from `argv` before Cliffy ever parses it.
 *
 * `--log-level` and `--no-color` are applied in `mod.ts` by `applyLogLevel` and
 * `applyColorMode`, so they exist nowhere in the command tree even though they
 * are accepted on every command and documented in the root help. Completion has
 * to carry them explicitly or they are the only documented flags it cannot
 * offer.
 */
export interface PreParseGlobal {
  readonly flags: readonly string[];
  readonly description: string;

  /** Accepted values, when the flag takes one. */
  readonly values?: readonly string[];
}

/** Mirrors `lib/log-level.ts` and `lib/color-mode.ts`. */
export const PRE_PARSE_GLOBALS: readonly PreParseGlobal[] = [
  {
    flags: ["--log-level"],
    description: "Set the global log floor",
    values: ["debug", "info", "warn", "error", "silent"],
  },
  {
    flags: ["--no-color"],
    description: "Disable ANSI color output",
  },
];

function findPreParseGlobal(token: string): PreParseGlobal | undefined {
  return PRE_PARSE_GLOBALS.find((global) => global.flags.includes(token));
}

export interface CompletionLine {
  /** Deepest command the words resolved to. */
  readonly command: AnyCommand;

  /** Command path below the program name, e.g. `["piece", "ls"]`. */
  readonly path: readonly string[];

  readonly slot: CompletionSlot | null;

  /** The partial word under the cursor; `""` at a fresh position. */
  readonly word: string;

  /** Long name -> last value, for value-taking options already on the line. */
  readonly options: ReadonlyMap<string, string>;

  /** Long names of valueless flags already on the line. */
  readonly flags: ReadonlySet<string>;

  /**
   * A canonical reference written in the first positional, in place of
   * `--cell`. It does not count as a positional: the command reads it out
   * before the rest, so `<callable>` is still the argument after it.
   */
  readonly address?: string;

  /** Positional words already supplied to `command`. */
  readonly positionals: readonly string[];

  /** Words after a `--` separator, excluding the separator itself. */
  readonly passthrough: readonly string[];
}

/** Long name of an option, without leading dashes. */
function longName(option: Option): string {
  const long = option.flags.find((flag) => flag.startsWith("--"));
  return (long ?? option.flags[0] ?? "").replace(/^-+/, "");
}

/** Whether the option consumes a following word as its value. */
function takesValue(option: Option): boolean {
  return (option.args?.length ?? 0) > 0;
}

/**
 * Whether the option's value may be omitted (`--flag` alone is legal, as in
 * Cliffy's `--json [value]`). Such an option never swallows the next word, so
 * the word after it is a positional, not a value.
 */
function valueIsOptional(option: Option): boolean {
  return option.args?.[0]?.optional === true;
}

/**
 * Find the option a flag token names. Cliffy stores every accepted spelling in
 * `flags`, so short and long forms resolve through the same lookup.
 */
function findOption(command: AnyCommand, token: string): Option | undefined {
  return command.getOptions(false).find((option) =>
    option.flags.includes(token)
  );
}

/**
 * Expand a bundled short-flag token (`-qs`) into its constituent options.
 * Returns `undefined` when any character is not a known short flag, which
 * leaves the caller to treat the token as an opaque word rather than
 * mis-parsing it.
 *
 * Getting this right matters beyond the bundled token itself: a mis-parse
 * shifts every later positional index, so the argument slot — and with it the
 * dynamic provider — would be chosen wrongly for the rest of the line.
 */
function expandBundle(
  command: AnyCommand,
  token: string,
): Option[] | undefined {
  if (!/^-[A-Za-z]{2,}$/.test(token)) return undefined;
  const expanded: Option[] = [];
  for (const char of token.slice(1)) {
    const option = findOption(command, `-${char}`);
    if (!option) return undefined;
    expanded.push(option);
  }
  return expanded;
}

/**
 * Subcommands that represent real commands.
 *
 * `main` registers `help` with `.global()`, so Cliffy propagates it to every
 * descendant and `hasCommands()` is true even on leaves like `cf piece call`.
 * Taking that at face value would resolve every leaf's positional to a
 * subcommand slot and silently disable all dynamic value completion.
 */
function realSubcommands(command: AnyCommand): AnyCommand[] {
  return command.getCommands(false).filter((child) =>
    child.getName() !== "help"
  );
}

/**
 * Whether the command ends its own option parsing at the first positional.
 *
 * `cf piece call` and `cf exec` are `stopEarly()`, so every word after the
 * callable name belongs to the callable's schema-derived parser and the CLI's
 * own flags are refused there. Cliffy stores the property with no accessor, so
 * it is read off the field: keeping the question where the command declares it
 * means a third command becoming `stopEarly()` needs no edit here.
 */
function stopsEarly(command: AnyCommand): boolean {
  return (command as unknown as { _stopEarly?: boolean })._stopEarly === true;
}

/**
 * Commands whose first positional may carry a reference in place of the
 * `--cell` flag, keyed the way the provider tables are.
 *
 * `readTargetPositionals` and `readCallTarget` in `commands/piece.ts` are what
 * implement it, and nothing on the command tree distinguishes those two
 * arguments from an ordinary one — `get` declares `[addressOrPath]` and `call`
 * declares `<callable>`, both plain strings. Carried explicitly for the same
 * reason `PRE_PARSE_GLOBALS` is.
 */
const POSITIONAL_ADDRESS_COMMANDS: ReadonlySet<string> = new Set([
  "cell get",
  "cell set",
  "piece call",
]);

/**
 * Whether `token` in the first positional of `path` names the target rather
 * than filling that argument. The deciding grammar is the command's:
 * a reference begins with `/`, and neither a cell path nor a callable name
 * ever does.
 */
function isPositionalAddress(
  path: readonly string[],
  token: string,
): boolean {
  return POSITIONAL_ADDRESS_COMMANDS.has(path.join(" ")) &&
    isReference(token);
}

/**
 * Subcommands a caller can reach, hidden ones included.
 *
 * A hidden command is one nothing offers, and a caller who types it is still
 * answered. Completion follows that split: suggestion lists only what
 * {@link realSubcommands} returns, while resolving a typed name and walking the
 * tree for slots see everything reachable — otherwise a hidden command would
 * complete none of its own flags.
 */
function reachableSubcommands(command: AnyCommand): AnyCommand[] {
  return command.getCommands(true).filter((child) =>
    child.getName() !== "help"
  );
}

/** Resolve a subcommand by name or alias, skipping Cliffy's own `help`. */
function findSubcommand(
  command: AnyCommand,
  name: string,
): AnyCommand | undefined {
  return reachableSubcommands(command).find((child) =>
    child.getName() === name || child.getAliases().includes(name)
  );
}

/** Deno task names in this repo that run the CLI. */
const CLI_TASK_NAMES = new Set(["cf", "cli", "cli-no-pwd-override"]);

/** Module paths that are the CLI entrypoint when run directly. */
const CLI_ENTRYPOINTS = ["packages/cli/mod.ts", "packages/cli/launcher.ts"];

/**
 * Strip a `deno …` wrapper so the rest of the line completes as plain `cf`.
 *
 * The CLI is most often invoked as `deno task cf …` rather than as a compiled
 * binary, and `deno run -A packages/cli/mod.ts …` is the third documented path.
 * Reducing those to the same word list the `cf` binary would see means one
 * resolver serves every invocation style.
 *
 * Returns the words unchanged when the line is not a CLI invocation, along with
 * the number of leading words removed so the cursor index can be rebased.
 */
export function stripInvocationPrefix(
  words: readonly string[],
): { words: readonly string[]; removed: number } {
  if (words.length === 0 || !/(^|\/)deno$/.test(words[0])) {
    return { words, removed: 0 };
  }

  let i = 1;
  // Deno's own flags before the subcommand (-q, -A, --allow-read=…, …).
  while (i < words.length && words[i].startsWith("-")) i++;
  if (i >= words.length) return { words, removed: 0 };

  const subcommand = words[i];
  let consumed: number;

  if (subcommand === "task") {
    let j = i + 1;
    // Flags between `task` and the task name (e.g. `--cwd`).
    while (j < words.length && words[j].startsWith("-")) j++;
    if (j >= words.length || !CLI_TASK_NAMES.has(words[j])) {
      return { words, removed: 0 };
    }
    consumed = j + 1;
  } else if (subcommand === "run") {
    let j = i + 1;
    while (j < words.length && words[j].startsWith("-")) j++;
    if (
      j >= words.length ||
      !CLI_ENTRYPOINTS.some((entry) => words[j].endsWith(entry))
    ) {
      return { words, removed: 0 };
    }
    consumed = j + 1;
  } else {
    return { words, removed: 0 };
  }

  // The launcher takes its own options before a `--` that hands the rest to
  // the CLI. Past that separator the words are ordinary cf arguments.
  const separator = words.indexOf("--", consumed);
  if (separator !== -1) consumed = separator + 1;

  // Re-head the list so `words[0]` is a program name again, as the resolver
  // expects. `cf` is the conventional name and is never matched as a command.
  return {
    words: ["cf", ...words.slice(consumed)],
    removed: consumed - 1,
  };
}

/**
 * Resolve what the word at `cword` is completing.
 *
 * `words[0]` is the program name and is skipped. Words after the cursor are
 * ignored: the slot depends only on what precedes the cursor, so editing
 * mid-line completes against the correct position instead of the line's end.
 */
export function resolveCompletionLine(
  root: AnyCommand,
  rawWords: readonly string[],
  rawCword: number,
): CompletionLine {
  const stripped = stripInvocationPrefix(rawWords);
  const words = stripped.words;
  const cword = rawCword - stripped.removed;

  const cursor = Math.max(0, Math.min(cword, words.length));
  const word = words[cursor] ?? "";
  const context = words.slice(1, Math.max(1, cursor));

  let command = root;
  const path: string[] = [];
  const options = new Map<string, string>();
  const flags = new Set<string>();
  let address: string | undefined;
  let positionals: string[] = [];
  const passthrough: string[] = [];
  let separatorSeen = false;

  for (let i = 0; i < context.length; i++) {
    const token = context[i];

    if (separatorSeen) {
      passthrough.push(token);
      continue;
    }
    if (token === "--") {
      separatorSeen = true;
      continue;
    }

    // Past a `stopEarly()` boundary the verb has opened its own section, so
    // every word belongs to the callable and a flag-shaped one is data rather
    // than an option. Reading it as an option would shift the positional index
    // the argument slot depends on.
    if (positionals.length > 0 && stopsEarly(command)) {
      positionals.push(token);
      continue;
    }

    if (token.startsWith("-") && token !== "-") {
      const inline = token.match(/^(--[^=]+)=(.*)$/);
      if (inline) {
        const option = findOption(command, inline[1]);
        if (option) options.set(longName(option), inline[2]);
        continue;
      }

      const option = findOption(command, token);
      if (option) {
        if (takesValue(option) && !valueIsOptional(option)) {
          const value = context[i + 1];
          // A trailing flag with no value yet still counts as present.
          if (value !== undefined) {
            options.set(longName(option), value);
            i++;
          }
        } else {
          flags.add(longName(option));
        }
        continue;
      }

      // Pre-parse globals are legal at any depth and are stripped before
      // Cliffy parses, so consume them (and any value) without letting them
      // disturb the positional indices the argument slot depends on.
      const preParse = findPreParseGlobal(token);
      if (preParse) {
        if (preParse.values && context[i + 1] !== undefined) i++;
        continue;
      }

      const bundle = expandBundle(command, token);
      if (bundle) {
        const last = bundle[bundle.length - 1];
        for (const bundled of bundle.slice(0, -1)) {
          flags.add(longName(bundled));
        }
        if (takesValue(last) && !valueIsOptional(last)) {
          const value = context[i + 1];
          if (value !== undefined) {
            options.set(longName(last), value);
            i++;
          }
        } else {
          flags.add(longName(last));
        }
        continue;
      }

      // Unknown flag: record it so it does not shift positional indices.
      continue;
    }

    // A subcommand only shadows a positional before any positional is taken;
    // afterwards a matching word is data, not a command.
    if (positionals.length === 0) {
      const child = findSubcommand(command, token);
      if (child) {
        command = child;
        path.push(child.getName());
        positionals = [];
        continue;
      }
      // A positional address replaces `--cell` rather than filling the
      // argument, so the words after it keep the indices they would have had.
      if (address === undefined && isPositionalAddress(path, token)) {
        address = token;
        continue;
      }
    }
    positionals.push(token);
  }

  const slot = resolveSlot({
    command,
    word,
    context,
    cursor,
    separatorSeen,
    positionals,
    passthrough,
  });

  return {
    command,
    path,
    slot,
    word,
    options,
    flags,
    ...(address !== undefined && { address }),
    positionals,
    passthrough,
  };
}

function resolveSlot(input: {
  command: AnyCommand;
  word: string;
  context: readonly string[];
  cursor: number;
  separatorSeen: boolean;
  positionals: readonly string[];
  passthrough: readonly string[];
}): CompletionSlot | null {
  const { command, word, context, separatorSeen, positionals } = input;

  if (separatorSeen) {
    return { kind: "passthrough", index: input.passthrough.length };
  }

  // Past a `stopEarly()` boundary the CLI's own flags are refused, so no
  // option slot is reachable there. The position belongs to the callable's
  // vocabulary, which the argument slot below names — and which nothing
  // completes yet. Offering nothing is what a position whose words the command
  // cannot name should offer; offering flags the command rejects is not.
  if (positionals.length > 0 && stopsEarly(command)) {
    return positionalSlot(command, positionals);
  }

  // `--name=<cursor>` completes the value, and candidates must be emitted with
  // the `--name=` prefix so the shell replaces the whole token.
  const inline = word.match(/^(--[^=]+)=(.*)$/);
  if (inline) {
    const preParse = findPreParseGlobal(inline[1]);
    if (preParse?.values) {
      return {
        kind: "global-option-value",
        option: preParse,
        inlinePrefix: `${inline[1]}=`,
      };
    }
    const option = findOption(command, inline[1]);
    if (!option || !takesValue(option)) return null;
    return {
      kind: "option-value",
      option,
      inlinePrefix: `${inline[1]}=`,
    };
  }

  if (word.startsWith("-") && word !== "-" || word === "-") {
    return { kind: "option-name" };
  }

  // Directly after a value-taking flag, the cursor is that flag's value.
  const previous = context[context.length - 1];
  if (previous !== undefined && previous.startsWith("-") && previous !== "--") {
    const preParse = findPreParseGlobal(previous);
    if (preParse?.values) {
      return { kind: "global-option-value", option: preParse };
    }

    const option = findOption(command, previous);
    if (option && takesValue(option) && !valueIsOptional(option)) {
      return { kind: "option-value", option };
    }
    if (!option) {
      const bundle = expandBundle(command, previous);
      const last = bundle?.[bundle.length - 1];
      if (last && takesValue(last) && !valueIsOptional(last)) {
        return { kind: "option-value", option: last };
      }
    }
  }

  if (positionals.length === 0 && realSubcommands(command).length > 0) {
    return { kind: "subcommand" };
  }

  return positionalSlot(command, positionals);
}

/** The argument the next positional word fills, or `null` past the last one. */
function positionalSlot(
  command: AnyCommand,
  positionals: readonly string[],
): CompletionSlot | null {
  const args = command.getArguments();
  if (args.length === 0) return null;
  const index = Math.min(positionals.length, args.length - 1);
  const argument = args[index];
  // Only a variadic final argument accepts more words than it declares.
  if (positionals.length < args.length || argument.variadic) {
    return { kind: "argument", argument, index: positionals.length };
  }
  return null;
}

/** Exported for `providers.ts`, which keys context lookups by long name. */
export { longName, takesValue };

/** One positional a command tree declares, and where it sits. */
export interface DeclaredPositional {
  /** `<command path>:<argument name>`, the key its provider carries. */
  readonly key: string;

  /** The command path, or `<root>` for the root command's own. */
  readonly where: string;

  /** Its place in that command's argument order, so a line can reach it. */
  readonly index: number;
}

/** Every value-taking option and every positional a command tree declares. */
export interface DeclaredSlots {
  /** Option long name -> the command paths declaring it. */
  readonly options: ReadonlyMap<string, readonly string[]>;

  readonly positionals: readonly DeclaredPositional[];

  /**
   * The option slots whose value may be omitted, as
   * `<command path>:--<long name>`.
   *
   * Such an option never swallows the next word, so the cursor after
   * `--name ` is on a positional and only `--name=` reaches the option's own
   * value. Anything walking these slots to drive a line has to spell them that
   * way or it drives a different slot.
   */
  readonly optionalValues: ReadonlySet<string>;
}

/**
 * Every slot the tree offers a value at, walked the way `resolveCompletionLine`
 * walks it: {@link reachableSubcommands} decides which children are commands,
 * and `takesValue` decides which options have a value to complete.
 *
 * Reachable rather than suggestible, which is the same split resolving a typed
 * name follows: a hidden command is left out of {@link realSubcommands}, so
 * nothing offers it, and it still owns every slot below it — a caller who
 * types it completes its flags, and a slot reached only through it is one the
 * provider tables have to answer for.
 *
 * Both keys the provider tables use fall out of this walk, which is what lets
 * a check subtract the tables from the tree — in either direction — rather
 * than remembering what was added.
 */
export function declaredSlots(root: AnyCommand): DeclaredSlots {
  const options = new Map<string, string[]>();
  const positionals: DeclaredPositional[] = [];
  const optionalValues = new Set<string>();
  const walk = (command: AnyCommand, path: readonly string[]): void => {
    const where = path.join(" ") || "<root>";
    for (const option of command.getOptions(false)) {
      if (!takesValue(option)) continue;
      const seen = options.get(longName(option)) ?? [];
      if (!seen.includes(where)) seen.push(where);
      options.set(longName(option), seen);
      if (valueIsOptional(option)) {
        optionalValues.add(`${where}:--${longName(option)}`);
      }
    }
    command.getArguments().forEach((argument: Argument, index: number) => {
      positionals.push({
        key: `${path.join(" ")}:${argument.name}`,
        where,
        index,
      });
    });
    for (const child of reachableSubcommands(command)) {
      walk(child, [...path, child.getName()]);
    }
  };
  walk(root, []);
  return { options, positionals, optionalValues };
}
