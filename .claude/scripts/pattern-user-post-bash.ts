#!/usr/bin/env -S deno run --allow-read

/**
 * .claude/scripts/pattern-user-post-bash.ts
 *
 * Claude Code PostToolUse hook for Bash on pattern-user subagent.
 * - Parses cf commands and suggests next steps.
 */

type ShellQuote = "'" | '"';

interface ShellParseContext {
  words: string[];
  word: string;
  wordStarted: boolean;
  quote?: ShellQuote;
  parenthesisDepth: number;
}

interface ShellParseFrame {
  context: ShellParseContext;
  terminator: ")" | "`";
}

function newShellParseContext(): ShellParseContext {
  return { words: [], word: "", wordStarted: false, parenthesisDepth: 0 };
}

interface HeredocDelimiter {
  value: string;
  stripTabs: boolean;
  expand: boolean;
}

interface HeredocScanState {
  quote?: ShellQuote;
  arithmeticDepth: number;
  substitutionFrames: Array<{
    outerQuote?: ShellQuote;
    parenthesisDepth: number;
    terminator: ")" | "`";
  }>;
}

function newHeredocScanState(): HeredocScanState {
  return { arithmeticDepth: 0, substitutionFrames: [] };
}

function heredocDelimiters(
  line: string,
  state: HeredocScanState,
): HeredocDelimiter[] {
  const delimiters: HeredocDelimiter[] = [];
  let { quote, arithmeticDepth } = state;
  const { substitutionFrames } = state;

  for (let index = 0; index < line.length; index++) {
    const character = line[index];
    const next = line[index + 1];

    if (character === "\\" && quote !== "'") {
      index++;
      continue;
    }
    if (quote === "'") {
      if (character === "'") quote = undefined;
      continue;
    }
    if (character === "$" && next === "(" && line[index + 2] === "(") {
      arithmeticDepth++;
      index += 2;
      continue;
    }
    if (arithmeticDepth > 0) {
      if (character === ")" && next === ")") {
        arithmeticDepth--;
        index++;
      }
      continue;
    }
    if (character === "`") {
      const frame = substitutionFrames.at(-1);
      if (frame?.terminator === "`") {
        quote = substitutionFrames.pop()!.outerQuote;
      } else {
        substitutionFrames.push({
          outerQuote: quote,
          parenthesisDepth: 0,
          terminator: "`",
        });
        quote = undefined;
      }
      continue;
    }
    if (
      character === "$" && next === "(" && line[index + 2] !== "("
    ) {
      substitutionFrames.push({
        outerQuote: quote,
        parenthesisDepth: 0,
        terminator: ")",
      });
      quote = undefined;
      index++;
      continue;
    }
    if (quote === '"') {
      if (character === '"') quote = undefined;
      continue;
    }
    if (character === "'" || character === '"') {
      quote = character;
      continue;
    }
    if (character === "(" && next === "(") {
      arithmeticDepth++;
      index++;
      continue;
    }
    const substitutionFrame = substitutionFrames.at(-1);
    if (substitutionFrame?.terminator === ")" && character === "(") {
      substitutionFrame.parenthesisDepth++;
      continue;
    }
    if (substitutionFrame?.terminator === ")" && character === ")") {
      if (substitutionFrame.parenthesisDepth > 0) {
        substitutionFrame.parenthesisDepth--;
      } else {
        quote = substitutionFrames.pop()!.outerQuote;
      }
      continue;
    }
    if (
      character === "#" &&
      (index === 0 || /[\s;&|()]/.test(line[index - 1]))
    ) {
      break;
    }
    if (character !== "<" || next !== "<" || line[index + 2] === "<") {
      continue;
    }

    index += 2;
    const stripTabs = line[index] === "-";
    if (stripTabs) index++;
    while (index < line.length && /[ \t]/.test(line[index])) index++;

    let value = "";
    let delimiterQuote: ShellQuote | undefined;
    let quoted = false;
    for (; index < line.length; index++) {
      const delimiterCharacter = line[index];
      if (delimiterQuote) {
        if (delimiterCharacter === delimiterQuote) {
          delimiterQuote = undefined;
        } else if (delimiterCharacter === "\\" && delimiterQuote === '"') {
          const escapedCharacter = line[index + 1];
          if (
            escapedCharacter !== undefined &&
            /[$`"\\]/.test(escapedCharacter)
          ) {
            value += escapedCharacter;
            index++;
          } else {
            value += delimiterCharacter;
          }
        } else {
          value += delimiterCharacter;
        }
        continue;
      }
      if (/[\s;&|()]/.test(delimiterCharacter)) break;
      if (delimiterCharacter === "'" || delimiterCharacter === '"') {
        quoted = true;
        delimiterQuote = delimiterCharacter;
      } else if (
        delimiterCharacter === "\\" && line[index + 1] !== undefined
      ) {
        quoted = true;
        value += line[++index];
      } else {
        value += delimiterCharacter;
      }
    }
    if (value) delimiters.push({ value, stripTabs, expand: !quoted });
  }
  state.quote = quote;
  state.arithmeticDepth = arithmeticDepth;
  return delimiters;
}

function commandSubstitutionEnd(text: string, start: number): number {
  const frames: Array<{
    quote?: ShellQuote;
    terminator: ")" | "`";
    parenthesisDepth: number;
  }> = [{ terminator: ")", parenthesisDepth: 0 }];

  for (let index = start + 2; index < text.length; index++) {
    const frame = frames.at(-1)!;
    const character = text[index];
    const next = text[index + 1];
    if (character === "\\" && frame.quote !== "'") {
      index++;
      continue;
    }
    if (frame.quote === "'") {
      if (character === "'") frame.quote = undefined;
      continue;
    }
    if (frame.quote === '"') {
      if (character === '"') {
        frame.quote = undefined;
      } else if (
        character === "$" && next === "(" && text[index + 2] !== "("
      ) {
        frames.push({ terminator: ")", parenthesisDepth: 0 });
        index++;
      } else if (character === "`") {
        frames.push({ terminator: "`", parenthesisDepth: 0 });
      }
      continue;
    }
    if (frame.terminator === "`" && character === "`") {
      frames.pop();
      continue;
    }
    if (
      character === "#" &&
      (index === 0 || /[\s;&|()]/.test(text[index - 1]))
    ) {
      while (
        index + 1 < text.length &&
        text[index + 1] !== "\n" &&
        text[index + 1] !== "\r"
      ) index++;
      continue;
    }
    if (character === "'" || character === '"') {
      frame.quote = character;
      continue;
    }
    if (character === "`") {
      frames.push({ terminator: "`", parenthesisDepth: 0 });
      continue;
    }
    if (
      character === "$" && next === "(" && text[index + 2] !== "("
    ) {
      frames.push({ terminator: ")", parenthesisDepth: 0 });
      index++;
      continue;
    }
    if (frame.terminator === ")" && character === "(") {
      frame.parenthesisDepth++;
      continue;
    }
    if (frame.terminator === ")" && character === ")") {
      if (frame.parenthesisDepth > 0) {
        frame.parenthesisDepth--;
      } else {
        frames.pop();
        if (frames.length === 0) return index + 1;
      }
    }
  }
  return text.length;
}

function commandSubstitutions(text: string, shellQuotes = false): string {
  const substitutions: string[] = [];
  let outerQuote: ShellQuote | undefined;
  for (let index = 0; index < text.length; index++) {
    if (shellQuotes) {
      const character = text[index];
      if (character === "\\" && outerQuote !== "'") {
        const escapedCharacter = text[index + 1];
        if (
          outerQuote !== '"' || escapedCharacter === undefined ||
          /[$`"\\\n]/.test(escapedCharacter)
        ) index++;
        continue;
      }
      if (outerQuote === "'") {
        if (character === "'") outerQuote = undefined;
        continue;
      }
      if (character === '"') {
        outerQuote = outerQuote === '"' ? undefined : '"';
        continue;
      }
      if (!outerQuote && character === "'") {
        outerQuote = "'";
        continue;
      }
    }
    if (text[index] === "\\") {
      index++;
      continue;
    }
    if (text[index] === "`") {
      const start = index++;
      while (index < text.length) {
        if (text[index] === "\\") index++;
        else if (text[index] === "`") break;
        index++;
      }
      substitutions.push(text.slice(start, index + 1));
      continue;
    }
    if (
      text[index] !== "$" || text[index + 1] !== "(" ||
      text[index + 2] === "("
    ) continue;

    const end = commandSubstitutionEnd(text, index);
    substitutions.push(text.slice(index, end));
    index = end - 1;
  }
  return substitutions.join(";");
}

function removeHeredocBodies(command: string): string {
  const pending: HeredocDelimiter[] = [];
  const state = newHeredocScanState();
  const output: string[] = [];
  let body: string[] = [];
  for (const line of command.split(/\r?\n/)) {
    const delimiter = pending[0];
    if (delimiter) {
      const candidate = delimiter.stripTabs ? line.replace(/^\t+/, "") : line;
      if (candidate === delimiter.value) {
        if (delimiter.expand) {
          output.push(commandSubstitutions(body.join("\n")));
        } else {
          output.push("");
        }
        body = [];
        pending.shift();
      } else {
        body.push(line);
        output.push("");
      }
      continue;
    }
    for (const delimiter of heredocDelimiters(line, state)) {
      pending.push(delimiter);
    }
    output.push(line);
  }
  if (pending[0]?.expand && body.length > 0) {
    output.push(commandSubstitutions(body.join("\n")));
  }
  return output.join("\n");
}

interface ShellRedirection {
  end: number;
  target: string;
}

function shellRedirection(command: string, start: number): ShellRedirection {
  let index = start + 1;
  while (index < command.length && /[<>&|]/.test(command[index])) index++;
  if (command[index] === "-") index++;
  while (index < command.length && /[ \t]/.test(command[index])) index++;

  const targetStart = index;
  let quote: ShellQuote | undefined;
  let substitutionDepth = 0;
  let backtick = false;
  for (; index < command.length; index++) {
    const character = command[index];
    if (character === "\\" && quote !== "'") {
      index++;
      continue;
    }
    if (backtick) {
      if (character === "`") backtick = false;
      continue;
    }
    if (quote) {
      if (character === quote) quote = undefined;
      continue;
    }
    if (character === "'" || character === '"') {
      quote = character;
      continue;
    }
    if (character === "`") {
      backtick = true;
      continue;
    }
    if (character === "$" && command[index + 1] === "(") {
      substitutionDepth++;
      index++;
      continue;
    }
    if (substitutionDepth > 0 && character === "(") {
      substitutionDepth++;
      continue;
    }
    if (substitutionDepth > 0 && character === ")") {
      substitutionDepth--;
      continue;
    }
    if (
      substitutionDepth === 0 &&
      (/\s/.test(character) || /[;&|()]/.test(character))
    ) break;
  }
  return { end: index - 1, target: command.slice(targetStart, index) };
}

export function parseShellCommandSegments(command: string): string[][] {
  const segments: string[][] = [];
  const stack: ShellParseFrame[] = [];
  let context = newShellParseContext();

  const finishWord = () => {
    if (!context.wordStarted) return;
    context.words.push(context.word);
    context.word = "";
    context.wordStarted = false;
  };
  const finishSegment = () => {
    finishWord();
    if (context.words.length > 0) segments.push(context.words);
    context.words = [];
  };

  for (let index = 0; index < command.length; index++) {
    const character = command[index];
    const previous = command[index - 1];
    const next = command[index + 1];

    if (character === "\\" && context.quote !== "'") {
      if (next === "\n") {
        index++;
      } else if (next === "\r" && command[index + 2] === "\n") {
        index += 2;
      } else if (next !== undefined) {
        context.word += next;
        context.wordStarted = true;
        index++;
      }
      continue;
    }
    if (context.quote === "'") {
      if (character === "'") context.quote = undefined;
      else context.word += character;
      continue;
    }
    if (context.quote === '"') {
      if (character === '"') {
        context.quote = undefined;
      } else if (character === "$" && next === "(") {
        context.word += "$()";
        context.wordStarted = true;
        stack.push({ context, terminator: ")" });
        context = newShellParseContext();
        index++;
      } else if (character === "`") {
        context.word += "$()";
        context.wordStarted = true;
        stack.push({ context, terminator: "`" });
        context = newShellParseContext();
      } else {
        context.word += character;
      }
      continue;
    }
    if (character === "'" || character === '"') {
      context.quote = character;
      context.wordStarted = true;
      continue;
    }
    if (character === "$" && next === "(") {
      context.word += "$()";
      context.wordStarted = true;
      stack.push({ context, terminator: ")" });
      context = newShellParseContext();
      index++;
      continue;
    }
    if (character === "`") {
      const frame = stack.at(-1);
      if (frame?.terminator === "`") {
        finishSegment();
        context = stack.pop()!.context;
      } else {
        context.word += "$()";
        context.wordStarted = true;
        stack.push({ context, terminator: "`" });
        context = newShellParseContext();
      }
      continue;
    }
    if (stack.at(-1)?.terminator === ")" && character === "(") {
      context.parenthesisDepth++;
      context.word += character;
      context.wordStarted = true;
      continue;
    }
    if (stack.at(-1)?.terminator === ")" && character === ")") {
      if (context.parenthesisDepth > 0) {
        context.parenthesisDepth--;
        context.word += character;
        context.wordStarted = true;
      } else {
        finishSegment();
        context = stack.pop()!.context;
      }
      continue;
    }
    if (
      character === "#" &&
      (index === 0 || /[\s;&|()]/.test(previous))
    ) {
      finishSegment();
      while (
        index + 1 < command.length &&
        command[index + 1] !== "\n" &&
        command[index + 1] !== "\r"
      ) index++;
      continue;
    }
    if (
      character === "<" || character === ">" ||
      (character === "&" && next === ">")
    ) {
      if (context.wordStarted && /^\d+$/.test(context.word)) {
        context.word = "";
        context.wordStarted = false;
      } else {
        finishWord();
      }
      const redirection = shellRedirection(command, index);
      const substitutions = commandSubstitutions(redirection.target, true);
      if (substitutions) {
        for (const segment of parseShellCommandSegments(substitutions)) {
          segments.push(segment);
        }
      }
      index = redirection.end;
      continue;
    }
    if (/\s/.test(character)) {
      if (character === "\n" || character === "\r") finishSegment();
      else finishWord();
      continue;
    }

    let separatorLength = 0;
    if (character === ";") {
      separatorLength = 1;
    } else if (character === "&") {
      if (next === "&") {
        separatorLength = 2;
      } else if (previous !== ">" && previous !== "<" && next !== ">") {
        separatorLength = 1;
      }
    } else if (character === "|") {
      separatorLength = next === "|" ? 2 : 1;
    }

    if (separatorLength > 0) {
      finishSegment();
      index += separatorLength - 1;
      continue;
    }

    context.word += character;
    context.wordStarted = true;
  }

  finishSegment();
  while (stack.length > 0) {
    context = stack.pop()!.context;
    finishSegment();
  }
  return segments;
}

function isTestPath(word: string | undefined): boolean {
  return word !== undefined && word.length > 0 && !word.startsWith("-");
}

const PIECE_NEW_VALUE_OPTIONS = new Set([
  "--main-export",
  "--root",
  "--repository",
  "--test",
  "--slug",
  "--identity",
  "-i",
  "--api-url",
  "-a",
  "--url",
  "-u",
  "--space",
  "-s",
]);

function pieceNewMain(commandWords: string[]): string | undefined {
  const positional: string[] = [];
  for (let index = 3; index < commandWords.length; index++) {
    const word = commandWords[index];
    if (word === "--") {
      for (const word of commandWords.slice(index + 1)) positional.push(word);
      break;
    }
    if (word.startsWith("-")) {
      if (!word.includes("=") && PIECE_NEW_VALUE_OPTIONS.has(word)) index++;
      continue;
    }
    positional.push(word);
  }
  return positional.length === 1 ? positional[0] : undefined;
}

/**
 * The commands this hook answers, each written as the noun it acts on and the
 * verb under it.
 *
 * A pair rather than a verb, because a verb alone does not name a command:
 * `set` acts on a cell and `new` on a piece, so a hook matching a verb under
 * whichever noun precedes it advises on `cf piece set` and `cf cell new`,
 * neither of which the CLI accepts. A pair joins this set when it gains a
 * branch below.
 *
 * The bare `set` is a superseded spelling that still answers, and the guidance
 * is the same one its blessed spelling gets. `get` and `call` are spelled two
 * ways too but carry no guidance, so listing them would widen what the hook
 * accepts without changing what it answers.
 */
const GUIDED_COMMANDS = new Set([
  "piece new",
  "piece setsrc",
  "piece inspect",
  "cell set",
  "set",
]);

/** The nouns those pairs sit under, which is what a `cf` is recognized by. */
const GUIDED_NOUNS = new Set(
  [...GUIDED_COMMANDS]
    .filter((command) => command.includes(" "))
    .map((command) => command.slice(0, command.indexOf(" "))),
);

function suggestionForCommandSegment(words: string[]): string {
  const normalizedWords = words.map((word) =>
    word.replace(/^\(+/, "").replace(/\)+$/, "")
  );
  const cfIndex = normalizedWords.findIndex((word, index) => {
    if (word !== "cf") return false;
    const next = normalizedWords[index + 1] ?? "";
    return GUIDED_NOUNS.has(next) || GUIDED_COMMANDS.has(next);
  });
  if (cfIndex < 0) return "";

  const commandWords = normalizedWords.slice(cfIndex);
  // A noun segment shifts the verb one word along, so the command is read as
  // the pair it forms rather than found at a fixed index.
  const command = GUIDED_NOUNS.has(commandWords[1] ?? "")
    ? `${commandWords[1]} ${commandWords[2] ?? ""}`
    : commandWords[1] ?? "";
  if (!GUIDED_COMMANDS.has(command)) return "";
  // Past that gate the noun has done its work, so the branches below key on
  // the verb alone. They are reachable only for a pair this hook answers,
  // which is what keeps `cf space set` out of the `set` branch.
  const verb = command.includes(" ")
    ? command.slice(command.indexOf(" ") + 1)
    : command;
  const testOptions = commandWords.flatMap((word, index) => {
    if (word === "--test") {
      return [{ value: commandWords[index + 1], inline: false }];
    }
    if (word.startsWith("--test=")) {
      return [{ value: word.slice("--test=".length), inline: true }];
    }
    return [];
  });
  const hasTestOption = testOptions.length > 0;
  const attachedTests = hasTestOption &&
    testOptions.every(({ value, inline }) =>
      inline ? value.length > 0 : isTestPath(value)
    );
  const testSuggestion = attachedTests
    ? "The command attaches tests for packaging, but does not run them. Confirm every entry passed with 'cf test'."
    : "No tests were attached. For new or changed source, write and run pattern tests, then deploy with repeatable '--test'.";

  if (verb === "new") {
    const main = pieceNewMain(commandWords);
    if (!hasTestOption && main && /\.test\.[cm]?[jt]sx?$/.test(main)) {
      return "Test pattern deployed as the executable diagnostic entry. Next, inspect its action and assertion cells.";
    }
    return `${testSuggestion} Next, use 'cf piece inspect' to view state or 'cf piece call' to test handlers.`;
  }
  if (verb === "setsrc") {
    return `${testSuggestion} Next, use 'cf piece step' to trigger re-evaluation, then 'cf piece inspect' to verify.`;
  }
  if (verb === "set") {
    return "State set. Run 'cf piece step' to trigger re-evaluation before reading computed values.";
  }
  if (verb === "inspect") {
    return "State inspected. Use 'cf piece call handlerName' to test handlers or 'cf cell set' to modify state.";
  }
  return "";
}

export function suggestionForPatternUserCommand(command: string): string {
  return parseShellCommandSegments(removeHeredocBodies(command))
    .map((segment) => suggestionForCommandSegment(segment))
    .filter(Boolean)
    .join(" ");
}

if (import.meta.main) {
  const rawInput = await new Response(Deno.stdin.readable).text();
  let input: {
    tool_input?: { command?: string };
    tool_response?: { stdout?: string; stderr?: string };
  } = {};

  try {
    input = JSON.parse(rawInput);
  } catch {
    Deno.exit(0);
  }

  const suggestion = suggestionForPatternUserCommand(
    input.tool_input?.command || "",
  );
  if (suggestion) {
    console.log(JSON.stringify({
      hookSpecificOutput: {
        hookEventName: "PostToolUse",
        additionalContext: suggestion,
      },
    }));
  }
}
