/**
 * Noticing, through the GitHub webhook relay, that the pull request for a
 * branch `P` pushed has been opened. The relay passes on each delivery of the
 * organization's webhook the moment GitHub makes it, and keeps none for a
 * subscriber that was not connected, so the viewer opens the page for creating
 * the pull request once it has connected.
 */

import {
  FrameReader,
  type GitHubDelivery,
  readDelivery,
  type RelayConnect,
} from "@commonfabric/github-webhooks/relay";
import { isObjectNotArray } from "@commonfabric/js-values/types";
import { githubRepositoryPage } from "./blame.ts";
import type { GitQuery } from "./push.ts";

/** What a pull request for the pushed branch has as its head. */
export interface PullRequestHead {
  /** The GitHub page of the repository the branch is pushed to. */
  readonly repository: string;

  /** The branch's name. */
  readonly branch: string;

  /** The commit the branch is pushed at. */
  readonly commit: string;
}

/** What a pull request's address on GitHub looks like. */
export const PULL_REQUEST_URL =
  /^https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/pull\/\d+$/;

/**
 * Returns the head that the checked-out commit, pushed to `branch` of
 * `origin`, gives a pull request, or null when `origin` is not on GitHub.
 */
export function pushedHead(
  git: GitQuery,
  branch: string,
): PullRequestHead | null {
  const remote = git(["remote", "get-url", "--push", "origin"])?.trim();
  const repository = remote === undefined ? null : githubRepositoryPage(remote);
  const commit = git(["rev-parse", "--verify", "--quiet", "HEAD"])?.trim();
  return repository === null || !commit ? null : { repository, branch, commit };
}

/**
 * Returns the address of the pull request that `delivery` reports was opened
 * with `head` as its head, or null when it reports nothing of the kind, or
 * gives an address that is not a pull request's on GitHub.
 */
export function openedPullRequest(
  delivery: GitHubDelivery,
  head: PullRequestHead,
): string | null {
  const { event, payload } = delivery;
  if (
    event !== "pull_request" || !isObjectNotArray(payload) ||
    payload.action !== "opened"
  ) return null;
  const pullRequest = payload.pull_request;
  if (!isObjectNotArray(pullRequest)) return null;
  const { head: opened, html_url: url } = pullRequest;
  if (!isObjectNotArray(opened) || typeof url !== "string") return null;
  const repository = opened.repo;
  const page = isObjectNotArray(repository) ? repository.html_url : undefined;
  return typeof page === "string" &&
      page.toLowerCase() === head.repository.toLowerCase() &&
      opened.ref === head.branch && opened.sha === head.commit &&
      PULL_REQUEST_URL.test(url)
    ? url
    : null;
}

/**
 * Connects to the relay with `connect`, calls `connected` once it has, and
 * resolves with the address of the pull request opened with `head` as its
 * head once a delivery reports it.
 * Rejects when the connection cannot be opened, or ends first, or carries a
 * frame the relay would not send, or `signal` aborts.
 */
export async function watchForPullRequest(
  connect: RelayConnect,
  head: PullRequestHead,
  signal: AbortSignal,
  connected: () => void = () => {},
): Promise<string> {
  signal.throwIfAborted();
  const connection = await connect(signal);
  const frames = new FrameReader(connection.readable);
  const stop = () => frames.cancel();
  signal.addEventListener("abort", stop);
  try {
    signal.throwIfAborted();
    connected();
    for (;;) {
      signal.throwIfAborted();
      const frame = await readDelivery(frames);
      if (frame === undefined) {
        signal.throwIfAborted();
        throw new Error("the webhook relay closed the connection");
      }
      // A delivery the viewer cannot read cannot say the pull request opened.
      const url = frame.delivery && openedPullRequest(frame.delivery, head);
      if (url) return url;
    }
  } finally {
    signal.removeEventListener("abort", stop);
    frames.release();
    try {
      connection.close();
    } catch {
      // A connection that has already closed has nothing left to close.
    }
  }
}
