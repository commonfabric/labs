import { join } from "@std/path";
import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";

import {
  githubApi,
  githubToken,
  listedPullRequest,
  pullRequestTarget,
  pullRequestText,
  readPullRequestList,
} from "../lib/view/github.ts";
import { realPushIo } from "../lib/view/push.ts";

/**
 * A git that answers as a checkout would whose remotes have the fetch
 * addresses `remotes` holds, each with `main` as its default branch, and
 * whose `origin` is pushed to `push`.
 */
function remotesGit(
  remotes: Readonly<Record<string, string>>,
  push = remotes.origin,
) {
  return (args: readonly string[]): string | null => {
    const asked = args.join(" ");
    if (asked === "remote get-url --push origin") {
      return push === undefined ? null : `${push}\n`;
    }
    const fetch = /^remote get-url (\w+)$/.exec(asked)?.[1];
    if (fetch !== undefined) {
      return remotes[fetch] === undefined ? null : `${remotes[fetch]}\n`;
    }
    const head = /^symbolic-ref --quiet refs\/remotes\/(\w+)\/HEAD$/.exec(
      asked,
    )?.[1];
    return head === undefined ? null : `refs/remotes/${head}/main\n`;
  };
}

const TARGET = {
  repository: "Octo/Repo",
  remote: "upstream",
  owner: "fork",
  head: "fork:feature",
  branch: "feature",
  base: "main",
};

/** A fetch that answers each request with `status` and `body`, recording
 * each request. */
function fakeFetch(status: number, body: string) {
  const requests: Array<{ url: string; init: RequestInit }> = [];
  const send: typeof fetch = (input, init) => {
    requests.push({ url: String(input), init: init ?? {} });
    return Promise.resolve(new Response(body, { status }));
  };
  return { send, requests };
}

const decoder = new TextDecoder();

/** Runs git in `cwd` with exactly `env`. */
function git(cwd: string, env: Record<string, string>, ...args: string[]) {
  const result = new Deno.Command("git", {
    args,
    cwd,
    env,
    clearEnv: true,
    stdout: "piped",
    stderr: "piped",
  }).outputSync();
  if (!result.success) {
    throw new Error(`git ${args.join(" ")}: ${decoder.decode(result.stderr)}`);
  }
  return decoder.decode(result.stdout).trim();
}

