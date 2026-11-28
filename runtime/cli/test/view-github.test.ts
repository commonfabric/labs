import { join } from "@std/path";
import { expect } from "@std/expect";

import {
  abortable,
  githubApi,
  GitHubRefusal,
  githubToken,
  listedPullRequest,
  pullRequestTarget,
  pullRequestText,
  readPullRequestList,
} from "../lib/view/github.ts";
import { realPushIo } from "../lib/view/push.ts";
import { describe, it } from "@commonfabric/test-support/test";

/**
 * A git that answers as a checkout would whose remotes have the fetch
 * addresses `remotes` holds, and whose `origin` is pushed to `push`.
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
    return fetch === undefined || remotes[fetch] === undefined
      ? null
      : `${remotes[fetch]}\n`;
  };
}

const TARGET = {
  repository: "Octo/Repo",
  remote: "upstream",
  owner: "fork",
  head: "fork:feature",
  branch: "feature",
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
    it("goes to upstream's repository, with the head in origin's repository", () => {
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

    it("throws when origin is not on GitHub", () => {
      expect(() =>
        pullRequestTarget(
          remotesGit({ origin: "https://example.test/repo.git" }),
          "feature",
        )
      ).toThrow("origin is not a GitHub repository");
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
        const query =
          realPushIo({ cwd: root, env, write() {}, step: () => () => {} })
            .query;

        expect(pullRequestText(query, TARGET, "main")).toEqual({
          title: "Fix the frobnicator",
          body: "It was broken.\n\nNow not.",
        });
        expect(() => pullRequestText(query, TARGET, "trunk")).toThrow(
          "git cannot compare the branch with refs/remotes/upstream/trunk",
        );
        run("update-ref", "refs/remotes/upstream/main", "HEAD");
        expect(() => pullRequestText(query, TARGET, "main")).toThrow(
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
          "main",
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

    it("resolves with the repository's default branch, with the token when there is one", async () => {
      for (const token of ["t0k", null]) {
        const { send, requests } = fakeFetch(
          200,
          JSON.stringify({ full_name: "octo/repo", default_branch: "trunk" }),
        );

        expect(
          await githubApi(() => token, send).defaultBranch(
            "octo/repo",
            new AbortController().signal,
          ),
        ).toBe("trunk");
        expect(requests[0].url).toBe("https://api.github.com/repos/octo/repo");
        expect(requests[0].init.method).toBe("GET");
        if (token === null) {
          expect(requests[0].init.headers).not.toHaveProperty("Authorization");
        } else {
          expect(requests[0].init.headers).toMatchObject({
            Authorization: "Bearer t0k",
          });
        }
      }
    });

    it("rejects when GitHub names no default branch, and with a refusal that cannot succeed when GitHub refuses to say", async () => {
      const ask = (status: number, body: string) =>
        githubApi(() => null, fakeFetch(status, body).send).defaultBranch(
          "octo/repo",
          new AbortController().signal,
        );

      for (const body of ["{}", JSON.stringify({ default_branch: "" }), "[]"]) {
        const error = await ask(200, body).catch((error) => error);
        expect(error).not.toBeInstanceOf(GitHubRefusal);
        expect(error.message).toBe(
          "GitHub did not say which branch is octo/repo's default",
        );
      }
      const refusal = await ask(404, JSON.stringify({ message: "Not Found" }))
        .catch((error) => error);
      expect(refusal).toBeInstanceOf(GitHubRefusal);
      expect(refusal.status).toBe(404);
      expect(refusal.retryable).toBe(false);
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
        () => () => {},
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
          () => () => {},
          new AbortController().signal,
        ),
      ).rejects.toThrow("GitHub did not say which pull request it created");
    });

    it("merges a pull request by the method, if its head is at the commit", async () => {
      const { send, requests } = fakeFetch(
        200,
        JSON.stringify({ merged: true }),
      );

      await githubApi(() => "t0k", send).merge(
        {
          repository: "octo/repo",
          number: 12,
          method: "rebase",
          sha: "c0ffee",
        },
        () => () => {},
        new AbortController().signal,
      );

      expect(requests[0].url).toBe(
        "https://api.github.com/repos/octo/repo/pulls/12/merge",
      );
      expect(requests[0].init.method).toBe("PUT");
      expect(JSON.parse(String(requests[0].init.body))).toEqual({
        merge_method: "rebase",
        sha: "c0ffee",
      });
    });

    it("merges a pull request whose successful answer is not JSON, but rejects such an answer to a creation", async () => {
      const { send } = fakeFetch(200, "Merged.");
      const api = githubApi(() => "t0k", send);

      await expect(api.merge(
        { repository: "octo/repo", number: 12, method: "merge", sha: "c0ffee" },
        () => () => {},
        new AbortController().signal,
      )).resolves.toBeUndefined();
      await expect(
        api.create(
          {
            repository: "octo/repo",
            head: "feature",
            base: "main",
            title: "Title",
            body: "",
          },
          () => () => {},
          new AbortController().signal,
        ),
      ).rejects.toThrow("GitHub did not say which pull request it created");
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
            () => () => {},
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
          () => () => {},
          new AbortController().signal,
        ),
      ).rejects.toThrow("there is no GitHub token");
      expect(requests).toEqual([]);
    });
  });

  describe("abortable()", () => {
    it("settles as the promise does while its signal has not aborted", async () => {
      const signal = new AbortController().signal;

      expect(await abortable(Promise.resolve(7), signal)).toBe(7);
      await expect(abortable(Promise.reject(new Error("no")), signal)).rejects
        .toThrow("no");
    });

    it("rejects with the signal's reason once it aborts, or when it already has", async () => {
      const controller = new AbortController();
      const pending = abortable(
        new Promise<never>(() => {}),
        controller.signal,
      );
      controller.abort(new Error("stopped"));

      await expect(pending).rejects.toThrow("stopped");
      await expect(
        abortable(Promise.resolve(7), AbortSignal.abort(new Error("early"))),
      ).rejects.toThrow("early");
    });

    it("listens to a signal that has already aborted for nothing, and leaves the promise's rejection handled", async () => {
      const signal = AbortSignal.abort(new Error("early"));
      let listened = 0;
      signal.addEventListener = () => listened++;

      await expect(abortable(Promise.reject(new Error("late")), signal))
        .rejects.toThrow("early");
      expect(listened).toBe(0);
    });

    it("lets GitHub's API stop waiting for the token, asking GitHub nothing", async () => {
      const { send, requests } = fakeFetch(200, "[]");
      const controller = new AbortController();
      const finding = githubApi(() => new Promise<never>(() => {}), send).find(
        TARGET,
        controller.signal,
      );
      controller.abort(new Error("stopped"));

      await expect(finding).rejects.toThrow("stopped");
      expect(requests).toEqual([]);
    });
  });

  describe("GitHubRefusal", () => {
    it("says GitHub's status and the message its reply gives, leaving out the rest of the reply", () => {
      const refusal = new GitHubRefusal(
        405,
        JSON.stringify({
          message: "Merge already in progress",
          documentation_url: "https://docs.github.com/rest/pulls/pulls",
          status: "405",
        }),
      );

      expect(refusal.message).toBe(
        "GitHub answered 405: Merge already in progress",
      );
      expect(new GitHubRefusal(502, "Bad gateway\n").message).toBe(
        "GitHub answered 502: Bad gateway",
      );
    });

    it("joins GitHub's message and errors as sentences without their full stops, and says only the status when the reply says nothing", () => {
      expect(
        new GitHubRefusal(
          422,
          JSON.stringify({
            message: "Validation Failed",
            errors: [{
              message: "A pull request already exists for octo:feature.",
            }],
          }),
        ).message,
      ).toBe(
        "GitHub answered 422: Validation Failed. A pull request already " +
          "exists for octo:feature",
      );
      expect(new GitHubRefusal(502, "").message).toBe("GitHub answered 502");
      expect(
        new GitHubRefusal(
          422,
          JSON.stringify({ message: ".", errors: [{ message: "Taken." }] }),
        ).message,
      ).toBe("GitHub answered 422: Taken");
      expect(new GitHubRefusal(502, "{}").message).toBe("GitHub answered 502");
    });

    it("gives GitHub's status, and the reason its reply gives as GitHub wrote it, a message per line, or an empty reason when the reply says nothing", () => {
      const refusal = new GitHubRefusal(
        422,
        JSON.stringify({
          message: "Validation Failed.",
          errors: [{ message: "A pull request already exists." }],
        }),
      );

      expect([refusal.status, refusal.reason]).toEqual([
        422,
        "Validation Failed.\nA pull request already exists.",
      ]);
      expect(new GitHubRefusal(502, "{}").reason).toBe("");
    });

    it("is retryable unless its status says the request itself cannot succeed", () => {
      for (const status of [404, 405, 409, 422]) {
        expect(new GitHubRefusal(status, "{}").retryable).toBe(false);
      }
      for (const status of [401, 403, 429, 500, 502]) {
        expect(new GitHubRefusal(status, "{}").retryable).toBe(true);
      }
    });

    it("exposes nothing to enumerate", () => {
      expect(Object.keys(new GitHubRefusal(405, "{}"))).toEqual([]);
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

    it("rejects when `gh` cannot be started for a reason other than its absence", async () => {
      const root = Deno.makeTempDirSync();
      try {
        const gh = join(root, "gh");
        Deno.writeTextFileSync(gh, "#!/bin/sh\necho t0k\n");
        Deno.chmodSync(gh, 0o644);

        await expect(githubToken({}, gh)).rejects.toThrow(
          Deno.errors.PermissionDenied,
        );
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

    it("rejects when the file cannot be opened for a reason other than its absence", async () => {
      const root = Deno.makeTempDirSync();
      try {
        const file = join(root, "cache");
        Deno.writeTextFileSync(file, "");

        await expect(readPullRequestList(join(file, "github-prs.tsv")))
          .rejects.toThrow(Deno.errors.NotADirectory);
      } finally {
        Deno.removeSync(root, { recursive: true });
      }
    });
  });
});
