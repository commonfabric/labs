import { assert, assertEquals, assertRejects } from "@std/assert";
import { dirname, fromFileUrl, join } from "@std/path";
import { runDenoCommandWithTemporaryLock } from "@commonfabric/test-support/isolated-deno";
import { test } from "@commonfabric/test-support/test";
import {
  checkStep,
  extensionsOf,
  main,
  parseSteps,
  pinOf,
  resolveFromGitHub,
  type Resolver,
  type Step,
} from "./check-action-pins.ts";

const REPO_ROOT = dirname(dirname(fromFileUrl(import.meta.url)));

const V6 = "55cc8345863c7cc4c66a329aec7e433d2d1c52a9";
const V6_0_0 = "2c8a9bd7457de244a408f35966fab2fb45fda9c8";
const OTHER = "deadbeefdeadbeefdeadbeefdeadbeefdeadbeef";

// Stands in for GitHub, answering by prefix the way matching-refs does, with
// every tag already followed through to its commit.
const TAGS: Resolver = (_repo, prefix) =>
  Promise.resolve(
    new Map(
      Object.entries({ v6: V6, "v6.0.0": V6_0_0, "v6.1.0": V6 })
        .filter(([name]) => name.startsWith(prefix)),
    ),
  );

function step(action: string, comment: string): Step {
  return { file: "workflows/x.yml", action, comment };
}

test("a commit the named release points at passes", async () => {
  assertEquals(
    await checkStep(step(`actions/cache@${V6}`, "v6.1.0"), TAGS),
    null,
  );
});

test("a comment naming a moving alias fails", async () => {
  // `v6` is true today and false after the next release, without anybody
  // touching the file, so the check asks for the release itself and says
  // which one.
  const problem = await checkStep(step(`actions/cache@${V6}`, "v6"), TAGS);
  assert(problem?.includes("a name its publisher moves onto each release"));
  assert(problem?.includes("v6.1.0"));
});

test("a commit under the wrong release fails", async () => {
  const problem = await checkStep(
    step(`actions/cache@${V6_0_0}`, "v6.1.0"),
    TAGS,
  );
  assert(problem?.includes("v6.1.0 is"));
  assert(problem?.includes("but the step runs"));
});

test("a sub-action is checked against its repository", async () => {
  assertEquals(
    await checkStep(step(`actions/cache/restore@${V6}`, "v6.1.0"), TAGS),
    null,
  );
});

test("a commit no release points at fails", async () => {
  const problem = await checkStep(
    step(`actions/cache@${OTHER}`, "v6.1.0"),
    TAGS,
  );
  assert(problem?.includes("but the step runs"));
});

test("a comment naming an absent release fails", async () => {
  const problem = await checkStep(step(`actions/cache@${V6}`, "v99"), TAGS);
  assert(problem?.includes("has no v99 release"));
});

test("a step naming a tag rather than a commit fails", async () => {
  const problem = await checkStep(step("actions/cache@v6", "v6.1.0"), TAGS);
  assert(problem?.includes("names no commit"));
});

test("a pinned step with no comment fails", async () => {
  const problem = await checkStep(step(`actions/cache@${V6}`, ""), TAGS);
  assert(problem?.includes("has no version comment"));
});

test("a comment that names no version fails", async () => {
  const problem = await checkStep(
    step(`actions/cache@${V6}`, "the good one"),
    TAGS,
  );
  assert(problem?.includes("the good one"));
});

test("pinOf drops a sub-action path and rejects a tag", () => {
  assertEquals(pinOf(step(`actions/cache/save@${V6}`, "v6.1.0")), {
    repo: "actions/cache",
    sha: V6,
  });
  assertEquals(pinOf(step("actions/cache@v6", "v6.1.0")), null);
  assertEquals(pinOf(step("./.github/actions/deno-setup", "")), null);
});

test("extensionsOf finds the releases a name covers", () => {
  const tags = new Map([["v4", "a"], ["v4.2.0", "b"], ["v41.0.0", "c"]]);
  // `v41.0.0` does not extend `v4`: the split is at the dot.
  assertEquals(extensionsOf(tags, "v4"), ["v4.2.0"]);
  assertEquals(extensionsOf(tags, "v4.2.0"), []);
});

test("parseSteps reads the action and the comment", () => {
  const steps = parseSteps(
    [
      `      uses: actions/checkout@${V6} # v7`,
      `      uses: "denoland/setup-deno@${V6}" # v2.0.5`,
      "      uses: ./.github/actions/deno-setup",
      "      uses: actions/checkout@v7",
      `      # uses: actions/checkout@${V6} # v7`,
    ].join("\n"),
    "workflows/x.yml",
  );

  assertEquals(steps.map((s) => s.action), [
    `actions/checkout@${V6}`,
    `denoland/setup-deno@${V6}`,
    // Kept, so that an unpinned step is reported rather than skipped.
    "./.github/actions/deno-setup",
    "actions/checkout@v7",
  ]);
  assertEquals(steps.map((s) => s.comment), ["v7", "v2.0.5", "", ""]);
});

// The resolver and the walk below are the parts that touch the outside world.
// `fetch` stands in for GitHub so the shapes it answers with — a lightweight
// tag, an annotated tag, an absent one, a refusal — are each exercised.

