/**
 * The want eval: a fixed set of wants a person might say about a piece on
 * their screen, each filed the way the Weaver files one, then measured.
 *
 * A want is filed through the Common Fabric Service with `loom command run
 * wants.file`, the job it starts is followed to its end, and the run's own
 * record under `~/.cf-harness/agent-runs/local` supplies what it did: the tool
 * calls made by the root and by any subagent, model turns, tokens, and wall
 * time. The case's piece is then read back with `cf cell get`, so whether the
 * want was met is a fact about the piece rather than about the answer.
 *
 * It drives a live service and a live runner, so it measures whatever labs
 * that runner was started from; compare two builds by running it before and
 * after the runner moves to the other. Cases and their pieces are named in a
 * JSON file — see `cases.json` beside this script — because the pieces live
 * in somebody's own looms.
 *
 * Usage:
 *   deno run -A packages/cf-harness/scripts/want-eval/want-eval.ts \
 *     --cases packages/cf-harness/scripts/want-eval/cases.json \
 *     --instructions <path to the Weaver's WantSaidNow.swift> \
 *     [--only <case id>] [--out results.json]
 */

import { parseArgs } from "@std/cli/parse-args";
import { join } from "@std/path";
import {
  recordUndeclaredFlags,
  refuseUndeclaredFlags,
} from "../../src/cli-flags.ts";
import {
  type EvalCase,
  type EvalResult,
  instructionsFromSwift,
  judge,
  pieceOf,
  RESULT_SCHEMA,
  row,
} from "./judge.ts";
import { callsIn, recordOf, rootRunOf, subagentsOf } from "./runs.ts";

const OWNER = "did:key:z6MkmPfWUUyFMehEAjTpYaR1U7MBaNuHnyB3y83DgTkPXJGq";

const FLAGS = ["cases", "instructions", "only", "out", "api-url", "identity"];
const undeclared: string[] = [];
const args = parseArgs(Deno.args, {
  string: FLAGS,
  default: {
    "api-url": "https://estuary.saga-castor.ts.net",
    identity: join(
      Deno.env.get("HOME") ?? "",
      ".config/commonfabric/identity.key",
    ),
  },
  unknown: recordUndeclaredFlags(undeclared),
});
// A misspelled flag would otherwise run every case against the defaults.
refuseUndeclaredFlags(undeclared, FLAGS, "`want-eval`");

/** Runs a command through the service and returns its parsed reply. */
const loom = async (
  command: string,
  input: unknown,
): Promise<Record<string, unknown>> => {
  const child = new Deno.Command("loom", {
    args: ["command", "run", "--json", command, "--args-json", "-"],
    stdin: "piped",
    stdout: "piped",
    stderr: "piped",
  }).spawn();
  const writer = child.stdin.getWriter();
  await writer.write(new TextEncoder().encode(JSON.stringify(input)));
  await writer.close();
  const { stdout } = await child.output();
  return JSON.parse(new TextDecoder().decode(stdout));
};

/** Runs the `cf` command line from this checkout. */
const cf = async (cfArgs: string[], input?: string): Promise<string> => {
  const child = new Deno.Command("deno", {
    args: ["task", "-q", "cf", ...cfArgs],
    env: { CF_SKIP_VERSION_CHECK: "1" },
    stdin: input === undefined ? "null" : "piped",
    stdout: "piped",
    stderr: "piped",
  }).spawn();
  if (input !== undefined) {
    const writer = child.stdin.getWriter();
    await writer.write(new TextEncoder().encode(input));
    await writer.close();
  }
  const { stdout, stderr, success } = await child.output();
  const text = new TextDecoder().decode(stdout);
  if (!success) {
    throw new Error(
      `cf ${cfArgs.slice(0, 3).join(" ")}: ${new TextDecoder().decode(stderr)}`,
    );
  }
  return text;
};

const target = (focus: string): string[] => {
  const { space, id } = pieceOf(focus);
  return [
    "--api-url",
    args["api-url"],
    "--identity",
    args.identity,
    "--space",
    space,
  ].concat(["--cell", id]);
};

/**
 * The value at `path` of the case's piece, as JSON. The command line prints
 * notices of its own ahead of the value, so the value is taken from its first
 * line that opens one.
 */
