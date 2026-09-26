import { assertEquals, assertRejects } from "@std/assert";
import { FakeTime } from "@std/testing/time";
import ports from "@commonfabric/ports" with { type: "json" };
import { preloadArgument } from "@commonfabric/test-support/records";
import {
  buildFilteredTestArgs,
  chooseGeneratedPortOffset,
  findIntegrationTestFiles,
  GENERATED_PORT_OFFSET_RANGE,
  integrationTestDir,
  offsetPorts,
  precompilePatternTests,
  runFilteredIntegration,
  runPackageIntegration,
  selectIntegrationTestFiles,
  selectPatternTestFiles,
  startServers,
} from "./integration.ts";
import { PATTERN_TREES } from "./pattern-files.ts";

Deno.test("selectPatternTestFiles returns the files slash-separated and sorted", () => {
  assertEquals(
    selectPatternTestFiles([
      "packages\\patterns\\notes\\note.test.tsx",
      "packages/patterns/dice.test.tsx",
    ]),
    [
      "packages/patterns/dice.test.tsx",
      "packages/patterns/notes/note.test.tsx",
    ],
  );
});

Deno.test("selectIntegrationTestFiles keeps .test.ts files matching the filter", () => {
  const files = [
    "home-profile.test.ts",
    "counter.test.ts",
    "home-dashboard.test.ts",
    "README.md",
  ];
  assertEquals(selectIntegrationTestFiles(files, "home"), [
    "home-dashboard.test.ts",
    "home-profile.test.ts",
  ]);
});

Deno.test("selectIntegrationTestFiles matches a single file by name", () => {
  const files = ["home-profile.test.ts", "counter.test.ts"];
  assertEquals(selectIntegrationTestFiles(files, "home-profile"), [
    "home-profile.test.ts",
  ]);
});

Deno.test("selectIntegrationTestFiles prefers an exact filename match", () => {
  const files = ["counter.test.ts", "nested-counter.test.ts"];
  assertEquals(selectIntegrationTestFiles(files, "counter"), [
    "counter.test.ts",
  ]);
  assertEquals(selectIntegrationTestFiles(files, "counter.test.ts"), [
    "counter.test.ts",
  ]);
});

Deno.test("selectIntegrationTestFiles returns empty when nothing matches", () => {
  assertEquals(
    selectIntegrationTestFiles(["counter.test.ts"], "nonexistent"),
    [],
  );
});

Deno.test("selectIntegrationTestFiles ignores non-test files containing the filter", () => {
  assertEquals(
    selectIntegrationTestFiles(
      ["home.ts", "home.test.ts", "home.test.tsx", "home.txt"],
      "home",
    ),
    ["home.test.ts"],
  );
});

Deno.test("selectIntegrationTestFiles sorts the results", () => {
  assertEquals(
    selectIntegrationTestFiles(["b.test.ts", "a.test.ts"], ".test.ts"),
    ["a.test.ts", "b.test.ts"],
  );
});

Deno.test("integrationTestDir points generated-patterns at its patterns subdir", () => {
  assertEquals(
    integrationTestDir("generated-patterns"),
    "integration/patterns",
  );
});

Deno.test("integrationTestDir defaults to the integration directory", () => {
  assertEquals(integrationTestDir("patterns"), "integration");
  assertEquals(integrationTestDir("runner"), "integration");
  assertEquals(integrationTestDir("shell"), "integration");
});

