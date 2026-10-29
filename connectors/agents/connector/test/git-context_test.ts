import { assertEquals, assertRejects } from "@std/assert";
import {
  type GitCommandRunner,
  GitContextResolver,
} from "../src/git-context.ts";
import type { NativeSessionSnapshot } from "../src/types.ts";

const GIT_OBSERVED_AT = "2026-08-21T00:00:00.000Z";
const gitClock = () => new Date(GIT_OBSERVED_AT);
const identityPath = (path: string) => Promise.resolve(path);

function result(stdout: string, code = 0) {
  return { code, stdout };
}

Deno.test("git context refreshes the repo and branch for every observation", async () => {
  const calls: string[][] = [];
  let observation = 0;
  const runner: GitCommandRunner = (args) => {
    calls.push(args);
    const command = args.slice(2).join(" ");
    if (command === "rev-parse --show-toplevel") {
      observation++;
      return Promise.resolve(result("/repo\n"));
    }
    if (command === "branch --show-current") {
      return Promise.resolve(
        result(observation === 1 ? "feature/sessions\n" : "main\n"),
      );
    }
    if (command === "remote get-url upstream") {
      return Promise.resolve(
        result(
          observation === 1
            ? "git@github.com:common/project.git\n"
            : "git@github.com:common/renamed-project.git\n",
        ),
      );
    }
    if (command === "rev-parse HEAD") {
      return Promise.resolve(result(`head-${observation}\n`));
    }
    if (command === "remote -v") {
      return Promise.resolve(result(
        "upstream\tgit@github.com:common/project.git (fetch)\n",
      ));
    }
    return Promise.resolve(result("", 1));
  };
  const resolver = new GitContextResolver(runner, gitClock);

  const first = await resolver.resolve("/repo/worktree");
  const second = await resolver.resolve("/repo/worktree");

  assertEquals(first, {
    gitRepo: "git@github.com:common/project.git",
    gitBranch: "feature/sessions",
    gitWorktreeRoot: "/repo",
    gitHeadSha: "head-1",
    gitRemotes: [{
      name: "upstream",
      urls: ["git@github.com:common/project.git"],
    }],
    gitObservedAt: GIT_OBSERVED_AT,
  });
  assertEquals(second, {
    gitRepo: "git@github.com:common/renamed-project.git",
    gitBranch: "main",
    gitWorktreeRoot: "/repo",
    gitHeadSha: "head-2",
    gitRemotes: [{
      name: "upstream",
      urls: ["git@github.com:common/project.git"],
    }],
    gitObservedAt: GIT_OBSERVED_AT,
  });
  assertEquals(calls.length, 10);
});

Deno.test("git context deduplicates directories and roots within one observation", async () => {
  const calls: string[] = [];
  const runner: GitCommandRunner = (args) => {
    const command = args.slice(2).join(" ");
    calls.push(`${args[1]}:${command}`);
    if (command === "rev-parse --show-toplevel") {
      return Promise.resolve(result("/repo\n"));
    }
    if (command === "branch --show-current") {
      return Promise.resolve(result("main\n"));
    }
    if (command === "remote get-url upstream") {
      return Promise.resolve(result("git@github.com:common/project.git\n"));
    }
    if (command === "rev-parse HEAD") {
      return Promise.resolve(result("abcdef\n"));
    }
    if (command === "remote -v") {
      return Promise.resolve(result(
        "upstream\tgit@github.com:common/project.git (fetch)\n",
      ));
    }
    return Promise.resolve(result("", 1));
  };
  const resolver = new GitContextResolver(runner, gitClock);
  const observation = resolver.beginObservation();

  const contexts = await Promise.all([
    observation.resolve("/repo/first"),
    observation.resolve("/repo/first"),
    observation.resolve("/repo/second"),
  ]);

  assertEquals(contexts[0], contexts[1]);
  assertEquals(contexts[1], contexts[2]);
  assertEquals(
    calls.filter((call) => call.endsWith("rev-parse --show-toplevel")).length,
    2,
  );
  assertEquals(
    calls.filter((call) => call.endsWith("branch --show-current")).length,
    1,
  );
  assertEquals(
    calls.filter((call) => call.endsWith("remote get-url upstream")).length,
    1,
  );

  await resolver.beginObservation().resolve("/repo/first");
  assertEquals(
    calls.filter((call) => call.endsWith("rev-parse --show-toplevel")).length,
    3,
  );
  assertEquals(
    calls.filter((call) => call.endsWith("branch --show-current")).length,
    2,
  );
});

