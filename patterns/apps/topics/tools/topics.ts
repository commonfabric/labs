/**
 * The command-line client for the team's Topics board: search, read, and write
 * Topics in one command each, run as `deno task topics` from a labs checkout.
 * `skills/topics/SKILL.md` is how to use it; `README.md` beside this file is
 * how it works.
 *
 * Reads come from a local copy of the board that every command first brings
 * up to date. Writes run the Topics verbs through the checkout's own
 * `cf piece call`, then refresh the copy and check that the write reads back.
 * Each write is a fresh invocation and announces its id before it dispatches;
 * naming that id again with `--invocation` settles on the first outcome
 * rather than writing twice, which is how a write whose answer was lost is
 * recovered.
 */

import { parseArgs } from "@std/cli/parse-args";
import { dirname, fromFileUrl, join, resolve } from "@std/path";
import { debugStr } from "@commonfabric/data-model";
import { isObjectNotArray } from "@commonfabric/utils/types";

import {
  FIELDS,
  formatTopic,
  formatTopicLine,
  type Now,
  type SearchScope,
  searchTopics,
  type ThreadWindow,
  type Topic,
  topicRecord,
} from "./mirror.ts";
import {
  boardFile,
  copySource,
  loadMirror,
  openDocSource,
  type OpenedDocSource,
  type OpenedSession,
  openSession,
  type Refreshed,
  refreshMirror,
  resolvePieces,
  saveMirror,
} from "./sync.ts";
import {
  type Clock,
  consoleTerminal,
  systemClock,
  type Terminal,
  watchBoard,
} from "./watch.ts";

/** The board this client addresses unless the environment names another. */
const DEFAULT_BOARD = {
  apiUrl: "https://estuary.saga-castor.ts.net",
  space: "topics-dev-476ea34f",
  board: "of:fid1:jtdD-DSmuGrLGSt_6sJ3DS_7jmerrkKTEnW3fZV9e34",
};

/** The checkout's `cf` launcher, which writes run. */
const LAUNCHER = fromFileUrl(
  new URL("../../../../runtime/cli/launcher.ts", import.meta.url),
);

/** What a write's report adds when an earlier run had already made it. */
const REPEATED = ", by an earlier run of this invocation";

/** Topics a search lists unless told otherwise. */
const DEFAULT_LIMIT = 20;

/** The options a command takes, from its flags and environment. */
export interface TopicsOptions {
  identity?: string;
  agentName?: string;
  offline?: boolean;
  invocation?: string;
}

/** The board, its connection, and where the client keeps its files. */
export interface Board {
  apiUrl: string;
  space: string;
  identity: string;
  board: string;

  /** Where the board's local copy is kept. */
  mirror: string;

  /** Where the invocation session writes are chosen within is kept. */
  session: string;
}

/** What one run of a program produced. */
export interface ProgramRun {
  code: number;
  stdout: string;
  stderr: string;
}

/** The effects the client has, injectable so the commands run in a test. */
export interface TopicsDeps {
  openDocSource: (board: Board) => Promise<OpenedDocSource>;

  /** Opens the session `watch` follows the board over. */
  openSession: (board: Board) => Promise<OpenedSession>;

  /**
   * The terminal `watch` takes over, and the clock it animates by and a
   * listing tells how long ago a Topic was active by.
   */
  terminal: Terminal;
  clock: Clock;

  /** The time zone a listing gives the day a Topic was last active in. */
  timeZone: string;

  /** The `cf` launcher writes are run through. */
  launcher: string;

  /** Runs `program` as {@link runProgram} does. */
  run: typeof runProgram;

  /** Where a write's text is read from when it is not an argument. */
  stdin: Pick<typeof Deno.stdin, "isTerminal" | "readable">;

  write: (text: string) => void;

  /** Where notes about the run go, apart from its output. */
  warn: (text: string) => void;

  env: (name: string) => string | undefined;
}

const defaultDeps: TopicsDeps = {
  openDocSource,
  openSession,
  terminal: consoleTerminal(Deno),
  clock: systemClock,
  timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
  launcher: LAUNCHER,
  run: runProgram,
  stdin: Deno.stdin,
  write: console.log,
  warn: console.error,
  env: Deno.env.get,
};

/**
 * Runs the Deno program at `program` with `args`, the variables in `env` added
 * to this process's environment, and `stdin` on its standard input, and
 * returns what it wrote and how it exited.
 */
