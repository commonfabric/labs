import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { dirname } from "@std/path";
import { parse as parseYaml } from "@std/yaml";
import { getBinary } from "@astral/astral";
import { COVERAGE_ARTIFACT } from "@commonfabric/test-support/records";
import { commandWords, withoutComments } from "./ci-workflow.ts";
import { phaseOf } from "./ci-step-phases.ts";
import {
  BINARY_CACHE_DIR,
  cachedBinaries,
  COMPILE_CACHE_FILE,
} from "./ci-capabilities.ts";
import {
  COVERAGE_PROFILE_DIR,
  COVERAGE_REPORT_DIR,
  COVERAGE_REPORT_FILE,
  DEFAULT_COVERAGE_DIR,
  measuredSetOfReport,
} from "./ci-lane.ts";
import { measuredSetDirectory } from "./test-selection/coverage.ts";
import {
  FULL_LANES_MAX,
  FULL_RUN_LABEL,
  LANES,
} from "./test-selection/policy.ts";

function jobBlock(workflow: string, jobId: string): string {
  const jobsStart = workflow.indexOf("jobs:\n");
  assert(jobsStart >= 0, "workflow jobs section not found");

  const header = `  ${jobId}:\n`;
  const start = workflow.indexOf(header, jobsStart);
  assert(start >= 0, `${jobId} job not found`);

  const bodyStart = start + header.length;
  const nextJobOffset = workflow.slice(bodyStart).search(
    /^ {2}[A-Za-z_][A-Za-z0-9_-]*:\n/m,
  );
  const end = nextJobOffset < 0 ? workflow.length : bodyStart + nextJobOffset;
  return workflow.slice(start, end);
}

function jobIds(workflow: string): string[] {
  const jobsStart = workflow.indexOf("jobs:\n");
  assert(jobsStart >= 0, "workflow jobs section not found");
  return [
    ...workflow.slice(jobsStart).matchAll(
      /^ {2}([A-Za-z_][A-Za-z0-9_-]*):\n/gm,
    ),
  ].map((match) => match[1]);
}

function stepBlock(job: string, stepName: string): string {
  const header = `      - name: ${stepName}\n`;
  const start = job.indexOf(header);
  assert(start >= 0, `${stepName} step not found`);

  const bodyStart = start + header.length;
  const nextStepOffset = job.slice(bodyStart).search(/^ {6}- name: /m);
  const end = nextStepOffset < 0 ? job.length : bodyStart + nextStepOffset;
  return job.slice(start, end);
}

function stepBlocks(job: string): { name: string; body: string }[] {
  return job.split(/^ {6}- name: /m).slice(1).map((step) => {
    const nameEnd = step.indexOf("\n");
    return { name: step.slice(0, nameEnd), body: step.slice(nameEnd + 1) };
  });
}

// The minutes each YAML anchor in the workflow stands for, by anchor name.
function anchoredMinutes(contents: string): Map<string, number> {
  return new Map(
    [...contents.matchAll(/^ +[A-Za-z_]+: &([a-z][a-z0-9-]*) (\d+)$/gm)].map((
      match,
    ) => [match[1], Number(match[2])]),
  );
}

// A `timeout-minutes` value is an alias to one of those anchors, so that the
// minutes themselves are written once. A value that is anything else — a number
// written in place, or an expression, whose arithmetic GitHub does not document
// anyway — has no minutes to give back and fails the check that asked.
function boundMinutes(
  anchors: Map<string, number>,
  value: string,
): number | null {
  const alias = value.match(/^\*([a-z][a-z0-9-]*)$/);
  return alias ? anchors.get(alias[1]) ?? null : null;
}

const workflowDirectory = new URL("../.github/workflows/", import.meta.url);

async function workflow(name: string): Promise<string> {
  return await Deno.readTextFile(new URL(name, workflowDirectory));
}

async function workflowNames(): Promise<string[]> {
  const names: string[] = [];
  for await (const entry of Deno.readDir(workflowDirectory)) {
    if (entry.isFile && /\.ya?ml$/.test(entry.name)) names.push(entry.name);
  }
  return names.sort();
}

// Every YAML file under .github, so the composite actions are read alongside
// the workflows that use them.
async function* githubYamlPaths(
  directory: URL = new URL("../.github/", import.meta.url),
): AsyncGenerator<URL> {
  for await (const entry of Deno.readDir(directory)) {
    const path = new URL(
      `${entry.name}${entry.isDirectory ? "/" : ""}`,
      directory,
    );
    if (entry.isDirectory) yield* githubYamlPaths(path);
    else if (/\.ya?ml$/.test(entry.name)) yield path;
  }
}

function stepNames(contents: string): string[] {
  return [...contents.matchAll(/^ *- name: (.+)$/gm)].map((match) => match[1]);
}

function deployInvocations(contents: string): string[] {
  return [...contents.matchAll(/^ +script: (\/opt\/cf\/deploy\.sh.*)$/gm)].map(
    (match) => match[1],
  );
}

function workflowTriggers(contents: string): string {
  const triggerEnd = contents.indexOf("\npermissions:");
  if (triggerEnd >= 0) return contents.slice(0, triggerEnd);

  const concurrencyStart = contents.indexOf("\nconcurrency:");
  assert(concurrencyStart >= 0, "workflow trigger section not found");
  return contents.slice(0, concurrencyStart);
}

Deno.test("every workflow and composite action is valid YAML", async () => {
  // Every other check in this file reads the workflow files as TEXT (regex over
  // job and step blocks), so none of them can notice that a file has stopped
  // being valid YAML — and a workflow that does not parse produces ZERO jobs on
  // every push while every text-level check here stays green. Parsing is what
  // catches that, and an unquoted `default: ` inside a step name is enough to
  // turn a workflow into a nested mapping the runner refuses.

  const broken: string[] = [];
  for await (const path of githubYamlPaths()) {
    const contents = await Deno.readTextFile(path);
    try {
      parseYaml(contents);
    } catch (error) {
      broken.push(
        `${path.pathname.split("/.github/")[1]}: ${
          String(error).split("\n")[0]
        }`,
      );
    }
  }
  assertEquals(
    broken,
    [],
    "these files under .github do not parse as YAML — the runner will " +
      "schedule NO jobs from them, and every text-level check in this file " +
      "stays green while it does",
  );
});

Deno.test("CI browser tests use the runner's installed Chrome", async () => {
  const contents = await workflow("deno.yml");
  const configuredPath = contents.match(
    /^ {2}ASTRAL_BIN_PATH: (\S+)$/m,
  )?.[1];
  const cache = await Deno.makeTempDir();
  const savedPath = Deno.env.get("ASTRAL_BIN_PATH");
  const savedCi = Deno.env.get("CI");
  const savedFetch = globalThis.fetch;

  try {
    assertEquals(configuredPath, "/usr/bin/google-chrome");
    Deno.env.set("CI", "1");
    Deno.env.delete("ASTRAL_BIN_PATH");
    if (configuredPath) Deno.env.set("ASTRAL_BIN_PATH", Deno.execPath());
    globalThis.fetch = (input) => {
      const url = String(input);
      if (url.endsWith("known-good-versions-with-downloads.json")) {
        return Promise.resolve(Response.json({
          versions: [{
            version: "125.0.6400.0",
            downloads: {
              chrome: [
                "linux64",
                "mac-arm64",
                "mac-x64",
                "win64",
              ].map((platform) => ({
                platform,
                url: "https://example.invalid/truncated.zip",
              })),
            },
          }],
        }));
      }
      const truncatedArchive = new Uint8Array(22);
      truncatedArchive.set([0x50, 0x4b, 0x03, 0x04]);
      return Promise.resolve(new Response(truncatedArchive));
    };

    assertEquals(
      await getBinary("chrome", { cache }),
      Deno.execPath(),
    );
  } finally {
    globalThis.fetch = savedFetch;
    if (savedPath === undefined) Deno.env.delete("ASTRAL_BIN_PATH");
    else Deno.env.set("ASTRAL_BIN_PATH", savedPath);
    if (savedCi === undefined) Deno.env.delete("CI");
    else Deno.env.set("CI", savedCi);
    await Deno.remove(cache, { recursive: true });
  }
});

