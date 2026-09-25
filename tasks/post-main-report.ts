#!/usr/bin/env -S deno run --allow-net --allow-env --allow-read --allow-write --allow-run=git,unzip

/**
 * Tells a pull request what a later run on the default branch found.
 *
 * Selection means some regressions land and the run on the default
 * branch is what catches them. This follows every such run, works out
 * what it found that the pull request behind its commit could not have
 * found for itself, and comments once on that pull request. It runs in
 * the base-repository context with a write token, which is what lets it
 * comment at all.
 *
 * The repository squash-merges with the pull request number in the
 * subject, so the pull request behind a commit is unambiguous. A commit
 * pushed directly, with no pull request behind it, is the ordinary case
 * for finding none: the commit is logged and nothing is posted.
 *
 * Three runs' records are what the notes rest on, and they come from two
 * places for one reason each. The two runs on the default branch are
 * read from their own `test-records-*` artifacts: those are readable the
 * moment a run ends, where the store holds a run's records only once the
 * relay has shipped them, and two merges landing close together are
 * exactly when the earlier relay is still running and exactly the case
 * this exists for.
 *
 * The pull request's own run is read from the store instead, because the
 * relay is where the trust decision about it was made: it ships a fork
 * run only for a team member, and the store is what that decision
 * produced. Reading the run's own artifacts would go around the gate and
 * put a fork's claims about which tests passed into a comment.
 *
 * Environment:
 *   GITHUB_TOKEN         - Required.
 *   GITHUB_EVENT_PATH    - The workflow_run payload naming the run.
 *   GITHUB_REPOSITORY    - Optional, defaults to "commonfabric/labs".
 *   MAIN_REPORT_RUN_ID   - Optional, the run to report on in place of the
 *                          payload's, for running this by hand.
 *
 * `--dry-run` prints what it would say and posts nothing:
 *
 *   GITHUB_TOKEN=$(gh auth token) MAIN_REPORT_RUN_ID=<id> \
 *     deno run --allow-net --allow-env --allow-read --allow-write \
 *     --allow-run=git,unzip tasks/post-main-report.ts --dry-run
 */

import { join } from "@std/path";
import {
  coverageArtifactAttempt,
  type CoverageFigures,
  coverageFiguresOf,
  datePartition,
  type FlakeEvidence,
  listObjects,
  parseReportGroups,
  readObject,
  RECORD_SCHEMA_VERSION,
  testIdentityKey,
  type TestRecord,
} from "@commonfabric/test-support/records";
import { ciSubmissionsPrefix, storeBucket } from "./test-records-config.ts";
import {
  type Artifact,
  coverageGroupsForChangedFiles,
  downloadAndExtractArtifact,
  fetchArtifactsForRun,
  fetchIssueComments,
  githubGet,
  githubPatch,
  githubPost,
  isNotFound,
  type IssueComment,
  REPO,
  TOKEN,
  WORKFLOW_FILE,
  type WorkflowRun,
} from "./ci-check-lib.ts";
import {
  capabilitiesBySuite,
  loadTopology,
  wholeUnits,
} from "./test-topology.ts";
import type { Suite } from "./test-topology/suite.ts";
import { census } from "./test-selection/census.ts";
import { coverageGateFor, measuredSetName } from "./test-selection/coverage.ts";
import { plan } from "./test-selection/plan.ts";
import { fetchManifest, type ManifestFetch } from "./test-selection/store.ts";
import type { Manifest, WithheldReason } from "./test-selection/manifest.ts";
import {
  buildReport,
  MAIN_REPORT_MARKER,
  outcomesOf,
  type PullRequestView,
  renderReport,
  renderWithdrawal,
  type ReportInput,
  reportIsEmpty,
  type RunOutcomes,
  unknownPullRequest,
} from "./test-selection/report.ts";

/** The branch whose runs this reports on. */
export const DEFAULT_BRANCH = "main";