Deno.test("git context falls back to origin and enriches a session snapshot", async () => {
  const runner: GitCommandRunner = (args) => {
    const command = args.slice(2).join(" ");
    if (command === "rev-parse --show-toplevel") {
      return Promise.resolve(result("/repo\n"));
    }
    if (command === "branch --show-current") {
      return Promise.resolve(result("main\n"));
    }
    if (command === "remote get-url upstream") {
      return Promise.resolve(result("", 2));
    }
    if (command === "remote get-url origin") {
      return Promise.resolve(
        result("https://account:secret@github.com/common/project.git\n"),
      );
    }
    if (command === "rev-parse HEAD") {
      return Promise.resolve(result("abcdef123456\n"));
    }
    if (command === "remote -v") {
      return Promise.resolve(result(
        "origin\thttps://account:secret@github.com/common/fork.git (fetch)\n" +
          "origin\thttps://account:secret@github.com/common/fork.git (push)\n" +
          "mirror\tgithub.com:common/mirror.git (fetch)\n" +
          "upstream\tgit@github.com:common/project.git (fetch)\n" +
          "helper\text::shell command with secret (fetch)\n" +
          "compact-helper\text::https://account:secret@example.test/repo (fetch)\n" +
          "file\tfile:/private/credential (fetch)\n" +
          "unsupported\tftp://example.test/repo (fetch)\n" +
          "windows-slash\tC:/private/credential (fetch)\n" +
          "windows-backslash\tC:\\private\\credential (fetch)\n" +
          "windows-relative\tD:private\\credential (fetch)\n" +
          "local\t/private/credential (fetch)\n",
      ));
    }
    return Promise.resolve(result("", 1));
  };
  const resolver = new GitContextResolver(runner, gitClock);
  const snapshot: NativeSessionSnapshot = {
    summary: {
      nativeSessionId: "session-1",
      title: "Test",
      cwd: "/repo/subdir",
      gitRepo: null,
      gitBranch: null,
      gitWorktreeRoot: null,
      createdAt: null,
      updatedAt: null,
      archived: false,
      active: null,
      raw: {},
    },
    events: [],
    normalizedMessages: [],
    complete: true,
  };

  const enriched = await resolver.enrich(snapshot);

  assertEquals(
    enriched.summary.gitRepo,
    "https://github.com/common/project.git",
  );
  assertEquals(enriched.summary.gitBranch, "main");
  assertEquals(enriched.summary.gitWorktreeRoot, "/repo");
  assertEquals("gitHeadSha" in enriched.summary, false);
  assertEquals("gitRemotes" in enriched.summary, false);
  assertEquals("gitObservedAt" in enriched.summary, false);
  assertEquals((await resolver.resolve("/repo/subdir")).gitRemotes, [{
    name: "mirror",
    urls: ["github.com:common/mirror.git"],
  }, {
    name: "origin",
    urls: ["https://github.com/common/fork.git"],
  }, {
    name: "upstream",
    urls: ["git@github.com:common/project.git"],
  }]);
});