describe("github", () => {
  describe("pullRequestTarget()", () => {
    it("goes to upstream's repository and default branch, with the head in origin's repository", () => {
      const target = pullRequestTarget(
        remotesGit({
          origin: "git@github.com:fork/repo.git",
          upstream: "https://github.com/Octo/Repo.git",
          github: "https://github.com/other/repo",
        }),
        "feature",
      );

      expect(target).toEqual(TARGET);
    });

    it("prefers github's repository to origin's, and origin's when no other names one", () => {
      expect(
        pullRequestTarget(
          remotesGit({
            origin: "git@github.com:fork/repo.git",
            upstream: "https://example.test/repo.git",
            github: "https://github.com/octo/repo",
          }),
          "feature",
        ),
      ).toMatchObject({ repository: "octo/repo", remote: "github" });
      expect(
        pullRequestTarget(
          remotesGit({ origin: "git@github.com:octo/repo.git" }),
          "feature",
        ),
      ).toEqual({
        ...TARGET,
        repository: "octo/repo",
        remote: "origin",
        owner: "octo",
        head: "feature",
      });
    });

    it("names the head by the branch alone when origin's repository is the target, whatever its letter case", () => {
      expect(
        pullRequestTarget(
          remotesGit(
            { upstream: "https://github.com/octo/repo" },
            "git@github.com:Octo/Repo.git",
          ),
          "feature",
        ).head,
      ).toBe("feature");
    });

    it("throws when origin is not on GitHub, or the target's remote names no default branch", () => {
      expect(() =>
        pullRequestTarget(
          remotesGit({ origin: "https://example.test/repo.git" }),
          "feature",
        )
      ).toThrow("origin is not a GitHub repository");
      expect(() =>
        pullRequestTarget(
          (args) =>
            args[0] === "remote" && args.at(-1) === "origin"
              ? "git@github.com:octo/repo.git\n"
              : null,
          "feature",
        )
      ).toThrow(
        "origin's default branch is unknown. " +
          "`git remote set-head origin --auto` finds it",
      );
    });
  });

  describe("pullRequestText()", () => {
    it("takes the title and description from the oldest commit the base branch lacks, passing over merges and commits whose changes it has", () => {
      const root = Deno.realPathSync(Deno.makeTempDirSync());
      try {
        const env = {
          PATH: Deno.env.get("PATH") ?? "",
          HOME: root,
          GIT_CONFIG_NOSYSTEM: "1",
          GIT_CONFIG_GLOBAL: join(root, "gitconfig"),
          GIT_AUTHOR_NAME: "Author",
          GIT_AUTHOR_EMAIL: "author@example.test",
          GIT_COMMITTER_NAME: "Author",
          GIT_COMMITTER_EMAIL: "author@example.test",
        };
        Deno.writeTextFileSync(env.GIT_CONFIG_GLOBAL, "");
        const run = (...args: string[]) => git(root, env, ...args);
        const commit = (file: string, message: string) => {
          Deno.writeTextFileSync(join(root, file), `${file}\n`);
          run("add", file);
          run("commit", "--quiet", "-m", message);
        };
        run("init", "--quiet", "-b", "main");
        commit("base.txt", "Base");
        commit("shared.txt", "Shared change");
        const shared = run("rev-parse", "HEAD");
        run("reset", "--quiet", "--hard", "HEAD~1");
        run("update-ref", "refs/remotes/upstream/main", shared);
        run("switch", "--quiet", "-c", "feature");
        commit("shared.txt", "Shared change, picked");
        commit(
          "first.txt",
          "Fix the frobnicator\n\nIt was broken.\n\nNow not.",
        );
        commit("second.txt", "Second");
        const query = realPushIo({ cwd: root, env, write() {} }).query;

        expect(pullRequestText(query, TARGET)).toEqual({
          title: "Fix the frobnicator",
          body: "It was broken.\n\nNow not.",
        });
        run("update-ref", "refs/remotes/upstream/main", "HEAD");
        expect(() => pullRequestText(query, TARGET)).toThrow(
          "the branch has no commits that refs/remotes/upstream/main does not have",
        );
      } finally {
        Deno.removeSync(root, { recursive: true });
      }
    });

    it("throws when git cannot read the commit", () => {
      expect(() =>
        pullRequestText(
          (args) => args[0] === "rev-list" ? "abc123\n" : null,
          TARGET,
        )
      ).toThrow("git cannot read commit abc123");
    });
  });

  describe("listedPullRequest()", () => {
    it("returns the pull request listed for the target's repository, in any letter case, and branch", () => {
      const list = [
        "octo/repo\tother\t3",
        "else/repo\tfeature\t4",
        "octo/repo\tfeature\tfive",
        "octo/repo\tfeature\t07",
        "",
        "OCTO/repo\tfeature\t9803",
      ].join("\n");

      expect(listedPullRequest(list, TARGET)).toEqual({
        number: 9803,
        url: "https://github.com/Octo/Repo/pull/9803",
      });
    });

    it("returns null when the list names no pull request for the branch, or several", () => {
      expect(listedPullRequest("octo/repo\tother\t3\n", TARGET)).toBeNull();
      expect(listedPullRequest("", TARGET)).toBeNull();
      expect(
        listedPullRequest(
          "octo/repo\tfeature\t3\nocto/repo\tfeature\t4\n",
          TARGET,
        ),
      ).toBeNull();
    });
  });

  describe("githubApi()", () => {
    it("finds the open pull request from the branch in origin's owner's repository, with the token when there is one", async () => {
      const { send, requests } = fakeFetch(
        200,
        JSON.stringify([{ number: 7 }, { number: 8 }]),
      );

      const found = await githubApi(() => "t0k", send).find(
        TARGET,
        new AbortController().signal,
      );

      expect(found).toEqual({
        number: 7,
        url: "https://github.com/Octo/Repo/pull/7",
      });
      expect(requests[0].url).toBe(
        "https://api.github.com/repos/Octo/Repo/pulls?state=open&head=fork%3Afeature",
      );
      expect(requests[0].init.method).toBe("GET");
      expect(requests[0].init.headers).toMatchObject({
        Authorization: "Bearer t0k",
      });
    });

    it("finds nothing when no pull request is open, asking without a token when there is none", async () => {
      const { send, requests } = fakeFetch(200, "[]");

      expect(
        await githubApi(() => null, send).find(
          TARGET,
          new AbortController().signal,
        ),
      ).toBeNull();
      expect(requests[0].init.headers).not.toHaveProperty("Authorization");
    });

    it("creates a pull request and resolves with its address", async () => {
      const url = "https://github.com/octo/repo/pull/12";
      const { send, requests } = fakeFetch(
        201,
        JSON.stringify({ html_url: url }),
      );

      const created = await githubApi(() => "t0k", send).create(
        {
          repository: "octo/repo",
          head: "fork:feature",
          base: "main",
          title: "Title",
          body: "Body",
        },
        () => {},
        new AbortController().signal,
      );

      expect(created).toBe(url);
      expect(requests[0].url).toBe(
        "https://api.github.com/repos/octo/repo/pulls",
      );
      expect(requests[0].init.method).toBe("POST");
      expect(JSON.parse(String(requests[0].init.body))).toEqual({
        head: "fork:feature",
        base: "main",
        title: "Title",
        body: "Body",
      });
    });

    it("rejects a creation whose answer names no pull request", async () => {
      const { send } = fakeFetch(201, "{}");

      await expect(
        githubApi(() => "t0k", send).create(
          {
            repository: "octo/repo",
            head: "feature",
            base: "main",
            title: "Title",
            body: "",
          },
          () => {},
          new AbortController().signal,
        ),
      ).rejects.toThrow("GitHub did not say which pull request it created");
    });

    it("merges a pull request by the method, if its head is at the commit", async () => {
      const { send, requests } = fakeFetch(
        200,
        JSON.stringify({ merged: true }),
      );

      const merged = await githubApi(() => "t0k", send).merge(
        {
          repository: "octo/repo",
          number: 12,
          method: "rebase",
          sha: "c0ffee",
        },
        () => {},
        new AbortController().signal,
      );

      expect(merged).toBe("Merged https://github.com/octo/repo/pull/12");
      expect(requests[0].url).toBe(
        "https://api.github.com/repos/octo/repo/pulls/12/merge",
      );
      expect(requests[0].init.method).toBe("PUT");
      expect(JSON.parse(String(requests[0].init.body))).toEqual({
        merge_method: "rebase",
        sha: "c0ffee",
      });
    });

    it("asks GitHub's GraphQL API for the method its page would merge by", async () => {
      const methods = [["SQUASH", "squash"], ["MERGE", "merge"], [
        "REBASE",
        "rebase",
      ]] as const;
      for (const [answer, method] of methods) {
        const { send, requests } = fakeFetch(
          200,
          JSON.stringify({
            data: { repository: { viewerDefaultMergeMethod: answer } },
          }),
        );

        expect(
          await githubApi(() => "t0k", send).mergeMethod(
            "octo/repo",
            new AbortController().signal,
          ),
        ).toBe(method);
        expect(requests[0].url).toBe("https://api.github.com/graphql");
        expect(requests[0].init.method).toBe("POST");
        const body = JSON.parse(String(requests[0].init.body));
        expect(body.query).toContain("viewerDefaultMergeMethod");
        expect(body.variables).toEqual({ owner: "octo", name: "repo" });
      }
    });

    it("rejects when GitHub names no merge method it knows, or there is no token to ask with", async () => {
      for (
        const reply of [
          {
            data: { repository: { viewerDefaultMergeMethod: "FAST_FORWARD" } },
          },
          { data: { repository: null } },
          { errors: [{ message: "Could not resolve to a Repository" }] },
        ]
      ) {
        const { send } = fakeFetch(200, JSON.stringify(reply));

        await expect(
          githubApi(() => "t0k", send).mergeMethod(
            "octo/repo",
            new AbortController().signal,
          ),
        ).rejects.toThrow("GitHub did not say how octo/repo merges");
      }
      const { send, requests } = fakeFetch(200, "{}");
      await expect(
        githubApi(() => null, send).mergeMethod(
          "octo/repo",
          new AbortController().signal,
        ),
      ).rejects.toThrow("there is no GitHub token");
      expect(requests).toEqual([]);
    });

    it("rejects with GitHub's message and errors, or its text, when it refuses", async () => {
      const refusals = [
        [
          422,
          JSON.stringify({
            message: "Validation Failed",
            errors: [{ message: "A pull request already exists" }, {
              code: "x",
            }],
          }),
          "GitHub answered 422: Validation Failed. A pull request already exists",
        ],
        [502, "Bad gateway\n", "GitHub answered 502: Bad gateway"],
      ] as const;
      for (const [status, body, message] of refusals) {
        const { send } = fakeFetch(status, body);

        await expect(
          githubApi(() => "t0k", send).merge(
            {
              repository: "octo/repo",
              number: 12,
              method: "squash",
              sha: "c0",
            },
            () => {},
            new AbortController().signal,
          ),
        ).rejects.toThrow(message);
      }
    });

    it("refuses to create or merge without a token, asking GitHub nothing", async () => {
      const { send, requests } = fakeFetch(200, "{}");

      await expect(
        githubApi(() => null, send).merge(
          { repository: "octo/repo", number: 12, method: "squash", sha: "c0" },
          () => {},
          new AbortController().signal,
        ),
      ).rejects.toThrow("there is no GitHub token");
      expect(requests).toEqual([]);
    });
  });

  describe("githubToken()", () => {
    it("resolves with GH_TOKEN, or else GITHUB_TOKEN, from the environment", async () => {
      expect(
        await githubToken({ GH_TOKEN: "a", GITHUB_TOKEN: "b" }, "/missing"),
      )
        .toBe("a");
      expect(await githubToken({ GITHUB_TOKEN: "b" }, "/missing")).toBe("b");
    });

    it("resolves with the token `gh auth token` prints, or null when it prints none, fails, or is missing", async () => {
      const root = Deno.makeTempDirSync();
      try {
        const script = (name: string, body: string) => {
          const path = join(root, name);
          Deno.writeTextFileSync(path, `#!/bin/sh\n${body}\n`);
          Deno.chmodSync(path, 0o755);
          return path;
        };

        expect(
          await githubToken(
            {},
            script("gh", 'test "$*" = "auth token" && echo t0k'),
          ),
        ).toBe("t0k");
        expect(await githubToken({}, script("silent", "exit 0"))).toBeNull();
        expect(await githubToken({}, script("fails", "echo t0k; exit 1")))
          .toBeNull();
        expect(await githubToken({}, join(root, "missing"))).toBeNull();
      } finally {
        Deno.removeSync(root, { recursive: true });
      }
    });
  });

  describe("readPullRequestList()", () => {
    it("resolves with the file's text, or null when there is no file", async () => {
      const root = Deno.makeTempDirSync();
      try {
        const path = join(root, "github-prs.tsv");
        expect(await readPullRequestList(path)).toBeNull();

        Deno.writeTextFileSync(path, "octo/repo\tfeature\t7\n");
        expect(await readPullRequestList(path)).toBe("octo/repo\tfeature\t7\n");
      } finally {
        Deno.removeSync(root, { recursive: true });
      }
    });
  });
});
