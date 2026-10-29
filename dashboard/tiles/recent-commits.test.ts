import { expect } from "@std/expect";
import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { FakeTime } from "@std/testing/time";

import { LOOM_REPO, RECENT_WINDOW, REPO, WEAVER_REPO } from "../config.ts";
import { staticGitHubCredential } from "../github-auth.ts";
import { FakeRelay, pushPayload } from "../test/webhook-relay.ts";
import type { Ctx, Run } from "../types.ts";
import {
  type Commit,
  commitGanttHref,
  commitRows,
  createRecentCommits,
  OrganizationCommits,
  runOutcome,
} from "./recent-commits.ts";

const ORG = REPO.split("/")[0];
const CREDENTIAL = staticGitHubCredential("test-token");

function run(over: Partial<Run> = {}): Run {
  return {
    id: 1,
    status: "completed",
    conclusion: "success",
    run_attempt: 1,
    event: "push",
    head_sha: "a".repeat(40),
    display_title: "a change",
    created_at: "2026-09-30T10:00:00Z",
    run_started_at: "2026-09-30T10:00:00Z",
    updated_at: "2026-09-30T10:30:00Z",
    html_url: "https://github.com/commonfabric/labs/actions/runs/1",
    head_commit: null,
    ...over,
  };
}

function commit(repo: string, sha: string, at: string, title = sha): Commit {
  return { repo, sha, title, at };
}

function ctx(
  runsByRepo: (repo: string) => Run[],
  over: Partial<Ctx> = {},
): Ctx {
  return {
    runs: () => Promise.resolve(runsByRepo(REPO)),
    runsFor: ({ repo }) => Promise.resolve(runsByRepo(repo)),
    env: () => undefined,
    ...over,
  };
}

/** The rows of a view's list, each the markup after its `<div class="ev">`. */
function rowsOf(extra: string | undefined): string[] {
  return (extra ?? "").split(`<div class="ev">`).slice(1);
}

/**
 * A repository the GitHub stand-in lists, and what it answers for it. Its
 * history holds, newest first, the merge commit of a pull request by a person
 * for each of `commits`, numbered from 1 and titled with the commit's title,
 * then each of `others`. `status` is the HTTP status GitHub answers with,
 * `rateLimited` whether that answer says a rate limit was exceeded,
 * `errorType` the type of a GraphQL error it answers with beside the history,
 * and `answer` a body it answers with in place of all of that.
 */
interface RepoSpec {
  name: string;
  pushedAt: string | null;
  archived?: boolean;
  commits?: Commit[];
  others?: Record<string, unknown>[];
  status?: number;
  rateLimited?: boolean;
  errorType?: string;
  answer?: unknown;
}

/**
 * Helper for the tests that read the organization's commits, which replaces
 * `fetch` with a stand-in for GitHub's organization repository listing and the
 * GraphQL query for a repository's history that answers from `repos`. It
 * records each listing's path, and each query as `graphql` and the repository
 * it names, in `calls`. A query not sent as a `POST` is answered with 405.
 * Returns a function that restores `fetch`.
 */
function standIn(repos: () => RepoSpec[], calls: string[]): () => void {
  const answer = (url: URL, init?: RequestInit): Response => {
    if (url.pathname === `/orgs/${ORG}/repos`) {
      calls.push(url.pathname + url.search);
      return Response.json(repos().map((repo) => ({
        full_name: `${ORG}/${repo.name}`,
        default_branch: "main",
        archived: repo.archived ?? false,
        pushed_at: repo.pushedAt,
      })));
    }
    if (init?.method !== "POST") {
      return new Response("method not allowed", { status: 405 });
    }
    const { variables } = JSON.parse(String(init.body));
    calls.push(`graphql ${variables.owner}/${variables.name}`);
    const repo = repos().find((spec) => spec.name === variables.name);
    if (!repo) return new Response("not found", { status: 404 });
    if (repo.status !== undefined) {
      return new Response("refused", {
        status: repo.status,
        headers: repo.rateLimited ? { "x-ratelimit-remaining": "0" } : {},
      });
    }
    if (repo.answer !== undefined) return Response.json(repo.answer);
    const nodes = [
      ...(repo.commits ?? []).map((held, index) => ({
        oid: held.sha,
        associatedPullRequests: {
          nodes: [{
            number: index + 1,
            title: held.title,
            baseRefName: "main",
            mergedAt: held.at,
            mergeCommit: { oid: held.sha },
            author: { __typename: "User" },
          }],
        },
      })),
      ...(repo.others ?? []),
    ];
    return Response.json({
      data: {
        repository: {
          defaultBranchRef: nodes.length === 0
            ? null
            : { target: { history: { nodes } } },
        },
      },
      ...(repo.errorType === undefined
        ? {}
        : { errors: [{ type: repo.errorType, message: "refused" }] }),
    });
  };
  const real = globalThis.fetch;
  globalThis.fetch = ((input: string | URL | Request, init?: RequestInit) =>
    Promise.resolve(
      answer(
        new URL(input instanceof Request ? input.url : String(input)),
        init,
      ),
    )) as typeof fetch;
  return () => {
    globalThis.fetch = real;
  };
}

