/**
 * Completion orchestration: words in, shell-ready candidate lines out.
 *
 * The wire format between the shell function and this module is deliberately
 * narrow — a list of lines, where lines beginning `:cf:` are directives and
 * everything else is a candidate. That keeps the installed shell functions
 * small and stable: they are sourced into a user's environment and are the one
 * part of this feature that cannot be updated by rebuilding the CLI.
 */

import {
  type AnyCommand,
  type CompletionLine,
  type CompletionSlot,
  resolveCompletionLine,
  stripInvocationPrefix,
} from "./line.ts";
import {
  type Candidate,
  enumeratedOptionValues,
  optionNameCandidates,
  preParseGlobalValues,
  subcommandCandidates,
} from "./static.ts";
import { type Directive, liveCandidates } from "./providers.ts";

export type CompletionShell = "bash" | "zsh";

/** Directive prefix. No CLI value legitimately starts with this. */
const DIRECTIVE_PREFIX = ":cf:";

/**
 * Tokenize a raw command line into words plus the index of the word under the
 * cursor.
 *
 * Bash hands over `COMP_LINE`/`COMP_POINT` rather than its own `COMP_WORDS`
 * because `COMP_WORDBREAKS` splits on `:` and `=`, which shreds exactly the
 * values cf deals in — `http://localhost:8000` and `--space=x`. Tokenizing here
 * means both shells reach the resolver with the same view of the line.
 */
export function tokenizeLine(
  line: string,
  point: number,
): { words: string[]; cword: number } {
  const upto = line.slice(0, Math.max(0, Math.min(point, line.length)));
  const words: string[] = [];
  let current = "";
  let started = false;
  let quote: '"' | "'" | null = null;

  for (let i = 0; i < upto.length; i++) {
    const char = upto[i];
    if (quote) {
      if (char === quote) quote = null;
      else if (char === "\\" && quote === '"' && i + 1 < upto.length) {
        current += upto[++i];
      } else current += char;
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      started = true;
      continue;
    }
    if (char === "\\" && i + 1 < upto.length) {
      current += upto[++i];
      started = true;
      continue;
    }
    if (char === " " || char === "\t") {
      if (started) {
        words.push(current);
        current = "";
        started = false;
      }
      continue;
    }
    current += char;
    started = true;
  }

  // A trailing separator means the cursor sits at a fresh, empty word.
  words.push(started ? current : "");
  return { words, cword: words.length - 1 };
}

/**
 * Escape a candidate for the shell's own list format.
 *
 * zsh's `_describe` splits `value:description` on the first colon, so a colon
 * inside a value — every `http://` api-url has two — must be escaped or the
 * candidate is silently truncated at insertion time.
 */
function formatCandidate(
  candidate: Candidate,
  shell: CompletionShell,
): string {
  if (shell !== "zsh") return candidate.value;
  const value = candidate.value.replaceAll(":", "\\:");
  return candidate.description
    ? `${value}:${candidate.description.replaceAll("\n", " ")}`
    : value;
}

function formatDirective(directive: Directive): string {
  switch (directive.kind) {
    case "files":
      return directive.glob
        ? `${DIRECTIVE_PREFIX}files ${directive.glob}`
        : `${DIRECTIVE_PREFIX}files`;
    case "dirs":
      return `${DIRECTIVE_PREFIX}dirs`;
    case "nospace":
      return `${DIRECTIVE_PREFIX}nospace`;
  }
}

/**
 * Whether these words are a Common Fabric CLI invocation at all.
 *
 * A `deno` line only qualifies once `stripInvocationPrefix` recognizes it as
 * running the CLI (`deno task cf …`, `deno run … mod.ts …`); `deno test`,
 * `deno task build`, and a bare `deno ` are somebody else's completion.
 */
function isOwnInvocation(words: readonly string[]): boolean {
  if (words.length === 0) return true;
  if (!/(^|\/)deno$/.test(words[0])) return true;
  return stripInvocationPrefix(words).removed > 0;
}

/**
 * The `--name=` a slot's candidates must carry, or `undefined` when the value
 * was written after a space.
 */
function inlinePrefixOf(slot: CompletionSlot | null): string | undefined {
  if (!slot) return undefined;
  if (slot.kind === "option-value" || slot.kind === "global-option-value") {
    return slot.inlinePrefix;
  }
  return undefined;
}

/**
 * Re-attach a `--name=` prefix to values completed in inline form, so the shell
 * replaces the whole token rather than appending to it.
 *
 * Applied to every source of candidates rather than to one of them. The word
 * under the cursor is `--name=…` in this spelling and candidates are filtered
 * against it below, so a bare value cannot survive that filter — which is how
 * a live provider's candidates came to be dropped for the one spelling
 * `tokenizeLine` exists to serve.
 */
function withInlinePrefix(
  candidates: readonly Candidate[],
  prefix: string | undefined,
): Candidate[] {
  if (!prefix) return [...candidates];
  return candidates.map((candidate) => ({
    ...candidate,
    value: `${prefix}${candidate.value}`,
  }));
}

/**
 * Static candidates for a resolved line — everything answerable without I/O.
 * Split out from `complete` so tests can assert the whole static surface
 * without a fabric, which is where most completion regressions would show.
 *
 * Values come back bare. `complete` attaches the inline `--name=` prefix, so
 * that one rule covers this half and the live half alike.
 */
export function staticCandidates(line: CompletionLine): Candidate[] {
  const slot = line.slot;
  if (!slot) return [];

  switch (slot.kind) {
    // A word starting with `-` resolves to `option-name` before reaching here,
    // so this slot only ever completes command names.
    case "subcommand":
      return subcommandCandidates(line.command);
    case "option-name":
      return optionNameCandidates(line.command, line);
    case "option-value":
      // `null` means the option has no statically known set, which leaves the
      // slot to a live provider.
      return enumeratedOptionValues(slot.option) ?? [];
    case "global-option-value":
      return preParseGlobalValues(slot.option);
    default:
      return [];
  }
}

/**
 * Produce the lines the shell function consumes.
 *
 * Candidates are filtered by the typed prefix here rather than left to the
 * shell: bash's own filtering works on its `COMP_WORDBREAKS` view of the word,
 * which does not match the word this module resolved against.
 */
export async function complete(
  root: AnyCommand,
  words: readonly string[],
  cword: number,
  shell: CompletionShell,
): Promise<string[]> {
  // The same shell function is bound to both `cf` and `deno`, because the CLI
  // is most often run as `deno task cf …`. A `deno` line that is not a CLI
  // invocation says so explicitly, so the shell can hand back to whatever
  // completed `deno` before rather than silently offering nothing.
  if (!isOwnInvocation(words)) return [`${DIRECTIVE_PREFIX}notmine`];

  const line = resolveCompletionLine(root, words, cword);

  const live = await liveCandidates(line);
  const candidates = withInlinePrefix(
    [...staticCandidates(line), ...live.candidates],
    inlinePrefixOf(line.slot),
  );

  const matching = candidates.filter((candidate) =>
    candidate.value.startsWith(line.word)
  );

  return [
    ...live.directives.map(formatDirective),
    ...matching.map((candidate) => formatCandidate(candidate, shell)),
  ];
}