/**
 * The pull request a squash-merged commit's subject names. Undefined for
 * a subject naming none, which is what a direct push looks like.
 *
 * The number is the last one in the subject rather than the first: a
 * subject may mention another pull request or an issue, and the merge
 * number is the one the merge appended.
 */
export function pullRequestOf(subject: string): number | undefined {
  const matches = [...subject.matchAll(/\(#(\d+)\)/g)];
  const last = matches[matches.length - 1];
  return last === undefined ? undefined : Number(last[1]);
}

/**
 * The conclusions a run this reads may have, which is every one that
 * leaves records.
 *
 * A run killed at its bound is the wedge case whose surviving records
 * matter most, and it is the shape a hanging test takes, so it counts
 * the way the relay counts it. What makes a partial run safe to read is
 * that every note needs evidence rather than the absence of it: a first
 * failure needs a failure here and a pass there, a flaky new test needs
 * a disagreement and an identity the store has never seen, and a rename
 * needs the departing test's unit to have recorded something.
 */
const REPORTABLE: ReadonlySet<string> = new Set([
  "success",
  "failure",
  "cancelled",
  "timed_out",
]);

/**
 * Whether a run is one this reports on: a push to the default branch,
 * finished, and of the workflow that runs the tests.
 */
export function isReportable(run: WorkflowRun): boolean {
  return run.event === "push" && run.head_branch === DEFAULT_BRANCH &&
    REPORTABLE.has(run.conclusion);
}

/**
 * The finished run of the test workflow at one commit, on the branch and
 * from the event given.
 *
 * A commit is asked for by name rather than a listing being walked back
 * from the run under report. Pushes to the default branch are not
 * cancelled by their successors, so two of them overlap whenever two
 * merges land close together, and the run before this one in a listing
 * of finished runs can be the run two commits back. Comparing against
 * that one attributes whatever the commit in between broke to this
 * change, which is the mistake the whole comparison exists to prevent.
 *
 * A run still going is not one of these, and neither is a re-run's
 * earlier attempt: the listing is finished runs, newest first.
 */
export async function runAt(
  commit: string,
  event: "push" | "pull_request",
): Promise<WorkflowRun | undefined> {
  const params = new URLSearchParams({
    event,
    status: "completed",
    head_sha: commit,
    per_page: "10",
  });
  if (event === "push") params.set("branch", DEFAULT_BRANCH);
  const data = await githubGet<{ workflow_runs: WorkflowRun[] }>(
    `/repos/${REPO}/actions/workflows/${WORKFLOW_FILE}/runs?${params}`,
  );
  return (data.workflow_runs ?? []).find((run) =>
    REPORTABLE.has(run.conclusion)
  );
}

/**
 * Every record in one extracted `test-records-*` artifact. The gather
 * step always writes the file, so one that is not there is a truncated
 * artifact and contributes nothing.
 */
export async function recordsInDirectory(
  directory: string,
): Promise<TestRecord[]> {
  let text: string;
  try {
    text = await Deno.readTextFile(join(directory, "records.ndjson"));
  } catch {
    return [];
  }
  return parseReportGroups(text).flatMap((group) => group.records);
}

/**
 * The day partitions one run's objects can be under.
 *
 * An object is named for the day its run's attempt started, and a
 * re-running attempt starts whenever it is asked to, so a run created
 * one day and re-run the next has its attempts under two days. Every day
 * from the run's creation to its latest attempt is listed, which is one
 * small prefixed request each.
 */
export function runPartitions(run: WorkflowRun): string[] {
  const days: string[] = [];
  const from = Date.parse(run.created_at);
  const to = Date.parse(run.run_started_at ?? run.created_at);
  if (Number.isNaN(from)) return days;
  const last = Number.isNaN(to) ? from : Math.max(from, to);
  for (let at = from; at <= last + 86_400_000; at += 86_400_000) {
    const day = datePartition(new Date(at).toISOString());
    if (!days.includes(day)) days.push(day);
    if (day === datePartition(new Date(last).toISOString())) break;
  }
  return days;
}

/**
 * What every test in one run did, from the store. Undefined where the
 * store holds nothing for it, because a run whose records never arrived
 * is a run nothing is known about, and reading it as a run that skipped
 * everything is what makes a test it ran look unrun.
 */
export async function outcomesFromStore(
  run: WorkflowRun,
): Promise<RunOutcomes | undefined> {
  const bucket = storeBucket();
  const records: TestRecord[] = [];
  let objects = 0;
  for (const day of runPartitions(run)) {
    const prefix = `${ciSubmissionsPrefix()}/v${RECORD_SCHEMA_VERSION}/` +
      `${day}/run-${run.id}-`;
    for (const objectName of await listObjects({ bucket, prefix })) {
      objects++;
      records.push(...(await readObject({ bucket, objectName })).records);
    }
  }
  return objects === 0 ? undefined : outcomesOf(records);
}

/**
 * What every test in one run did, from the run's own artifacts.
 *
 * Every `test-records-*` artifact counts, including a re-run attempt's,
 * so an identity that passed in one attempt and failed in another folds
 * into the test disagreeing with itself rather than into whichever
 * attempt was uploaded last. The coverage artifact holds no test's record
 * and is left to `coverageOfRun`. Undefined where one of them could not be
 * read, because a run read in part reads as a run that ran less.
 */
export async function outcomesFromArtifacts(
  runId: number,
  listed?: readonly Artifact[],
): Promise<RunOutcomes | undefined> {
  const artifacts = (listed ?? await fetchArtifactsForRun(runId))
    .filter((artifact) =>
      artifact.name.startsWith("test-records-") &&
      coverageArtifactAttempt(artifact.name) === undefined && !artifact.expired
    );
  const records: TestRecord[] = [];
  for (let at = 0; at < artifacts.length; at += ARTIFACTS_AT_ONCE) {
    const batch = artifacts.slice(at, at + ARTIFACTS_AT_ONCE);
    for (const read of await Promise.all(batch.map(readArtifact))) {
      // One artifact this could not read is a share of the run missing
      // from what would otherwise read as the whole of it. Every test in
      // it would look unrun, and a report built on that would withdraw
      // one an earlier attempt correctly made.
      if (read === undefined) {
        console.log(
          `Run ${runId}: an artifact could not be read, so what it ran is ` +
            "not known.",
        );
        return undefined;
      }
      records.push(...read);
    }
  }
  return outcomesOf(records);
}

/**
 * How many artifacts are downloaded at once. A run carries one per test
 * job, and reading two runs one artifact at a time is most of what this
 * spends its time on.
 */
const ARTIFACTS_AT_ONCE = 8;

/** One artifact's records, or nothing where it could not be read. */
async function readArtifact(
  artifact: Artifact,
): Promise<TestRecord[] | undefined> {
  const directory = await downloadAndExtractArtifact(
    artifact.id,
    "test-records-",
  );
  if (directory === null) return undefined;
  try {
    return await recordsInDirectory(directory);
  } finally {
    await Deno.remove(directory, { recursive: true }).catch(() => {});
  }
}

/**
 * Every coverage figure one run measured, from the newest of its coverage
 * artifacts, since a re-run attempt measures the run again. Artifact ids
 * grow with upload.
 */
export async function coverageOfRun(
  runId: number,
  listed?: readonly Artifact[],
): Promise<CoverageFigures> {
  const artifact = (listed ?? await fetchArtifactsForRun(runId))
    .filter((candidate) =>
      coverageArtifactAttempt(candidate.name) !== undefined &&
      !candidate.expired
    )
    .sort((a, b) => b.id - a.id)[0];
  const records = artifact === undefined ? [] : await readArtifact(artifact);
  return coverageFiguresOf(records ?? []);
}

/**
 * What the reporter reads from outside itself.
 *
 * A caller that supplies one of these is saying what is there — what the
 * checkout holds, what the tree declares, what the store has — which is
 * how everything the reporter does with those answers is exercised
 * without a checkout, a tree, or a store to read.
 */
export interface ReportDeps {
  /** Runs git in the checkout. */
  git?: (...args: string[]) => Promise<string>;

  /** The suites the working tree declares. */
  topology?: () => Promise<Suite[]>;

  /** The manifest the store holds at a moment. */
  manifest?: (at: string) => Promise<ManifestFetch>;
}

/** Runs git in the checkout and returns what it printed. */
export async function runGit(...args: string[]): Promise<string> {
  const { code, stdout, stderr } = await new Deno.Command("git", {
    args,
    stdout: "piped",
    stderr: "piped",
  }).output();
  if (code !== 0) {
    throw new Error(
      `git ${args.join(" ")} failed: ${new TextDecoder().decode(stderr)}`,
    );
  }
  return new TextDecoder().decode(stdout);
}

/**
 * The commit at the head of one pull request's branch, and the committer
 * date it carries.
 *
 * That date is the moment the manifest is resolved at, and it is the
 * branch tip's rather than the tip's merge with the default branch. The
 * tip is a commit somebody made, so its date is stable; the merge is
 * built by the continuous-integration provider and dated whenever it
 * last rebuilt it, which moves as the default branch moves.
 *
 * Undefined when the pull request cannot be read. The report is worth
 * more with a note saying its own run could not be read than it is worth
 * not being written, so this is the one place the reporter carries on
 * without an answer.
 */
export async function pullRequestHead(
  pullRequest: number,
): Promise<{ sha: string; at: string } | "absent" | undefined> {
  let head: string;
  try {
    const info = await githubGet<{ head: { sha: string } }>(
      `/repos/${REPO}/pulls/${pullRequest}`,
    );
    head = info.head.sha;
  } catch (error) {
    // A number in a commit subject may name an issue rather than a pull
    // request, and an issue takes comments just as a pull request does.
    // Nothing is posted to one.
    if (isNotFound(error)) return "absent";
    console.warn(`  Warning: could not read PR #${pullRequest}: ${error}`);
    return undefined;
  }
  try {
    const commit = await githubGet<{ commit: { committer: { date: string } } }>(
      `/repos/${REPO}/commits/${head}`,
    );
    const at = Date.parse(commit.commit.committer.date);
    if (Number.isNaN(at)) return undefined;
    return { sha: head, at: new Date(at).toISOString() };
  } catch (error) {
    console.warn(
      `  Warning: could not read PR #${pullRequest}'s head commit: ${error}`,
    );
    return undefined;
  }
}

/**
 * What the packing over one manifest reaches, worked out the way a lane
 * works it out: this tree read against that manifest, packed.
 *
 * Reading the tree is what makes this the answer a lane would give
 * rather than a summary of the manifest, because the capabilities a
 * suite opens are most of what a lane's budget goes on and the manifest
 * holds neither the suites nor which units still exist.
 */
export function manifestView(
  manifest: Manifest,
  suites: Awaited<ReturnType<typeof loadTopology>>,
  changed: ReadonlySet<string>,
): Omit<PullRequestView, "ran"> {
  const seen = census(suites, manifest, changed);
  const packed = plan({
    manifest: seen.manifest,
    mandatory: seen.mandatory,
    capabilities: capabilitiesBySuite(suites),
    wholeUnits: wholeUnits(suites),
  });
  const selected = new Set<string>();
  for (const lane of packed.lanes) {
    for (const selection of lane.selections) {
      selected.add(testIdentityKey(selection.entry.test));
    }
  }
  const withheld = new Map<string, WithheldReason>();
  for (const entry of seen.manifest.withheld) {
    withheld.set(testIdentityKey(entry.test), entry.reason);
  }
  const flakes = new Map<string, FlakeEvidence | undefined>();
  const catches = new Map<string, number>();
  const units = new Map<string, string>();
  for (const entry of manifest.entries) {
    const key = testIdentityKey(entry.test);
    flakes.set(key, entry.flakeEvidence);
    catches.set(key, entry.inputs.catches);
    units.set(key, `${entry.suite}\t${entry.unit}`);
  }
  return { manifest: true, selected, withheld, flakes, catches, units };
}

/**
 * The report this run left on a pull request, when it left one.
 *
 * The marker is what finds it, and the author is what keeps this from
 * editing somebody else's comment that happens to quote the marker: the
 * token this runs under may edit any comment on the pull request, and
 * every review app on it writes as a bot.
 */
function ownReport(
  comments: readonly IssueComment[],
): IssueComment | undefined {
  return comments.find((comment) =>
    comment.body.includes(MAIN_REPORT_MARKER) &&
    comment.author === WORKFLOW_AUTHOR
  );
}

/** The login every comment a workflow token posts is written under. */
const WORKFLOW_AUTHOR = "github-actions[bot]";

/** Posts the comment, or edits the one already there. */
export async function postReport(
  pullRequest: number,
  body: string,
): Promise<void> {
  const marked = ownReport(await fetchIssueComments(pullRequest));
  if (marked === undefined) {
    await githubPost(`/repos/${REPO}/issues/${pullRequest}/comments`, { body });
    console.log(`Posted the run report to PR #${pullRequest}.`);
    return;
  }
  if (marked.body === body) {
    console.log(`The run report on PR #${pullRequest} already says this.`);
    return;
  }
  await githubPatch(`/repos/${REPO}/issues/comments/${marked.id}`, { body });
  console.log(`Updated the run report on PR #${pullRequest}.`);
}

/** Withdraws a report an earlier attempt left, when there is one. */
export async function withdrawReport(
  pullRequest: number,
  body: string,
): Promise<void> {
  const marked = ownReport(await fetchIssueComments(pullRequest));
  if (marked === undefined || marked.body === body) return;
  await githubPatch(`/repos/${REPO}/issues/comments/${marked.id}`, { body });
  console.log(`Withdrew the run report on PR #${pullRequest}.`);
}

/** The run this was asked to report on. */
async function runUnderReport(): Promise<WorkflowRun | undefined> {
  const override = Deno.env.get("MAIN_REPORT_RUN_ID");
  if (override !== undefined && override.length > 0) {
    if (!/^\d+$/.test(override)) {
      throw new Error(`MAIN_REPORT_RUN_ID is not a run id: ${override}`);
    }
    return await githubGet<WorkflowRun>(
      `/repos/${REPO}/actions/runs/${override}`,
    );
  }
  const path = Deno.env.get("GITHUB_EVENT_PATH");
  if (path === undefined) return undefined;
  const event = JSON.parse(await Deno.readTextFile(path)) as {
    workflow_run?: WorkflowRun;
  };
  return event.workflow_run;
}

export async function main(
  dryRun = false,
  deps: ReportDeps = {},
): Promise<void> {
  const git = deps.git ?? runGit;
  const run = await runUnderReport();
  if (run === undefined || !isReportable(run)) {
    console.log(
      `Nothing to report on: ${
        run === undefined ? "no run in the event" : `run ${run.id} is a ` +
          `${run.conclusion} ${run.event} on ${run.head_branch}`
      }.`,
    );
    return;
  }
  const commit = run.head_sha;

  const subject = (await git("log", "-1", "--format=%s", commit)).trim();
  const pullRequest = pullRequestOf(subject);
  if (pullRequest === undefined) {
    console.log(
      `${commit} has no pull request behind it: ${subject}. Nothing to post.`,
    );
    return;
  }

  const parent = (await git("rev-parse", `${commit}^`)).trim();
  const previousRun = await runAt(parent, "push");
  if (previousRun === undefined) {
    console.log(
      `${parent} has no finished run on ${DEFAULT_BRANCH}, so nothing at ` +
        `${commit} can be attributed to it.`,
    );
    return;
  }
  const listedThere = await fetchArtifactsForRun(previousRun.id);
  const previous = await outcomesFromArtifacts(previousRun.id, listedThere);
  if (previous === undefined || previous.size === 0) {
    console.log(
      `Nothing readable from run ${previousRun.id}, so there is nothing to ` +
        "compare against.",
    );
    return;
  }

  const listedHere = await fetchArtifactsForRun(run.id);
  const current = await outcomesFromArtifacts(run.id, listedHere);
  if (current === undefined || current.size === 0) {
    console.log(
      `Nothing readable from run ${run.id}, so there is nothing to say.`,
    );
    return;
  }

  const changed = new Set(
    (await git("diff", "--name-only", parent, commit))
      .split("\n").map((line) => line.trim()).filter((line) => line.length > 0),
  );

  const head = await pullRequestHead(pullRequest);
  if (head === "absent") {
    console.log(
      `${commit}'s subject names #${pullRequest}, which is not a pull ` +
        "request. Nothing to post.",
    );
    return;
  }
  let view: PullRequestView = unknownPullRequest();
  if (head !== undefined) {
    const theirRun = await runAt(head.sha, "pull_request");
    const ran = theirRun === undefined
      ? undefined
      : await outcomesFromStore(theirRun);
    const fetched = await (deps.manifest ?? ((at: string) =>
      fetchManifest({ at })))(head.at);
    if (fetched.manifest === undefined) {
      console.log(`No manifest at ${head.at}: ${fetched.absent}`);
    }
    view = {
      ...(fetched.manifest === undefined ? unknownPullRequest() : manifestView(
        fetched.manifest,
        await (deps.topology ?? loadTopology)(),
        changed,
      )),
      ...(ran === undefined ? {} : { ran }),
    };
  }

  // The same function the gate runs, over the same declarations, so the
  // note about a rise and the gate that was supposed to catch it cannot
  // disagree about which sets were gated.
  const gate = coverageGateFor(
    await (deps.topology ?? loadTopology)(),
    changed,
  );
  const input: ReportInput = {
    current,
    previous,
    pullRequest: view,
    coverage: await coverageOfRun(run.id, listedHere),
    coverageBefore: await coverageOfRun(previousRun.id, listedThere),
    touched: coverageGroupsForChangedFiles(changed),
    coverageGate: {
      reached: gate.reached.map(measuredSetName),
      ran: gate.off === undefined,
    },
    day: new Date().toISOString().slice(0, 10),
  };
  console.log(
    `Run ${run.id} judged ${input.current.size} identities, run ` +
      `${previousRun.id} at ${parent.slice(0, 12)} judged ` +
      `${input.previous.size}, and PR #${pullRequest}'s own run judged ` +
      `${view.ran?.size ?? 0}.`,
  );

  const context = { commit, runUrl: run.html_url };
  const report = buildReport(input);
  const body = reportIsEmpty(report)
    ? undefined
    : renderReport(report, context);
  if (dryRun) {
    console.log(
      body === undefined
        ? `Would withdraw any report on PR #${pullRequest}.`
        : `Would comment on PR #${pullRequest}:\n\n${body}`,
    );
    return;
  }
  if (body === undefined) {
    await withdrawReport(pullRequest, renderWithdrawal(context));
    return;
  }
  await postReport(pullRequest, body);
}

if (import.meta.main) {
  if (!TOKEN) {
    console.error("GITHUB_TOKEN is required.");
    Deno.exit(1);
  }
  // Best-effort, exactly as the coverage comment is: a comment nobody
  // gates on must never turn a run red, and least of all a run on the
  // default branch that has already passed.
  try {
    await main(Deno.args.includes("--dry-run"));
  } catch (error) {
    // An annotation rather than a line in the log, so a reporter that
    // stopped is visible on the run rather than only to whoever opens it.
    console.log(`::warning title=Run report::${error}`);
  }
}