export async function runProgram(
  program: string,
  args: readonly string[],
  env: Record<string, string>,
  stdin: string,
): Promise<ProgramRun> {
  const child = new Deno.Command(Deno.execPath(), {
    args: [
      "run",
      "--allow-run",
      "--allow-env",
      "--allow-read",
      program,
      ...args,
    ],
    env,
    stdin: "piped",
    stdout: "piped",
    stderr: "piped",
  }).spawn();
  // Fed and drained at once, so that neither side waits on a full pipe.
  const writer = child.stdin.getWriter();
  const [{ code, stdout, stderr }] = await Promise.all([
    child.output(),
    writer.write(new TextEncoder().encode(stdin)).then(() => writer.close())
      .catch(() => {
        // A child that exits without reading its input leaves the write to
        // fail; its exit code and output say why.
      }),
  ]);
  const decoder = new TextDecoder();
  return {
    code,
    stdout: decoder.decode(stdout),
    stderr: decoder.decode(stderr),
  };
}

/** Everything `stdin` holds, or `undefined` when it is a terminal. */
export async function stdinText(
  stdin: Pick<typeof Deno.stdin, "isTerminal" | "readable">,
): Promise<string | undefined> {
  return stdin.isTerminal()
    ? undefined
    : await new Response(stdin.readable).text();
}

/**
 * The board `TOPICS_API_URL`, `TOPICS_SPACE`, and `TOPICS_BOARD` name, the
 * team's by default, read as the identity `options` names.
 */
