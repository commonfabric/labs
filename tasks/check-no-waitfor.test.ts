import { assert, assertEquals } from "@std/assert";
import { expect } from "@std/expect";
import { fromFileUrl, join } from "@std/path";
import {
  ALLOWLIST,
  importsPollingWaitFor,
  isIntegrationTestFile,
  main,
  scan,
} from "./check-no-waitfor.ts";
import { test } from "@commonfabric/test-support/test";
import { runDenoCommandWithTemporaryLock } from "@commonfabric/test-support/isolated-deno";

// Writes a single integration test file with the given contents into a fresh
// temp tree and returns its root. The caller removes the tree.
async function fixtureTree(
  fileName: string,
  contents: string,
): Promise<string> {
  const root = await Deno.makeTempDir({ prefix: "check-no-waitfor-" });
  const dir = join(root, "runtime", "foo", "integration");
  await Deno.mkdir(dir, { recursive: true });
  await Deno.writeTextFile(join(dir, fileName), contents);
  return root;
}

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

test("importsPollingWaitFor detects a single-line named import", () => {
  assert(
    importsPollingWaitFor(
      'import { env, waitFor } from "@commonfabric/integration";',
    ),
  );
});

test("importsPollingWaitFor detects a multi-line named import", () => {
  const source = [
    "import {",
    "  env,",
    "  Page,",
    "  waitFor,",
    "  waitForCondition,",
    '} from "@commonfabric/integration";',
  ].join("\n");
  assert(importsPollingWaitFor(source));
});

test("importsPollingWaitFor detects an aliased import", () => {
  assert(
    importsPollingWaitFor(
      'import { waitFor as poll } from "@commonfabric/integration";',
    ),
  );
});

//
// Type members, and the value imports beside them
//
// A type-only import binds the type of `waitFor` and is erased before the test
// runs, so it cannot poll. The value forms below it still have to be caught.
//

test("importsPollingWaitFor ignores a type-only import statement", () => {
  assertEquals(
    importsPollingWaitFor(
      'import type { waitFor } from "@commonfabric/integration";',
    ),
    false,
  );
});

test("importsPollingWaitFor ignores a type-only import by relative path", () => {
  assertEquals(
    importsPollingWaitFor(
      'import type { waitFor } from "../../integration/utils.ts";',
    ),
    false,
  );
});

test("importsPollingWaitFor ignores an inline type member", () => {
  assertEquals(
    importsPollingWaitFor(
      'import { type waitFor } from "@commonfabric/integration";',
    ),
    false,
  );
});

test("importsPollingWaitFor ignores an aliased inline type member", () => {
  // The erased member binds the local name `waitFor`, so dropping only the
  // `type` keyword would leave the name behind and flag this.
  assertEquals(
    importsPollingWaitFor(
      'import { type Poll as waitFor } from "@commonfabric/integration";',
    ),
    false,
  );
});

test("importsPollingWaitFor detects a value waitFor beside a type member", () => {
  assert(
    importsPollingWaitFor(
      'import { type Page, waitFor } from "@commonfabric/integration";',
    ),
  );
});

test("importsPollingWaitFor detects a value waitFor after a type member on its own line", () => {
  const source = [
    "import {",
    "  type Page,",
    "  waitFor,",
    '} from "@commonfabric/integration";',
  ].join("\n");
  assert(importsPollingWaitFor(source));
});

//
// Names and specifiers that are not the polling import
//
// A helper whose name merely begins with `waitFor`, a subpath specifier, and
// a member call on something else: none of them import the thing the gate
// exists to find.
//

test("importsPollingWaitFor ignores waitFor-prefixed helpers", () => {
  assertEquals(
    importsPollingWaitFor(
      'import { waitForCondition, waitForText } from "@commonfabric/integration";',
    ),
    false,
  );
});

test("importsPollingWaitFor ignores a subpath specifier", () => {
  assertEquals(
    importsPollingWaitFor(
      'import { waitFor } from "@commonfabric/integration/shell-utils";',
    ),
    false,
  );
});

test("importsPollingWaitFor ignores a harness.waitFor member call", () => {
  const source = [
    'import { MultiRuntimeHarness } from "./multi-runtime-harness.ts";',
    "await harness.waitFor(() => true);",
  ].join("\n");
  assertEquals(importsPollingWaitFor(source), false);
});

//
// Occurrences that are not an import
//
// Commenting one out is the first step of migrating a test off the polling
// waitFor, and a specifier inside a string or a template literal is data
// rather than an import. None of these shapes may be flagged.
//

