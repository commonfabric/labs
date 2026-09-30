#!/usr/bin/env -S deno run --allow-net --allow-env --allow-read

/**
 * Posts the pull-request comment the coverage gate wrote.
 *
 * The gate, `tasks/coverage-gate.ts`, runs in the `Status` job on the
 * `pull_request` event, where a fork's pull request gets a read-only token
 * and cannot be commented on. It writes the comment it wants posted to
 * `coverage-comment.json`, which travels as an artifact, and the Pull Request
 * Comments workflow runs this from the base repository's context with a write
 * token.
 *
 * A pull request has at most one coverage comment: the one carrying
 * `COVERAGE_SUGGESTION_MARKER`. A `regressed` payload posts that comment, or
 * replaces its body. A `resolved` payload replaces its body where there is
 * one, and posts nothing where there is not, since a pull request the gate
 * never failed has nothing to be told. An absent or invalid payload is
 * reported and skipped. Posting is best-effort: a failure to reach GitHub is
 * logged rather than thrown, so the workflow stays green. A missing
 * `HEAD_SHA` is a misconfigured workflow rather than a failure of GitHub's,
 * and fails the run.
 *
 * The payload was written by the pull request's own code, and this posts with
 * a write token, so the pull request it names is held to being the one whose
 * run wrote it: its head has to be the commit that run tested. A payload
 * naming any other pull request or issue is refused.
 *
 * Environment:
 *   GITHUB_TOKEN           - Required.
 *   HEAD_SHA               - Required, the head commit the run tested.
 *   GITHUB_REPOSITORY      - Optional, defaults to "commonfabric/labs".
 *   COVERAGE_COMMENT_FILE  - Optional, path to the payload file.
 */

import {
  COVERAGE_COMMENT_FILE,
  COVERAGE_SUGGESTION_MARKER,
  type CoverageCommentPayload,
  fetchIssueComments,
  githubGet,
  githubPatch,
  githubPost,
  REPO,
  TOKEN,
} from "./ci-check-lib.ts";

/**
 * Reads a parsed payload file, or returns undefined for anything that is not
 * a payload. A body that does not open with the marker is not one: posted,
 * it would be a coverage comment that no later run could find to update.
 */
function payloadOf(raw: unknown): CoverageCommentPayload | undefined {
  if (
    typeof raw !== "object" || raw === null || !("prNumber" in raw) ||
    !("state" in raw) || !("body" in raw)
  ) {
    return undefined;
  }
  const { prNumber, state, body } = raw;
  if (
    typeof prNumber !== "number" || !Number.isInteger(prNumber) ||
    prNumber <= 0 || (state !== "regressed" && state !== "resolved") ||
    typeof body !== "string" || !body.startsWith(COVERAGE_SUGGESTION_MARKER)
  ) {
    return undefined;
  }
  return { prNumber, state, body };
}

/**
 * Reads the pending payload and posts or updates the pull request's coverage
 * comment accordingly. Throws when `HEAD_SHA` is unset or empty, whatever the
 * payload. Never throws for a missing or invalid payload, or for a failure to
 * reach GitHub; each is logged instead.
 */
export async function postCoverageComment(): Promise<void> {
  const tested = Deno.env.get("HEAD_SHA");
  if (tested === undefined || tested.length === 0) {
    throw new Error(
      "`HEAD_SHA` is required, to know which pull request to post to.",
    );
  }

  const file = Deno.env.get("COVERAGE_COMMENT_FILE") ?? COVERAGE_COMMENT_FILE;

  let raw: string;
  try {
    raw = await Deno.readTextFile(file);
  } catch {
    console.log(`No ${file} present; nothing to post.`);
    return;
  }

  let payload: CoverageCommentPayload | undefined;
  try {
    payload = payloadOf(JSON.parse(raw));
  } catch (error) {
    console.error(`Could not parse ${file}: ${error}`);
    return;
  }
  if (payload === undefined) {
    console.error(`Invalid coverage comment payload in ${file}.`);
    return;
  }

  const { prNumber, state, body } = payload;
  try {
    const pull = await githubGet<{ head: { sha: string } }>(
      `/repos/${REPO}/pulls/${prNumber}`,
    );
    if (pull.head.sha !== tested) {
      console.error(
        `The payload names PR #${prNumber}, whose head is ${pull.head.sha}, ` +
          `and the run that wrote it tested ${tested}; nothing is posted.`,
      );
      return;
    }
    const marked = (await fetchIssueComments(prNumber)).find((comment) =>
      comment.body.includes(COVERAGE_SUGGESTION_MARKER)
    );
    if (marked === undefined) {
      if (state === "resolved") {
        console.log(
          `No coverage comment on PR #${prNumber}; nothing to resolve.`,
        );
        return;
      }
      await githubPost(`/repos/${REPO}/issues/${prNumber}/comments`, { body });
      console.log(`Posted coverage comment to PR #${prNumber}.`);
      return;
    }
    if (marked.body === body) {
      console.log(`Coverage comment on PR #${prNumber} already up to date.`);
      return;
    }
    await githubPatch(`/repos/${REPO}/issues/comments/${marked.id}`, {
      body,
    });
    console.log(`Updated coverage comment on PR #${prNumber}.`);
  } catch (error) {
    console.warn(
      `  Warning: could not post or update coverage comment on PR #${prNumber}: ${error}`,
    );
  }
}

if (import.meta.main) {
  if (!TOKEN) {
    console.error("GITHUB_TOKEN is required.");
    Deno.exit(1);
  }
  await postCoverageComment();
}
