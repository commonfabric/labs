import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { parse as parseYaml } from "@std/yaml";
import { getBinary } from "@astral/astral";
import { commandWords, withoutComments } from "./ci-workflow.ts";
import { phaseOf } from "./ci-step-phases.ts";
import { EXPECTED_COVERAGE_ARTIFACT_NAMES } from "./coverage-check.ts";
import { PATTERN_INTEGRATION_SHARD_COUNT } from "./select-pattern-integration-files.ts";
import { UNLAUNCHED_MEMBERS_FILE } from "./unlaunched-members.ts";

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

function expandedJobCount(job: string): number {
  const includeRows = [...job.matchAll(/^ {10}- [A-Za-z_][A-Za-z0-9_-]*:/gm)];
  if (includeRows.length > 0) return includeRows.length;

  const dimensions = [
    ...job.matchAll(/^ {8}[A-Za-z_][A-Za-z0-9_-]*: \[([^\]]+)\]$/gm),
  ];
  return dimensions.reduce(
    (count, dimension) => count * dimension[1].split(",").length,
    1,
  );
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

function neededJobIds(job: string): string[] {
  const marker = "\n    needs:\n";
  const needsStart = job.indexOf(marker);
  assert(needsStart >= 0, "job needs list not found");

  const needsBody = job.slice(needsStart + marker.length);
  const nextProperty = needsBody.search(/^ {4}[A-Za-z_][A-Za-z0-9_-]*:/m);
  const needs = nextProperty < 0 ? needsBody : needsBody.slice(0, nextProperty);
  return [...needs.matchAll(/^ {6}- ([A-Za-z_][A-Za-z0-9_-]*)$/gm)].map(
    (match) => match[1],
  );
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

Deno.test("Check preserves a native crash from Deno lint", async () => {
  const contents = await workflow("deno.yml");
  const check = jobBlock(contents, "check");
  const lint = stepBlock(check, "🧹 Lint codebase");
  const describe = stepBlock(check, "📋 Describe Deno lint core dump");
  const upload = stepBlock(check, "📤 Upload Deno lint core dump");

  assertStringIncludes(lint, "ulimit -c unlimited");
  assertStringIncludes(
    lint,
    'sudo sysctl -w kernel.core_pattern="$GITHUB_WORKSPACE/deno-core.%p"',
  );
  assertStringIncludes(
    lint,
    "deno task run-recorded lint repo deno-lint -- deno lint",
  );
  assertStringIncludes(describe, "if: ${{ failure() }}");
  assertStringIncludes(describe, 'file "$core"');
  assertStringIncludes(upload, "if: ${{ failure() }}");
  assertStringIncludes(upload, "uses: actions/upload-artifact@");
  assertStringIncludes(
    upload,
    "name: deno-lint-core-a${{ github.run_attempt }}",
  );
  assertStringIncludes(upload, "path: deno-core.*");
  assertStringIncludes(upload, "if-no-files-found: ignore");
  assert(
    check.indexOf("🧹 Lint codebase") <
        check.indexOf("📋 Describe Deno lint core dump") &&
      check.indexOf("📋 Describe Deno lint core dump") <
        check.indexOf("📤 Upload Deno lint core dump") &&
      check.indexOf("📤 Upload Deno lint core dump") <
        check.indexOf("🔎 Type check codebase"),
    "the lint crash report must run immediately after the lint step",
  );
});

Deno.test("Status waits for every pull request validation job", async () => {
  const contents = await workflow("deno.yml");
  const gate = jobBlock(contents, "status");
  const pushOnlyJobs = new Set([
    "attest-binaries",
    "deploy-rapids",
    "deploy-shell-staging",
  ]);
  const expected = jobIds(contents).filter((jobId) =>
    jobId !== "status" && !pushOnlyJobs.has(jobId)
  ).sort();

  assertEquals(neededJobIds(gate).sort(), expected);
  assertStringIncludes(contents, "name: CI\n");
  assertStringIncludes(gate, 'name: "Status"');
  assertStringIncludes(
    gate,
    "if: ${{ always() && github.event_name == 'pull_request' }}",
  );
  assertStringIncludes(gate, "JOB_RESULTS: ${{ toJSON(needs) }}");
  assertStringIncludes(gate, 'select(.value.result != "success")');
  assertStringIncludes(gate, "permissions: {}");

  // A path filter would leave the required check pending on a pull request
  // that touches none of the listed paths.
  const triggers = workflowTriggers(contents);
  assertStringIncludes(triggers, "  pull_request:\n");
  assertEquals(triggers.includes("\n    paths:"), false);
});

Deno.test("the first CI wave leaves runner capacity for another run", async () => {
  const contents = await workflow("deno.yml");
  const githubParallelRunnerLimit = 60;
  const firstWaveJobs = jobIds(contents)
    .map((jobId) => jobBlock(contents, jobId))
    .filter((job) => !/^ {4}needs:/m.test(job));
  const firstWaveRunnerCount = firstWaveJobs.reduce(
    (count, job) => count + expandedJobCount(job),
    0,
  );

  assert(
    firstWaveRunnerCount < githubParallelRunnerLimit / 2,
    `the dependency-free wave expands to ${firstWaveRunnerCount} jobs; ` +
      `two overlapping runs must fit within GitHub's ` +
      `${githubParallelRunnerLimit}-runner limit`,
  );
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
  // The deploy jobs hand the work to a script that lives elsewhere — one on the
  // bastion, one in Cloud Storage — and how long that takes is not this
  // workflow's to say. They carry no bound, so none is asked of them here.
  const unboundedJobs = new Set(["deploy-rapids", "deploy-shell-staging"]);

  for (const jobId of jobIds(contents)) {
    if (unboundedJobs.has(jobId)) continue;
    const job = jobBlock(contents, jobId);
    const jobValue = job.match(/^ {4}timeout-minutes: (.+)$/m);
    assert(jobValue, `${jobId}: job has no timeout-minutes`);
    const jobBound = boundMinutes(anchors, jobValue[1]);
    assert(
      jobBound,
      `${jobId}: timeout-minutes ${jobValue[1]} is not an anchored bound`,
    );

    const work = stepBlocks(job).filter((step) =>
      phaseOf(step.name) === "work"
    );
    // Every job here does work of its own, so an empty list means the steps
    // went unread rather than that this job had none to bound.
    assert(work.length > 0, `${jobId}: no work step found`);

    for (const step of work) {
      const stepValue = step.body.match(/^ {8}timeout-minutes: (.+)$/m);
      assert(stepValue, `${jobId}: "${step.name}" has no timeout-minutes`);
      const stepBound = boundMinutes(anchors, stepValue[1]);
      assert(
        stepBound,
        `${jobId}: "${step.name}" timeout-minutes ${stepValue[1]} is not an ` +
          `anchored bound`,
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

Deno.test("coverage requirements follow sharded test matrices", async () => {
  const contents = await workflow("deno.yml");
  const jobs = [
    ["test", "coverage-profile-workspace-", "shard"],
    ["runner-test", "coverage-profile-runner-", "shard"],
    [
      "generated-patterns-integration-test",
      "coverage-profile-generated-patterns-",
      "shard",
    ],
    [
      "pattern-integration-test",
      "coverage-profile-pattern-integration-",
      "shard",
    ],
    ["pattern-unit-test", "coverage-profile-pattern-unit-", "chunk"],
  ] as const;

  for (const [jobId, artifactPrefix, dimension] of jobs) {
    const job = jobBlock(contents, jobId);
    const shardMatch = job.match(
      new RegExp(`^ {8}${dimension}: \\[([0-9, ]+)\\]$`, "m"),
    );
    const totalMatch = job.match(/^ {8}total: \[(\d+)\]$/m);
    assert(shardMatch, `${jobId} ${dimension} matrix not found`);
    assert(totalMatch, `${jobId} total matrix not found`);

    const shards = shardMatch[1].split(",").map((value) =>
      Number(value.trim())
    );
    const total = Number(totalMatch[1]);
    if (jobId === "pattern-integration-test") {
      assertEquals(
        total,
        PATTERN_INTEGRATION_SHARD_COUNT,
        "pattern integration matrix must use its measured weight profile",
      );
    }
    assertEquals(
      shards,
      Array.from({ length: total }, (_, index) => index + 1),
      `${jobId} must list every ${dimension} exactly once`,
    );
    assertStringIncludes(
      job,
      `name: ${artifactPrefix}\${{ matrix.${dimension} }}`,
    );
    assertEquals(
      EXPECTED_COVERAGE_ARTIFACT_NAMES.filter((name) =>
        name.startsWith(artifactPrefix)
      ),
      shards.map((shard) => `${artifactPrefix}${shard}`),
      `${jobId} coverage requirements must match its matrix`,
    );
  }
});

Deno.test("every workspace test job uploads its unlaunched-package record", async () => {
  // The record is written only by a run that stopped early, so a job that
  // leaves it out of its artifact looks exactly like a job that never left
  // one, and the coverage gate scores the packages that job never started.
  const contents = await workflow("deno.yml");
  const runners = jobIds(contents).filter((jobId) =>
    stepBlocks(jobBlock(contents, jobId)).some((step) =>
      /^ +run: deno task test$/m.test(step.body)
    )
  );

  assertEquals(runners, ["test"], "jobs running the workspace test runner");
  for (const jobId of runners) {
    const upload = stepBlock(
      jobBlock(contents, jobId),
      "📤 Upload coverage report",
    );
    assertStringIncludes(upload, `coverage/lcov/${UNLAUNCHED_MEMBERS_FILE}\n`);
  }
});

Deno.test("sharded pattern caches follow their shard topology", async () => {
  const contents = await workflow("deno.yml");
  for (
    const [jobId, selector, dimension] of [
      [
        "generated-patterns-integration-test",
        "'tasks/select-generated-pattern-files.ts'",
        "shard",
      ],
      [
        "pattern-integration-test",
        "'tasks/select-pattern-integration-files.ts'",
        "shard",
      ],
      ["pattern-unit-test", "'tasks/integration.ts'", "chunk"],
    ] as const
  ) {
    const job = jobBlock(contents, jobId);
    const topology = `-\${{ matrix.total }}-\${{ matrix.${dimension} }}-`;
    assertEquals(job.split(topology).length - 1, 2);
    const key = job.match(/^ {10}key: (.+)$/m);
    assert(key, `${jobId} cache key not found`);
    assertStringIncludes(key[1], selector);
    const restoreKeys = job.match(/restore-keys: \|\n((?: {12}.+\n)+)/);
    assert(restoreKeys, `${jobId} restore prefixes not found`);
    assertEquals(restoreKeys[1].trim().split("\n").length, 1);
  }
});

Deno.test("every compile byte cache is keyed on the compiler fingerprint", async () => {
  // A compile byte cache holds bytes one compiler emitted, and the runtime
  // stores each of them under `compileCache:<fingerprint>/<identity>`. Keying
  // the CI entry on that same fingerprint is what makes a restored entry usable
  // rather than dead weight, and the compile-cache-key action is where the
  // value comes from. A job that points the compiler at a cache file is the
  // one that needs it, so that is what this reads rather than a step name.
  const contents = await workflow("deno.yml");
  const fingerprint = "${{ steps.compile-cache-key.outputs.fingerprint }}";
  const resolver = "uses: ./.github/actions/compile-cache-key";

  let entries = 0;
  for (const jobId of jobIds(contents)) {
    const job = jobBlock(contents, jobId);
    const steps = stepBlocks(job);
    const resolves = steps.some((step) => step.body.includes(resolver));
    const files = new Set(
      [...job.matchAll(/CF_COMPILE_CACHE_FILE[:=] ?(.+)$/gm)].map((match) =>
        match[1].trim().replace(/\s*\\$/, "").replace(/^"|"$/g, "")
      ),
    );

    if (files.size === 0) {
      assert(!resolves, `${jobId} resolves a fingerprint it keys nothing on`);
      continue;
    }
    assert(
      resolves,
      `${jobId} uses a compile cache without resolving the fingerprint`,
    );

    for (const file of files) {
      let resolved = false;
      let cached = false;
      for (const step of steps) {
        if (step.body.includes(resolver)) resolved = true;
        if (!step.body.includes(`path: ${file}\n`)) continue;
        cached = true;
        assert(
          resolved,
          `${jobId} keys ${file} before resolving the fingerprint`,
        );

        const key = step.body.match(/^ {10}key: (.+)$/m);
        assert(key, `${jobId} has no key for ${file}`);
        assertStringIncludes(key[1], fingerprint);

        const restoreKeys = step.body.match(
          /restore-keys: \|\n((?: {12}.+\n)+)/,
        );
        for (const prefix of restoreKeys?.[1].trim().split("\n") ?? []) {
          assertStringIncludes(prefix, fingerprint);
        }
        entries += 1;
      }
      assert(cached, `${jobId} caches nothing at ${file}`);
    }
  }
  assert(entries > 0, "no compile byte cache found in deno.yml");
});

Deno.test("pattern shard selection fails loudly instead of running an empty shard", async () => {
  // `mapfile -t X < <(deno run … select-pattern-integration-files.ts …)`
  // discards the selector's exit status: a selector failure leaves the
  // array empty WITHOUT failing the step, and the step then runs ZERO test
  // files and exits green — a silently empty shard. The selector itself
  // throws on an empty selection (every shard carries the
  // internally-sharded files), so empty output is only ever a failure; the
  // exit status is the discriminator, and only a plain command
  // substitution propagates it under `bash -e`.

  const contents = withoutComments(await workflow("deno.yml"));
  for (
    // Both stable pattern roles use the same selector contract.
    const jobId of [
      "pattern-integration-test",
      "pattern-integration-test-server-execution-opposite",
    ]
  ) {
    const job = jobBlock(contents, jobId);
    assert(
      !/mapfile[^\n]*<\s*<\([^\n]*select-pattern-integration-files/.test(job),
      `${jobId}: the shard selector must not feed mapfile through a ` +
        `process substitution — that discards its exit status, and a ` +
        `selector failure then runs an empty shard green`,
    );
    assertStringIncludes(
      job,
      "SELECTED_FILES=$(deno run --allow-read " +
        "../../tasks/select-pattern-integration-files.ts",
    );
    assertStringIncludes(
      job,
      "::error::select-pattern-integration-files.ts selected no files",
    );
  }
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

Deno.test("the Coverage Check job records no tests", async () => {
  const job = jobBlock(
    withoutComments(await workflow("deno.yml")),
    "coverage-check",
  );

  // The gate reads the coverage artifacts of every test job in this run, so no
  // lane can be asked to run it, and the criterion in `docs/specs/test-records.md`
  // under "Recording" puts it outside test records: no spool directory, no
  // wrapper, no ship step.
  assert(!job.includes("CF_TEST_RECORDS_DIR"), "the job spools test records");
  assert(
    !job.includes("run-recorded"),
    "the job wraps its command in run-recorded",
  );
  assert(!job.includes("test-records-ship"), "the job ships test records");
  // The gate itself runs.
  assertStringIncludes(job, "tasks/coverage-check.ts");
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

Deno.test("the store half of the drift guard reads every record artifact", async () => {
  const contents = withoutComments(await workflow("deno.yml"));
  const job = jobBlock(contents, "test-topology-store-check");

  // An identity is claimed by the suite that would run it, so a record
  // artifact this job does not see is a surface it cannot hold the topology
  // to. It therefore waits for every job that ships records, and downloads
  // them by the prefix the ship step names them under.
  const shippers = jobIds(contents).filter((jobId) =>
    jobId !== "test-topology-store-check" &&
    jobBlock(contents, jobId).includes(
      "uses: ./.github/actions/test-records-ship",
    )
  );
  // The floor pins the extraction: zero found jobs would mean the search
  // broke rather than that the workflow stopped shipping records.
  assert(shippers.length >= 14, `only ${shippers.length} shipping jobs found`);
  assertEquals(
    shippers.filter((jobId) => !neededJobIds(job).includes(jobId)),
    [],
    "record-shipping jobs the store half does not wait for",
  );
  assertStringIncludes(job, "pattern: test-records-*");

  // The records are held to the commit the run checked out, and the
  // directory is named rather than the files under it, so the guard is
  // handed the download itself and fails when it holds nothing. The whole
  // command is compared, because a glob appended to the directory
  // contains the directory.
  const command = job.match(/deno task check-test-topology[^\n]*\n[^\n]*/);
  assert(command, "the job does not run the topology check");
  assertEquals(
    command[0].replace(/\s+/g, " ").trim(),
    'deno task check-test-topology --commit "$GITHUB_SHA" ' +
      "--records test-records-artifacts",
  );

  // The guard reads the artifacts of every job in this run, so no lane can be
  // asked to run it, and `docs/specs/test-records.md` under "Recording" puts
  // it outside test records: no spool directory, no wrapper, no ship step.
  assert(!job.includes("CF_TEST_RECORDS_DIR"), "the job spools test records");
  assert(
    !job.includes("run-recorded"),
    "the job wraps its command in run-recorded",
  );
  assert(!job.includes("test-records-ship"), "the job ships test records");
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
  // extraction broke, not that the repository stopped shipping records.
  assert(shipSteps >= 14, `only ${shipSteps} ship steps found`);
});

Deno.test("every deno.yml JUnit job spools and ships test records", async () => {
  const contents = withoutComments(await workflow("deno.yml"));
  const missing: string[] = [];
  let junitJobs = 0;
  for (const jobId of jobIds(contents)) {
    const job = jobBlock(contents, jobId);
    if (!job.includes("--junit-path=")) continue;
    junitJobs++;
    if (!job.includes("uses: ./.github/actions/test-records-ship")) {
      missing.push(
        `${jobId}: writes a JUnit file but has no test-records-ship step`,
      );
    } else {
      const ship = stepBlock(job, "📤 Ship test records");
      if (!ship.includes("if: always()")) {
        missing.push(`${jobId}: does not ship test records after a failure`);
      }
      if (!ship.includes("junit:")) {
        missing.push(`${jobId}: does not gather its JUnit file`);
      }
    }
    if (!job.includes("CF_TEST_RECORDS_DIR:")) {
      missing.push(
        `${jobId}: runs tests without CF_TEST_RECORDS_DIR — the spool ` +
          "half of the records is never written",
      );
    }
  }
  assertEquals(missing, []);
  // Pin the search itself: zero junit jobs would mean the extraction
  // broke, not that the repository stopped writing JUnit files.
  assert(junitJobs >= 7, `only ${junitJobs} JUnit-writing jobs found`);
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

Deno.test("server-execution records follow the stable default and opposite roles", async () => {
  // The default continues the unmarked history. The opposite role exports the
  // actual implementation arm as CF_TEST_RECORDS_VARIANT, which the shipping
  // action consumes without hard-coding ON or OFF in the workflow.
  const contents = withoutComments(await workflow("deno.yml"));
  const packageJob = jobBlock(
    contents,
    "package-integration-test-server-execution-opposite",
  );
  const patternJob = jobBlock(
    contents,
    "pattern-integration-test-server-execution-opposite",
  );
  assertStringIncludes(
    packageJob,
    "--junit-path=../../test-results/${JUNIT_NAME}.xml",
  );
  assertStringIncludes(packageJob, "JUNIT_NAME: ${{ matrix.junit_name }}");
  assertStringIncludes(
    stepBlock(packageJob, "📤 Ship test records"),
    "glob=test-results/${{ matrix.junit_name }}.xml",
  );
  assertStringIncludes(
    patternJob,
    "--junit-path=../../test-results/patterns-server-execution-opposite-${{ matrix.shard }}.xml",
  );
  assertStringIncludes(
    stepBlock(patternJob, "📤 Ship test records"),
    "glob=test-results/patterns-server-execution-opposite-${{ matrix.shard }}.xml",
  );

  for (
    const jobId of ["package-integration-test", "pattern-integration-test"]
  ) {
    const ship = stepBlock(jobBlock(contents, jobId), "📤 Ship test records");
    assert(
      !ship.includes("variant:"),
      `${jobId}: the default configuration must remain unmarked`,
    );
  }

  for (
    const jobId of [
      "package-integration-test-server-execution-opposite",
      "pattern-integration-test-server-execution-opposite",
    ]
  ) {
    const job = jobBlock(contents, jobId);
    assertStringIncludes(
      stepBlock(job, "🧭 Resolve opposite server-execution posture"),
      "tasks/server-execution-ci-command.ts env opposite",
    );
    const ship = stepBlock(job, "📤 Ship test records");
    assert(
      !ship.includes("variant:"),
      `${jobId}: the arm variant must come from the shared role resolver`,
    );
  }
});

Deno.test("server-execution CI uses stable default and opposite roles", async () => {
  // Both roles resolve from one helper. The default keeps the flag unset; the
  // opposite build, server, and test processes inherit its explicit inverse.
  const contents = await workflow("deno.yml");

  for (
    const jobId of ["package-integration-test", "pattern-integration-test"]
  ) {
    const job = jobBlock(contents, jobId);
    assertStringIncludes(
      job,
      "tasks/server-execution-ci-command.ts env default",
      `${jobId}: the default lane must resolve from the shared helper`,
    );
    assertStringIncludes(
      job,
      "tasks/server-execution-ci-command.ts probe default",
      `${jobId}: the default lane must use the shared posture probe`,
    );
    assertStringIncludes(
      job,
      "server-execution-on-skips.ts",
      `${jobId}: the lane must be able to carry the ON-arm skip list`,
    );
    assertStringIncludes(
      job,
      '[ "$SERVER_EXECUTION_ENABLED" = "true" ]',
      `${jobId}: the skip list must apply only when this role is ON`,
    );
  }

  // The opposite job resolves its role once into the job environment. Both
  // the toolshed and test steps inherit it; no step may pin today's inverse
  // value independently and turn a future flip into a mixed posture.
  for (
    const { jobId, runStep } of [
      {
        jobId: "package-integration-test-server-execution-opposite",
        runStep: "🧪 Run ${{ matrix.step_name }} (opposite posture)",
      },
      {
        jobId: "pattern-integration-test-server-execution-opposite",
        runStep:
          "🧩 Run end-to-end patterns integration tests (opposite posture)",
      },
    ]
  ) {
    const job = jobBlock(contents, jobId);
    assertStringIncludes(
      job,
      "tasks/server-execution-ci-command.ts env opposite",
    );
    assertStringIncludes(
      job,
      "tasks/server-execution-ci-command.ts probe opposite",
    );
    for (
      const stepName of [
        "🔌 Start Toolshed server for testing (opposite posture)",
        runStep,
      ]
    ) {
      // The selecting steps exist under these names and, like every other
      // step (asserted over the whole workflow below), carry no literal arm.
      stepBlock(job, stepName);
    }
    assertStringIncludes(
      job,
      '[ "$SERVER_EXECUTION_ENABLED" = "true" ]',
      `${jobId}: the ON-arm skip list follows the resolved posture`,
    );
    assertStringIncludes(
      job,
      "binary-toolshed-opposite",
      `${jobId}: the opposite lane runs the opposite-built binary`,
    );
  }

  // No step anywhere selects an arm by literal: every assignment of the flag
  // is the resolve step's output, so a flip of the default moves both roles
  // together and a value pinned by hand cannot turn a flip into a mixed
  // posture. Every assignment form counts — a YAML `env:` entry in either
  // quote style, a shell `NAME=value`, and the shell default-assignment
  // `${NAME:=value}`. Comments are stripped so a note naming a value is not
  // read as setting it; the CLI lane's `${EXPERIMENTAL_SERVER_EXECUTION:-…}`
  // is a read, not an assignment, and does not match.
  const literal = withoutComments(contents).match(
    /EXPERIMENTAL_SERVER_EXECUTION\s*(?::=|[:=])\s*['"]?(?:true|false)\b/,
  );
  assert(
    literal === null,
    `deno.yml selects a server-execution arm by literal: ${literal?.[0]}`,
  );

  const buildOpposite = jobBlock(contents, "build-toolshed-opposite");
  assertStringIncludes(
    buildOpposite,
    "tasks/server-execution-ci-command.ts env opposite",
    "the opposite build must bake the posture resolved by the shared helper",
  );

  // The real bg-piece-service binary and cf-harness fabric session are always
  // exercised at the first-party default resolution.
  const gate = jobBlock(contents, "deployed-topology-gate");
  assertStringIncludes(gate, "binary-bg-piece-service");
  assertStringIncludes(gate, "integration/posture-gate.test.ts");
  assertStringIncludes(gate, "integration/fabric-session-posture-gate.test.ts");
  assertStringIncludes(
    gate,
    "tasks/server-execution-ci-command.ts env default",
  );
  assertStringIncludes(
    gate,
    "tasks/server-execution-ci-command.ts probe default",
  );
});

Deno.test("the CLI lane follows the default and refuses a mixed posture", async () => {
  // `cf` is a deployed CLIENT: it ADOPTS the arm the server publishes on
  // /api/meta (experimentalOptionsForDeployedClient, authority "server")
  // unless an explicit EXPERIMENTAL_SERVER_EXECUTION overrides it. A
  // serving loop therefore proves only the SERVER's half — the review's
  // finding-7 mixed posture (a client on the other arm) would still read
  // as a passing ON exercise. The probe has to compare both arms and fail
  // on a disagreement, which is what this pins.
  const contents = await workflow("deno.yml");
  const job = jobBlock(contents, "cli-integration-test");
  const probe = stepBlock(
    job,
    "✅ Verify the default server-execution posture and cf adoption",
  );

  assertStringIncludes(
    probe,
    "tasks/server-execution-ci-command.ts probe default",
    "the CLI probe must verify the resolved default server posture",
  );
  assertStringIncludes(
    probe,
    ".experimental.serverExecution",
    "the CLI probe must read the posture the server PUBLISHES, which is what cf adopts",
  );
  assertStringIncludes(
    probe,
    'CLIENT_ARM="${EXPERIMENTAL_SERVER_EXECUTION:-$SERVER_ARM}"',
    "the CLI probe must resolve the client arm the way cf does: an explicit env wins, else the published posture",
  );
  assertStringIncludes(
    probe,
    '[ "$CLIENT_ARM" != "$SERVER_ARM" ]',
    "the CLI probe must fail on a client/server arm disagreement",
  );
  assertStringIncludes(
    probe,
    'if .experimental.serverExecution == null then "unpublished"',
    "the CLI probe must preserve a published JSON false rather than treating it as absent",
  );
});

Deno.test("both server-execution pattern roles upload failure logs", async () => {
  const contents = await workflow("deno.yml");
  const patternJob = jobBlock(
    contents,
    "pattern-integration-test-server-execution-opposite",
  );
  const upload = stepBlock(patternJob, "📋 Upload toolshed log on failure");

  assertStringIncludes(upload, "if: failure()");
  assertStringIncludes(upload, "uses: actions/upload-artifact@");
  assertStringIncludes(
    upload,
    "name: toolshed-log-pattern-integration-server-execution-opposite-${{ matrix.shard }}",
  );
  assertStringIncludes(upload, "path: ${{ runner.temp }}/toolshed.log");
  assertStringIncludes(upload, "retention-days: 14");
  assertStringIncludes(upload, "if-no-files-found: ignore");

  const defaultJob = jobBlock(contents, "pattern-integration-test");
  const defaultUpload = stepBlock(
    defaultJob,
    "📋 Upload toolshed log on failure",
  );
  assertStringIncludes(defaultUpload, "if: failure()");
  assertStringIncludes(
    defaultUpload,
    "name: toolshed-log-pattern-integration-${{ matrix.shard }}",
  );
});

Deno.test("both package integration roles upload failure logs", async () => {
  const contents = await workflow("deno.yml");
  // Named for the JUnit name rather than the suite, which is what keeps the
  // two roles' artifacts apart: both carry the same three suite names, and
  // only the JUnit name says which arm a log came off.
  for (
    const job of [
      "package-integration-test",
      "package-integration-test-server-execution-opposite",
    ]
  ) {
    const upload = stepBlock(
      jobBlock(contents, job),
      "📋 Upload toolshed log on failure",
    );
    assertStringIncludes(upload, "if: failure()");
    assertStringIncludes(upload, "uses: actions/upload-artifact@");
    assertStringIncludes(
      upload,
      "name: toolshed-log-package-integration-${{ matrix.junit_name }}",
    );
    assertStringIncludes(upload, "path: ${{ runner.temp }}/toolshed.log");
    assertStringIncludes(upload, "retention-days: 14");
    assertStringIncludes(upload, "if-no-files-found: ignore");
  }
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
  for (const id of ["coverage-check", "test-topology-store-check"]) {
    assertEquals(
      ci.jobs[id].if,
      "(github.event_name == 'pull_request') || " +
        "(github.event_name == 'push' && github.ref_name == 'main')",
      `${id} can run in a called run`,
    );
  }

  // The relay follows a workflow by its own name, and a called run belongs to
  // its caller, so the relay names this workflow as well as the CI workflow
  // for the records of both to ship.
  const followed = workflowTriggers(relay);
  assertStringIncludes(followed, `"${ci.name}"`);
  assertStringIncludes(followed, `"${tomorrow.name}"`);
});