test("importsPollingWaitFor ignores a commented-out member", () => {
  const source = [
    "import {",
    "  env,",
    "  // waitFor,",
    '} from "@commonfabric/integration";',
  ].join("\n");
  assertEquals(importsPollingWaitFor(source), false);
});

test("importsPollingWaitFor ignores an import in a line comment", () => {
  assertEquals(
    importsPollingWaitFor(
      '// import { waitFor } from "@commonfabric/integration";',
    ),
    false,
  );
});

test("importsPollingWaitFor ignores an import in a block comment", () => {
  assertEquals(
    importsPollingWaitFor(
      '/* import { waitFor } from "@commonfabric/integration"; */',
    ),
    false,
  );
});

test("importsPollingWaitFor ignores an import quoted in JSDoc prose", () => {
  const source = [
    "/**",
    ' * Do not: import { waitFor } from "@commonfabric/integration"',
    " */",
    "export const helper = () => {};",
  ].join("\n");
  assertEquals(importsPollingWaitFor(source), false);
});

test("importsPollingWaitFor ignores an import inside a string", () => {
  const source =
    `const banned = 'import { waitFor } from "@commonfabric/integration";';`;
  assertEquals(importsPollingWaitFor(source), false);
});

test("importsPollingWaitFor ignores an import inside a template literal", () => {
  const source = [
    "const sample = `",
    'import { waitFor } from "@commonfabric/integration";',
    "`;",
  ].join("\n");
  assertEquals(importsPollingWaitFor(source), false);
});

//
// Blanking comments and strings
//
// The blanking of comments and strings must not swallow the code around them.
//

test("importsPollingWaitFor detects an import after a comment holding an apostrophe and a brace", () => {
  const source = [
    "// Don't use this: it polls { every 50ms }.",
    'import { waitFor } from "@commonfabric/integration";',
  ].join("\n");
  assert(importsPollingWaitFor(source));
});

test("importsPollingWaitFor detects an import after a template literal", () => {
  const source = [
    "const selector = `#${id} > .row`;",
    'import { waitFor } from "@commonfabric/integration";',
  ].join("\n");
  assert(importsPollingWaitFor(source));
});

test("importsPollingWaitFor detects an import after a nested template literal", () => {
  // A template literal ends at its own closing backtick even when it holds a
  // nested one, so what follows is read as code again.
  const source = [
    "const label = `a ${`b ${c}`} d`;",
    'import { waitFor } from "@commonfabric/integration";',
  ].join("\n");
  assert(importsPollingWaitFor(source));
});

test("importsPollingWaitFor ignores an import in a line-continued string", () => {
  // A string may carry a newline through a trailing backslash, so the scan
  // cannot simply stop looking at the end of the line.
  const source = 'const sample = "\\\n' +
    "import { waitFor } from '@commonfabric/integration';\\\n" +
    '";';
  assertEquals(importsPollingWaitFor(source), false);
});

//
// Relative paths that reach the same `waitFor`, and those that do not
//

test("importsPollingWaitFor detects a relative import of the package's utils.ts", () => {
  assert(
    importsPollingWaitFor(
      'import { waitFor } from "../../integration/utils.ts";',
    ),
  );
});

test("importsPollingWaitFor detects a relative import of the package's index.ts", () => {
  assert(
    importsPollingWaitFor(
      'import { env, waitFor } from "../../../../integration/index.ts";',
    ),
  );
});

test("importsPollingWaitFor ignores a relative import of a module that lacks waitFor", () => {
  // shell-utils.ts imports waitFor for its own use but does not re-export it,
  // so naming waitFor in an import of it would not resolve. The clause has to
  // name waitFor for this to test the specifier rather than the clause.
  assertEquals(
    importsPollingWaitFor(
      'import { waitFor } from "../../integration/shell-utils.ts";',
    ),
    false,
  );
});

test("importsPollingWaitFor ignores a sibling utils.ts outside the package", () => {
  assertEquals(
    importsPollingWaitFor('import { waitFor } from "./utils.ts";'),
    false,
  );
});

//
// Scoping to integration test files
//

test("isIntegrationTestFile scopes to integration test files", () => {
  assert(isIntegrationTestFile("runtime/shell/integration/piece.test.ts"));
  assert(
    isIntegrationTestFile("patterns/integration/counter.test.ts"),
  );
  assert(
    isIntegrationTestFile(
      "runtime/cli/test/integration/fuse-memory-proxy.test.ts",
    ),
  );
});

