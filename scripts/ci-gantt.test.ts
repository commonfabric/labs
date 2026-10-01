import { assert, assertEquals, assertStringIncludes } from "@std/assert";

import { maxOf } from "@commonfabric/utils/math";

const SCRIPT = new URL("./ci-gantt.ts", import.meta.url).href;
const START = Date.parse("2026-07-20T10:00:00Z");

interface TestJob {
  attempt: number;
  name: string;
  status: string;
  conclusion: string;
  started_at: string;
  completed_at: string;
  steps: {
    name: string;
    number: number;
    conclusion: string;
    started_at: string;
    completed_at: string;
  }[];
}

function job(
  name: string,
  attempt: number,
  startSeconds: number,
  durationSeconds: number,
  conclusion = "success",
): TestJob {
  const startedAt = new Date(START + startSeconds * 1_000).toISOString();
  const completedAt = new Date(
    START + (startSeconds + durationSeconds) * 1_000,
  ).toISOString();
  return {
    attempt,
    name,
    status: "completed",
    conclusion,
    started_at: startedAt,
    completed_at: completedAt,
    steps: [{
      name: "🧪 Test",
      number: 1,
      conclusion,
      started_at: startedAt,
      completed_at: completedAt,
    }],
  };
}

function inputRun(databaseId: number, jobs: TestJob[]) {
  return {
    run: {
      attempt: maxOf(jobs.map((value) => value.attempt)),
      databaseId,
      status: "completed",
      conclusion: "success",
      event: "push",
      headBranch: "main",
      startedAt: new Date(START).toISOString(),
      workflowName: "CI",
    },
    jobs,
  };
}

async function render(input: unknown, theme = "dark"): Promise<string> {
  const result = await runGantt(input, theme);
  assert(result.success, result.stderr);
  return result.svg;
}

async function runGantt(
  input: unknown,
  theme = "dark",
): Promise<{ success: boolean; stderr: string; svg: string }> {
  const directory = await Deno.makeTempDir({ prefix: "ci-gantt-test-" });
  const inputPath = `${directory}/input.json`;
  const outputPath = `${directory}/output.svg`;
  try {
    await Deno.writeTextFile(inputPath, JSON.stringify(input));
    const output = await new Deno.Command(Deno.execPath(), {
      args: [
        "run",
        `--allow-read=${inputPath}`,
        `--allow-write=${outputPath}`,
        SCRIPT,
        "--input",
        inputPath,
        "--out",
        outputPath,
        "--theme",
        theme,
        "--min-runs",
        "1",
      ],
      stdout: "piped",
      stderr: "piped",
    }).output();
    return {
      success: output.success,
      stderr: new TextDecoder().decode(output.stderr),
      svg: output.success ? await Deno.readTextFile(outputPath) : "",
    };
  } finally {
    await Deno.remove(directory, { recursive: true });
  }
}

function attemptBar(
  svg: string,
  attempt: number,
  result: string,
  duration: string,
  conclusion = result,
): { x: number; y: number; width: number } {
  const match = svg.match(
    new RegExp(
      `<g data-attempt="${attempt}" data-result="${result}">` +
        `<title>Attempt ${attempt}: ${conclusion}, ${duration}</title>\\s*` +
        `<rect x="([\\d.]+)" y="([\\d.]+)" width="([\\d.]+)"`,
    ),
  );
  assert(match, `missing attempt ${attempt} ${conclusion} ${duration}`);
  return {
    x: Number(match[1]),
    y: Number(match[2]),
    width: Number(match[3]),
  };
}

function attemptDuration(
  svg: string,
  attempt: number,
  result: string,
  duration: string,
  conclusion = result,
): { x: number; y: number } {
  const match = svg.match(
    new RegExp(
      `<g data-attempt="${attempt}" data-result="${result}">` +
        `<title>Attempt ${attempt}: ${conclusion}, ${duration}</title>` +
        `[\\s\\S]*?<text class="attempt-duration" x="([\\d.]+)" ` +
        `y="([\\d.]+)"[^>]*>${duration}</text></g>`,
    ),
  );
  assert(match, `missing duration for attempt ${attempt} ${duration}`);
  return { x: Number(match[1]), y: Number(match[2]) };
}