Deno.test("checkout observations accept a repository with unborn HEAD", async () => {
  const calls: string[] = [];
  const resolver = new GitContextResolver(
    (args) => {
      const command = args.slice(2).join(" ");
      calls.push(command);
      if (command === "rev-parse --show-toplevel") {
        return Promise.resolve(result("/repo\n"));
      }
      if (command === "branch --show-current") {
        return Promise.resolve(result("main\n"));
      }
      if (command === "rev-parse HEAD") {
        return Promise.resolve(result("", 128));
      }
      if (command === "symbolic-ref -q HEAD") {
        return Promise.resolve(result("refs/heads/main\n"));
      }
      if (command === "remote -v") return Promise.resolve(result(""));
      return Promise.resolve(result("", 2));
    },
    gitClock,
    identityPath,
  );

  assertEquals(await resolver.validateCheckout("/repo"), true);
  const observation = resolver.beginObservation();
  assertEquals(await observation.resolveCheckout("/repo"), {
    gitRepo: null,
    gitBranch: "main",
    gitWorktreeRoot: "/repo",
    gitHeadSha: null,
    gitRemotes: [],
    gitObservedAt: GIT_OBSERVED_AT,
  });
  assertEquals(await observation.resolve("/repo"), {
    gitRepo: null,
    gitBranch: "main",
    gitWorktreeRoot: "/repo",
    gitHeadSha: null,
    gitRemotes: [],
    gitObservedAt: GIT_OBSERVED_AT,
  });
  assertEquals(
    calls.filter((command) => command === "branch --show-current").length,
    1,
  );
});

Deno.test("checkout observations skip an invalid worktree marker", async () => {
  const resolver = new GitContextResolver(
    () => Promise.resolve(result("", 128)),
    gitClock,
  );

  assertEquals(
    await resolver.validateCheckout("/stale-worktree"),
    false,
  );
  assertEquals(
    await resolver.beginObservation().resolveCheckout("/stale-worktree"),
    null,
  );
});

Deno.test("checkout validation reports a Git process failure", async () => {
  const resolver = new GitContextResolver(() =>
    Promise.reject(new Deno.errors.NotFound("git"))
  );

  await assertRejects(
    () => resolver.validateCheckout("/repo"),
    Error,
    "Git process failed while validating a discovered checkout",
  );
});

Deno.test("checkout observation reports a Git process failure", async () => {
  const resolver = new GitContextResolver(() =>
    Promise.reject(new Deno.errors.NotFound("git"))
  );

  await assertRejects(
    () => resolver.beginObservation().resolveCheckout("/repo"),
    Error,
    "Git process failed while validating a discovered checkout",
  );
});

Deno.test("checkout observation rejects a missing worktree root", async () => {
  const resolver = new GitContextResolver(() => Promise.resolve(result("")));

  await assertRejects(
    () => resolver.beginObservation().resolveCheckout("/repo"),
    Error,
    "Git returned no worktree root for a discovered checkout",
  );
});

Deno.test("checkout observation rejects a failed Git command", async () => {
  const resolver = new GitContextResolver((args) => {
    const command = args.slice(2).join(" ");
    return Promise.resolve(
      command === "rev-parse --show-toplevel"
        ? result("/repo\n")
        : result("", 1),
    );
  });

  await assertRejects(
    () => resolver.beginObservation().resolveCheckout("/repo"),
    Error,
    "Git command failed while observing checkout: branch --show-current",
  );
});