test("isIntegrationTestFile excludes the integration package itself", () => {
  // runtime/integration/ defines and re-exports waitFor.
  assertEquals(
    isIntegrationTestFile("runtime/integration/utils.ts"),
    false,
  );
  assertEquals(
    isIntegrationTestFile("runtime/integration/shell-utils.ts"),
    false,
  );
});

test("isIntegrationTestFile excludes non-integration and non-ts files", () => {
  assertEquals(
    isIntegrationTestFile("runtime/runner/test/scheduler.test.ts"),
    false,
  );
  assertEquals(
    isIntegrationTestFile("patterns/integration/counter.tsx"),
    false,
  );
  // Outside every package.
  assertEquals(
    isIntegrationTestFile("docs/examples/integration/demo.ts"),
    false,
  );
});

//
// The repository's own tree
//
// The following two tests run against the real repository tree. Together they
// assert that the set of in-scope files importing the polling `waitFor` equals
// the ALLOWLIST exactly.
//

test("no un-allowlisted polling waitFor in integration tests", async () => {
  const { violations } = await scan();
  assertEquals(
    violations,
    [],
    "New polling waitFor usage found in integration test(s). Migrate to " +
      "waitForCondition / awaitViewSettled (see docs/development/waiting-in-tests.md), " +
      "or, for a genuine exception, add the file to ALLOWLIST in tasks/check-no-waitfor.ts.",
  );
});

test("the polling-waitFor ALLOWLIST has no stale entries", async () => {
  const { allowlisted } = await scan();
  const seen = new Set(allowlisted);
  const stale = [...ALLOWLIST].filter((path) => !seen.has(path)).sort();
  assertEquals(
    stale,
    [],
    "ALLOWLIST entries in tasks/check-no-waitfor.ts no longer import the polling " +
      "waitFor (or no longer exist). Remove them from the allowlist.",
  );
});

//
// The command entry point
//
// The next two tests drive the command entry point over a temp fixture tree, so
// they cover the clean and violation paths without depending on the real tree.
// The last two run the script itself as a separate process.
//

test(
  "check-no-waitfor main reports success and returns 0 on a clean tree",
  async () => {
    const root = await fixtureTree(
      "ok.test.ts",
      'import { env } from "@commonfabric/integration";\n',
    );
    try {
      let code = -1;
      const { out } = await captureConsole(async () => {
        code = await main(root);
      });
      assertEquals(code, 0);
      assert(out.includes("No new polling waitFor"));
    } finally {
      await Deno.remove(root, { recursive: true });
    }
  },
);

test("main reports the offender and returns 1 on a violation", async () => {
  const root = await fixtureTree(
    "bad.test.ts",
    'import { waitFor } from "@commonfabric/integration";\n',
  );
  try {
    let code = -1;
    const { err } = await captureConsole(async () => {
      code = await main(root);
    });
    assertEquals(code, 1);
    assert(err.includes("runtime/foo/integration/bad.test.ts"));
    assert(err.includes("waitForCondition"));
    assert(err.includes("docs/development/waiting-in-tests.md"));
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

/**
 * Runs the script with the task's permissions over a tree holding one
 * integration test file, returning its exit code and what it printed.
 */
async function runScript(fileName: string, contents: string) {
  const root = await fixtureTree(fileName, contents);
  const repo = fromFileUrl(new URL("..", import.meta.url));
  try {
    const output = await runDenoCommandWithTemporaryLock({
      root: repo,
      args: (lockPath) => [
        "run",
        "--config",
        join(repo, "deno.jsonc"),
        "--lock",
        lockPath,
        "--allow-read",
        join(repo, "tasks/check-no-waitfor.ts"),
        root,
      ],
    });
    return {
      code: output.code,
      stdout: new TextDecoder().decode(output.stdout),
      stderr: new TextDecoder().decode(output.stderr),
    };
  } finally {
    await Deno.remove(root, { recursive: true });
  }
}

test("exits 1 as a command-line program and names the offender in the repository it is given", async () => {
  const { code, stdout, stderr } = await runScript(
    "bad.test.ts",
    'import { waitFor } from "@commonfabric/integration";\n',
  );
  expect(code).toBe(1);
  expect(stdout).toBe("");
  expect(stderr).toContain("runtime/foo/integration/bad.test.ts");
});

test("exits 0 as a command-line program for a repository it is given with no polling `waitFor`", async () => {
  expect(
    await runScript(
      "good.test.ts",
      'import { waitForCondition } from "@commonfabric/integration";\n',
    ),
  ).toEqual({
    code: 0,
    stdout: `No new polling waitFor in integration tests ` +
      `(${ALLOWLIST.size} allowlisted exception(s)).\n`,
    stderr: "",
  });
});
