/**
 * The command-line client for a feedback reports board, run as
 * `deno task feedback-reports` from a labs checkout. `send` writes one report
 * from a JSON request on stdin and answers in JSON on stdout, for a person's
 * service to call. `triage` files a templated Topic on the team's Topics board
 * for each new report from a trusted sender. `README.md` in the directory
 * above says what the board holds and how triage decides.
 *
 * Reads and writes go through the Topics client's machinery: the same local
 * copy, read over a memory session of its own, and the same `cf piece call`
 * invocations, each announced before it dispatches and settled by naming its
 * id again.
 */

import { parseArgs } from "@std/cli/parse-args";
import { fromFileUrl } from "@std/path/from-file-url";
import { join } from "@std/path/join";
import { resolve } from "@std/path/resolve";
import { debugStr } from "@commonfabric/data-model";
import { describeFailure } from "@commonfabric/js-values/describe-failure";
import { isObjectNotArray } from "@commonfabric/js-values/types";

import {
  type Board,
  bodyAction,
  commentAction,
  invoke,
  newAction,
  readTopic,
  runProgram,
  stdinText,
  type TopicsDeps,
  type TopicsOptions,
  UnconfirmedWrite,
  UnsettledWrite,
} from "../../topics/tools/topics.ts";
import {
  boardFile,
  loadMirror,
  openDocSource,
  type OpenedDocSource,
  saveMirror,
} from "../../topics/tools/sync.ts";
import { readReports, type Report } from "./read.ts";
import { checked, REPORT_ID, TOPIC_ADDRESS } from "../fields.ts";
import {
  INVALID,
  listed,
  parseTrusted,
  type Plan,
  planTriage,
  withSection,
} from "./triage.ts";

/** The checkout's `cf` launcher, which writes run. */
const LAUNCHER = fromFileUrl(
  new URL("../../../../runtime/cli/launcher.ts", import.meta.url),
);

/** The options a command takes, from its flags and environment. */
export interface ReportsOptions {
  identity?: string;
  agentName?: string;
  invocation?: string;

  /** The file listing trusted senders, for `triage`. */
  trusted?: string;

  /** The file listing who may link a report to a Topic, for `triage`. */
  triagers?: string;
  dryRun?: boolean;
}

/** The effects the client has, injectable so the commands run in a test. */
export interface ReportsDeps {
  openDocSource: (board: Board) => Promise<OpenedDocSource>;
  launcher: string;
  run: typeof runProgram;
  stdin: Pick<typeof Deno.stdin, "isTerminal" | "readable">;
  write: (text: string) => void;
  warn: (text: string) => void;
  env: (name: string) => string | undefined;

  /** What the Topics client runs with, which `triage` files Topics through.
   * Unset, it runs with its own. */
  topics?: TopicsDeps;
}

const defaultDeps: ReportsDeps = {
  openDocSource,
  launcher: LAUNCHER,
  run: runProgram,
  stdin: Deno.stdin,
  write: console.log,
  warn: console.error,
  env: Deno.env.get,
};

/** A failure `send` answers with a code of its own. */
class SendRefused extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = "SendRefused";
  }
}

/**
 * The board `FEEDBACK_REPORTS_API_URL`, `FEEDBACK_REPORTS_SPACE` and
 * `FEEDBACK_REPORTS_BOARD` name, read as the identity `options` names. There
 * is no default board.
 *
 * @throws SendRefused naming the variables that are not set.
 */