Deno.test("checkout validation accepts a canonical path alias", async () => {
  const resolver = new GitContextResolver(
    () => Promise.resolve(result("/private/tmp/repo\n")),
    gitClock,
    (path) => Promise.resolve(path.replace(/^\/tmp\//, "/private/tmp/")),
  );

  assertEquals(await resolver.validateCheckout("/tmp/repo"), true);
});

Deno.test("checkout observations fail when Git metadata is incomplete", async () => {
  const resolver = new GitContextResolver((args) => {
    const command = args.slice(2).join(" ");
    if (command === "rev-parse --show-toplevel") {
      return Promise.resolve(result("/repo\n"));
    }
    if (command === "branch --show-current") {
      return Promise.resolve(result("main\n"));
    }
    if (command === "remote get-url upstream") {
      return Promise.resolve(result("git@github.com:common/project.git\n"));
    }
    if (command === "rev-parse HEAD") {
      return Promise.resolve(result("", 128));
    }
    if (command === "symbolic-ref -q HEAD") {
      return Promise.resolve(result("", 1));
    }
    return Promise.resolve(result(""));
  }, gitClock);

  await assertRejects(
    () => resolver.beginObservation().resolveCheckout("/repo"),
    Error,
    "Git command failed while observing checkout: rev-parse HEAD",
  );
});

Deno.test("checkout observations pass cancellation to Git commands", async () => {
  const controller = new AbortController();
  const reason = new Error("checkout observation cancelled");
  const resolver = new GitContextResolver((_args, signal) => {
    assertEquals(signal, controller.signal);
    controller.abort(reason);
    return Promise.reject(reason);
  }, gitClock);

  await assertRejects(
    () =>
      resolver.beginObservation().resolveCheckout(
        "/repo",
        controller.signal,
      ),
    Error,
    reason.message,
  );
});

Deno.test("git context returns null fields outside a repository", async () => {
  const resolver = new GitContextResolver(
    () => Promise.resolve(result("", 128)),
    gitClock,
  );

  assertEquals(await resolver.resolve("/tmp/not-a-repo"), {
    gitRepo: null,
    gitBranch: null,
    gitWorktreeRoot: null,
    gitHeadSha: null,
    gitRemotes: [],
    gitObservedAt: null,
  });
  assertEquals(await resolver.resolve(null), {
    gitRepo: null,
    gitBranch: null,
    gitWorktreeRoot: null,
    gitHeadSha: null,
    gitRemotes: [],
    gitObservedAt: null,
  });
});

Deno.test("git context observes a repository created after an earlier lookup", async () => {
  let lookup = 0;
  const runner: GitCommandRunner = (args) => {
    const command = args.slice(2).join(" ");
    if (command === "rev-parse --show-toplevel") {
      lookup++;
      return lookup === 1
        ? Promise.resolve(result("", 128))
        : Promise.resolve(result("/repo\n"));
    }
    if (command === "branch --show-current") {
      return Promise.resolve(result("main\n"));
    }
    if (command === "remote get-url upstream") {
      return Promise.resolve(result("git@github.com:common/project.git\n"));
    }
    if (command === "rev-parse HEAD") {
      return Promise.resolve(result("abcdef\n"));
    }
    if (command === "remote -v") {
      return Promise.resolve(result(
        "upstream\tgit@github.com:common/project.git (fetch)\n",
      ));
    }
    return Promise.resolve(result("", 1));
  };
  const resolver = new GitContextResolver(runner, gitClock);

  assertEquals(await resolver.resolve("/repo"), {
    gitRepo: null,
    gitBranch: null,
    gitWorktreeRoot: null,
    gitHeadSha: null,
    gitRemotes: [],
    gitObservedAt: null,
  });
  assertEquals(await resolver.resolve("/repo"), {
    gitRepo: "git@github.com:common/project.git",
    gitBranch: "main",
    gitWorktreeRoot: "/repo",
    gitHeadSha: "abcdef",
    gitRemotes: [{
      name: "upstream",
      urls: ["git@github.com:common/project.git"],
    }],
    gitObservedAt: GIT_OBSERVED_AT,
  });
});

Deno.test("git context degrades when spawning git fails", async () => {
  const resolver = new GitContextResolver(
    () => Promise.reject(new Deno.errors.NotFound("git")),
    gitClock,
  );

  assertEquals(await resolver.resolve("/repo"), {
    gitRepo: null,
    gitBranch: null,
    gitWorktreeRoot: null,
    gitHeadSha: null,
    gitRemotes: [],
    gitObservedAt: null,
    gitObservationFailed: true,
  });
});
