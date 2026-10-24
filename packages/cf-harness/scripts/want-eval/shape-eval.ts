/**
 * The shape eval: the same asks, each run under several shapes a caller can
 * give a job, side by side. A shape is what a job's request may say about how
 * to take the task — today its `depth` — so a case run under each shows what
 * the shape changes: whether the opening research pass ran, the tools called
 * and subagents spawned, the turns, tokens and wall time, and the answer.
 *
 * Each job is submitted to the runner's local job API the way the Common
 * Fabric Service submits a want said now — the `carry` profile, the Weaver's
 * instructions and result schema — but straight to the runner's socket, so a
 * shape the service does not pass yet can be tried. A job's end is read off
 * its own event stream, which the runner closes after the terminal state.
 *
 * It drives a live runner, so it measures whatever labs that runner was
 * started from; compare two builds by running it before and after the runner
 * moves. The answers come from the owner's own data, so `--out` names a
 * directory outside any repository.
 *
 * Usage:
 *   deno run -A packages/cf-harness/scripts/want-eval/shape-eval.ts \
 *     --cases packages/cf-harness/scripts/want-eval/shape-cases.json \
 *     --instructions <path to the Weaver's WantSaidNow.swift> \
 *     --out <directory> [--label baseline] [--variants default,deep] \
 *     [--only <case id>] [--instance-dir <loom instance directory>] \
 *     [--runs-root <the runner's agent-runs/local>]
 *
 * A variant names only what a caller may say about a job's shape: `depth`,
 * `tags` and `domains`. A job that cannot be measured is a row saying why,
 * so one failure does not lose the others.
 */

import { type IncomingMessage, request } from "@node/http";
import { parseArgs } from "@std/cli/parse-args";
import { ensureDir } from "@std/fs";
import { join } from "@std/path";
import {
  recordUndeclaredFlags,
  refuseUndeclaredFlags,
} from "../../src/cli-flags.ts";
import { instructionsFromSwift, RESULT_SCHEMA } from "./judge.ts";
import {
  callsIn,
  defaultRunsRoot,
  recordOf,
  rootRunOf,
  subagentsOf,
} from "./runs.ts";

const FLAGS = [
  "cases",
  "instructions",
  "out",
  "label",
  "variants",
  "only",
  "instance-dir",
  "runs-root",
];
const undeclared: string[] = [];
const args = parseArgs(Deno.args, {
  string: FLAGS,
  default: {
    label: "run",
    "instance-dir": join(
      Deno.env.get("HOME") ?? "",
      ".local/share/loom/instances/loom",
    ),
    "runs-root": defaultRunsRoot(),
  },
  unknown: recordUndeclaredFlags(undeclared),
});
// A misspelled flag would otherwise run every case against the defaults.
refuseUndeclaredFlags(undeclared, FLAGS, "`shape-eval`");

/** One ask, and what a good answer to it looks like, for the reader. */
interface ShapeCase {
  id: string;
  text: string;
  expect: string;
}

/** The cases, and the shapes each is run under, by name. */
interface ShapeSuite {
  variants: Record<string, Record<string, unknown>>;
  cases: ShapeCase[];
}

/** What one case did under one shape. */
interface ShapeResult {
  case: string;
  variant: string;
  job: string;
  state: string;
  errorCode?: string;
  seconds: number;
  tags: string[];
  classificationPath?: string;
  openingResearch?: string;
  modelTurns: number;
  totalTokens: number;
  rootCalls: string[];
  subagents: number;
  childCalls: number;
  answer: string;
  offers: number;
}

const SOCKET = join(args["instance-dir"], "agent-runner", "jobs.sock");

/** One request to the runner's socket; `onEnd` gets the whole body. */
const call = async (
  method: string,
  path: string,
  body?: unknown,
): Promise<{ status: number; text: string }> => {
  const token = (await Deno.readTextFile(`${SOCKET}.token`)).trim();
  return await new Promise((resolve, reject) => {
    const req = request({
      socketPath: SOCKET,
      method,
      path,
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
      },
    }, (response: IncomingMessage) => {
      response.setEncoding("utf8");
      let text = "";
      response.on("data", (chunk: string) => text += chunk);
      response.on("error", reject);
      response.on("end", () => resolve({ status: response.statusCode!, text }));
    });
    req.on("error", reject);
    if (body !== undefined) req.write(JSON.stringify(body));
    req.end();
  });
};

/** A job the runner holds, as its snapshot. */
const jobOf = async (id: string): Promise<Record<string, unknown>> => {
  const { status, text } = await call("GET", `/jobs/${id}`);
  if (status !== 200) throw new Error(`job ${id}: HTTP ${status} ${text}`);
  return JSON.parse(text).job;
};

const submit = async (
  evalCase: ShapeCase,
  variant: string,
  shape: Record<string, unknown>,
  instructions: string,
): Promise<string> => {
  const { status, text } = await call("POST", "/jobs", {
    caller: "dev:shape-eval",
    profile: "carry",
    idempotencyKey: `shape-eval:${args.label}:${crypto.randomUUID()}`,
    task: evalCase.text,
    instructions,
    resultSchema: RESULT_SCHEMA,
    ...shape,
  });
  if (status !== 200 && status !== 201) {
    throw new Error(`${evalCase.id} (${variant}): HTTP ${status} ${text}`);
  }
  return JSON.parse(text).job.id;
};