function stubFetch(
  answer: (
    path: string,
  ) => { status: number; body?: unknown; headers?: HeadersInit },
): () => void {
  const real = globalThis.fetch;
  globalThis.fetch = ((input: string | URL | Request) => {
    const url = new URL(String(input instanceof Request ? input.url : input));
    const { status, body, headers } = answer(url.pathname);
    return Promise.resolve(
      new Response(body === undefined ? null : JSON.stringify(body), {
        status,
        headers,
      }),
    );
  }) as typeof fetch;
  return () => {
    globalThis.fetch = real;
  };
}

test("resolveFromGitHub reads a lightweight tag", async () => {
  const restore = stubFetch(() => ({
    status: 200,
    body: [{ ref: "refs/tags/v6.1.0", object: { type: "commit", sha: V6 } }],
  }));
  try {
    assertEquals(
      [...await resolveFromGitHub("actions/cache", "v6.1.0")],
      [["v6.1.0", V6]],
    );
  } finally {
    restore();
  }
});

test("resolveFromGitHub follows an annotated tag", async () => {
  // An annotated tag answers with the tag object, so the commit is one more
  // request away.
  const restore = stubFetch((path) =>
    path.endsWith("/git/tags/tagobject00000000000000000000000000000")
      ? { status: 200, body: { object: { sha: V6 } } }
      : {
        status: 200,
        body: [{
          ref: "refs/tags/v6.1.0",
          object: {
            type: "tag",
            sha: "tagobject00000000000000000000000000000",
          },
        }],
      }
  );
  try {
    assertEquals(
      [...await resolveFromGitHub("actions/cache", "v6.1.0")],
      [["v6.1.0", V6]],
    );
  } finally {
    restore();
  }
});

test("resolveFromGitHub reads an absent version as empty", async () => {
  const restore = stubFetch(() => ({ status: 404 }));
  try {
    assertEquals((await resolveFromGitHub("actions/cache", "v99")).size, 0);
  } finally {
    restore();
  }
});

test("resolveFromGitHub reports a refused listing", async () => {
  const restore = stubFetch(() => ({ status: 500 }));
  try {
    await assertRejects(
      () => resolveFromGitHub("actions/cache", "v6.1.0"),
      Error,
      "500",
    );
  } finally {
    restore();
  }
});

test("resolveFromGitHub reports a refused peel", async () => {
  const restore = stubFetch((path) =>
    path.includes("/git/tags/") ? { status: 500 } : {
      status: 200,
      body: [{
        ref: "refs/tags/v6.1.0",
        object: { type: "tag", sha: "tagobject" },
      }],
    }
  );
  try {
    await assertRejects(
      () => resolveFromGitHub("actions/cache", "v6.1.0"),
      Error,
      "peeling",
    );
  } finally {
    restore();
  }
});

test("resolveFromGitHub names the rate limit when refused", async () => {
  // The unauthenticated limit is low enough to hit by accident, so the
  // message has to say what to do about it rather than just the status.
  const restore = stubFetch(() => ({
    status: 403,
    headers: { "x-ratelimit-remaining": "0" },
  }));
  try {
    await assertRejects(
      () => resolveFromGitHub("actions/cache", "v6.1.0"),
      Error,
      "GITHUB_TOKEN",
    );
  } finally {
    restore();
  }
});

async function withGithubTree(
  files: Record<string, string>,
  body: (root: string) => Promise<void>,
): Promise<void> {
  const root = await Deno.makeTempDir();
  try {
    for (const [path, contents] of Object.entries(files)) {
      const full = `${root}/.github/${path}`;
      await Deno.mkdir(full.slice(0, full.lastIndexOf("/")), {
        recursive: true,
      });
      await Deno.writeTextFile(full, contents);
    }
    await body(root);
  } finally {
    await Deno.remove(root, { recursive: true });
  }
}

test("main walks nested files and passes a sound tree", async () => {
  await withGithubTree({
    "workflows/a.yml": `      uses: actions/cache@${V6} # v6.1.0\n`,
    // A nested directory, a second extension, and a step naming an action in
    // this repository, which is carried by the run already.
    "actions/deep/action.yaml":
      `      uses: actions/cache/restore@${V6} # v6.1.0\n` +
      "      uses: ./.github/actions/deno-setup\n",
    "workflows/notes.md": "not a workflow\n",
  }, async (root) => {
    assertEquals(await main(root, TAGS), 0);
  });
});

test("main reports a step that does not match", async () => {
  await withGithubTree({
    "workflows/a.yml": `      uses: actions/cache@${OTHER} # v6.1.0\n`,
  }, async (root) => {
    assertEquals(await main(root, TAGS), 1);
  });
});

test("running the script as a command checks a tree", async () => {
  // Runs the script the way `deno task check-action-pins` does, which the
  // calls to main() above do not: they would still pass if the entry point
  // never ran it, or if the task's declared permissions were too narrow to
  // read the files. The tree names only actions this repository carries, so
  // the run reaches no network and the result does not depend on GitHub.
  await withGithubTree({
    "workflows/a.yml": "      uses: ./.github/actions/deno-setup\n",
  }, async (root) => {
    const output = await runDenoCommandWithTemporaryLock({
      root: REPO_ROOT,
      args: (lockPath) => [
        "run",
        "--config",
        join(REPO_ROOT, "deno.jsonc"),
        "--lock",
        lockPath,
        "--allow-read",
        "--allow-net=api.github.com",
        "--allow-env",
        join(REPO_ROOT, "tasks/check-action-pins.ts"),
        root,
      ],
    });
    assertEquals(output.code, 0);
    assert(
      new TextDecoder().decode(output.stdout).includes(
        "Every action step runs a release its comment names",
      ),
    );
  });
});