export function boardFrom(
  deps: Pick<ReportsDeps, "env">,
  options: Pick<ReportsOptions, "identity">,
): Board {
  const { env } = deps;
  const names = [
    "FEEDBACK_REPORTS_API_URL",
    "FEEDBACK_REPORTS_SPACE",
    "FEEDBACK_REPORTS_BOARD",
  ];
  const [apiUrl, space, piece] = names.map((name) => env(name)?.trim() ?? "");
  const unset = names.filter((_, index) =>
    [apiUrl, space, piece][index] === ""
  );
  if (unset.length > 0) {
    throw new SendRefused(
      "not-configured",
      `Name the reports board: set ${unset.join(", ")}.`,
    );
  }
  const board = piece.replace(/^\//, "");
  return {
    apiUrl,
    space,
    // As the Topics client does: `deno task` runs this from the checkout's
    // root, and a relative path means the directory the command was typed in.
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

/** The board's reports, from its copy brought up to date first. */
async function readBoard(deps: ReportsDeps, board: Board): Promise<Report[]> {
  const data = await loadMirror(board.mirror);
  const source = await deps.openDocSource(board);
  try {
    const reports = await readReports(data, board.board, source);
    await saveMirror(board.mirror, data);
    return reports;
  } finally {
    await source.close();
  }
}

/** What `send` answers on stdout. */
export type SendAnswer =
  | { ok: true; id: string; name: string }
  | { ok: false; code: string; message: string; invocation?: string };

/**
 * Runs the `send` command: writes the `addReport` request on stdin and
 * answers whether the report reads back on the board.
 */
export async function sendAction(
  options: ReportsOptions,
  deps: ReportsDeps = defaultDeps,
): Promise<SendAnswer> {
  const invocation = options.invocation ??
    `feedback-reports-${crypto.randomUUID()}`;
  try {
    const text = await stdinText(deps.stdin);
    let request: unknown;
    try {
      request = JSON.parse(text ?? "");
    } catch {
      throw new SendRefused(
        "bad-request",
        "Give one JSON addReport request on stdin.",
      );
    }
    if (!isObjectNotArray(request)) {
      throw new SendRefused(
        "bad-request",
        "The request on stdin must be a JSON object.",
      );
    }
    const board = boardFrom(deps, options);
    const id = typeof request.id === "string" ? request.id : "";
    const name = typeof request.name === "string" ? request.name.trim() : "";
    return await invoke(
      deps,
      board,
      { ...options, invocation },
      { target: board.board, verb: "addReport", payload: { ...request } },
      async () => {
        const reports = await readBoard(deps, board);
        if (!reports.some((report) => report.id === id)) {
          throw new UnconfirmedWrite(
            `addReport settled, but no report with id ${id} reads back.`,
          );
        }
        return { ok: true, id, name };
      },
    );
  } catch (error) {
    return refusal(error, invocation);
  }
}

/** The answer `send` gives for `error`, a write as `invocation`. */
function refusal(error: unknown, invocation: string): SendAnswer {
  if (error instanceof SendRefused) {
    return { ok: false, code: error.code, message: error.message };
  }
  const message = describeFailure(error);
  // The board refuses a report as `addReport rejected: <code>: <reason>`,
  // which reaches here inside whatever `cf` reported.
  const [, code, reason] =
    /addReport rejected: ([a-z-]+): ([^\n"\\]*)/.exec(message) ?? [];
  if (code !== undefined && reason !== undefined) {
    return { ok: false, code, message: reason };
  }
  if (error instanceof UnsettledWrite) {
    return {
      ok: false,
      code: "unsettled",
      message: `${error.reason} Send again with \`--invocation ` +
        `${invocation}\` to settle it without writing twice.`,
      invocation,
    };
  }
  return {
    ok: false,
    code: error instanceof UnconfirmedWrite ? "unconfirmed" : "failed",
    message,
  };
}

/**
 * The invocation id for a triage write of `kind` over `parts`: the same for
 * the same parts, so a run that stopped part way and is run again settles
 * the write it made rather than making it twice.
 */
export async function triageInvocation(
  kind: string,
  parts: readonly string[],
): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode([kind, ...parts].join("\n")),
  );
  const hex = [...new Uint8Array(digest).slice(0, 16)]
    .map((byte) => byte.toString(16).padStart(2, "0")).join("");
  return `feedback-triage-${kind}-${hex}`;
}

/** The DIDs the file at `path` lists, read from where the command was typed. */
async function didsIn(deps: ReportsDeps, path: string): Promise<Set<string>> {
  return parseTrusted(
    await Deno.readTextFile(resolve(deps.env("INIT_CWD") ?? Deno.cwd(), path)),
  );
}

/** Runs the `triage` command. */
export async function triageAction(
  options: ReportsOptions,
  deps: ReportsDeps = defaultDeps,
): Promise<void> {
  if (options.trusted === undefined) {
    throw new Error("Name the trusted senders with `--trusted <file>`.");
  }
  if (options.triagers === undefined) {
    throw new Error(
      "Name who may link reports to Topics with `--triagers <file>`.",
    );
  }
  const agentName = (options.agentName ?? deps.env("CF_AGENT_NAME"))?.trim();
  if (!agentName) {
    throw new Error(
      "Triage writes as an agent: pass `--agent-name <name>` or set " +
        "`CF_AGENT_NAME`.",
    );
  }
  const trusted = await didsIn(deps, options.trusted);
  const triagers = await didsIn(deps, options.triagers);
  const board = boardFrom(deps, options);
  const plan = planTriage(await readBoard(deps, board), trusted, triagers);
  if (options.dryRun) {
    deps.write(describePlan(plan));
    return;
  }
  const topicOptions: TopicsOptions = {
    agentName,
    ...(options.identity === undefined ? {} : { identity: options.identity }),
  };
  const linked = new Map<string, string>();
  const link = async (id: string, topic: string) => {
    await invoke(
      deps,
      board,
      {},
      {
        target: board.board,
        verb: "linkTopic",
        payload: { agentName, id, topic },
      },
      () => Promise.resolve(),
    );
    linked.set(id, topic);
  };
  // Each problem's reports are linked as soon as its Topic is written, so a
  // run that stops part way leaves what it filed linked; and each Topic is
  // filed as an invocation named by the reports it files, so a run that
  // stopped before linking them settles the Topic it filed when run again.
  for (const filing of plan.file) {
    const topic = await newAction(
      {
        ...topicOptions,
        invocation: await triageInvocation("file", filing.reports.toSorted()),
      },
      filing.title,
      filing.body,
      deps.topics,
    );
    const address = checked(topic.address, TOPIC_ADDRESS);
    if (address === undefined) {
      throw new UnconfirmedWrite(
        "The Topics board answered with a Topic address of another shape.",
      );
    }
    for (const id of filing.reports) await link(id, address);
  }
  for (const update of plan.update) {
    if (update.comment !== undefined) {
      await commentAction(
        {
          ...topicOptions,
          invocation: await triageInvocation("comment", [
            update.topic,
            ...update.reports.toSorted(),
          ]),
        },
        update.topic,
        update.comment,
        deps.topics,
      );
    }
    // Only the marked section is triage's; what people wrote around it stays.
    const { body } = await readTopic(topicOptions, update.topic, deps.topics);
    await bodyAction(
      topicOptions,
      update.topic,
      withSection(body, update.section),
      deps.topics,
    );
    for (const id of update.reports) await link(id, update.topic);
  }
  const after = await readBoard(deps, board);
  const unlinked = [...linked].filter(([id, topic]) =>
    !after.some((report) => report.id === id && report.topic === topic)
  );
  if (unlinked.length > 0) {
    throw new UnconfirmedWrite(
      "linkTopic settled, but these reports do not read back linked: " +
        unlinked.map(([id]) => id).join(", "),
    );
  }
  deps.write(
    `Filed ${plan.file.length} Topics and updated ${plan.update.length}; ` +
      `linked ${linked.size} reports.\n${leftOut(plan)}`,
  );
}

/** What a run left for a person: counts only, never content. */
function leftOut(plan: Plan): string {
  return `${plan.untrusted} new reports from senders not on the trusted ` +
    `list and ${plan.unreadable} whose sender could not be read were left ` +
    `for a person. ${plan.untrustedLinks} links to a Topic were not written ` +
    `by a triager and were ignored. ${plan.invalid} fields failed their ` +
    "checks and show as invalid.";
}

/** `value` when it has `shape`, else {@link INVALID}: what output shows. */
function shown(value: string, shape: RegExp): string {
  return checked(value, shape) ?? INVALID;
}

/** Report ids as output shows them. */
function ids(reports: readonly string[]): string {
  return listed(reports.map((id) => shown(id, REPORT_ID)));
}

/** What a run of `plan` would do, for `--dry-run`. The titles and bodies
 * hold only values that passed their shapes. */
export function describePlan(plan: Plan): string {
  return [
    ...plan.file.map((filing) =>
      `Would file a Topic for ${ids(filing.reports)}:\n` +
      `${filing.title}\n\n${filing.body}\n`
    ),
    ...plan.update.map((update) =>
      `Would update ${shown(update.topic, TOPIC_ADDRESS)} for ` +
      ids(update.reports) +
      (update.comment === undefined
        ? ", replacing its triage section with:\n"
        : `, commenting:\n${update.comment}\n\nand replacing its triage ` +
          "section with:\n") +
      `${update.section}\n`
    ),
    leftOut(plan),
  ].join("\n");
}

export const USAGE = `Usage: deno task -q feedback-reports <command> [options]

Commands:
  send < request.json   Write the addReport request on stdin; answer on
                        stdout with {"ok":true,"id":...,"name":...} or
                        {"ok":false,"code":...,"message":...}.
  triage --trusted <file> --triagers <file> --agent-name <name> [--dry-run]
                        File or update a Topic for each new report from a
                        sender --trusted lists, one DID per line, and link
                        the report to it. Reports from anyone else are only
                        counted, and only links someone --triagers lists
                        wrote count.

Options:
  --identity <path>     The identity key to write as (else CF_IDENTITY).
  --invocation <id>     Settle an earlier \`send\` without writing twice.

The board is FEEDBACK_REPORTS_API_URL, FEEDBACK_REPORTS_SPACE and
FEEDBACK_REPORTS_BOARD; triage files on the Topics board TOPICS_API_URL,
TOPICS_SPACE and TOPICS_BOARD name, the team's by default.`;

/** Runs the command `args` name, and returns the exit status. */
export async function main(
  args: readonly string[],
  deps: ReportsDeps = defaultDeps,
): Promise<number> {
  const flags = parseArgs([...args], {
    string: ["identity", "agent-name", "invocation", "trusted", "triagers"],
    boolean: ["dry-run", "help"],
    alias: { h: "help" },
    unknown: (arg) => {
      if (arg.startsWith("-")) {
        throw new Error(debugStr`Unknown option $quote${arg}; see \`--help\`.`);
      }
      return true;
    },
  });
  const [command, ...operands] = flags._.map(String);
  const options: ReportsOptions = {
    identity: flags.identity,
    agentName: flags["agent-name"],
    invocation: flags.invocation,
    trusted: flags.trusted,
    triagers: flags.triagers,
    dryRun: flags["dry-run"],
  };
  if (flags.help || command === undefined) {
    deps.write(USAGE);
    return command === undefined && !flags.help ? 2 : 0;
  }
  if (operands.length > 0) {
    throw new Error(`\`${command}\` takes no arguments; see \`--help\`.`);
  }
  switch (command) {
    case "send": {
      const answer = await sendAction(options, deps);
      deps.write(JSON.stringify(answer));
      return answer.ok ? 0 : 1;
    }
    case "triage":
      await triageAction(options, deps);
      return 0;
    default:
      throw new Error(
        debugStr`Unknown command $quote${command}; see \`--help\`.`,
      );
  }
}

if (import.meta.main) {
  Deno.exit(
    await main(Deno.args).catch((error) => {
      console.error(describeFailure(error));
      return 1;
    }),
  );
}