const measure = async (
  evalCase: ShapeCase,
  variant: string,
  job: string,
  seconds: number,
): Promise<ShapeResult> => {
  const snapshot = await jobOf(job);
  const result = (snapshot.result ?? {}) as {
    answer?: string;
    offers?: unknown[];
  };
  const run = await rootRunOf(job, args["runs-root"]);
  const report = await recordOf(run, "run-report.json") as {
    modelTurns?: number;
    totalUsage?: { totalTokens?: number };
  };
  const state = await recordOf(run, "run-state.json") as {
    taskClassification?: { tags: string[]; path: string };
    openingResearch?: { status: string };
  };
  return {
    case: evalCase.id,
    variant,
    job,
    state: String(snapshot.state),
    ...(typeof snapshot.errorCode === "string"
      ? { errorCode: snapshot.errorCode }
      : {}),
    seconds,
    tags: state.taskClassification?.tags ?? [],
    ...(state.taskClassification !== undefined
      ? { classificationPath: state.taskClassification.path }
      : {}),
    ...(state.openingResearch !== undefined
      ? { openingResearch: state.openingResearch.status }
      : {}),
    modelTurns: report.modelTurns ?? 0,
    totalTokens: report.totalUsage?.totalTokens ?? 0,
    rootCalls: await callsIn(run),
    ...await subagentsOf(run),
    answer: result.answer ?? "",
    offers: result.offers?.length ?? 0,
  };
};

/**
 * A job whose run could not be read, such as one that failed before its run
 * directory existed: a row with its state and why, and nothing measured.
 */
const unmeasured = async (
  evalCase: ShapeCase,
  variant: string,
  job: string,
  seconds: number,
  error: unknown,
): Promise<ShapeResult> => {
  const snapshot = await jobOf(job).catch(
    (): Record<string, unknown> => ({}),
  );
  return {
    case: evalCase.id,
    variant,
    job,
    state: String(snapshot.state ?? "unknown"),
    // The runner's own code says why the job failed; the read error only
    // says why it could not be measured.
    errorCode: [
      ...(typeof snapshot.errorCode === "string" ? [snapshot.errorCode] : []),
      `unmeasured: ${error instanceof Error ? error.message : String(error)}`,
    ].join("; "),
    seconds,
    tags: [],
    modelTurns: 0,
    totalTokens: 0,
    rootCalls: [],
    subagents: 0,
    childCalls: 0,
    answer: "",
    offers: 0,
  };
};

const row = (result: ShapeResult): string =>
  `| ${result.case} | ${result.variant} | ${result.state}${
    result.errorCode !== undefined ? ` (${result.errorCode})` : ""
  } | ${result.tags.join(",")} | ${
    result.openingResearch ?? "-"
  } | ${result.seconds} s | ${result.modelTurns} | ${result.totalTokens} | ${
    result.rootCalls.join(" → ") || "-"
  } | ${result.subagents} (${result.childCalls}) | ${result.offers} |`;

if (
  args.cases === undefined || args.instructions === undefined ||
  args.out === undefined
) {
  console.error(
    "usage: shape-eval.ts --cases <json> --instructions <swift> --out <dir>",
  );
  Deno.exit(2);
}
const suite = JSON.parse(await Deno.readTextFile(args.cases)) as ShapeSuite;
const variants = args.variants === undefined
  ? Object.keys(suite.variants)
  : args.variants.split(",");
/** What a variant may say: the parts of a job's shape a caller can give. */
const SHAPE_KEYS = ["depth", "tags", "domains"];
for (const variant of variants) {
  if (!(variant in suite.variants)) {
    console.error(`no variant ${variant} in ${args.cases}`);
    Deno.exit(2);
  }
  const stray = Object.keys(suite.variants[variant]).filter((key) =>
    !SHAPE_KEYS.includes(key)
  );
  if (stray.length > 0) {
    console.error(
      `variant ${variant} names ${stray.join(", ")}; a variant may name only ${
        SHAPE_KEYS.join(", ")
      }`,
    );
    Deno.exit(2);
  }
}
const cases = suite.cases.filter((evalCase) =>
  args.only === undefined || evalCase.id === args.only
);
if (cases.length === 0) {
  console.error(`no case ${args.only} in ${args.cases}`);
  Deno.exit(2);
}
const instructions = instructionsFromSwift(
  await Deno.readTextFile(args.instructions),
);
if (instructions === undefined) {
  console.error(`no instructions in ${args.instructions}`);
  Deno.exit(2);
}

// Every job is submitted first: the runner queues them and runs as many at
// once as its lane allows, and each is waited on through its own stream.
const runs = await Promise.all(
  cases.flatMap((evalCase) =>
    variants.map(async (variant) => {
      const started = Date.now();
      const job = await submit(
        evalCase,
        variant,
        suite.variants[variant],
        instructions,
      );
      await call("GET", `/jobs/${job}/events?after=0`);
      const seconds = Math.round((Date.now() - started) / 1000);
      try {
        return await measure(evalCase, variant, job, seconds);
      } catch (error) {
        return unmeasured(evalCase, variant, job, seconds, error);
      }
    })
  ),
);

await ensureDir(args.out);
const table = [
  `# Shape eval: ${args.label}`,
  "",
  "| case | shape | state | tags | opening research | wall | turns | tokens | root tool calls | subagents (calls) | offers |",
  "| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |",
  ...runs.map(row),
  "",
  ...cases.flatMap((evalCase) => [
    `## ${evalCase.id}: ${evalCase.text}`,
    "",
    `Expected: ${evalCase.expect}`,
    "",
    ...runs.filter((result) => result.case === evalCase.id).flatMap((
      result,
    ) => [`**${result.variant}:** ${result.answer || "(no answer)"}`, ""]),
  ]),
].join("\n");
await Deno.writeTextFile(
  join(args.out, `${args.label}.json`),
  JSON.stringify(runs, null, 2),
);
await Deno.writeTextFile(join(args.out, `${args.label}.md`), table);
console.log(table);
