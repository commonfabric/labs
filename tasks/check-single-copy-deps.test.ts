import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { dirname, fromFileUrl, join } from "@std/path";
import { runDenoCommandWithTemporaryLock } from "@commonfabric/test-support/isolated-deno";
import { test } from "@commonfabric/test-support/test";
import {
  copiesOf,
  findProblems,
  main,
  packageNameOf,
  SINGLE_COPY_PACKAGES,
} from "./check-single-copy-deps.ts";

const REPO_ROOT = dirname(dirname(fromFileUrl(import.meta.url)));

// Runs `body` with console.log and console.error captured, returning what each
// received. Restores the originals afterward.
async function captureConsole(
  body: () => Promise<void>,
): Promise<{ out: string; err: string }> {
  const out: string[] = [];
  const err: string[] = [];
  const origLog = console.log;
  const origError = console.error;
  console.log = (...args) => out.push(args.map(String).join(" "));
  console.error = (...args) => err.push(args.map(String).join(" "));
  try {
    await body();
  } finally {
    console.log = origLog;
    console.error = origError;
  }
  return { out: out.join("\n"), err: err.join("\n") };
}

// npm entry keys as deno.lock writes them: `name@version`, optionally with a
// `_peer@version` suffix, and the name itself may be scoped.
function singleCopyLock(): { npm: Record<string, unknown> } {
  return {
    npm: {
      "ai@7.0.30_zod@3.25.76": {},
      "@ai-sdk/provider-utils@5.0.10_zod@3.25.76": {},
      "@arizeai/openinference-semantic-conventions@2.5.0": {},
      // Two copies of a package that tolerates them; must not be reported.
      "gaxios@6.7.1": {},
      "gaxios@7.2.0": {},
    },
  };
}

test("packageNameOf splits the name from the version and peer suffix", () => {
  assertEquals(packageNameOf("ai@7.0.30_zod@3.25.76"), "ai");
  assertEquals(
    packageNameOf("@ai-sdk/provider-utils@5.0.10_zod@3.25.76"),
    "@ai-sdk/provider-utils",
  );
  assertEquals(
    packageNameOf("@arizeai/openinference-semantic-conventions@2.5.0"),
    "@arizeai/openinference-semantic-conventions",
  );
  assertEquals(packageNameOf("gaxios@6.7.1"), "gaxios");
});

test("copiesOf groups every entry under its package name", () => {
  const copies = copiesOf(singleCopyLock());
  assertEquals(copies.get("ai"), ["ai@7.0.30_zod@3.25.76"]);
  assertEquals(copies.get("gaxios"), ["gaxios@6.7.1", "gaxios@7.2.0"]);
});

test("findProblems reports nothing when each package resolves once", () => {
  assertEquals(findProblems(singleCopyLock()), []);
});

test("findProblems reports a package resolved twice", () => {
  // The shape of the bug this check exists for: rolling the arizeai packages
  // alone leaves the AI SDK resolved twice, once for toolshed and once for
  // @ai-sdk/otel.

  const lock = singleCopyLock();
  lock.npm["ai@5.0.27_zod@3.25.76"] = {};

  const problems = findProblems(lock);
  assertEquals(problems.length, 1);
  assertStringIncludes(problems[0], "ai: resolved 2 times, must be 1");
  assertStringIncludes(problems[0], "ai@5.0.27_zod@3.25.76");
  assertStringIncludes(problems[0], "ai@7.0.30_zod@3.25.76");
});

test("findProblems reports a package missing from the lockfile", () => {
  // A package that disappears from the lockfile would otherwise pass silently,
  // which would make this check quietly stop covering it.

  const problems = findProblems({ npm: {} }, { ai: "the AI SDK" });
  assertEquals(problems.length, 1);
  assertStringIncludes(problems[0], "not in deno.lock at all");
});

test("findProblems does not report packages outside the list", () => {
  assertEquals(findProblems(singleCopyLock(), {}), []);
});

test("the repository's own lockfile passes", async () => {
  assertEquals(await main(REPO_ROOT), 0);
});

test("main reports the duplicate and returns 1", async () => {
  // main() reads deno.lock from the root it is given, so a temp tree with a
  // duplicated lockfile drives the reporting path the passing repo never does:
  // the message, the per-copy listing, and the non-zero exit.

  const root = await Deno.makeTempDir({ prefix: "check-single-copy-deps-" });
  try {
    const lock = singleCopyLock();
    lock.npm["ai@5.0.27_zod@3.25.76"] = {};
    await Deno.writeTextFile(join(root, "deno.lock"), JSON.stringify(lock));

    let code = -1;
    const { err } = await captureConsole(async () => {
      code = await main(root);
    });

    assertEquals(code, 1);
    assertStringIncludes(err, "resolves more than one copy");
    assertStringIncludes(err, "ai@5.0.27_zod@3.25.76");
    assertStringIncludes(err, "ai@7.0.30_zod@3.25.76");
    assertStringIncludes(err, "Roll the AI SDK");
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

test("running the script as a command reports single copies", async () => {
  // Runs the script the way `deno task check-single-copy-deps` does, which the
  // calls to main() above do not: they would still pass if the entry point
  // never ran it, or if the task's declared permissions were too narrow to read
  // the lockfile.

  const output = await runDenoCommandWithTemporaryLock({
    root: REPO_ROOT,
    args: (lockPath) => [
      "run",
      "--config",
      join(REPO_ROOT, "deno.jsonc"),
      "--lock",
      lockPath,
      "--allow-read",
      join(REPO_ROOT, "tasks/check-single-copy-deps.ts"),
    ],
  });
  assertEquals(output.code, 0);
  assert(
    new TextDecoder().decode(output.stdout).includes(
      "Single-copy packages resolve once each",
    ),
  );
});

test("every guarded package names what breaks when it is duplicated", () => {
  for (const [name, reason] of Object.entries(SINGLE_COPY_PACKAGES)) {
    assertEquals(typeof reason, "string", `${name} has no reason`);
    assertEquals(reason.length > 0, true, `${name} has an empty reason`);
  }
});