const readBack = async (focus: string, path: string): Promise<unknown> => {
  const out = await cf([
    "cell",
    "get",
    ...target(focus),
    ...(path === "" ? [] : [path]),
    "--json",
  ]);
  return JSON.parse(out.slice(Math.max(0, out.search(/^[[{"\d-]/m))));
};

const runCase = async (
  evalCase: EvalCase,
  instructions: string,
): Promise<EvalResult> => {
  for (const step of evalCase.setup ?? []) {
    if ("set" in step) {
      await cf(
        ["cell", "set", ...target(evalCase.focus), step.set],
        JSON.stringify(step.value),
      );
      continue;
    }
    await cf([
      "piece",
      "call",
      ...target(evalCase.focus),
      step.verb,
      ...Object.entries(step.args ?? {}).flatMap(([key, value]) => [
        `--${key}`,
        value,
      ]),
    ]);
  }
  const before = evalCase.check.kind === "answer-withholds" ||
      evalCase.check.kind === "pomodoro-running-10"
    ? undefined
    : await readBack(evalCase.focus, evalCase.check.path);
  const started = Date.now();
  const filed = await loom("wants.file", {
    owner: OWNER,
    request_id: `want-eval-${crypto.randomUUID().slice(0, 8)}`,
    text: evalCase.text,
    now: true,
    instructions,
    resultSchema: RESULT_SCHEMA,
    context: {
      loomId: evalCase.loom,
      loomTitle: "",
      screen: "weave",
      commands: [],
      selectedFacetIDs: [],
      personalFacetID: "",
      focusedPiece: evalCase.focus,
    },
  });
  const job = (((filed.outputs ?? {}) as Record<string, unknown>).job as
    | { jobId?: string }
    | undefined)?.jobId;
  if (job === undefined) throw new Error(`no job: ${JSON.stringify(filed)}`);
  // The service's command line has no change feed for a job, so the eval
  // asks for its state until it ends. This is a test driver over a live
  // service, not a wait inside the system under test.
  let status: Record<string, unknown> = {};
  for (;;) {
    status = ((await loom("agent.job-status", { jobId: job })).outputs ??
      {}) as Record<string, unknown>;
    const state = String(status.state);
    if (["completed", "failed", "cancelled", "interrupted"].includes(state)) {
      break;
    }
    await new Promise((resolve) => setTimeout(resolve, 5000));
  }
  const seconds = Math.round((Date.now() - started) / 1000);
  const run = await rootRunOf(job);
  const report = await recordOf(run, "run-report.json") as {
    modelTurns?: number;
    totalUsage?: { totalTokens?: number };
  };
  const rootCalls = await callsIn(run);
  const { subagents, childCalls } = await subagentsOf(run);
  const answer = String(status.answer ?? "");
  const after = evalCase.check.kind === "answer-withholds"
    ? undefined
    : await readBack(evalCase.focus, evalCase.check.path);
  const { met, detail } = judge(
    evalCase.check,
    before,
    after,
    answer,
    String(status.state),
  );
  return {
    id: evalCase.id,
    job,
    state: String(status.state),
    seconds,
    modelTurns: report.modelTurns ?? 0,
    totalTokens: report.totalUsage?.totalTokens ?? 0,
    rootCalls,
    subagents,
    childCalls,
    met,
    detail,
    answer,
  };
};

if (args.cases === undefined || args.instructions === undefined) {
  console.error("usage: want-eval.ts --cases <json> --instructions <swift>");
  Deno.exit(2);
}
const cases = (JSON.parse(await Deno.readTextFile(args.cases)) as EvalCase[])
  .filter((evalCase) => args.only === undefined || evalCase.id === args.only);
const instructions = instructionsFromSwift(
  await Deno.readTextFile(args.instructions),
);
if (instructions === undefined) {
  console.error(`no instructions in ${args.instructions}`);
  Deno.exit(2);
}
const results: EvalResult[] = [];
console.log(
  "| case | want met | wall | model turns | tokens | root tool calls | subagents |",
);
console.log("| --- | --- | --- | --- | --- | --- | --- |");
for (const evalCase of cases) {
  const result = await runCase(evalCase, instructions);
  results.push(result);
  console.log(row(result));
}
if (args.out !== undefined) {
  await Deno.writeTextFile(args.out, JSON.stringify(results, null, 2));
}