Deno.test("the first CI wave leaves runner capacity for another run", async () => {
  const ci = await parsedWorkflow("deno.yml");
  const githubParallelRunnerLimit = 60;
  // A job without dependencies starts at once, as many times as its matrix
  // has entries. The full run's matrix waits for the job counting it.
  const firstWaveRunnerCount = Object.values(ci.jobs)
    .filter((job) => needsOf(job).length === 0)
    .reduce((count, job) => {
      const lanes = job.strategy?.matrix?.lane;
      return count + (Array.isArray(lanes) ? lanes.length : 1);
    }, 0);

  assert(
    firstWaveRunnerCount < githubParallelRunnerLimit / 2,
    `the dependency-free wave expands to ${firstWaveRunnerCount} jobs; ` +
      `two overlapping runs must fit within GitHub's ` +
      `${githubParallelRunnerLimit}-runner limit`,
  );
  // The full run's lanes are held to the same limit by the cap on them.
  assert(FULL_LANES_MAX <= githubParallelRunnerLimit / 2);
});

Deno.test("every step we name carries a phase marker", async () => {
  // A step whose name starts with no marker in `PHASE_MARKERS` is charted as
  // "other", which is how a job's setup time goes missing from the timings
  // people read when deciding what to make faster. The classifier reads the
  // marker rather than the wording, so the check is the classifier itself.

  const unmarked: string[] = [];
  let steps = 0;
  for await (const path of githubYamlPaths()) {
    for (const name of stepNames(await Deno.readTextFile(path))) {
      steps++;
      if (phaseOf(name) !== "other") continue;
      unmarked.push(`${path.pathname.split("/.github/")[1]}: ${name}`);
    }
  }

  assert(steps > 100, `only ${steps} steps found; the search read nothing`);
  assertEquals(
    unmarked,
    [],
    "these steps start with no marker from docs/development/CI_PERFORMANCE.md",
  );
});

Deno.test("every work step is bounded before its job is", async () => {
  // GitHub ends a job that runs past the job's own `timeout-minutes` by
  // cancelling it, so the job's conclusion is `cancelled` — the same conclusion
  // a run stopped by hand or superseded by a newer push carries, and one that
  // reads as nobody's fault. A step that runs past the step's own bound fails
  // instead, and its job fails with it. Each work step therefore carries a
  // bound of its own, below the bound on the job by the headroom the setup and
  // upload steps around it normally need. Both bounds are aliases to an anchor,
  // so each is a name here rather than a number, and the minutes behind the
  // names are written once.

  const headroom = 10;
  const contents = await workflow("deno.yml");
  const anchors = anchoredMinutes(contents);
  // Every bound is written as an alias, which the text shows and the parsed
  // workflow, having resolved it, does not.
  for (const bound of contents.matchAll(/^ +timeout-minutes: (.+)$/gm)) {
    assert(
      boundMinutes(anchors, bound[1]!) !== null,
      `timeout-minutes ${bound[1]} is not an anchored bound`,
    );
  }

  // The deploy jobs hand the work to a script that lives elsewhere — one on the
  // bastion, one in Cloud Storage — and how long that takes is not this
  // workflow's to say. They carry no bound, so none is asked of them here.
  const unboundedJobs = new Set(["deploy-rapids", "deploy-shell-staging"]);
  const ci = await parsedWorkflow("deno.yml");
  for (const [jobId, job] of Object.entries(ci.jobs)) {
    if (unboundedJobs.has(jobId)) continue;
    const jobBound = job["timeout-minutes"];
    assert(
      typeof jobBound === "number",
      `${jobId}: job has no timeout-minutes`,
    );

    const work = (job.steps ?? []).filter((step) =>
      step.name !== undefined && phaseOf(step.name) === "work"
    );
    // Every job here does work of its own, so an empty list means the steps
    // went unread rather than that this job had none to bound.
    assert(work.length > 0, `${jobId}: no work step found`);

    for (const step of work) {
      const stepBound = step["timeout-minutes"];
      assert(
        typeof stepBound === "number",
        `${jobId}: "${step.name}" has no timeout-minutes`,
      );
      assert(
        jobBound - stepBound >= headroom,
        `${jobId}: "${step.name}" is bounded at ${stepBound} minutes within a ` +
          `job bounded at ${jobBound}, leaving under ${headroom} minutes ` +
          `between that step bound and the outer job bound`,
      );
    }
  }
});

Deno.test("Pull Request Comments follows the CI workflow by name", async () => {
  const deno = await workflow("deno.yml");
  const comment = await workflow("pull-request-comments.yml");
  const name = deno.match(/^name: (.+)$/m);
  assert(name, "workflow name not found");

  assertStringIncludes(comment, `    workflows: ["${name[1]}"]\n`);
});

// A workflow_run payload describes the run it names, not the run that
// triggered it, so only a first-level follower of the test workflow can
// read a run's own event, branch and head. A follower of a follower gets
// the default branch and its tip whatever the triggering run was.
Deno.test("each comment job selects runs by the triggering run's own facts", async () => {
  const comment = await workflow("pull-request-comments.yml");
  assertStringIncludes(
    comment,
    "github.event.workflow_run.event == 'pull_request' &&",
  );
  assertStringIncludes(
    comment,
    "github.event.workflow_run.event == 'push' &&",
  );
  assertStringIncludes(
    comment,
    "github.event.workflow_run.head_branch == 'main' &&",
  );
});

// The run report reads the tree of the commit it reports on, so that the
// topology it packs is the pull request's tree as it landed and the diff
// it reads is the change itself. That commit is on the default branch,
// which is what makes it safe to run in a job holding a write token; a
// pull request head in the same job would be running fork-authored code
// with permission to comment as the repository.
Deno.test("the run report checks out the commit it reports on", async () => {
  const comment = await workflow("pull-request-comments.yml");
  assertStringIncludes(
    comment,
    "ref: ${{ github.event.workflow_run.head_sha }}",
  );
  assertStringIncludes(comment, "fetch-depth: 2");
});

//
// The workflow as GitHub reads it
//
// The lanes' steps are written once, under a YAML anchor, and the two lane
// jobs alias them. A reader of the text sees them in one job only, so the
// checks about the lanes read the parsed workflow, where every job holds its
// own steps.
//

interface Step {
  name?: string;
  id?: string;
  if?: string;
  uses?: string;
  run?: string;
  env?: Record<string, string>;
  with?: Record<string, string | boolean | number>;
  "timeout-minutes"?: unknown;
}

interface Job {
  name?: string;
  if?: string;
  needs?: string | string[];
  uses?: string;
  with?: Record<string, string>;
  secrets?: unknown;
  environment?: string;
  "timeout-minutes"?: unknown;
  permissions?: Record<string, string>;
  env?: Record<string, string>;
  outputs?: Record<string, string>;
  strategy?: { "fail-fast"?: boolean; matrix?: Record<string, unknown> };
  steps?: Step[];
}

interface Workflow {
  name: string;
  on: Record<string, unknown>;
  env?: Record<string, string | number>;
  jobs: Record<string, Job>;
}

async function parsedWorkflow(name: string): Promise<Workflow> {
  return parseYaml(await workflow(name)) as Workflow;
}