Deno.test("findIntegrationTestFiles reads one level deep and filters by name", async () => {
  const dir = await Deno.makeTempDir();
  try {
    await Deno.writeTextFile(`${dir}/home-profile.test.ts`, "");
    await Deno.writeTextFile(`${dir}/counter.test.ts`, "");
    await Deno.writeTextFile(`${dir}/notes.txt`, "");
    // A nested directory and the test file inside it are not descended into.
    await Deno.mkdir(`${dir}/reload`);
    await Deno.writeTextFile(`${dir}/reload/home-reload.test.ts`, "");

    assertEquals(await findIntegrationTestFiles(dir, "home"), [
      "home-profile.test.ts",
    ]);
    assertEquals(await findIntegrationTestFiles(dir, ""), [
      "counter.test.ts",
      "home-profile.test.ts",
    ]);
    assertEquals(await findIntegrationTestFiles(dir, "nope"), []);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("findIntegrationTestFiles returns empty for a missing directory", async () => {
  const dir = await Deno.makeTempDir();
  try {
    assertEquals(await findIntegrationTestFiles(`${dir}/missing`, "home"), []);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("findIntegrationTestFiles rethrows errors other than a missing directory", async () => {
  const file = await Deno.makeTempFile();
  try {
    // Reading a file as a directory raises NotADirectory, not NotFound.
    await assertRejects(() => findIntegrationTestFiles(file, "home"));
  } finally {
    await Deno.remove(file);
  }
});

Deno.test("buildFilteredTestArgs passes files as explicit paths under relDir", () => {
  assertEquals(
    buildFilteredTestArgs("runner", "integration", ["a.test.ts", "b.test.ts"]),
    ["test", "-A", "./integration/a.test.ts", "./integration/b.test.ts"],
  );
});

Deno.test("buildFilteredTestArgs adds patterns memory and leak flags", () => {
  assertEquals(
    buildFilteredTestArgs("patterns", "integration", ["home-profile.test.ts"]),
    [
      "test",
      "-A",
      "--v8-flags=--max-old-space-size=4096",
      "--trace-leaks",
      "./integration/home-profile.test.ts",
    ],
  );
});

Deno.test("buildFilteredTestArgs uses the generated-patterns subdir and flags", () => {
  assertEquals(
    buildFilteredTestArgs(
      "generated-patterns",
      "integration/patterns",
      ["simple-counter.test.ts"],
    ),
    [
      "test",
      "-A",
      "--trace-leaks",
      "--parallel",
      "./integration/patterns/simple-counter.test.ts",
    ],
  );
});

Deno.test("buildFilteredTestArgs adds a junit path when a junit dir is given", () => {
  assertEquals(
    buildFilteredTestArgs("shell", "integration", ["a.test.ts"], "out/junit"),
    [
      "test",
      "-A",
      "--junit-path=out/junit/shell.xml",
      preloadArgument(),
      "./integration/a.test.ts",
    ],
  );
});

Deno.test("runFilteredIntegration fails without running when no file matches", async () => {
  const pkgDir = await Deno.makeTempDir();
  try {
    await Deno.mkdir(`${pkgDir}/integration`);
    await Deno.writeTextFile(`${pkgDir}/integration/counter.test.ts`, "");
    let ran = false;
    const result = await runFilteredIntegration(
      "runner",
      pkgDir,
      {},
      "no-such-test",
      undefined,
      () => {
        ran = true;
        return Promise.resolve({ success: true, code: 0 });
      },
    );
    assertEquals(result, { success: false, code: 1 });
    assertEquals(ran, false);
  } finally {
    await Deno.remove(pkgDir, { recursive: true });
  }
});

Deno.test("runFilteredIntegration runs deno test with the matching explicit paths", async () => {
  const pkgDir = await Deno.makeTempDir();
  try {
    await Deno.mkdir(`${pkgDir}/integration`);
    await Deno.writeTextFile(`${pkgDir}/integration/home-profile.test.ts`, "");
    await Deno.writeTextFile(`${pkgDir}/integration/counter.test.ts`, "");
    let captured: { cmd: string[]; cwd?: string } | undefined;
    const result = await runFilteredIntegration(
      "patterns",
      pkgDir,
      { LOG_LEVEL: "warn" },
      "home-profile",
      undefined,
      (cmd, options) => {
        captured = { cmd, cwd: options?.cwd };
        return Promise.resolve({ success: true, code: 0 });
      },
    );
    assertEquals(result, { success: true, code: 0 });
    assertEquals(captured?.cwd, pkgDir);
    assertEquals(captured?.cmd, [
      "deno",
      "test",
      "-A",
      "--v8-flags=--max-old-space-size=4096",
      "--trace-leaks",
      "./integration/home-profile.test.ts",
    ]);
  } finally {
    await Deno.remove(pkgDir, { recursive: true });
  }
});

Deno.test("runFilteredIntegration uses the generated-patterns subdir", async () => {
  const pkgDir = await Deno.makeTempDir();
  try {
    await Deno.mkdir(`${pkgDir}/integration/patterns`, { recursive: true });
    await Deno.writeTextFile(
      `${pkgDir}/integration/patterns/simple-counter.test.ts`,
      "",
    );
    let captured: string[] | undefined;
    await runFilteredIntegration(
      "generated-patterns",
      pkgDir,
      {},
      "simple-counter",
      undefined,
      (cmd) => {
        captured = cmd;
        return Promise.resolve({ success: true, code: 0 });
      },
    );
    assertEquals(captured, [
      "deno",
      "test",
      "-A",
      "--trace-leaks",
      "--parallel",
      "./integration/patterns/simple-counter.test.ts",
    ]);
  } finally {
    await Deno.remove(pkgDir, { recursive: true });
  }
});

Deno.test("runPackageIntegration returns false when a filtered run matches nothing", async () => {
  const rootDir = await Deno.makeTempDir();
  try {
    await Deno.mkdir(`${rootDir}/packages/runner/integration`, {
      recursive: true,
    });
    await Deno.writeTextFile(
      `${rootDir}/packages/runner/integration/counter.test.ts`,
      "",
    );
    const ok = await runPackageIntegration(
      "runner",
      "",
      rootDir,
      "no-such-test",
    );
    assertEquals(ok, false);
  } finally {
    await Deno.remove(rootDir, { recursive: true });
  }
});

Deno.test("startServers returns when the startup script completes", async () => {
  using time = new FakeTime();
  let ran = false;
  let settled = false;
  const completion = startServers(
    17,
    "/repo",
    {},
    () => {
      ran = true;
      return Promise.resolve({ success: true, code: 0 });
    },
  ).then((code) => {
    settled = true;
    return code;
  });

  await time.tickAsync(0);

  assertEquals(ran, true);
  assertEquals(settled, true);
  assertEquals(await completion, 0);
});

Deno.test("startServers returns the startup script failure", async () => {
  const failureCode = 42;
  const code = await startServers(
    17,
    "/repo",
    {},
    () => Promise.resolve({ success: false, code: failureCode }),
  );

  assertEquals(code, failureCode);
});

// Every offset the choice can return, collected by sweeping its random input
// finely enough that nothing it can produce is missed.
function generatedPortOffsets(): number[] {
  const steps = 100_000;
  const offsets = new Set<number>();
  for (let step = 0; step < steps; step++) {
    offsets.add(chooseGeneratedPortOffset(() => step / steps));
  }
  return [...offsets].sort((a, b) => a - b);
}

//
// Port offsets, and the ports they must not land on
//
// A port offset shifts every dev server together, and the servers bind whatever
// port arithmetic lands on. Browsers and Deno's `fetch` both refuse to open a
// connection to a port on the WHATWG bad-port list, so an offset that lands a
// server on one produces a server that starts, passes a curl health check, and
// that nothing in a test can reach: every browser navigation gets an error page
// and every server-to-server proxy hop fails.
//

Deno.test("no generated port offset lands a server on a blocked port", () => {
  const blocked = new Set(ports.blockedPorts);
  const offenders: string[] = [];
  for (const offset of generatedPortOffsets()) {
    for (const port of offsetPorts(offset)) {
      if (blocked.has(port)) {
        offenders.push(`offset ${offset} uses port ${port}`);
      }
    }
  }
  assertEquals(offenders, []);
});

Deno.test("generated port offsets span the documented range", () => {
  const offsets = generatedPortOffsets();
  assertEquals(offsets[0], GENERATED_PORT_OFFSET_RANGE.first);
  assertEquals(offsets[offsets.length - 1], GENERATED_PORT_OFFSET_RANGE.last);
});

Deno.test("every recorded blocked port is one fetch refuses", async () => {
  // Keeps the recorded list honest against the runtime that enforces it. A
  // blocked port is rejected before any connection is opened, so pointing these
  // probes at a host that cannot resolve reaches no network service: the
  // blocked answer arrives first, and any other port would fail on the name
  // instead.

  const stillBlocked: number[] = [];
  for (const port of ports.blockedPorts) {
    try {
      await fetch(`http://blocked-port-probe.invalid:${port}/`);
    } catch (error) {
      if (String(error).includes("are blocked")) stillBlocked.push(port);
    }
  }
  assertEquals(stillBlocked, ports.blockedPorts);
});

// The precompile pass, driven with a stand-in for the command runner: what it
// asks to run, and how a group that fails or cannot spawn is reported.

type Ran = Awaited<
  ReturnType<NonNullable<Parameters<typeof precompilePatternTests>[4]>>
>;

const PRECOMPILE_ROOT = "/repo";
const PATTERN_FILES = "abcdefghijkl".split("").map((name) =>
  `packages/patterns/${name}/main.test.tsx`
);
const CONNECTOR_FILE = `${PATTERN_TREES[1].directory}/main.test.tsx`;

async function precompileCapturing(
  run: (argv: string[]) => Promise<Ran>,
): Promise<{ argvs: string[][]; logged: string[] }> {
  const argvs: string[][] = [];
  const logged: string[] = [];
  const previousLog = console.log;
  console.log = (...args: unknown[]) => {
    logged.push(args.map(String).join(" "));
  };
  try {
    await precompilePatternTests(
      ["cf"],
      PRECOMPILE_ROOT,
      [...PATTERN_FILES, CONNECTOR_FILE],
      5,
      (argv) => {
        argvs.push(argv);
        return run(argv);
      },
    );
  } finally {
    console.log = previousLog;
  }
  return { argvs, logged };
}

Deno.test("precompilePatternTests cuts the shard into runs of neighbors that share a root", async () => {
  const { argvs } = await precompileCapturing(() =>
    Promise.resolve({ success: true, code: 0 })
  );
  const groups = argvs.map((argv) => {
    const root = argv[argv.indexOf("--root") + 1];
    return { root, files: argv.slice(argv.indexOf("--root") + 2) };
  });
  // Thirteen files, five at a time: runs of three, and the lone file of the
  // other root in a run of its own, never beside the others.
  assertEquals(
    groups.map((group) => group.files.length),
    [3, 3, 3, 3, 1],
  );
  assertEquals(
    groups.map((group) => group.root),
    [
      ...Array(4).fill(`${PRECOMPILE_ROOT}/packages/patterns`),
      PRECOMPILE_ROOT,
    ],
  );
  assertEquals(groups.flatMap((group) => group.files), [
    ...PATTERN_FILES,
    CONNECTOR_FILE,
  ]);
  for (const argv of argvs) {
    assertEquals(argv.slice(0, 3), ["cf", "test", "--compile-only"]);
  }
});

Deno.test("precompilePatternTests prints a failed group's output and goes on to the rest", async () => {
  let calls = 0;
  const { argvs, logged } = await precompileCapturing(() => {
    calls++;
    return Promise.resolve(
      calls === 1
        ? { success: false, code: 3, stdout: "first\nsecond", stderr: "third" }
        : { success: true, code: 0 },
    );
  });
  assertEquals(argvs.length, 5);
  assertEquals(
    logged.some((line) => line.endsWith("exited 3:")),
    true,
  );
  for (const line of ["   first", "   second", "   third"]) {
    assertEquals(logged.includes(line), true, line);
  }
  assertEquals(
    logged.some((line) => line.includes("1 group(s) had a failure")),
    true,
  );
});

Deno.test("precompilePatternTests treats a run that cannot spawn as that group's failure", async () => {
  let calls = 0;
  const { argvs, logged } = await precompileCapturing(() => {
    calls++;
    return calls === 1
      ? Promise.reject(new Error("no such binary"))
      : Promise.resolve({ success: true, code: 0 });
  });
  assertEquals(argvs.length, 5);
  assertEquals(
    logged.some((line) => line.endsWith("exited 127:")),
    true,
  );
  assertEquals(logged.includes("   Error: no such binary"), true);
});