Deno.test("single-run CI Gantt draws every rerun attempt on one row", async () => {
  const svg = await render({
    runs: [
      inputRun(42, [
        job("Retried job", 1, 60, 60, "failure"),
        job("Retried job", 2, 7_260, 120),
        job("Timed out job", 1, 180, 75, "timed_out"),
        job("Timed out job", 2, 300, 90),
        job("Downstream", 2, 7_380, 60),
      ]),
    ],
  });

  const failed = attemptBar(svg, 1, "failure", "1:00");
  const succeeded = attemptBar(svg, 2, "success", "2:00");
  const timedOut = attemptBar(svg, 1, "failure", "1:15", "timed_out");
  const timedOutRetry = attemptBar(svg, 2, "success", "1:30");
  assertEquals(failed.y, succeeded.y);
  assertEquals(timedOut.y, timedOutRetry.y);
  assert(succeeded.x > failed.x + failed.width + 500);
  const timedOutDuration = attemptDuration(
    svg,
    1,
    "failure",
    "1:15",
    "timed_out",
  );
  const timedOutRetryDuration = attemptDuration(svg, 2, "success", "1:30");
  assert(timedOutDuration.y > timedOutRetryDuration.y);
  assertEquals(svg.match(/class="attempt-failure"/g)?.length, 2);
  const timedOutRetryMarkup = "<title>Attempt 2: success, 1:30</title>";
  const timedOutFailureMarkup =
    '<g class="attempt-failure" data-attempt="1"><title>Attempt 1: timed_out, 1:15</title>';
  const timedOutRetryIndex = svg.indexOf(timedOutRetryMarkup);
  assert(timedOutRetryIndex >= 0);
  assert(
    svg.indexOf(timedOutFailureMarkup, timedOutRetryIndex) >
      timedOutRetryIndex,
  );
  assertStringIncludes(svg, "<title>Attempt 1: timed_out, 1:15</title>");
  assertEquals(svg.includes('class="attempt-label"'), false);
  assertEquals(svg.includes(">a1"), false);
  assertEquals(svg.includes(">a2"), false);
  const failedAttempt = svg.match(
    /<g data-attempt="1" data-result="failure"><title>Attempt 1: failure, 1:00<\/title>[\s\S]*?<\/g>/,
  )?.[0];
  assert(failedAttempt);
  assertStringIncludes(failedAttempt, ">1:00</text>");
  const successfulAttempt = svg.match(
    /<g data-attempt="2" data-result="success"><title>Attempt 2: success, 2:00<\/title>[\s\S]*?<\/g>/,
  )?.[0];
  assert(successfulAttempt);
  assertStringIncludes(successfulAttempt, ">2:00</text>");
  assertEquals(successfulAttempt.includes("attempt-failure"), false);
  assertStringIncludes(svg, "failed attempts end in ×");
});

Deno.test("CI Gantt light theme paints a light SVG", async () => {
  const svg = await render({
    runs: [inputRun(42, [job("Test", 1, 60, 120)])],
  }, "default");

  assertStringIncludes(svg, 'fill="#ffffff"');
  assertStringIncludes(svg, 'fill="#1f2328"');
  assertEquals(svg.includes('fill="#0d0e11"'), false);
});

Deno.test("CI Gantt rejects a rerun whose jobs carry no attempt", async () => {
  const collapsed: Partial<TestJob> = { ...job("Retried job", 1, 60, 120) };
  delete collapsed.attempt;
  const rerun = inputRun(42, [job("Retried job", 2, 60, 120)]);
  const rejected = await runGantt({ runs: [{ ...rerun, jobs: [collapsed] }] });

  assertEquals(rejected.success, false);
  assertStringIncludes(
    rejected.stderr,
    "run 42 reports 2 attempts but has jobs with no attempt",
  );

  // One attempt needs no provenance, so cached data from before attempts were
  // recorded still draws.
  const legacy: Partial<TestJob> = { ...job("Only job", 1, 60, 120) };
  delete legacy.attempt;
  const single = inputRun(43, [job("Only job", 1, 60, 120)]);
  const drawn = await runGantt({ runs: [{ ...single, jobs: [legacy] }] });

  assertEquals(drawn.success, true);
  assertStringIncludes(drawn.svg, "Only job");
});

Deno.test("multi-run CI Gantt keeps one aggregate bar per job", async () => {
  const svg = await render({
    runs: [
      inputRun(42, [
        job("Retried job", 1, 60, 60, "failure"),
        job("Retried job", 2, 180, 120),
      ]),
      inputRun(43, [
        job("Retried job", 1, 60, 180),
      ]),
    ],
  });

  assertEquals(svg.includes('data-attempt="'), false);
  assertEquals(svg.includes('class="attempt-failure"'), false);
  assertStringIncludes(svg, "median of 2 completed runs");
  assertStringIncludes(svg, "whiskers = min/max");
  assertStringIncludes(svg, ">2:30<tspan");
  assertStringIncludes(svg, ">2:00–3:00</tspan>");
});