describe("recent-commits", () => {
  let calls: string[];
  let logged: string[];
  let restore: () => void;
  const realError = console.error;

  beforeEach(() => {
    calls = [];
    logged = [];
    restore = () => {};
    console.error = (...args: unknown[]) => {
      logged.push(args.join(" "));
    };
  });

  afterEach(() => {
    restore();
    console.error = realError;
  });

  describe("runOutcome()", () => {
    it("returns a green dot and `green` for a run that passed on its first attempt", () => {
      expect(runOutcome(run())).toEqual({ dot: "green", text: "green" });
    });

    it("returns a gray dot and names the attempt for a run that passed only on a retry", () => {
      expect(runOutcome(run({ run_attempt: 3 }))).toEqual({
        dot: "gray",
        text: "green on retry #3",
      });
    });

    it("returns a red dot and the conclusion for a run that failed", () => {
      expect(runOutcome(run({ conclusion: "timed_out" }))).toEqual({
        dot: "red",
        text: "timed_out",
      });
    });

    it("returns a gray dot and `done` for a finished run with no conclusion", () => {
      expect(runOutcome(run({ conclusion: null }))).toEqual({
        dot: "gray",
        text: "done",
      });
    });

    it("returns the running dot, naming any attempt past the first, for a run still going", () => {
      const going = run({ status: "in_progress", conclusion: null });
      expect(runOutcome(going)).toEqual({ dot: "run", text: "running" });
      expect(runOutcome({ ...going, run_attempt: 2 })).toEqual({
        dot: "run",
        text: "running · attempt 2",
      });
    });
  });

  describe("commitRows()", () => {
    it("returns every commit, newest first across repositories", () => {
      const rows = commitRows([
        commit(REPO, "a", "2026-09-30T10:00:00Z"),
        commit(REPO, "c", "2026-09-30T12:00:00Z"),
        commit(`${ORG}/specs`, "b", "2026-09-30T11:00:00Z"),
      ], []);
      expect(rows.map((row) => row.commit.sha)).toEqual(["c", "b", "a"]);
      expect(rows.every((row) => row.run === undefined)).toBe(true);
    });

    it("puts the newest run of a commit on its row, and no run on the same commit hash of another repository", () => {
      const push = run({ id: 1, repo: REPO, head_sha: "a" });
      const dispatched = run({
        id: 2,
        repo: REPO,
        head_sha: "a",
        event: "workflow_dispatch",
        created_at: "2026-09-30T13:00:00Z",
      });
      const rows = commitRows([
        commit(REPO, "a", "2026-09-30T10:00:00Z"),
        commit(LOOM_REPO, "a", "2026-09-30T09:00:00Z"),
      ], [dispatched, push]);
      expect(rows.map((row) => row.run?.id)).toEqual([2, undefined]);
    });

    it("adds a row titled by its first line and dated when the run was created for the commit of a push run that the commits lack, and none for a run of another event", () => {
      const rows = commitRows([commit(REPO, "a", "2026-09-30T10:00:00Z")], [
        run({
          id: 1,
          repo: WEAVER_REPO,
          head_sha: "w",
          created_at: "2026-09-30T11:00:00Z",
          head_commit: { message: "weaver change (#5)\n\nbody" },
        }),
        run({
          id: 2,
          repo: LOOM_REPO,
          head_sha: "l",
          event: "workflow_dispatch",
          created_at: "2026-09-30T12:00:00Z",
        }),
      ]);
      expect(rows.map((row) => row.commit)).toEqual([
        commit(WEAVER_REPO, "w", "2026-09-30T11:00:00Z", "weaver change (#5)"),
        commit(REPO, "a", "2026-09-30T10:00:00Z"),
      ]);
      expect(rows[0].run?.id).toBe(1);
    });
  });

  describe("commitGanttHref()", () => {
    it("returns the Gantt of every successful push run of the commit, and null for a run that cannot have one", () => {
      const sha = "a".repeat(40);
      const first = run({ id: 41, repo: REPO, head_sha: sha });
      const second = run({ id: 42, repo: REPO, head_sha: sha, run_attempt: 2 });
      const failed = run({
        id: 43,
        repo: REPO,
        head_sha: sha,
        conclusion: "failure",
      });
      const loom = run({ id: 44, repo: LOOM_REPO, head_sha: sha });
      const dispatched = run({
        id: 45,
        repo: REPO,
        head_sha: sha,
        event: "workflow_dispatch",
      });
      const href = commitGanttHref(first, [
        first,
        second,
        failed,
        loom,
        dispatched,
      ]);
      const target = new URL(href ?? "", "http://dashboard");
      expect(target.pathname).toBe("/ci-gantt");
      expect(target.searchParams.get("repo")).toBe("labs");
      expect(target.searchParams.get("sha")).toBe(sha);
      expect(target.searchParams.getAll("run")).toEqual(["41:1", "42:2"]);
      expect(
        new URL(commitGanttHref(loom, [loom]) ?? "", "http://dashboard")
          .searchParams.get("repo"),
      ).toBe("loom");

      const weaver = run({ repo: WEAVER_REPO, head_sha: sha });
      expect(commitGanttHref(weaver, [weaver])).toBe(null);
      expect(commitGanttHref({ ...first, head_sha: "" }, [first])).toBe(null);
      expect(commitGanttHref(failed, [first, failed])).toBe(null);
      const tooMany = Array.from(
        { length: 151 },
        (_, index) => run({ id: 1_000 + index, repo: REPO, head_sha: sha }),
      );
      expect(commitGanttHref(tooMany[0], tooMany)).toBe(null);
    });
  });

  describe("OrganizationCommits", () => {
    describe("instance members", () => {
      describe("refresh()", () => {
        describe("given the relay", () => {
          const labs = (shas: string[]): RepoSpec => ({
            name: "labs",
            pushedAt: "2026-09-30T12:00:00Z",
            commits: shas.map((sha) => commit(REPO, sha, "2026-09-30T12:00:00Z")),
          });

          it("reads nothing while the relay vouches for the last listing and no push has been delivered", async () => {
            const relay = new FakeRelay();
            await relay.open();
            restore = standIn(() => [labs(["l"])], calls);
            const organization = new OrganizationCommits(relay.webhooks);
            await organization.refresh(CREDENTIAL);
            await relay.deliver("push", pushPayload(REPO, "refs/heads/feature"));
            calls.length = 0;

            expect(organization.current).toBe(true);
            await organization.refresh(CREDENTIAL);
            expect(calls).toEqual([]);
          });

          it("reads the history of a repository delivered as pushed to, without listing, until it starts at the commit pushed", async () => {
            const relay = new FakeRelay();
            await relay.open();
            let repos = [labs(["l"])];
            restore = standIn(() => repos, calls);
            const organization = new OrganizationCommits(relay.webhooks);
            await organization.refresh(CREDENTIAL);
            await relay.deliver(
              "push",
              pushPayload(REPO, "refs/heads/main", "m"),
            );
            calls.length = 0;

            expect(organization.current).toBe(false);
            expect(await organization.refresh(CREDENTIAL)).toBe(false);
            expect(organization.current).toBe(false);
            repos = [labs(["m", "l"])];
            expect(await organization.refresh(CREDENTIAL)).toBe(true);

            expect(organization.current).toBe(true);
            expect(calls).toEqual([`graphql ${ORG}/labs`, `graphql ${ORG}/labs`]);
          });

          it("reads again a repository whose read failed, however the relay vouches", async () => {
            const relay = new FakeRelay();
            await relay.open();
            let repos: RepoSpec[] = [{ ...labs(["l"]), status: 502 }];
            restore = standIn(() => repos, calls);
            const organization = new OrganizationCommits(relay.webhooks);
            await organization.refresh(CREDENTIAL);
            expect(organization.current).toBe(false);
            repos = [labs(["l"])];
            calls.length = 0;

            expect(await organization.refresh(CREDENTIAL)).toBe(true);

            expect(calls).toEqual([`graphql ${ORG}/labs`]);
            expect(organization.current).toBe(true);
          });

          it("lists the repositories again for a push to one the listing leaves out, and drops the push once a later listing leaves it out too", async () => {
            const relay = new FakeRelay();
            await relay.open();
            let repos = [labs(["l"])];
            restore = standIn(() => repos, calls);
            const organization = new OrganizationCommits(relay.webhooks);
            await organization.refresh(CREDENTIAL);
            await relay.deliver(
              "push",
              pushPayload(`${ORG}/hidden`, "refs/heads/main", "h"),
            );
            calls.length = 0;

            await organization.refresh(CREDENTIAL);
            expect(calls).toEqual([`/orgs/${ORG}/repos?per_page=100&page=1`]);
            expect(organization.current).toBe(true);

            await relay.deliver(
              "push",
              pushPayload(`${ORG}/fresh`, "refs/heads/main", "f"),
            );
            repos = [...repos, {
              name: "fresh",
              pushedAt: "2026-09-30T13:00:00Z",
              commits: [commit(`${ORG}/fresh`, "f", "2026-09-30T13:00:00Z")],
            }];
            calls.length = 0;
            await organization.refresh(CREDENTIAL);
            expect(calls).toEqual([
              `/orgs/${ORG}/repos?per_page=100&page=1`,
              `graphql ${ORG}/fresh`,
            ]);
            expect(organization.current).toBe(true);
          });

          it("leaves out a repository a delivery says was deleted, until a listing leaves it out itself", async () => {
            const relay = new FakeRelay();
            await relay.open();
            const specs = {
              name: "specs",
              pushedAt: "2026-09-30T11:00:00Z",
              commits: [commit(`${ORG}/specs`, "s", "2026-09-30T11:00:00Z")],
            };
            let repos = [labs(["l"]), specs];
            restore = standIn(() => repos, calls);
            const organization = new OrganizationCommits(relay.webhooks);
            await organization.refresh(CREDENTIAL);
            await relay.deliver("repository", {
              action: "deleted",
              repository: { full_name: `${ORG}/specs` },
            });

            expect(await organization.refresh(CREDENTIAL)).toBe(true);
            expect(organization.commits.map((held) => held.sha)).toEqual(["l"]);

            repos = [labs(["l"])];
            await relay.deliver("repository", {
              action: "created",
              repository: { full_name: `${ORG}/specs` },
            });
            repos = [labs(["l"]), specs];
            await organization.refresh(CREDENTIAL);
            expect(organization.commits.map((held) => held.sha).sort()).toEqual([
              "l",
              "s",
            ]);
          });

          it("keeps listing a repository a transfer delivery names", async () => {
            const relay = new FakeRelay();
            await relay.open();
            restore = standIn(() => [labs(["l"])], calls);
            const organization = new OrganizationCommits(relay.webhooks);
            await organization.refresh(CREDENTIAL);
            await relay.deliver("repository", {
              action: "transferred",
              repository: { full_name: REPO },
            });

            await organization.refresh(CREDENTIAL);

            expect(organization.commits.map((held) => held.sha)).toEqual(["l"]);
          });

          it("lists the repositories again once a repository delivery arrives", async () => {
            const relay = new FakeRelay();
            await relay.open();
            restore = standIn(() => [labs(["l"])], calls);
            const organization = new OrganizationCommits(relay.webhooks);
            await organization.refresh(CREDENTIAL);
            await relay.deliver("repository", { action: "created" });
            calls.length = 0;

            await organization.refresh(CREDENTIAL);

            expect(calls).toEqual([`/orgs/${ORG}/repos?per_page=100&page=1`]);
          });
        });

        it("reads the commits of every repository that is not archived, and returns `true`", async () => {
          restore = standIn(() => [
            {
              name: "labs",
              pushedAt: "2026-09-30T12:00:00Z",
              commits: [commit(REPO, "l", "2026-09-30T12:00:00Z")],
            },
            {
              name: "specs",
              pushedAt: "2026-09-30T11:00:00Z",
              commits: [commit(`${ORG}/specs`, "s", "2026-09-30T11:00:00Z")],
            },
            {
              name: "old",
              pushedAt: "2026-01-01T00:00:00Z",
              archived: true,
              commits: [commit(`${ORG}/old`, "o", "2026-01-01T00:00:00Z")],
            },
          ], calls);
          const organization = new OrganizationCommits();
          expect(await organization.refresh(CREDENTIAL)).toBe(true);
          expect(organization.commits.map((held) => held.sha).sort()).toEqual([
            "l",
            "s",
          ]);
          expect(calls).toEqual([
            `/orgs/${ORG}/repos?per_page=100&page=1`,
            `graphql ${ORG}/labs`,
            `graphql ${ORG}/specs`,
          ]);
        });

        it("reads again only the repositories pushed to since, and returns `false` when no default branch moved", async () => {
          const repos: RepoSpec[] = [
            {
              name: "labs",
              pushedAt: "2026-09-30T12:00:00Z",
              commits: [commit(REPO, "l", "2026-09-30T12:00:00Z")],
            },
            {
              name: "specs",
              pushedAt: "2026-09-30T11:00:00Z",
              commits: [commit(`${ORG}/specs`, "s", "2026-09-30T11:00:00Z")],
            },
          ];
          restore = standIn(() => repos, calls);
          const organization = new OrganizationCommits();
          await organization.refresh(CREDENTIAL);

          // A push to a branch other than the default one.
          repos[0] = { ...repos[0], pushedAt: "2026-09-30T13:00:00Z" };
          calls.length = 0;
          expect(await organization.refresh(CREDENTIAL)).toBe(false);
          expect(calls).toEqual([
            `/orgs/${ORG}/repos?per_page=100&page=1`,
            `graphql ${ORG}/labs`,
          ]);

          repos[0] = {
            ...repos[0],
            pushedAt: "2026-09-30T14:00:00Z",
            commits: [
              commit(REPO, "m", "2026-09-30T14:00:00Z"),
              commit(REPO, "l", "2026-09-30T12:00:00Z"),
            ],
          };
          expect(await organization.refresh(CREDENTIAL)).toBe(true);
          expect(organization.commits.map((held) => held.sha)).toEqual([
            "m",
            "l",
            "s",
          ]);
        });

        it("keeps a repository's commits when GitHub fails to answer, and reads them again on the next refresh", async () => {
          const repos: RepoSpec[] = [{
            name: "labs",
            pushedAt: "2026-09-30T12:00:00Z",
            commits: [commit(REPO, "l", "2026-09-30T12:00:00Z")],
          }];
          restore = standIn(() => repos, calls);
          const organization = new OrganizationCommits();
          await organization.refresh(CREDENTIAL);

          repos[0] = {
            ...repos[0],
            pushedAt: "2026-09-30T13:00:00Z",
            status: 500,
          };
          expect(await organization.refresh(CREDENTIAL)).toBe(false);
          expect(organization.commits.map((held) => held.sha)).toEqual(["l"]);
          expect(logged.join("\n")).toContain(
            `recent commits: could not read ${ORG}/labs's commits: GitHub API graphql failed: HTTP 500`,
          );

          repos[0] = {
            name: "labs",
            pushedAt: "2026-09-30T13:00:00Z",
            commits: [commit(REPO, "m", "2026-09-30T13:00:00Z")],
          };
          calls.length = 0;
          expect(await organization.refresh(CREDENTIAL)).toBe(true);
          expect(calls).toContain(
            `graphql ${ORG}/labs`,
          );
          expect(organization.commits.map((held) => held.sha)).toEqual(["m"]);
        });

        it("keeps a repository's commits when GitHub refuses to list them, counts the refusal, and reads them again only after its next push", async () => {
          const repos: RepoSpec[] = [{
            name: "labs",
            pushedAt: "2026-09-30T12:00:00Z",
            commits: [commit(REPO, "l", "2026-09-30T12:00:00Z")],
          }];
          restore = standIn(() => repos, calls);
          const organization = new OrganizationCommits();
          await organization.refresh(CREDENTIAL);

          repos[0] = {
            ...repos[0],
            pushedAt: "2026-09-30T13:00:00Z",
            status: 403,
          };
          expect(await organization.refresh(CREDENTIAL)).toBe(true);
          expect(organization.commits.map((held) => held.sha)).toEqual(["l"]);
          expect(organization.refused).toEqual(new Set([REPO]));
          calls.length = 0;
          expect(await organization.refresh(CREDENTIAL)).toBe(false);
          expect(calls).toEqual([`/orgs/${ORG}/repos?per_page=100&page=1`]);

          repos[0] = {
            name: "labs",
            pushedAt: "2026-09-30T14:00:00Z",
            commits: [commit(REPO, "m", "2026-09-30T14:00:00Z")],
          };
          expect(await organization.refresh(CREDENTIAL)).toBe(true);
          expect(organization.commits.map((held) => held.sha)).toEqual(["m"]);
          expect(organization.refused).toEqual(new Set());
        });

        it("counts a GraphQL `FORBIDDEN` error or a missing repository as a refusal, and reads a repository again on the next refresh after any other GraphQL error or a rate limit", async () => {
          const repos: RepoSpec[] = [
            {
              name: "secret",
              pushedAt: "2026-09-30T12:00:00Z",
              errorType: "FORBIDDEN",
            },
            {
              name: "hidden",
              pushedAt: "2026-09-30T12:00:00Z",
              answer: { data: { repository: null } },
            },
            {
              name: "busy",
              pushedAt: "2026-09-30T12:00:00Z",
              errorType: "RATE_LIMITED",
            },
            {
              name: "throttled",
              pushedAt: "2026-09-30T12:00:00Z",
              status: 403,
              rateLimited: true,
            },
          ];
          restore = standIn(() => repos, calls);
          const organization = new OrganizationCommits();
          await organization.refresh(CREDENTIAL);
          expect(organization.refused).toEqual(
            new Set([`${ORG}/secret`, `${ORG}/hidden`]),
          );

          calls.length = 0;
          await organization.refresh(CREDENTIAL);
          expect(calls).toEqual([
            `/orgs/${ORG}/repos?per_page=100&page=1`,
            `graphql ${ORG}/busy`,
            `graphql ${ORG}/throttled`,
          ]);
        });

        it("holds, in the order of the branch's history, the commits that merged pull requests by people, and no other commit", async () => {
          const pull = (over: Record<string, unknown>) => ({
            number: 9,
            title: "A change",
            baseRefName: "main",
            mergedAt: "2026-09-30T09:00:00Z",
            mergeCommit: { oid: "branch-tip" },
            author: { __typename: "User" },
            ...over,
          });
          restore = standIn(() => [{
            name: "infra",
            pushedAt: "2026-09-30T12:00:00Z",
            commits: [
              commit(`${ORG}/infra`, "newer", "2026-09-30T11:00:00Z"),
              commit(`${ORG}/infra`, "older", "2026-09-30T10:00:00Z"),
            ],
            others: [
              // A commit of a branch that a merge commit brought onto the
              // default branch.
              {
                oid: "branch-commit",
                associatedPullRequests: { nodes: [pull({})] },
              },
              {
                oid: "advance",
                associatedPullRequests: {
                  nodes: [pull({
                    title: "Advance a deployment",
                    mergeCommit: { oid: "advance" },
                    author: { __typename: "Bot" },
                  })],
                },
              },
              {
                oid: "ghost",
                associatedPullRequests: {
                  nodes: [pull({ mergeCommit: { oid: "ghost" }, author: null })],
                },
              },
              // A pull request into another branch, which reached the
              // default branch through that branch's merge.
              {
                oid: "release",
                associatedPullRequests: {
                  nodes: [pull({
                    baseRefName: "release",
                    mergeCommit: { oid: "release" },
                  })],
                },
              },
              { oid: "pushed", associatedPullRequests: { nodes: [] } },
            ],
          }], calls);
          const organization = new OrganizationCommits();
          await organization.refresh(CREDENTIAL);
          expect(organization.commits).toEqual([
            commit(`${ORG}/infra`, "newer", "2026-09-30T11:00:00Z", "newer (#1)"),
            commit(`${ORG}/infra`, "older", "2026-09-30T10:00:00Z", "older (#2)"),
            commit(`${ORG}/infra`, "ghost", "2026-09-30T09:00:00Z", "A change (#9)"),
          ]);
        });

        it("logs and throws away a repository's read when GitHub's answer or its history has the wrong shape, and reads it again on the next refresh", async () => {
          restore = standIn(() => [
            {
              name: "odd",
              pushedAt: "2026-09-30T12:00:00Z",
              others: [{ oid: 7 }],
            },
            { name: "garbled", pushedAt: "2026-09-30T12:00:00Z", answer: [] },
          ], calls);
          const organization = new OrganizationCommits();
          expect(await organization.refresh(CREDENTIAL)).toBe(false);
          expect(organization.commits).toEqual([]);
          expect(logged.join("\n")).toContain(
            `recent commits: could not read ${ORG}/odd's commits: GitHub commit history returned invalid data`,
          );
          expect(logged.join("\n")).toContain(
            `recent commits: could not read ${ORG}/garbled's commits: GitHub GraphQL returned invalid data`,
          );
          calls.length = 0;
          await organization.refresh(CREDENTIAL);
          expect(calls).toContain(`graphql ${ORG}/odd`);
          expect(calls).toContain(`graphql ${ORG}/garbled`);
        });

        it("holds no commits for an empty repository, and logs nothing for it", async () => {
          restore = standIn(() => [{ name: "empty", pushedAt: null }], calls);
          const organization = new OrganizationCommits();
          await organization.refresh(CREDENTIAL);
          expect(organization.commits).toEqual([]);
          expect(organization.refused).toEqual(new Set());
          expect(logged).toEqual([]);

          // Read once, it is not read again until it is pushed to.
          calls.length = 0;
          expect(await organization.refresh(CREDENTIAL)).toBe(false);
          expect(calls).toEqual([
            `/orgs/${ORG}/repos?per_page=100&page=1`,
          ]);
        });

        it("forgets the commits of a repository the listing no longer names, and returns `true`", async () => {
          const repos: RepoSpec[] = [{
            name: "labs",
            pushedAt: "2026-09-30T12:00:00Z",
            commits: [commit(REPO, "l", "2026-09-30T12:00:00Z")],
          }];
          restore = standIn(() => repos, calls);
          const organization = new OrganizationCommits();
          await organization.refresh(CREDENTIAL);

          repos[0] = { ...repos[0], archived: true };
          expect(await organization.refresh(CREDENTIAL)).toBe(true);
          expect(organization.commits).toEqual([]);
        });

        it("throws when the organization's repositories cannot be listed", async () => {
          const real = globalThis.fetch;
          globalThis.fetch = (() =>
            Promise.resolve(Response.json({ message: "moved" }))) as typeof fetch;
          restore = () => {
            globalThis.fetch = real;
          };
          await expect(new OrganizationCommits().refresh(CREDENTIAL)).rejects
            .toThrow("GitHub organization repositories returned invalid data");
        });
      });
    });
  });

  describe("createRecentCommits()", () => {
    describe("collect()", () => {
      it("lists the commits of the followed workflows' push runs, interleaved newest first, each tagged with its repository", async () => {
        const mk = (repo: string, at: string, id: number, message: string) =>
          run({
            repo,
            id,
            head_sha: `${id}`.repeat(40),
            created_at: at,
            head_commit: { message },
            html_url: `https://github.com/${repo}/actions/runs/${id}`,
          });
        const byRepo = (repo: string) =>
          repo === LOOM_REPO
            ? [mk(LOOM_REPO, "2026-09-30T11:00:00Z", 7, "loom c (#7)")]
            : repo === WEAVER_REPO
            ? [mk(WEAVER_REPO, "2026-09-30T10:00:00Z", 6, "weaver b (#6)")]
            : [
              mk(REPO, "2026-09-30T12:00:00Z", 3, "labs c (#3)"),
              mk(REPO, "2026-09-30T09:00:00Z", 2, "labs a (#2)"),
            ];
        const view = await createRecentCommits().collect(ctx(byRepo));
        const order = [
          ...(view.extra ?? "").matchAll(/<a class="pr"[^>]*\/pull\/(\d+)"/g),
        ].map((match) => match[1]);
        expect(order).toEqual(["3", "7", "6", "2"]);
        expect(view.status).toBe("good");
        expect(view.aside).toContain(">4 in window</span>");

        // The text links to the run, the pull request number to the pull
        // request, and the arrow to the pull request that landed the commit.
        const key = `labs-${"3".repeat(40)}`;
        expect(rowsOf(view.extra)[0]).toContain(
          `<span class="evtxt"><a data-focus-key="title-${key}-0" href="https://github.com/${REPO}/actions/runs/3" target="_blank" rel="noopener">labs · green · labs c </a><a class="pr" data-focus-key="title-${key}-1" href="https://github.com/${REPO}/pull/3" target="_blank" rel="noopener">(#3)</a></span>`,
        );
        expect(rowsOf(view.extra)[0]).toContain(
          `<a class="evarrow" data-focus-key="pr-arrow-${key}" href="https://github.com/${REPO}/pull/3" target="_blank" rel="noopener" aria-label="Open landed change on GitHub">↗</a>`,
        );
        expect(rowsOf(view.extra)[2]).toContain("commonfabric-weaver · green · ");
        // The list's scroll position carries over live updates.
        expect(view.extra).toContain(
          '<div class="evscroll" data-focus-key="commits">',
        );
      });

      it("dates a row, with a UTC fallback and a viewer-local marker", async () => {
        const at = "2024-01-02T17:05:00Z";
        const view = await createRecentCommits().collect(
          ctx((repo) => repo === REPO ? [run({ repo, created_at: at })] : []),
        );
        expect(view.extra).toContain(
          `<time class="t" datetime="${at}" data-viewer-time>17:05 UTC</time>`,
        );
      });

      it("is bad when the newest completed run failed, a warning when an older one in the window did, and good otherwise", async () => {
        const at = (hour: number) => `2026-09-30T${hour}:00:00Z`;
        const status = async (conclusions: string[]) =>
          (await createRecentCommits().collect(ctx((repo) =>
            repo === REPO
              ? conclusions.map((conclusion, index) =>
                run({
                  repo,
                  id: index,
                  head_sha: `${index}`,
                  conclusion,
                  created_at: at(20 - index),
                  run_started_at: at(20 - index),
                })
              )
              : []
          ))).status;
        const failingAt = (index: number) =>
          Array.from(
            { length: RECENT_WINDOW + 1 },
            (_, at) => at === index ? "failure" : "success",
          );
        expect(await status(["failure", "success"])).toBe("bad");
        expect(await status(failingAt(RECENT_WINDOW - 1))).toBe("warn");
        expect(await status(failingAt(RECENT_WINDOW))).toBe("good");
        expect(await status([])).toBe("unknown");
      });

      it("shows a run's duration as a link to the commit's Gantt when there is one, and the run's state when it has no duration", async () => {
        const start = Date.parse("2026-07-21T18:00:00Z");
        const timed = run({
          id: 41,
          repo: REPO,
          head_sha: "a".repeat(40),
          created_at: new Date(start).toISOString(),
          run_started_at: new Date(start).toISOString(),
          updated_at: new Date(start + 185_000).toISOString(),
        });
        const running = run({
          id: 46,
          repo: REPO,
          status: "in_progress",
          conclusion: null,
          head_sha: "b".repeat(40),
          created_at: new Date(start - 60_000).toISOString(),
        });
        const untimed = run({
          id: 47,
          repo: REPO,
          head_sha: "c".repeat(40),
          created_at: new Date(start - 120_000).toISOString(),
          updated_at: "not-a-timestamp",
        });
        const weaver = run({
          id: 48,
          repo: WEAVER_REPO,
          head_sha: "d".repeat(40),
          created_at: new Date(start - 180_000).toISOString(),
          run_started_at: new Date(start - 240_000).toISOString(),
          updated_at: new Date(start - 198_000).toISOString(),
        });
        const view = await createRecentCommits().collect(ctx((repo) =>
          repo === REPO
            ? [timed, running, untimed]
            : repo === WEAVER_REPO
            ? [weaver]
            : []
        ));
        const [first, second, third, fourth] = rowsOf(view.extra);
        expect(first).toContain(
          `class="evdur" data-focus-key="gantt-labs-${"a".repeat(40)}" href="${
            commitGanttHref(timed, [timed])?.replaceAll("&", "&amp;")
          }"`,
        );
        expect(first).toContain(">3m 05s</a>");
        expect(second).toContain('<span class="evdur">running</span>');
        expect(third).toContain('<span class="evdur">—</span>');
        expect(fourth).toContain('<span class="evdur">42s</span>');
      });

      it("opens the text of a row whose commit the green branch is or was at with a star, solid only for the commit it is at now", async () => {
        const loom = [
          run({
            repo: LOOM_REPO,
            id: 3,
            head_sha: "3",
            created_at: "2026-09-30T12:00:00Z",
            green: { branch: "main-green", current: true },
          }),
          run({
            repo: LOOM_REPO,
            id: 2,
            head_sha: "2",
            created_at: "2026-09-30T11:00:00Z",
            green: { branch: "main-green", current: false },
          }),
          run({ repo: LOOM_REPO, id: 1, head_sha: "1" }),
        ];
        const view = await createRecentCommits().collect(
          ctx((repo) => repo === LOOM_REPO ? loom : []),
        );
        const [current, former, unmarked] = rowsOf(view.extra);
        expect(current).toContain(
          `<span class="evtxt"><span class="green-star" role="img" aria-label="main-green is at this commit" title="main-green is at this commit">★</span><a`,
        );
        expect(former).toContain(
          `<span class="evtxt"><span class="green-star" role="img" aria-label="main-green was at this commit" title="main-green was at this commit">☆</span><a`,
        );
        expect(unmarked).toContain(`<span class="evtxt"><a`);
        expect(unmarked).not.toContain("green-star");
      });

      it("reads the organization's commits in the background, asks to be collected again, and then lists them, linking a commit no followed workflow ran on to the commit", async () => {
        restore = standIn(() => [
          {
            name: "labs",
            pushedAt: "2026-09-30T12:00:00Z",
            commits: [commit(REPO, "l", "2026-09-30T12:00:00Z", "labs")],
          },
          {
            name: "specs",
            pushedAt: "2026-09-30T13:00:00Z",
            commits: [
              commit(`${ORG}/specs`, "s", "2026-09-30T13:00:00Z", "spec"),
            ],
          },
        ], calls);
        let asked = 0;
        const tile = createRecentCommits();
        const collecting = ctx(
          (repo) =>
            repo === REPO
              ? [run({ repo, head_sha: "l", created_at: "2026-09-30T12:01:00Z" })]
              : [],
          {
            env: (key) => key === "GH_TOKEN" ? "test-token" : undefined,
            collectAgain: () => asked++,
          },
        );

        const before = await tile.collect(collecting);
        expect(rowsOf(before.extra).length).toBe(1);
        await tile.reading();
        expect(asked).toBe(1);

        const after = await tile.collect(collecting);
        const [specs, labs] = rowsOf(after.extra);
        expect(specs).toContain(
          `<span class="dot"></span><span class="evtxt"><a data-focus-key="title-specs-s-0" href="https://github.com/${ORG}/specs/commit/s" target="_blank" rel="noopener">specs · spec </a><a class="pr" data-focus-key="title-specs-s-1" href="https://github.com/${ORG}/specs/pull/1" target="_blank" rel="noopener">(#1)</a></span><span class="evdur"></span>`,
        );
        expect(labs).toContain(
          `<time class="t" datetime="2026-09-30T12:00:00Z"`,
        );
        expect(labs).toContain("labs · green · labs ");
        expect(rowsOf(after.extra).length).toBe(2);
        // The second collection comes within the refresh interval, so it
        // reads nothing.
        await tile.reading();
        expect(
          calls.filter((call) => call.startsWith(`/orgs/`)).length,
        ).toBe(1);
      });

      it("reads at once when a push to a default branch is delivered, and not while the relay vouches it would read nothing", async () => {
        const relay = new FakeRelay();
        await relay.open();
        let repos: RepoSpec[] = [{
          name: "labs",
          pushedAt: "2026-09-30T12:00:00Z",
          commits: [commit(REPO, "l", "2026-09-30T12:00:00Z")],
        }];
        restore = standIn(() => repos, calls);
        let asked = 0;
        const tile = createRecentCommits(
          new OrganizationCommits(relay.webhooks),
          relay.webhooks,
        );
        const collecting = ctx(() => [], {
          env: (key) => key === "GH_TOKEN" ? "test-token" : undefined,
          collectAgain: () => asked++,
        });
        using time = new FakeTime();
        await tile.collect(collecting);
        await tile.reading();
        time.tick(60_000);
        await relay.deliver("ping", {});
        await tile.collect(collecting);
        await tile.reading();
        expect(calls.length).toBe(2);

        repos = [{
          ...repos[0],
          commits: [
            commit(REPO, "m", "2026-09-30T13:00:00Z"),
            ...repos[0].commits ?? [],
          ],
        }];
        await relay.deliver("push", pushPayload(REPO, "refs/heads/main", "m"));
        await tile.reading();

        expect(calls.slice(2)).toEqual([`graphql ${ORG}/labs`]);
        expect(asked).toBe(2);
      });

      it("counts on its sub line the repositories GitHub refused to read, and says when a read found no commits", async () => {
        restore = standIn(() => [
          { name: "secret", pushedAt: "2026-09-30T12:00:00Z", errorType: "FORBIDDEN" },
          { name: "other", pushedAt: "2026-09-30T12:00:00Z", status: 403 },
          { name: "specs", pushedAt: "2026-09-30T12:00:00Z" },
        ], calls);
        let asked = 0;
        const tile = createRecentCommits();
        const collecting = ctx(() => [], {
          env: (key) => key === "GH_TOKEN" ? "test-token" : undefined,
          collectAgain: () => asked++,
        });
        const before = await tile.collect(collecting);
        expect(before.sub).toBe(undefined);
        expect(before.extra).toContain("waiting for first poll…");
        await tile.reading();
        expect(asked).toBe(1);
        const view = await tile.collect(collecting);
        expect(view.sub).toBe("2 repositories unreadable");
        expect(view.extra).toContain("no commits found");
      });

      it("says why the organization's commits could not be listed, still lists the runs' commits, and asks to be collected again only when the reason changes", async () => {
        const real = globalThis.fetch;
        globalThis.fetch = (() =>
          Promise.resolve(new Response("nope", { status: 403 }))) as typeof fetch;
        restore = () => {
          globalThis.fetch = real;
        };
        let asked = 0;
        const tile = createRecentCommits();
        const collecting = ctx(
          (repo) => repo === REPO ? [run({ repo })] : [],
          {
            env: (key) => key === "GH_TOKEN" ? "test-token" : undefined,
            collectAgain: () => asked++,
          },
        );
        using time = new FakeTime();
        await tile.collect(collecting);
        await tile.reading();
        expect(asked).toBe(1);
        const view = await tile.collect(collecting);
        expect(view.sub).toBe("auth failed");
        expect(rowsOf(view.extra).length).toBe(1);
        expect(logged.join("\n")).toContain(
          "recent commits: could not list the organization's repositories:",
        );

        time.tick(60_000);
        await tile.collect(collecting);
        await tile.reading();
        expect(asked).toBe(1);
      });
    });
  });
});