function needsOf(job: Job): string[] {
  return job.needs === undefined
    ? []
    : typeof job.needs === "string"
    ? [job.needs]
    : job.needs;
}

function namedStep(job: Job, name: string): Step {
  const step = job.steps?.find((step) => step.name === name);
  assert(step, `${name} step not found`);
  return step;
}

/** The jobs that lay out a pull request's lanes or the full run's. */
const LANE_JOBS = ["tests"] as const;

/**
 * What one run of a step's script did: its exit code, what it wrote to
 * `GITHUB_OUTPUT`, and what it wrote to its standard output and error.
 */
interface StepRun {
  code: number;
  output: string;
  stdout: string;
  stderr: string;
}

/**
 * Runs a step's script the way GitHub runs one with no `shell` of its own,
 * `bash -e`, with the named commands replaced by stand-ins written as shell
 * scripts. Expressions are replaced by `x`, and `GITHUB_OUTPUT` names a file
 * whose contents come back.
 */
async function runStep(
  run: string,
  env: Record<string, string>,
  standIns: Record<string, string> = {},
): Promise<StepRun> {
  const dir = await Deno.makeTempDir({ prefix: "ci-workflow-step-" });
  try {
    for (const [command, body] of Object.entries(standIns)) {
      await Deno.writeTextFile(`${dir}/${command}`, `#!/bin/sh\n${body}\n`, {
        mode: 0o755,
      });
    }
    await Deno.writeTextFile(
      `${dir}/step.sh`,
      run.replaceAll(/\$\{\{.*?\}\}/g, "x"),
    );
    await Deno.writeTextFile(`${dir}/output`, "");
    const { code, stdout, stderr } = await new Deno.Command("bash", {
      args: ["-e", "step.sh"],
      cwd: dir,
      env: {
        PATH: `${dir}:${Deno.env.get("PATH")}`,
        GITHUB_OUTPUT: `${dir}/output`,
        GITHUB_STEP_SUMMARY: `${dir}/summary`,
        ...env,
      },
    }).output();
    return {
      code,
      output: await Deno.readTextFile(`${dir}/output`),
      stdout: new TextDecoder().decode(stdout),
      stderr: new TextDecoder().decode(stderr),
    };
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
}

/** `message`, followed by what the script of `run` wrote to stderr. */
function withStderr(message: string, run: StepRun): string {
  return `${message}; the script's stderr:\n${run.stderr}`;
}

/** Asserts that the script of `run` exited with `code`. */
function assertStepCode(run: StepRun, code: number, what: string): void {
  assertEquals(run.code, code, withStderr(what, run));
}

/** Asserts that the script of `run` failed. */
function assertStepFailed(run: StepRun, what: string): void {
  assert(run.code !== 0, withStderr(what, run));
}

Deno.test("the lanes run every test when the full run is planned, and a selection otherwise", async () => {
  // A pull request runs its lanes over a selection, and anything else,
  // including a pull request carrying the full-run label, runs every test.
  // `plan-full` is the one place that decides which: the lanes read its
  // outputs, and fall back to a pull request's lanes where it was skipped.
  const ci = await parsedWorkflow("deno.yml");
  const plan = ci.jobs["plan-full"];
  const tests = ci.jobs.tests;
  assertEquals(
    plan.if,
    "github.event_name != 'pull_request' || " +
      `contains(github.event.pull_request.labels.*.name, '${FULL_RUN_LABEL}')`,
  );
  assertEquals(plan.outputs, {
    of: "${{ steps.count.outputs.of }}",
    lanes: "${{ steps.count.outputs.lanes }}",
    args: "--full",
  });
  assertEquals(needsOf(tests), ["plan-full"]);
  // A skipped plan is how a pull request's lanes start at once; a failed or
  // cancelled one is a run that cannot know its lanes.
  assertEquals(
    tests.if,
    "!cancelled() && (needs.plan-full.result == 'success' || " +
      "needs.plan-full.result == 'skipped')",
  );

  // A pull request's lane count is the dial, written where the plan is
  // skipped, and this holds it to the dial.
  const selected = Array.from({ length: LANES }, (_, index) => index + 1);
  const of = `\${{ needs.plan-full.outputs.of || ${LANES} }}`;
  assertEquals(
    tests.strategy?.matrix?.lane,
    `\${{ fromJSON(needs.plan-full.outputs.lanes || '[${
      selected.join(", ")
    }]') }}`,
  );
  assertEquals(tests.name, `Tests (\${{ matrix.lane }}/${of})`);
  assertEquals(tests.env?.LANE_JOB, `Tests (\${{ matrix.lane }}/${of})`);
  assertEquals(
    tests.env?.LANE_ARGS,
    `--lane \${{ matrix.lane }} --of ${of} ` +
      "${{ needs.plan-full.outputs.args || " +
      "format('--base origin/{0}', github.base_ref) }}",
  );
});

Deno.test("a lane runs the lane runner and holds the token alone", async () => {
  const ci = await parsedWorkflow("deno.yml");

  for (const id of LANE_JOBS) {
    const job = ci.jobs[id];
    assertEquals(job.strategy?.["fail-fast"], false);
    assertEquals(job.permissions, { contents: "read" });
    // Only the lane step holds the token, which the lane hands on to the
    // suites that declared `github-api` and to nothing else.
    assertEquals(job.env?.GITHUB_TOKEN, undefined);
    const lane = namedStep(job, "🧪 Run the lane");
    assertEquals(lane.env?.GITHUB_TOKEN, "${{ secrets.GITHUB_TOKEN }}");
    for (const step of job.steps ?? []) {
      if (step !== lane) {
        assertEquals(
          step.env?.GITHUB_TOKEN,
          undefined,
          `${step.name} holds the token`,
        );
      }
    }
    // The plan heads a step of its own, ahead of the lane's step, which
    // packs the same plan and only names it.
    const plan = namedStep(job, "🗺️ Plan the lane");
    assertStringIncludes(
      plan.run ?? "",
      "\ndeno run -A tasks/ci-lane.ts $LANE_ARGS --dry-run\n",
    );
    assertStringIncludes(
      lane.run ?? "",
      "\ndeno run -A tasks/ci-lane.ts $LANE_ARGS --described\n",
    );
    const steps = job.steps ?? [];
    assert(steps.indexOf(plan) < steps.indexOf(lane));
    // The diff behind a change is taken against the merge base.
    const checkout = namedStep(job, "📥 Checkout repository");
    assertEquals(checkout.with?.["fetch-depth"], 0);
    assertEquals(checkout.with?.["persist-credentials"], false);
  }
});

Deno.test("the full run's count reaches the lanes as a list of lanes", async () => {
  const plan = (await parsedWorkflow("deno.yml")).jobs["plan-full"];
  const count = namedStep(plan, "🗺️ Count the lanes the full run needs");
  assertStringIncludes(
    count.run ?? "",
    "deno run -A tasks/ci-lane.ts --full --lane-count",
  );

  const answering = (body: string) =>
    runStep(count.run ?? "", {}, {
      deno: body,
    });
  const three = await answering("echo 3");
  assertStepCode(three, 0, "a count of three fails");
  assertEquals(
    three.output,
    "of=3\nlanes=[1,2,3]\n",
    withStderr("a count of three", three),
  );

  // A planner that failed, or that answered with something other than a
  // count, fails the step rather than handing the lanes an empty matrix.
  assertStepFailed(await answering("exit 1"), "a failed count passes");
  assertStepFailed(await answering("echo three"), "a word passes");
});

Deno.test("a lane keeps each binary under an exact key and its compile cache by compiler", async () => {
  // A lane runs a binary it restores without asking what it was built from,
  // so each binary's key names everything it is built from and has no
  // prefix to fall back on. A lane builds only the binaries it needs, so
  // each has an entry of its own: one entry holding both would keep
  // whichever the first lane to save happened to build. A compiled pattern
  // is reused only where its source is unchanged, so the compile cache may
  // fall back to another lane's, as long as the same compiler wrote it, and
  // its key moves with the pattern sources so that a fallback is saved
  // fresh.
  const job = (await parsedWorkflow("deno.yml")).jobs.tests;
  const steps = job.steps ?? [];
  const at = (id: string) => steps.findIndex((step) => step.id === id);
  const cacheOf = (path: string) => {
    const index = steps.findIndex((step) =>
      step.uses?.startsWith("actions/cache@") && step.with?.path === path
    );
    assert(index >= 0, `nothing caches ${path}`);
    return { index, step: steps[index]! };
  };

  const names = Object.keys(cachedBinaries());
  assert(names.length > 0, "no cached binary is declared");
  for (const name of names) {
    const binary = cacheOf(`${BINARY_CACHE_DIR}/${name}`);
    assert(
      at("binary-cache-key") >= 0 && at("binary-cache-key") < binary.index,
    );
    assertEquals(
      binary.step.with?.key,
      `lane-binary-${name}-\${{ steps.binary-cache-key.outputs.key }}`,
    );
    assertEquals(binary.step.with?.["restore-keys"], undefined);
  }

  const fingerprint = "${{ steps.compile-cache-key.outputs.fingerprint }}";
  const compile = cacheOf(dirname(COMPILE_CACHE_FILE));
  assert(
    at("compile-cache-key") >= 0 && at("compile-cache-key") < compile.index,
  );
  assert(
    String(compile.step.with?.key).startsWith(`cc-lane-${fingerprint}-`),
    "the compile cache's key does not open with the compiler's fingerprint",
  );
  assertStringIncludes(String(compile.step.with?.key), "hashFiles(");
  assertEquals(
    String(compile.step.with?.["restore-keys"]).trim(),
    `cc-lane-${fingerprint}-`,
  );

  // An empty key would name every build alike, so the step that resolves it
  // fails rather than handing on nothing.
  const resolve = steps[at("binary-cache-key")]!.run ?? "";
  assertStringIncludes(resolve, "tasks/binary-cache-key.ts");
  const resolving = (body: string) => runStep(resolve, {}, { deno: body });
  const found = await resolving("echo abc123");
  assertStepCode(found, 0, "a key fails");
  assertEquals(found.output, "key=abc123\n", withStderr("a key", found));
  assertStepFailed(await resolving("true"), "an empty key passes");
  assertStepFailed(await resolving("exit 1"), "a failed key passes");
});

Deno.test("a lane uploads what Status and a reader of a failure need", async () => {
  const ci = await parsedWorkflow("deno.yml");
  const job = ci.jobs.tests;

  // The whole of what the lane converted, so a marker beside a report and
  // the compile cache's state travel with the reports, and the raw profiles
  // stay behind.
  const coverage = namedStep(job, "📤 Upload the lane's coverage reports");
  const paths = String(coverage.with?.path).trim().split("\n");
  assertEquals(paths, [
    `${DEFAULT_COVERAGE_DIR}/`,
    `!${DEFAULT_COVERAGE_DIR}/${COVERAGE_PROFILE_DIR}/`,
  ]);
  assertEquals(
    coverage.with?.name,
    "lane-coverage-${{ github.job }}-${{ matrix.lane }}",
  );
  // A re-run of a lane replaces its first attempt's reports rather than
  // sitting beside them.
  assertEquals(coverage.with?.overwrite, true);

  // An artifact is rooted at the directory its included paths share, and a
  // download of several artifacts puts each under a directory named for it.
  // A report the lane wrote therefore arrives at the path below, and the
  // readers have to find its set there.
  const included = paths.filter((at) => !at.startsWith("!"));
  assertEquals(included.length, 1);
  const root = included[0]!.replace(/\/$/, "");
  const set = measuredSetDirectory({
    suite: "workspace-unit",
    set: { member: "packages/bakery", reachedBy: [], units: [] },
  });
  const written = [
    DEFAULT_COVERAGE_DIR,
    COVERAGE_REPORT_DIR,
    set,
    COVERAGE_REPORT_FILE,
  ].join("/");
  assert(written.startsWith(`${root}/`), "the report is outside the artifact");
  const status = ci.jobs.status;
  const download = namedStep(status, "📥 Download the lanes' coverage reports");
  assertEquals(download.with?.pattern, "lane-coverage-*");
  assertEquals(download.with?.["merge-multiple"], false);
  const arrived = [
    download.with?.path,
    "lane-coverage-tests-1",
    written.slice(root.length + 1),
  ].join("/");
  assertEquals(measuredSetOfReport(arrived), set);

  // Status reads what the lanes uploaded, from where it downloaded it.
  assertStringIncludes(
    namedStep(status, "🔎 Hold the measured sets to their baselines").run ??
      "",
    `--reports ${download.with?.path}`,
  );
  assertStringIncludes(
    namedStep(status, "📊 Report the run's coverage").run ?? "",
    `tasks/coverage-report.ts --reports ${download.with?.path}`,
  );

  // A failing lane keeps its working directory under the job's temporary
  // directory, which is where this reaches for it, and a process in the lane
  // that crashes natively leaves its core beside it.
  const failure = namedStep(job, "📋 Upload what a failing lane left behind");
  assertEquals(failure.if, "${{ failure() }}");
  assertEquals(failure.with?.path, "${{ runner.temp }}/ci-lane-*");
  const lane = namedStep(job, "🧪 Run the lane").run ?? "";
  assertStringIncludes(lane, "ulimit -c unlimited");
  assertStringIncludes(
    lane,
    'kernel.core_pattern="$RUNNER_TEMP/ci-lane-cores/',
  );

  // The lane gathered every batch's records and marked each with its suite's
  // variant already, so the ship step carries neither of its own.
  const ship = namedStep(job, "📤 Ship test records");
  assertEquals(ship.if, "always()");
  assertEquals(ship.with, {
    artifact: "${{ github.job }}-${{ matrix.lane }}",
    job: "${{ env.LANE_JOB }}",
  });
  for (const id of LANE_JOBS) {
    assertEquals(
      ci.jobs[id].env?.CF_TEST_RECORDS_DIR,
      "${{ github.workspace }}/test-records-spool",
    );
  }
});

Deno.test("Status waits for every job that runs a test", async () => {
  const ci = await parsedWorkflow("deno.yml");
  const status = ci.jobs.status;
  const release = Object.keys(ci.jobs).filter((id) =>
    ci.jobs[id].if ===
      "github.event_name == 'push' && github.ref == 'refs/heads/main'"
  );
  assertEquals(
    needsOf(status).sort(),
    Object.keys(ci.jobs).filter((id) =>
      id !== "status" && !release.includes(id)
    ).sort(),
  );
  assertEquals(status.name, "Status");
  assertEquals(
    status.if,
    "!cancelled() && (github.event_name == 'pull_request' || " +
      "github.event_name == 'push')",
  );
  assertEquals(status.permissions, {
    contents: "read",
    "pull-requests": "read",
  });

  // A path filter would leave the required check pending on a pull request
  // that touches none of the listed paths.
  const triggers = workflowTriggers(await workflow("deno.yml"));
  assertStringIncludes(triggers, "  pull_request:\n");
  assertEquals(triggers.includes("\n    paths:"), false);
  // Adding or removing the full-run label starts a run that reads it.
  const pullRequest = ci.on.pull_request;
  assert(
    typeof pullRequest === "object" && pullRequest !== null &&
      "types" in pullRequest && Array.isArray(pullRequest.types),
    "the pull_request trigger names no types",
  );
  for (const type of ["labeled", "unlabeled", "synchronize", "opened"]) {
    assert(pullRequest.types.includes(type), `a ${type} event starts no run`);
  }
});

Deno.test("nothing is released that the full run has not passed", async () => {
  const ci = await parsedWorkflow("deno.yml");
  for (const id of ["attest-binaries", "deploy-shell-staging"]) {
    assert(
      needsOf(ci.jobs[id]).includes("tests"),
      `${id} does not wait for the full run`,
    );
  }
  assertEquals(needsOf(ci.jobs["deploy-rapids"]), ["attest-binaries"]);
});

Deno.test("Status fails unless every job passed and the lanes ran", async () => {
  const status = (await parsedWorkflow("deno.yml")).jobs.status;
  const verify = namedStep(status, "🔎 Verify the run's jobs");
  assertEquals(verify.if, "always()");
  assertEquals(verify.env?.JOB_RESULTS, "${{ toJSON(needs) }}");
  const verdict = async (
    results: Record<string, string>,
    code: number,
    what: string,
  ) =>
    assertStepCode(
      await runStep(verify.run ?? "", {
        JOB_RESULTS: JSON.stringify(
          Object.fromEntries(
            Object.entries(results).map(([job, result]) => [job, { result }]),
          ),
        ),
      }),
      code,
      what,
    );

  const selected = { "plan-full": "skipped", tests: "success" };
  const full = { "plan-full": "success", tests: "success" };
  await verdict(selected, 0, "a passing selected run fails");
  await verdict(full, 0, "a passing full run fails");

  // A lane that failed, or was cancelled, fails the run.
  await verdict(
    { ...selected, tests: "failure" },
    1,
    "a failed lane passes",
  );
  await verdict(
    { ...full, tests: "cancelled" },
    1,
    "a cancelled lane passes",
  );
  await verdict(
    { ...full, "plan-full": "failure", tests: "skipped" },
    1,
    "a failed plan passes",
  );
  // The lanes skipped, which is a run that tested nothing and would
  // otherwise pass.
  await verdict(
    { "plan-full": "skipped", tests: "skipped" },
    1,
    "a run that tested nothing passes",
  );
});

Deno.test("Status holds a pull request's measured sets to their baselines", async () => {
  const status = (await parsedWorkflow("deno.yml")).jobs.status;
  const gate = namedStep(
    status,
    "🔎 Hold the measured sets to their baselines",
  );
  assertEquals(
    gate.if,
    "${{ !cancelled() && github.event_name == 'pull_request' }}",
  );
  assertEquals(gate.env?.JOB_RESULTS, "${{ toJSON(needs) }}");
  // The gate asks git which baselines' commits the branch holds.
  assertEquals(
    namedStep(status, "📥 Checkout repository").with?.["fetch-depth"],
    0,
  );

  // The description is read as it stands, so an acceptance written after
  // the push counts on a re-run. A run whose tests did not pass measured
  // coverage through the failure, so the gate is told, and reports rather
  // than gates.
  const results = (plan: string, tests: string) =>
    JSON.stringify({
      "plan-full": { result: plan },
      tests: { result: tests },
    });
  const words = async (jobResults: string, gh = "echo '$DESCRIPTION'") =>
    await runStep(gate.run ?? "", {
      BASE_REF: "main",
      GITHUB_REPOSITORY: "commonfabric/labs",
      JOB_RESULTS: jobResults,
      PR_NUMBER: "42",
      DESCRIPTION: "ACCEPT_COVERAGE_DEBT: packages/memory +1 lines",
    }, {
      deno: 'printf "%s\\n" "$@"',
      gh: `[ "$2" = "repos/$GITHUB_REPOSITORY/pulls/$PR_NUMBER" ] || exit 9\n` +
        gh.replace("'$DESCRIPTION'", '"$DESCRIPTION"'),
    });
  const passing = await words(results("skipped", "success"));
  assertStepCode(passing, 0, "a passing run's gate fails");
  assertEquals(passing.stdout.trim().split("\n"), [
    "run",
    "-A",
    "tasks/coverage-gate.ts",
    "--base",
    "origin/main",
    "--reports",
    "lane-coverage",
    "--body",
    "ACCEPT_COVERAGE_DEBT: packages/memory +1 lines",
    "--comment",
    "coverage-comment.json",
    "--pr",
    "42",
  ], withStderr("a passing run's gate", passing));
  const full = await words(results("success", "success"));
  assertEquals(
    full.stdout,
    passing.stdout,
    withStderr("a full run's gate", full),
  );
  const failed = await words(results("skipped", "failure"));
  assertEquals(
    failed.stdout.trim().split("\n"),
    [...passing.stdout.trim().split("\n"), "--tests-failed"],
    withStderr("a failed run's gate", failed),
  );
  // A description that cannot be read fails the step rather than gating
  // against an empty one.
  assertStepFailed(
    await words(results("skipped", "success"), "exit 1"),
    "an unread description passes",
  );

  const comment = namedStep(status, "📤 Upload coverage comment");
  assertEquals(comment.with?.name, "coverage-comment");
  assertEquals(comment.with?.path, "coverage-comment.json");
});

Deno.test("Status records no tests, and ships the run's coverage from a push", async () => {
  const status = (await parsedWorkflow("deno.yml")).jobs.status;

  // It reads what every lane of the run produced, so no lane can be asked to
  // run it, and the criterion in `docs/specs/test-records.md` under
  // "Recording" puts it outside test records: no wrapper, and no JUnit file
  // gathered. What its spool holds is the run's coverage measurements, which
  // it ships under the name readers list the store for, and only from a push,
  // because every reader takes a figure from a push to main alone.
  assert(
    !(status.steps ?? []).some((step) => step.run?.includes("run-recorded")),
    "the job wraps a command in run-recorded",
  );
  assertEquals(
    status.env?.CF_TEST_RECORDS_DIR,
    "${{ github.workspace }}/test-records-spool",
  );
  const ship = namedStep(status, "📤 Ship test records");
  assertEquals(ship.with, { artifact: COVERAGE_ARTIFACT, job: "Status" });
  assertEquals(ship.if, "${{ !cancelled() && github.event_name == 'push' }}");
  assertEquals(
    namedStep(status, "📊 Report the run's coverage").if,
    "${{ !cancelled() && github.event_name == 'push' }}",
  );
});

Deno.test("the store half of the drift guard reads every record artifact", async () => {
  const ci = await parsedWorkflow("deno.yml");
  const status = ci.jobs.status;

  // An identity is claimed by the suite that would run it, so a record
  // artifact this does not see is a surface it cannot hold the topology to.
  // It therefore waits for every job that ships records, and downloads them
  // by the prefix the ship step names them under. A job shipping the run's
  // coverage measurements alone ships no test's record.
  const shippers = Object.keys(ci.jobs).filter((id) =>
    (ci.jobs[id].steps ?? []).some((step) =>
      step.uses === "./.github/actions/test-records-ship" &&
      step.with?.artifact !== COVERAGE_ARTIFACT
    )
  );
  assertEquals(shippers.sort(), [...LANE_JOBS].sort());
  assertEquals(
    shippers.filter((id) => !needsOf(status).includes(id)),
    [],
    "record-shipping jobs the store half does not wait for",
  );
  const download = namedStep(status, "📥 Download the lanes' test records");
  assertEquals(download.with?.pattern, "test-records-*");

  // The records are held to the commit the run checked out, and the
  // directory is named rather than the files under it, so the guard is
  // handed the download itself and fails when it holds nothing.
  const check = namedStep(
    status,
    "🔎 Check the topology against this run's records",
  );
  assertEquals(
    check.run?.trim(),
    'deno task check-test-topology --commit "$GITHUB_SHA" ' +
      `--records ${download.with?.path}`,
  );
  assertEquals(check.if, "${{ !cancelled() }}");
});

Deno.test("no step selects a server-execution arm by literal", async () => {
  // Every assignment of the flag belongs to the lane runner's capabilities,
  // which resolve both roles from one constant, so a flip of the default
  // moves both together and a value pinned by hand cannot turn a flip into a
  // mixed posture. Every assignment form counts — a YAML `env:` entry in
  // either quote style, a shell `NAME=value`, and the shell
  // default-assignment `${NAME:=value}`. Comments are stripped so a note
  // naming a value is not read as setting it.
  const literal = withoutComments(await workflow("deno.yml")).match(
    /EXPERIMENTAL_SERVER_EXECUTION\s*(?::=|[:=])\s*['"]?(?:true|false)\b/,
  );
  assert(
    literal === null,
    `deno.yml selects a server-execution arm by literal: ${literal?.[0]}`,
  );
});

Deno.test("Dashboard publishes only from main, never from a pull request", async () => {
  const deno = await workflow("deno.yml");
  const dashboard = await workflow("dashboard-image.yml");

  assertEquals(deno.includes("dashboard-image.yml"), false);
  assertEquals(jobIds(deno).includes("dashboard"), false);

  assertStringIncludes(dashboard, "name: Dashboard\n");
  const triggers = workflowTriggers(dashboard);
  assertStringIncludes(triggers, "  workflow_dispatch: {}");
  assertStringIncludes(
    triggers,
    "  push:\n    branches: [main]\n    paths:\n",
  );
  assertEquals(triggers.includes("  pull_request:"), false);
  assertEquals(triggers.includes("  workflow_call:"), false);
  assertStringIncludes(
    dashboard,
    "\npermissions:\n  contents: read\n\nconcurrency:\n",
  );
  assertStringIncludes(dashboard, "group: dashboard-${{ github.ref }}");
  assertEquals(jobIds(dashboard).sort(), ["publish", "tests"]);

  // A manual run can name any ref, so the tests job refuses anything but main
  // before the publish job it gates gets a credential. The guard has to fail
  // the run, not just report: a guard that only warns lets a dispatch from any
  // branch move the `latest` tag.
  const tests = jobBlock(dashboard, "tests");
  assertEquals(tests.includes("id-token: write"), false);
  const guard = stepBlock(tests, "🔎 Verify the run is on main");
  assertStringIncludes(guard, "if: ${{ github.ref != 'refs/heads/main' }}");
  assertStringIncludes(guard, "\n          exit 1\n");

  const publish = jobBlock(dashboard, "publish");
  assertStringIncludes(publish, "needs: [tests]");
  assertEquals(publish.includes("\n    if:"), false);
  assertStringIncludes(
    publish,
    "permissions:\n      contents: read\n      id-token: write",
  );

  // Both tags go up in the one push: the immutable commit tag the infra
  // overlay pins, and the `latest` the deployment follows.
  const build = stepBlock(publish, "🏗️ Build and push dashboard image");
  assertStringIncludes(build, "\n          push: true\n");
  assertStringIncludes(
    build,
    "\n          build-args: |\n" +
      "            DASHBOARD_GIT_COMMIT=${{ github.sha }}\n",
  );
  assertStringIncludes(
    build,
    "\n          tags: |\n" +
      "            ${{ env.IMAGE }}:${{ github.sha }}\n" +
      "            ${{ env.IMAGE }}:latest\n",
  );
});

Deno.test("the Dashboard workflow records no tests", async () => {
  const dashboard = withoutComments(await workflow("dashboard-image.yml"));
  const relay = withoutComments(await workflow("test-records-relay.yml"));

  // CI runs `packages/dashboard`'s test task on the same commit and records
  // what it runs. Recording the same task again here would file each of those
  // tests twice against one commit, so this workflow takes no part in test
  // records at either end: it spools nothing, and the relay does not follow
  // it. Reinstating either half alone produces a run whose records are
  // gathered and never shipped.
  assertEquals(dashboard.includes("CF_TEST_RECORDS_DIR"), false);
  assertEquals(dashboard.includes("run-recorded"), false);
  assertEquals(dashboard.includes("test-records-ship"), false);
  const name = dashboard.match(/^name: (.+)$/m);
  assert(name, "the workflow has no name");
  assertEquals(
    workflowTriggers(relay).includes(name[1]),
    false,
    `the relay follows ${name[1]}, whose records nothing gathers`,
  );
});

Deno.test("the CFC Property Suite workflow records no tests", async () => {
  const suite = withoutComments(await workflow("cfc-properties.yml"));
  const relay = withoutComments(await workflow("test-records-relay.yml"));

  // Both of the job's steps fall outside what a record is for, and for the
  // two different reasons `docs/specs/test-records.md` gives under
  // "Recording". The suite step runs `deno test` directly, with no
  // `--junit-path` to ingest and no registration preload, so nothing under
  // it records; a wrapper passes recording through to what it runs, so one
  // here would file a line summarizing the invocation and nothing else.
  // Those tests are units of `workspace-unit` and record when CI runs
  // them. The audit step reads the corpus the step before it wrote, so no
  // lane can be asked to run it. The workflow therefore takes no part in
  // test records at either end: it spools nothing, and the relay does not
  // follow it. Spooling again without the relay produces a run whose
  // records are gathered and never shipped, and the relay assertion is
  // what keeps its follow list honest about which workflows record.
  assert(
    !suite.includes("CF_TEST_RECORDS_DIR"),
    "the workflow spools test records",
  );
  assert(
    !suite.includes("run-recorded"),
    "the workflow wraps a command in run-recorded",
  );
  assert(
    !suite.includes("test-records-ship"),
    "the workflow ships test records",
  );
  const name = suite.match(/^name: (.+)$/m);
  assert(name, "the workflow has no name");
  assertEquals(
    workflowTriggers(relay).includes(name[1]),
    false,
    `the relay follows ${name[1]}, whose records nothing gathers`,
  );

  // Both checks themselves still run.
  const job = jobBlock(suite, "cfc-properties");
  assertStringIncludes(
    job,
    "run: deno test --shuffle=$(deno task -q test-seed) -A " +
      "test/cfc-properties/\n",
  );
  assertStringIncludes(job, "deno task cfc-audit ");
});

Deno.test("One commit publishes one set of release artifacts", async () => {
  // A release artifact is named after the commit it was built from, and the
  // deploy hands the bastion a commit rather than a build. So a commit has one
  // tarball and one checksum for that tarball, and they stay as they were
  // published. Two builds of one commit do not produce the same tarball: the
  // binaries are compiled again, and `tar` records modification times. Publish
  // a second build over a first and a reader can come away holding one build's
  // tarball beside the other build's checksum, which is what the deploy's
  // `sha256sum -c` reports as a failure. docs/development/deploying.md covers
  // the invariant.

  const contents = await workflow("deno.yml");

  // Main can receive the same head commit twice, which starts two runs of that
  // commit. Grouping a push by the commit makes the second run wait for the
  // first, so the two builds never publish at once. Grouping it by anything
  // that differs between runs of one commit, `github.run_id` among them, puts
  // them in separate groups and lets them overlap.
  assertStringIncludes(
    contents,
    "\nconcurrency:\n" +
      "  group: ${{ github.workflow }}-" +
      "${{ github.event.pull_request.number || github.sha }}\n" +
      "  cancel-in-progress: ${{ github.event_name == 'pull_request' }}\n",
  );

  // Waiting alone leaves the second run free to publish over the first once the
  // first has finished, so the publish itself is what holds the bytes still: a
  // commit that already has both objects keeps them. The pair is published
  // together, in the one branch, because publishing just one of them is how a
  // commit ends up with two builds' halves.
  const upload = stepBlock(
    jobBlock(contents, "attest-binaries"),
    "📤 Upload artifacts to Google Cloud Storage",
  );
  const guard =
    'if gsutil -q stat "$BUCKET/$TARBALL" && gsutil -q stat "$BUCKET/$CHECKSUM"; then';
  const guardStart = upload.indexOf(guard);
  assert(
    guardStart >= 0,
    "the published pair is not looked for before it is published",
  );
  const branchStart = upload.indexOf("\n          else\n", guardStart);
  const branchEnd = upload.indexOf("\n          fi\n", branchStart);
  assert(
    branchStart >= 0 && branchEnd > branchStart,
    "publishing branch not found",
  );
  const branch = upload.slice(branchStart, branchEnd);

  for (const object of ["$TARBALL", "$CHECKSUM"]) {
    const copy = `gsutil cp "release/${object}" "$BUCKET/"`;
    assertStringIncludes(branch, copy);
    assertEquals(
      upload.split(copy).length - 1,
      1,
      `${copy} runs somewhere other than the branch that publishes the pair`,
    );
  }
});

Deno.test("a release subject whose attestation does not verify fails the job", async () => {
  // The verification step's script runs here against a stand-in `gh` that
  // lists the subjects it is asked about and fails on the one named by
  // FAIL_SUBJECT, and a stand-in `jq` that prints what it reads.
  const job = jobBlock(await workflow("deno.yml"), "attest-binaries");
  const step = stepBlock(job, "🔎 Verify binary attestations");
  // A step with no `shell` is run by GitHub as `bash -e {0}`.
  assert(!/^ {8}shell:/m.test(step), "the step names its own shell");
  const run = step.indexOf("\n        run: |\n");
  assert(run >= 0, "the step's script not found");
  const script = step.slice(run + "\n        run: |\n".length)
    .split("\n").map((line) => line.slice(10)).join("\n")
    .replaceAll(/\$\{\{.*?\}\}/g, "x");
  // Each subject is attested under a name ending in the file name it is
  // verified by.
  const baseName = (path: string) =>
    path.replaceAll(/\$\{\{.*?\}\}/g, "x").split("/").at(-1);
  const attested = [...job.matchAll(/^ {10}subject-name: (.+)$/gm)]
    .map((match) => baseName(match[1])).sort();

  const subjectsFile = await Deno.makeTempFile();
  try {
    const verify = async (failing: string) => {
      await Deno.writeTextFile(subjectsFile, "");
      const run = await runStep(
        script,
        { FAIL_SUBJECT: failing, SUBJECTS: subjectsFile },
        {
          gh: 'echo "$3" >> "$SUBJECTS"\n' +
            '[ "$3" = "$FAIL_SUBJECT" ] && { echo "no attestation" >&2; exit 1; }\n' +
            "echo '{\"verified\":true}'",
          jq: "exec cat",
        },
      );
      const subjects = (await Deno.readTextFile(subjectsFile)).split("\n")
        .filter(Boolean);
      return { ...run, subjects };
    };

    const passing = await verify("");
    assertStepCode(passing, 0, "verifying every subject fails");
    assertEquals(
      passing.subjects.map(baseName).sort(),
      attested,
      withStderr("the verified subjects", passing),
    );
    assertEquals(
      passing.stdout.match(
        /^::group::.*\n\{"verified":true\}\n::endgroup::$/gm,
      )?.length,
      attested.length,
      "each subject's details are not printed inside a log group",
    );
    for (const subject of passing.subjects) {
      assertStepFailed(
        await verify(subject),
        `a failed verification of ${subject} passes the step`,
      );
    }
  } finally {
    await Deno.remove(subjectsFile);
  }
});

Deno.test("Deploy steps call the bastion wrapper the way it accepts", async () => {
  // The bastion's /opt/cf/deploy.sh takes an environment name and a
  // 40-character commit SHA, and nothing else. Hand it a third argument, an
  // environment it does not know, or a revision that is not a full SHA, and it
  // prints its usage and exits 1, failing the deploy job. That script belongs
  // to the infra repository, so nothing else here sees it and the call sites
  // are checked instead. docs/development/deploying.md covers the seam.

  const environments = ["estuary", "rapids"];
  // The revision has to expand to a full SHA, which is a property of what the
  // expression reads rather than of the expression itself. `github.ref_name`
  // would look just as much like a revision here and fail on the bastion, so
  // the expressions whose value is a full SHA are named.
  const revisions = ["${{ github.sha }}", "${{ steps.resolve.outputs.sha }}"];

  const callers: string[] = [];
  for (const name of await workflowNames()) {
    const contents = withoutComments(await workflow(name));
    const mentions = [...contents.matchAll(/\/opt\/cf\/deploy\.sh/g)].length;
    if (mentions === 0) continue;
    callers.push(name);

    // Invocations are found by their one-line `script:` value. Counting the
    // mentions of the script separately catches a call site written some other
    // way, which would otherwise go unchecked.
    const invocations = deployInvocations(contents);
    assertEquals(
      invocations.length,
      mentions,
      `${name}: every deploy.sh call belongs on a single script: line`,
    );

    for (const invocation of invocations) {
      const args = commandWords(invocation).slice(1);
      assertEquals(args.length, 2, `${name}: wrong arity in \`${invocation}\``);
      assert(
        args[0].startsWith("${{") || environments.includes(args[0]),
        `${name}: unknown environment in \`${invocation}\``,
      );
      assert(
        revisions.includes(args[1]),
        `${name}: \`${args[1]}\` is not known to be a full SHA, in ` +
          `\`${invocation}\``,
      );
    }
  }

  // Every workflow that calls the script is checked, so a new one is covered
  // without being listed. The two that call it today are named to catch the
  // case where the search comes back empty and the loop above does nothing.
  for (const name of ["deno.yml", "deploy-production.yml"]) {
    assert(callers.includes(name), `${name}: no deploy.sh call found`);
  }
});

Deno.test("a configured presence URL reaches every shell bundle CI builds", async () => {
  // Both shells CI builds take their co-presence endpoint from a repository
  // variable, and an unset variable is a supported state that builds a working
  // shell. Every check the wiring performs therefore sits inside an
  // `if [ -n "$PRESENCE_URL" ]` that a repository without the variable never
  // enters, so those checks cannot report on the wiring itself: remove the
  // wiring and the same runs stay green. The properties a configured value
  // depends on are checked here instead, against the workflow text, where
  // repository configuration does not get to decide whether the check runs.

  const deno = await workflow("deno.yml");

  // Each job that builds a shell, and the directory its build leaves the
  // bundle in. Both are named so the shell embedded in the toolshed binary and
  // the one published to the bucket are held to a single shape.
  const bundles = new Map([
    ["build-toolshed", "packages/toolshed/shell-frontend/scripts"],
    ["deploy-shell-staging", "dist/scripts"],
  ]);

  // Membership is checked both ways. A job that starts carrying a presence URL
  // without being named above would go unchecked, and a job that stops
  // carrying one is a shell that quietly lost co-presence.
  const carriers = jobIds(deno).filter((id) =>
    jobBlock(deno, id).includes('PRESENCE_URL=$PRESENCE_URL" >> "$GITHUB_ENV"')
  );
  assertEquals(carriers.sort(), [...bundles.keys()].sort());

  for (const [id, bundle] of bundles) {
    const steps = stepBlocks(jobBlock(deno, id));

    const exporter = steps.findIndex((step) =>
      step.body.includes('PRESENCE_URL=$PRESENCE_URL" >> "$GITHUB_ENV"')
    );
    assert(exporter >= 0, `${id}: no step exports PRESENCE_URL`);

    // Read from `vars`, never `secrets`: the value ships inside a bundle any
    // reader can open, so hiding it would cost review and buy nothing.
    assertStringIncludes(steps[exporter].body, "PRESENCE_URL: ${{ vars.");

    // What the bundle carries is `URL.href`, which is not always the spelling
    // the variable holds — a host written without a path gains a trailing
    // slash. Exporting the normalized form is what makes the check below an
    // equality on the value that shipped rather than a prefix match.
    assertStringIncludes(
      steps[exporter].body,
      "packages/shell/src/lib/presence-url.ts",
    );
    assertStringIncludes(steps[exporter].body, "?.href");

    // A configured endpoint that did not reach the bundle is a deployment
    // whose co-presence is off with nothing downstream to notice, so the build
    // is not allowed to pass until the URL is found in what it produced.
    const verifier = steps.findIndex((step) =>
      step.body.includes(`grep -rqF -e "$PRESENCE_URL" ${bundle}`)
    );
    assert(
      verifier >= 0,
      `${id}: nothing greps ${bundle} for the presence URL`,
    );
    assertStringIncludes(
      steps[verifier].body,
      'does not reference $PRESENCE_URL."\n            exit 1\n',
    );

    // GITHUB_ENV reaches the steps after the one that writes it, and not that
    // step itself. An exporter placed after the build it configures would
    // export a value no later step reads, and the guarded check above would
    // then skip on an empty variable instead of failing.
    assert(
      exporter < verifier,
      `${id}: PRESENCE_URL is exported after the build that has to read it`,
    );
  }
});

Deno.test("every test-records artifact name is store-safe and unique", async () => {
  // The relay derives each store object's name from the artifact's name
  // through objectNameSlug, which collapses characters unsafe in object
  // names. Two artifacts in one run whose names differ only by collapsed
  // characters would produce one object name, and the second would be
  // mistaken for an idempotent re-ship and silently lost. Holding every
  // literal to the already-safe alphabet makes the slug the identity on
  // these names, so distinct names stay distinct in the store. Uniqueness
  // matters per workflow: object names carry the run id, so two different
  // workflows can reuse a name.

  let shipSteps = 0;
  for (const name of await workflowNames()) {
    const contents = withoutComments(await workflow(name));
    const artifacts: string[] = [];
    const chunks = contents.split("uses: ./.github/actions/test-records-ship");
    for (const chunk of chunks.slice(1)) {
      shipSteps++;
      const artifact = chunk.match(/^\s*artifact: (.+)$/m);
      assert(artifact, `${name}: a ship step with no artifact input`);
      artifacts.push(artifact[1].trim());
    }
    for (const artifact of artifacts) {
      const literal = artifact.replaceAll(/\$\{\{[^}]*\}\}/g, "");
      assert(
        /^[A-Za-z0-9._-]*$/.test(literal),
        `${name}: artifact name \`${artifact}\` has characters the store ` +
          "slug would collapse",
      );
    }
    assertEquals(
      new Set(artifacts).size,
      artifacts.length,
      `${name}: duplicate test-records artifact names`,
    );
  }
  // The count pins the search itself: zero found steps would mean the
  // extraction broke, not that the repository stopped shipping records. The
  // lanes' step is written once, and Status ships the run's coverage.
  assert(shipSteps >= 2, `only ${shipSteps} ship steps found`);
});

Deno.test("test-records-ship forwards its optional variant input", async () => {
  const action = await Deno.readTextFile(
    new URL(
      "../.github/actions/test-records-ship/action.yml",
      import.meta.url,
    ),
  );
  assertStringIncludes(action, "  variant:\n");
  assertStringIncludes(action, "SHIP_VARIANT: ${{ inputs.variant }}");
  assertStringIncludes(
    action,
    'RESOLVED_VARIANT="${SHIP_VARIANT:-${CF_TEST_RECORDS_VARIANT:-}}"',
  );
  assertStringIncludes(action, 'args+=(--variant "$RESOLVED_VARIANT")');
});

Deno.test("the run in tomorrow's order runs the CI suites and ships nothing", async () => {
  interface Job {
    if?: string;
    environment?: string;
    uses?: string;
    with?: Record<string, string>;
    secrets?: unknown;
    permissions?: Record<string, string>;
    steps?: { run?: string }[];
  }
  interface Workflow {
    name: string;
    on: Record<string, unknown>;
    env?: Record<string, string>;
    jobs: Record<string, Job>;
  }
  const ciText = await workflow("deno.yml");
  const ci = parseYaml(ciText) as Workflow;
  const tomorrow = parseYaml(
    await workflow("test-order-tomorrow.yml"),
  ) as Workflow;
  const relay = withoutComments(await workflow("test-records-relay.yml"));

  // The scheduled workflow works out the next Pacific day's seed and hands it
  // to the CI workflow, which puts it where every test runner reads it.
  assertEquals(tomorrow.on.schedule, [{ cron: "0 11 * * *" }]);
  assert(
    tomorrow.jobs.seed.steps?.some((step) =>
      step.run?.includes("deno task -q test-seed --tomorrow")
    ),
    "no step asks for the next day's seed",
  );
  const call = tomorrow.jobs.ci;
  assertEquals(call.uses, "./.github/workflows/deno.yml");
  assertEquals(call.with, { "shuffle-seed": "${{ needs.seed.outputs.seed }}" });
  assertEquals(ci.env?.CF_TEST_SHUFFLE_SEED, "${{ inputs.shuffle-seed }}");

  // GitHub refuses to start the run when a called job asks for a permission
  // the call does not grant, whether or not the job would run. The call hands
  // on no secrets, so the only jobs that name one run for a push alone.
  const asked = new Map<string, string>();
  for (const job of Object.values(ci.jobs)) {
    for (const [scope, level] of Object.entries(job.permissions ?? {})) {
      if (asked.get(scope) !== "write") asked.set(scope, level);
    }
  }
  assertEquals(call.permissions, Object.fromEntries(asked));
  assertEquals(call.secrets, undefined);

  // A called run takes its caller's event and ref, and the scheduled run's
  // ref is main. So a job that holds a deployment environment or a secret
  // runs only for a push to main, and a guard on the branch alone would let
  // the scheduled run attest and deploy. The gates on coverage and topology
  // judge the commit, which the commit's own run already does.
  const shipping = jobIds(ciText).filter((id) =>
    ci.jobs[id].environment !== undefined ||
    /secrets\.(?!GITHUB_TOKEN\b)/.test(jobBlock(ciText, id))
  );
  assertEquals(shipping.sort(), [
    "attest-binaries",
    "deploy-rapids",
    "deploy-shell-staging",
  ]);
  for (const id of shipping) {
    assertEquals(
      ci.jobs[id].if,
      "github.event_name == 'push' && github.ref == 'refs/heads/main'",
      `${id} can run in a called run`,
    );
  }
  assertEquals(
    ci.jobs.status.if,
    "!cancelled() && (github.event_name == 'pull_request' || " +
      "github.event_name == 'push')",
    "status can run in a called run",
  );
  // A called run is not a pull request, so it runs every test.
  assertEquals(
    ci.jobs["plan-full"].if?.startsWith(
      "github.event_name != 'pull_request' ||",
    ),
    true,
  );

  // The relay follows a workflow by its own name, and a called run belongs to
  // its caller, so the relay names this workflow as well as the CI workflow
  // for the records of both to ship.
  const followed = workflowTriggers(relay);
  assertStringIncludes(followed, `"${ci.name}"`);
  assertStringIncludes(followed, `"${tomorrow.name}"`);
});