function boardFrom(deps: TopicsDeps, options: TopicsOptions): Board {
  const { env } = deps;
  const apiUrl = env("TOPICS_API_URL") ?? DEFAULT_BOARD.apiUrl;
  const space = env("TOPICS_SPACE") ?? DEFAULT_BOARD.space;
  const board = (env("TOPICS_BOARD") ?? DEFAULT_BOARD.board).replace(/^\//, "");
  return {
    apiUrl,
    space,
    // `deno task` runs this script from the checkout's root and `cf` from
    // where the command was typed, so a relative path is made absolute
    // against the latter before either reads it.
    identity: resolve(
      env("INIT_CWD") ?? Deno.cwd(),
      options.identity ?? env("CF_IDENTITY") ??
        join(env("HOME") ?? ".", ".config/commonfabric/identity.key"),
    ),
    board,
    mirror: boardFile("copy", apiUrl, space, board, env),
    session: boardFile("session", apiUrl, space, board, env),
  };
}

/**
 * The board's Topics, from its copy brought up to date first; from the copy
 * as it stands when `offline` is set; or, when `rebuild` is set, from a new
 * copy that reads the whole board again.
 */
async function readTopics(
  deps: TopicsDeps,
  board: Board,
  { offline = false, rebuild = false } = {},
): Promise<Read> {
  const data = rebuild
    ? { pieces: {}, docs: {} }
    : await loadMirror(board.mirror);
  if (offline) {
    if (data.space === undefined) {
      throw new Error(
        "There is no local copy of the board yet: run without `--offline`.",
      );
    }
    const refreshed = await refreshMirror(
      data,
      board.board,
      copySource(data.space),
    );
    return read(deps, refreshed, [board.space, data.space]);
  }
  const source = await deps.openDocSource(board);
  try {
    const refreshed = await refreshMirror(data, board.board, source);
    await saveMirror(board.mirror, data);
    return read(deps, refreshed, [board.space, source.space]);
  } finally {
    await source.close();
  }
}

/** The board's Topics, and the names a reference may give the board's space. */
interface Read extends Refreshed {
  spaces: string[];
}

/**
 * Helper for {@link readTopics}, which reports Topics that read as blank and
 * records the space's names.
 */
function read(
  deps: TopicsDeps,
  refreshed: Refreshed,
  spaces: string[],
): Read {
  if (refreshed.unreached.length > 0) {
    deps.warn(
      "These board entries lead to no Topic piece the copy has read, so " +
        "they are left out: " +
        refreshed.unreached.map((number) => `top/${number}`).join(", "),
    );
  }
  if (refreshed.unreadable.length > 0) {
    deps.warn(
      "These Topics are not stored where this client reads a Topic's title, " +
        "comments, and links, so they show blank; the deployed Topics " +
        "pattern may store Topics differently: " +
        refreshed.unreadable.map((number) => `top/${number}`).join(", "),
    );
  }
  return { ...refreshed, spaces };
}

/**
 * The Topic `reference` names among `topics`: a number, written `42`, `#42`,
 * `top/42`, or `//<space>/top/42`, or an address, written `/of:…` or `of:…`.
 *
 * @throws Error naming the Topic when the board has none by that name.
 */
export function findTopic(
  read: Pick<Read, "topics" | "spaces">,
  reference: string,
): Topic {
  const topic = lookUp(read, reference);
  if (topic === undefined) {
    throw new Error(`The board has no Topic ${topicName(reference)}.`);
  }
  return topic;
}

/** Helper for {@link findTopic}, which is `undefined` for no such Topic. */
function lookUp(
  { topics, spaces }: Pick<Read, "topics" | "spaces">,
  reference: string,
): Topic | undefined {
  const [, space, number] = NUMBERED.exec(reference) ?? [];
  const address = reference.replace(/^\//, "");
  return space !== undefined && !spaces.includes(space)
    ? undefined
    : topics.find((t) =>
      number === undefined
        ? t.address === address || t.piece === address
        : t.number === number
    );
}

/** A Topic named by its number, with the space it is in or without. */
const NUMBERED = /^(?:\/\/([^/]+)\/)?(?:top\/|#)?(\d+)$/;

/** How a message names the Topic `reference` names: `top/42`, or the address. */
function topicName(reference: string): string {
  const [, space, number] = NUMBERED.exec(reference) ?? [];
  return number === undefined
    ? debugStr`$quote${reference}`
    : `${space === undefined ? "" : `//${space}/`}top/${number}`;
}

/** The text of a write: the argument given, else everything on stdin. */
async function textFrom(
  deps: TopicsDeps,
  given: string | undefined,
  what: string,
): Promise<string> {
  const text = given ?? await stdinText(deps.stdin) ?? "";
  if (text.trim() === "") {
    throw new Error(
      `Give the ${what} as an argument or on stdin.`,
    );
  }
  return text;
}

function agentFrom(deps: TopicsDeps, options: TopicsOptions): string {
  const agent = (options.agentName ?? deps.env("CF_AGENT_NAME"))?.trim();
  if (!agent) {
    throw new Error(
      "A write names the agent making it: pass `--agent-name <name>` or " +
        "set `CF_AGENT_NAME`.",
    );
  }
  return agent;
}

/**
 * The invocation session this machine's writes to `board` are chosen within,
 * minted on first use into a file only its owner can read.
 */
export async function writeSession(board: Board): Promise<string> {
  const path = board.session;
  await Deno.mkdir(dirname(path), { recursive: true });
  // Linking a finished file into place mints the session atomically: a
  // second run, or a concurrent one, finds the name taken and reads the
  // session already there.
  const minted = join(dirname(path), `.${crypto.randomUUID()}.tmp`);
  await Deno.writeTextFile(minted, crypto.randomUUID(), { mode: 0o600 });
  try {
    await Deno.link(minted, path);
  } catch (error) {
    if (!(error instanceof Deno.errors.AlreadyExists)) throw error;
  } finally {
    await Deno.remove(minted);
  }
  return (await Deno.readTextFile(path)).trim();
}

/** One write: the verb, the piece it is called on, and its payload. */
interface Write {
  target: string;
  verb: string;
  payload: Record<string, unknown>;

  /** The result's projection, for a verb whose result is read. */
  resultSchema?: string;
}

/** What a write that settled produced. */
interface Written {
  result: unknown;

  /** The invocation's id. */
  invocation: string;

  /** Whether an earlier run of the same invocation had already made it. */
  repeated: boolean;
}

/** The variables that point `cf` at `board`, as the identity it names. */
function cfEnv(board: Board): Record<string, string> {
  return {
    CF_API_URL: board.apiUrl,
    CF_SPACE: board.space,
    CF_IDENTITY: board.identity,
  };
}

/**
 * Runs `cf` with `args` against `board`, failing with what it wrote to
 * standard error when it fails.
 */
async function cf(
  deps: TopicsDeps,
  board: Board,
  args: readonly string[],
  env: Record<string, string> = {},
  stdin = "",
): Promise<ProgramRun> {
  // The launcher takes options of its own; `--` hands the rest to `cf`.
  const run = await deps.run(
    deps.launcher,
    ["--", ...args],
    { ...cfEnv(board), ...env },
    stdin,
  );
  if (run.code !== 0) {
    // `cf` names the invocation session as it dispatches; the session stays
    // in its file rather than in a report.
    const report = run.stderr.split("\n").filter((line) =>
      !line.startsWith("session: ")
    ).join("\n").trim();
    throw new Error(`\`cf ${args.slice(0, 2).join(" ")}\` failed:\n${report}`);
  }
  return run;
}

/**
 * Makes `write` as the invocation `options.invocation` names, or a fresh one,
 * through `cf piece call`, and runs `settle` over what it produced. The
 * invocation's id is announced before the write dispatches, and a failure
 * once it has dispatched, which may have committed, says how to settle it by
 * naming the id again.
 */
async function invoke<T>(
  deps: TopicsDeps,
  board: Board,
  options: TopicsOptions,
  { target, verb, payload, resultSchema }: Write,
  settle: (written: Written) => Promise<T>,
): Promise<T> {
  if (options.invocation?.trim() === "") {
    throw new Error("`--invocation` names an invocation id.");
  }
  const id = options.invocation ?? `topics-${crypto.randomUUID()}`;
  const session = await writeSession(board);
  deps.warn(
    `Writing as invocation ${id}; if no answer arrives, run the same ` +
      `command with \`--invocation ${id}\` to settle it.`,
  );
  // How far a failed call got decides what it leaves unknown. `cf piece call`
  // names the phase it reached; only one that never dispatched cannot have
  // committed, so any other failure, named or not, names this id to settle it.
  const unsettled = (error: unknown): Error => {
    const message = messageOf(error);
    const phases = [...message.matchAll(/^invocation: \S+ phase: (\S+)$/gm)];
    return phases.at(-1)?.[1] === "initial_sync"
      ? new Error(message, { cause: error })
      : new Error(
        `${message}\nThe write may have committed: run the same command ` +
          `with \`--invocation ${id}\` to settle it without writing twice.`,
        { cause: error },
      );
  };
  let stdout: string;
  try {
    ({ stdout } = await cf(
      deps,
      board,
      [
        "piece",
        "call",
        "--cell",
        `/${target}`,
        "--invocation",
        id,
        verb,
        "-",
        ...(resultSchema === undefined ? [] : ["--", "--schema", resultSchema]),
      ],
      { CF_INVOCATION_SESSION: session },
      JSON.stringify(payload),
    ));
  } catch (error) {
    throw unsettled(error);
  }
  let outcome: unknown;
  try {
    outcome = JSON.parse(stdout);
  } catch {
    throw unsettled(debugStr`\`${verb}\` answered $quote,long${stdout}.`);
  }
  if (!isObjectNotArray(outcome) || outcome.status !== "settled") {
    throw unsettled(
      debugStr`\`${verb}\` did not settle: $quote,long${outcome}.`,
    );
  }
  return await settle({
    result: outcome.result,
    invocation: id,
    repeated: outcome.deduplicated === true,
  });
}

/** What `error` says. */
function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Runs the Topic at `cell` to completion once, after the write `written` to
 * it. The board lists each Topic with a comment count and a last activity
 * that the Topic derives and stores only when a run of it completes, and
 * `cf piece call` returns before that.
 */
async function step(
  deps: TopicsDeps,
  board: Board,
  cell: string,
  written: Written,
) {
  try {
    await cf(deps, board, ["piece", "step", "--cell", cell]);
  } catch (error) {
    throw new Error(
      `${messageOf(error)}\nThe write was made, but the board will not ` +
        `show it until ${cell} runs: run the same command with ` +
        `\`--invocation ${written.invocation}\` to run it without writing ` +
        "again.",
      { cause: error },
    );
  }
}

/**
 * Refreshes the copy after a write and prints the Topic it wrote to, failing
 * when `wrote` does not hold of what reads back.
 */
async function confirm(
  deps: TopicsDeps,
  board: Board,
  reference: string,
  wrote: (topic: Topic) => boolean | Promise<boolean>,
  done: string,
): Promise<void> {
  const topic = findTopic(await readTopics(deps, board), reference);
  if (!await wrote(topic)) {
    throw new Error(
      `The write settled but does not read back on top/${topic.number}.`,
    );
  }
  deps.write(`${done}\n${formatTopicLine(topic, nowFor(deps))}`);
}

/**
 * Writes to the Topic `reference` names with `verb`, then confirms the write
 * reads back.
 */
async function writeTopic(
  deps: TopicsDeps,
  options: TopicsOptions,
  reference: string,
  verb: string,
  payload: (agentName: string) => Record<string, unknown>,
  wrote: (before: Topic, after: Topic, repeated: boolean) => boolean,
  done: string,
): Promise<void> {
  const board = boardFrom(deps, options);
  const agentName = agentFrom(deps, options);
  const target = findTopic(await readTopics(deps, board), reference);
  await invoke(
    deps,
    board,
    options,
    { target: target.address, verb, payload: payload(agentName) },
    async (written) => {
      const { repeated } = written;
      await step(deps, board, `/${target.address}`, written);
      await confirm(
        deps,
        board,
        target.number,
        (after) => wrote(target, after, repeated),
        `${done} top/${target.number}${repeated ? REPEATED : ""}.`,
      );
    },
  );
}

/** Runs the `search` command. */
export async function searchAction(
  options: TopicsOptions & SearchScope & { limit?: number; json?: boolean },
  terms: string[],
  deps: TopicsDeps = defaultDeps,
): Promise<void> {
  const { topics } = await readTopics(
    deps,
    boardFrom(deps, options),
    { offline: options.offline },
  );
  const hits = searchTopics(topics, terms.map(patternOf), options);
  const limit = options.limit ?? DEFAULT_LIMIT;
  const listed = hits.slice(0, limit);
  if (options.json) {
    deps.write(JSON.stringify(
      {
        matching: hits.length,
        topics: listed.map(({ topic, snippets }) => ({
          number: topic.number,
          address: `/${topic.address}`,
          title: topic.title,
          createdAt: topic.createdAt,
          createdBy: topic.createdBy,
          lastActivityAt: topic.lastActivityAt,
          comments: topic.comments.filter((c) => !c.removed).length,
          matches: snippets,
        })),
      },
      null,
      2,
    ));
    return;
  }
  const lines = listed.flatMap(({ topic, snippets }) => [
    formatTopicLine(topic, nowFor(deps)),
    ...snippets.map((snippet) => `    ${snippet}`),
  ]);
  lines.push(
    hits.length > limit
      ? `${hits.length} Topics match; these are the ${limit} most recently ` +
        "active (`--limit` lists more)."
      : `${hits.length} of ${topics.length} Topics match.`,
  );
  deps.write(lines.join("\n"));
}

/**
 * The case-insensitive pattern `term` is, or that matches it literally when
 * it is not a valid regular expression.
 */
function patternOf(term: string): RegExp {
  try {
    return new RegExp(term, "i");
  } catch {
    return new RegExp(RegExp.escape(term), "i");
  }
}

/**
 * Runs the `show` command: prints each Topic named that the board holds, in
 * the order named, then fails naming any it does not.
 */
export async function showAction(
  options: TopicsOptions & { window?: ThreadWindow; json?: boolean },
  references: readonly string[],
  deps: TopicsDeps = defaultDeps,
): Promise<void> {
  const read = await readTopics(
    deps,
    boardFrom(deps, options),
    { offline: options.offline },
  );
  const found = references.map((reference) => lookUp(read, reference));
  const present = found.flatMap((topic) => topic === undefined ? [] : [topic]);
  if (options.json) {
    deps.write(JSON.stringify(
      present.map((topic) => topicRecord(topic, options.window)),
      null,
      2,
    ));
  } else if (present.length > 0) {
    deps.write(
      present.map((topic) =>
        formatTopic(topic, `/${topic.address}`, options.window)
      ).join("\n\n"),
    );
  }
  const missing = references.filter((_, index) => found[index] === undefined);
  if (missing.length > 0) {
    throw new Error(
      `The board has no ${missing.length === 1 ? "Topic" : "Topics"} ` +
        `${missing.map(topicName).join(", ")}.`,
    );
  }
}

/** The moment a listing is made at, and the time zone it is read in. */
function nowFor(deps: TopicsDeps): Now {
  return { now: deps.clock.now(), timeZone: deps.timeZone };
}

/** Runs the `sync` command. */
export async function syncAction(
  options: TopicsOptions & { rebuild?: boolean },
  deps: TopicsDeps = defaultDeps,
): Promise<void> {
  const board = boardFrom(deps, options);
  const { topics, fetched } = await readTopics(deps, board, {
    rebuild: options.rebuild,
  });
  deps.write(
    `${topics.length} Topics; the server sent ${fetched} changed ` +
      `documents.\nLocal copy: ${board.mirror}`,
  );
}

/** Runs the `new` command. */
export async function newAction(
  options: TopicsOptions,
  title: string,
  body: string | undefined,
  deps: TopicsDeps = defaultDeps,
): Promise<void> {
  const board = boardFrom(deps, options);
  const agentName = agentFrom(deps, options);
  const text = await textFrom(deps, body, "body");
  await invoke(
    deps,
    board,
    options,
    {
      target: board.board,
      verb: "addTopic",
      payload: { title, body: text, agentName },
      resultSchema: JSON.stringify({
        properties: { topic: { $link: true }, name: { type: "string" } },
      }),
    },
    async (written) => {
      const { result, repeated } = written;
      const topic = isObjectNotArray(result) && isObjectNotArray(result.topic)
        ? result.topic.$link
        : undefined;
      const name = isObjectNotArray(result) ? result.name : undefined;
      if (typeof topic !== "string" || typeof name !== "string") {
        throw new Error(
          "`addTopic` settled without naming the Topic it created.",
        );
      }
      await step(deps, board, topic, written);
      await confirm(
        deps,
        board,
        name,
        (created) => created.title === title.trim(),
        `Created top/${name} (${topic})${repeated ? REPEATED : ""}.`,
      );
    },
  );
}

/** Runs the `comment` command. */
export async function commentAction(
  options: TopicsOptions,
  reference: string,
  body: string | undefined,
  deps: TopicsDeps = defaultDeps,
): Promise<void> {
  const text = await textFrom(deps, body, "comment");
  // A comment like an earlier one confirms nothing: the count has to grow,
  // unless an earlier run of this invocation already made it.
  const like = (topic: Topic) =>
    topic.comments.filter((c) => c.body.trim() === text.trim() && !c.removed)
      .length;
  await writeTopic(
    deps,
    options,
    reference,
    "addComment",
    (agentName) => ({ body: text, agentName }),
    (before, after, repeated) => like(after) > (repeated ? 0 : like(before)),
    "Commented on",
  );
}

/** Runs the `body` command. */
export async function bodyAction(
  options: TopicsOptions,
  reference: string,
  body: string | undefined,
  deps: TopicsDeps = defaultDeps,
): Promise<void> {
  const text = await textFrom(deps, body, "body");
  await writeTopic(
    deps,
    options,
    reference,
    "setBody",
    (agentName) => ({ body: text, agentName }),
    (_, after) => after.body === text,
    "Replaced the body of",
  );
}

/** Runs the `title` command. */
export async function titleAction(
  options: TopicsOptions,
  reference: string,
  title: string,
  deps: TopicsDeps = defaultDeps,
): Promise<void> {
  await writeTopic(
    deps,
    options,
    reference,
    "setTitle",
    (agentName) => ({ title, agentName }),
    (_, after) => after.title === title.trim(),
    "Retitled",
  );
}

/** Runs the `link` command. */
export async function linkAction(
  options: TopicsOptions & { kind?: string },
  reference: string,
  url: string,
  label: string | undefined,
  deps: TopicsDeps = defaultDeps,
): Promise<void> {
  const like = (topic: Topic) =>
    topic.links.filter((l) => l.url === url.trim() && !l.removed).length;
  await writeTopic(
    deps,
    options,
    reference,
    "addLink",
    (agentName) => ({
      url,
      ...(options.kind === undefined ? {} : { kind: options.kind }),
      ...(label === undefined ? {} : { label }),
      agentName,
    }),
    (before, after, repeated) => like(after) > (repeated ? 0 : like(before)),
    "Linked",
  );
}

/** Runs the `mention` or `unmention` command. */
export async function mentionAction(
  options: TopicsOptions,
  verb: "mention" | "unmention",
  reference: string,
  other: string,
  deps: TopicsDeps = defaultDeps,
): Promise<void> {
  const board = boardFrom(deps, options);
  const read = await readTopics(deps, board);
  const from = findTopic(read, reference);
  const to = findTopic(read, other);
  // A reference is stored as whatever address it was given, and one piece
  // answers to several, so each is followed to its piece and compared there.
  const mentions = async (topic: Topic) => {
    const source = await deps.openDocSource(board);
    try {
      const { resolved } = await resolvePieces(source, topic.mentions);
      return [...resolved.values()].some(({ piece }) => piece === to.piece);
    } finally {
      await source.close();
    }
  };
  await invoke(
    deps,
    board,
    options,
    { target: from.address, verb, payload: { topic: `/${to.address}` } },
    async (written) => {
      const { repeated } = written;
      await step(deps, board, `/${from.address}`, written);
      await confirm(
        deps,
        board,
        from.number,
        async (after) => await mentions(after) === (verb === "mention"),
        `top/${from.number} ${verb === "mention" ? "now" : "no longer"} ` +
          `mentions top/${to.number}${repeated ? REPEATED : ""}.`,
      );
    },
  );
}

/** The options each command takes, beyond `--identity` and `--help`. */
const OPTIONS: Record<string, readonly string[]> = {
  search: ["limit", "offline", "in", "exclude", "json"],
  show: ["offline", "json", "last", "comments-since"],
  sync: ["rebuild"],
  watch: [],
  new: ["agent-name", "invocation"],
  comment: ["agent-name", "invocation"],
  body: ["agent-name", "invocation"],
  title: ["agent-name", "invocation"],
  link: ["agent-name", "invocation", "kind"],
  mention: ["invocation"],
  unmention: ["invocation"],
};

/** What `--help` prints. */
export const USAGE = `Usage: deno task -q topics <command> [options]

Search, read, and write the team's Topics board. Every command first brings a
local copy of the board up to date, asking the server only for documents that
changed. The copy lives under $XDG_CACHE_HOME (or ~/.cache), in
commonfabric/topics/.

Reading:
  search [term...]          The Topics matching every term, most recently
                            active first, with the lines that matched. A term
                            is a case-insensitive regular expression; with no
                            terms, the most recently active Topics.
      -n, --limit <count>   How many Topics to list (default ${DEFAULT_LIMIT}).
      --in <fields>         Match only in these, comma-separated: title,
                            body, comments, links, authors (default all).
      --exclude <pattern>   Leave out Topics whose title matches, such as
                            '^\\[(RESOLVED|DUPLICATE|OBSOLETE)'. Repeatable.
  show <topic>...           Each Topic as Markdown: body, links, and comments.
      --last <count>        Only the last this many comments of each.
      --comments-since <date>
                            Only comments sent since then: 2026-10-27 or
                            2026-10-27T14:00 in local time, or ...Z in UTC.
  sync                      Bring the copy up to date and say where it is.
      --rebuild             Read the whole board again.
  watch                     The board, live, on the whole terminal: each
                            change shown as it happens. q quits.
  --offline                 Read the copy as it stands (search, show).
  --json                    Print JSON for a program to read (search, show).

Writing:
  new <title> [body]        File a Topic.
  comment <topic> [body]    Add a comment to a Topic's thread.
  body <topic> [body]       Replace a Topic's body whole.
  title <topic> <title>     Rename a Topic.
  link <topic> <url> [label]
      --kind <kind>         Link kind: web (default) or pr.
  mention <topic> <other>   Record that one Topic references another.
  unmention <topic> <other> Remove those references.

A body omitted from the arguments is read from stdin; give one that begins with
- there, or after --. A Topic is named by its number (42, #42, top/42,
//<space>/top/42) or its address.

Writes of authored content need --agent-name <name> (or CF_AGENT_NAME). Every
write is a new one, and prints its invocation id before it is made. When a
write fails saying it may have committed, or its answer is lost, run the same
command with --invocation <id>: that settles on the first outcome, where
running it again without the id writes a second time.

The identity is --identity (-i), else CF_IDENTITY, else
~/.config/commonfabric/identity.key. TOPICS_API_URL, TOPICS_SPACE, and
TOPICS_BOARD name a board other than the team's on Estuary.`;

/** Runs the command `args` name. */
export async function main(
  args: readonly string[],
  deps: TopicsDeps = defaultDeps,
): Promise<void> {
  const flags = parseArgs([...args], {
    string: [
      "_",
      "identity",
      "agent-name",
      "invocation",
      "limit",
      "kind",
      "in",
      "exclude",
      "last",
      "comments-since",
    ],
    boolean: ["offline", "rebuild", "json", "help"],
    collect: ["exclude"],
    alias: { i: "identity", n: "limit", h: "help" },
    unknown: (arg) => {
      if (arg.startsWith("-")) {
        throw new Error(debugStr`Unknown option $quote${arg}; see \`--help\`.`);
      }
      return true;
    },
  });
  const [command, ...operands] = flags._.map(String);
  const options = {
    identity: flags.identity,
    agentName: flags["agent-name"],
    invocation: flags.invocation,
    offline: flags.offline,
  };
  // The operands a command takes, at least `min` and at most `max`.
  const take = (min: number, max: number): (string | undefined)[] => {
    if (operands.length < min || operands.length > max) {
      throw new Error(
        `\`${command}\` takes ${
          min === max
            ? min
            : max === Infinity
            ? `at least ${min}`
            : `${min} to ${max}`
        } arguments; see \`--help\`.`,
      );
    }
    return operands;
  };
  if (flags.help || command === undefined) {
    deps.write(USAGE);
    return;
  }
  const allowed = OPTIONS[command];
  if (allowed === undefined) {
    throw new Error(
      debugStr`Unknown command $quote${command}; see \`--help\`.`,
    );
  }
  const valued = [
    "agent-name",
    "invocation",
    "limit",
    "kind",
    "in",
    "last",
    "comments-since",
  ] as const;
  for (const option of valued) {
    if (flags[option] !== undefined && !allowed.includes(option)) {
      throw new Error(`\`${command}\` takes no \`--${option}\`.`);
    }
  }
  if (flags.exclude.length > 0 && !allowed.includes("exclude")) {
    throw new Error(`\`${command}\` takes no \`--exclude\`.`);
  }
  for (const option of ["offline", "rebuild", "json"] as const) {
    if (flags[option] && !allowed.includes(option)) {
      throw new Error(`\`${command}\` takes no \`--${option}\`.`);
    }
  }
  switch (command) {
    case "search": {
      const limit = flags.limit === undefined ? undefined : Number(flags.limit);
      if (limit !== undefined && !(Number.isInteger(limit) && limit > 0)) {
        throw new Error("`--limit` takes a positive whole number.");
      }
      const fields = flags.in?.split(",").map((named) => {
        const field = FIELDS.find((field) => field === named.trim());
        if (field === undefined) {
          throw new Error(
            `\`--in\` takes a comma-separated list of ${FIELDS.join(", ")}.`,
          );
        }
        return field;
      });
      return await searchAction(
        {
          ...options,
          limit,
          fields,
          exclude: flags.exclude.map(patternOf),
          json: flags.json,
        },
        operands,
        deps,
      );
    }
    case "show": {
      take(1, Infinity);
      const last = flags.last === undefined ? undefined : Number(flags.last);
      if (last !== undefined && !(Number.isInteger(last) && last > 0)) {
        throw new Error("`--last` takes a positive whole number.");
      }
      // A day alone is the start of that day where the command runs, as a
      // time without a zone is.
      const given = flags["comments-since"];
      const since = given === undefined ? undefined : Date.parse(
        /^\d{4}-\d{2}-\d{2}$/.test(given) ? `${given}T00:00` : given,
      );
      if (since !== undefined && Number.isNaN(since)) {
        throw new Error(
          "`--comments-since` takes a date or time, such as 2026-10-27 or " +
            "2026-10-27T14:00.",
        );
      }
      return await showAction(
        { ...options, window: { since, last }, json: flags.json },
        operands,
        deps,
      );
    }
    case "watch": {
      take(0, 0);
      if (!deps.stdin.isTerminal()) {
        throw new Error("`watch` takes over a terminal; run it in one.");
      }
      const board = boardFrom(deps, options);
      return await watchBoard(board, {
        terminal: deps.terminal,
        clock: deps.clock,
        connect: () => deps.openSession(board),
      });
    }
    case "sync":
      take(0, 0);
      return await syncAction({ ...options, rebuild: flags.rebuild }, deps);
    case "new": {
      const [title, body] = take(1, 2);
      return await newAction(options, title!, body, deps);
    }
    case "comment": {
      const [topic, body] = take(1, 2);
      return await commentAction(options, topic!, body, deps);
    }
    case "body": {
      const [topic, body] = take(1, 2);
      return await bodyAction(options, topic!, body, deps);
    }
    case "title": {
      const [topic, title] = take(2, 2);
      return await titleAction(options, topic!, title!, deps);
    }
    case "link": {
      const [topic, url, label] = take(2, 3);
      return await linkAction(
        { ...options, kind: flags.kind },
        topic!,
        url!,
        label,
        deps,
      );
    }
    case "mention":
    case "unmention": {
      const [topic, other] = take(2, 2);
      return await mentionAction(options, command, topic!, other!, deps);
    }
  }
}

/** Reports `error` as what the command failed with, giving the exit status. */
function failure(error: unknown): number {
  console.error(messageOf(error));
  return 1;
}

// The process ends when the command does: a session `watch` was still opening
// when it quit is not waited for.
if (import.meta.main) Deno.exit(await main(Deno.args).then(() => 0, failure));
