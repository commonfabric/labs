import { assert, assertEquals, assertThrows } from "@std/assert";
import { dirname, fromFileUrl, join } from "@std/path";
import { runDenoCommandWithTemporaryLock } from "@commonfabric/test-support/isolated-deno";
import {
  compareVersions,
  findProblems,
  isExactVersion,
  main,
  parseCheckShRange,
  parseDockerfileDenoVersions,
  parseMisePin,
  parseMisePins,
  versionInRange,
} from "./check-deno-pins.ts";

const REPO_ROOT = dirname(dirname(fromFileUrl(import.meta.url)));

// A consistent set of file contents, mirroring the real files' shapes. The
// action and check.sh fixtures carry the prose mentions of mise.toml that the
// real files have (a description, a comment), so a check that matched the
// file name alone would pass here for a reason production could not reproduce.
function alignedFiles() {
  return {
    miseToml: '[tools]\ndeno = "2.9.4"\n',
    dockerfiles: {
      "dashboard/Dockerfile":
        "FROM --platform=linux/amd64 denoland/deno:2.9.4\n",
      "runtime/toolshed/Dockerfile": "FROM denoland/deno:2.9.4 AS builder\n" +
        "RUN deno install --frozen\n" +
        "FROM denoland/deno:2.9.4\n",
    },
    checkSh: "# The exact Deno version is pinned in mise.toml.\n" +
      'DENO_VERSION_MIN="2.8.0"\nDENO_VERSION_MAX="2.10.0"\n' +
      `DENO_PINS="$(sed -n 's/^deno = "\\([^"]*\\)"$/\\1/p' mise.toml)"\n`,
    denoSetupAction: '    description: "Defaults to the pin in mise.toml."\n' +
      "    # The repository's Deno version is pinned once, in mise.toml.\n" +
      "      run: |\n" +
      `        version="$(sed -n 's/^deno = "\\([^"]*\\)"$/\\1/p' mise.toml | head -1)"\n`,
  };
}

Deno.test("parseMisePin extracts the pinned version", () => {
  assertEquals(parseMisePin('[tools]\ndeno = "2.8.1"\n'), "2.8.1");
});

Deno.test("parseMisePin returns undefined when there is no pin", () => {
  assertEquals(parseMisePin('[tools]\nnode = "22.0.0"\n'), undefined);
});

Deno.test("parseMisePin returns undefined when the pin is defined twice", () => {
  assertEquals(
    parseMisePin('[tools]\ndeno = "2.8.1"\ndeno = "2.8.1"\n'),
    undefined,
  );
});

Deno.test("parseMisePins returns every pin in order", () => {
  assertEquals(parseMisePins('[tools]\ndeno = "2.8.1"\n'), ["2.8.1"]);
  assertEquals(parseMisePins('[tools]\nnode = "22.0.0"\n'), []);
  assertEquals(
    parseMisePins('[tools]\ndeno = "2.8.1"\ndeno = "2.9.0"\n'),
    ["2.8.1", "2.9.0"],
  );
});

Deno.test("findProblems flags a Deno pin defined twice", () => {
  // TOML rejects a key defined twice even when both values agree, so mise fails
  // to load the file. Reading only the first pin would report the toolchain as
  // aligned while `mise install` — the documented way to get it — is broken.

  for (
    const miseToml of [
      '[tools]\ndeno = "2.8.1"\ndeno = "2.8.1"\n',
      '[tools]\ndeno = "2.8.1"\ndeno = "2.9.0"\n',
    ]
  ) {
    const problems = findProblems({ ...alignedFiles(), miseToml });
    assertEquals(problems.length, 1, miseToml);
    assert(problems[0].includes("defined 2 times"), problems[0]);
  }
});

Deno.test("parseDockerfileDenoVersions finds every FROM line", () => {
  assertEquals(
    parseDockerfileDenoVersions(
      alignedFiles().dockerfiles["dashboard/Dockerfile"],
    ),
    ["2.9.4"],
  );
  assertEquals(
    parseDockerfileDenoVersions(
      alignedFiles().dockerfiles["runtime/toolshed/Dockerfile"],
    ),
    ["2.9.4", "2.9.4"],
  );
});

Deno.test("parseDockerfileDenoVersions reads past flags and a lowercase FROM", () => {
  assertEquals(
    parseDockerfileDenoVersions(
      "FROM --platform=linux/amd64 denoland/deno:2.5.0 AS builder\n" +
        "from denoland/deno:2.6.0\n",
    ),
    ["2.5.0", "2.6.0"],
  );
});

Deno.test("parseDockerfileDenoVersions drops a digest", () => {
  assertEquals(
    parseDockerfileDenoVersions("FROM denoland/deno:2.8.1@sha256:abc123\n"),
    ["2.8.1"],
  );
});

Deno.test("parseCheckShRange extracts min and max", () => {
  assertEquals(parseCheckShRange(alignedFiles().checkSh), {
    min: "2.8.0",
    max: "2.10.0",
  });
});

Deno.test("parseCheckShRange returns undefined when a bound is missing", () => {
  assertEquals(parseCheckShRange('DENO_VERSION_MIN="2.8.0"\n'), undefined);
});

Deno.test("compareVersions compares components numerically", () => {
  assert(compareVersions("2.10.0", "2.9.0") > 0);
  assert(compareVersions("2.9.0", "2.10.0") < 0);
  assertEquals(compareVersions("2.8.1", "2.8.1"), 0);
});

Deno.test("compareVersions rejects a version that is not exact", () => {
  // Reading only the leading components would compare "2.8.0.1" as "2.8.0" and
  // answer as though the trailing component were not there.

  for (const bad of ["2.8.0.1", "2.8", "abc", "", "v2.8.0"]) {
    assertThrows(
      () => compareVersions(bad, "2.8.0"),
      Error,
      "Not an exact",
    );
    assertThrows(
      () => compareVersions("2.8.0", bad),
      Error,
      "Not an exact",
    );
  }
});

Deno.test("isExactVersion accepts only MAJOR.MINOR.PATCH", () => {
  assert(isExactVersion("2.8.1"));
  assert(isExactVersion("10.0.100"));
  assert(!isExactVersion("2.8"));
  assert(!isExactVersion("2.8.0.1"));
  assert(!isExactVersion("2.8.x"));
  assert(!isExactVersion("latest"));
});

Deno.test("versionInRange includes the minimum and excludes the maximum", () => {
  assert(versionInRange("2.8.0", "2.8.0", "2.9.0"));
  assert(versionInRange("2.8.1", "2.8.0", "2.9.0"));
  assert(!versionInRange("2.9.0", "2.8.0", "2.9.0"));
  assert(!versionInRange("2.7.9", "2.8.0", "2.9.0"));
});

Deno.test("findProblems accepts aligned files", () => {
  assertEquals(findProblems(alignedFiles()), []);
});

Deno.test("findProblems flags a missing pin", () => {
  const files = { ...alignedFiles(), miseToml: "[tools]\n" };
  assertEquals(findProblems(files).length, 1);
});

Deno.test("findProblems flags a non-exact pin", () => {
  const files = { ...alignedFiles(), miseToml: '[tools]\ndeno = "2.8"\n' };
  assertEquals(findProblems(files).length, 1);
});

Deno.test("findProblems flags a mismatched Dockerfile image", () => {
  for (const path of Object.keys(alignedFiles().dockerfiles)) {
    const files = {
      ...alignedFiles(),
      dockerfiles: {
        ...alignedFiles().dockerfiles,
        [path]: "FROM denoland/deno:2.8.0\n",
      },
    };
    const problems = findProblems(files);
    assertEquals(problems.length, 1, path);
    assert(problems[0].includes(path), problems[0]);
    assert(problems[0].includes("2.8.0"), problems[0]);
  }
});

Deno.test("findProblems flags a Dockerfile without deno images", () => {
  const files = {
    ...alignedFiles(),
    dockerfiles: {
      ...alignedFiles().dockerfiles,
      "dashboard/Dockerfile": "FROM debian:12\n",
    },
  };
  assertEquals(findProblems(files).length, 1);
});

Deno.test("findProblems flags a range bound that is not exact", () => {
  // check.sh reads the bounds with shell arithmetic, which aborts on a bound
  // carrying anything beyond MAJOR.MINOR.PATCH. Comparing such a bound
  // loosely would report "aligned" for a range that makes check.sh fail for
  // everyone.

  for (const bad of ["2.8.0.1", "2.8", "abc"]) {
    const withMin = findProblems({
      ...alignedFiles(),
      checkSh: alignedFiles().checkSh.replace(
        'DENO_VERSION_MIN="2.8.0"',
        `DENO_VERSION_MIN="${bad}"`,
      ),
    });
    assertEquals(withMin.length, 1, `MIN=${bad}`);
    assert(withMin[0].includes("DENO_VERSION_MIN"), `MIN=${bad}`);
    assert(withMin[0].includes("not an exact"), `MIN=${bad}`);

    const withMax = findProblems({
      ...alignedFiles(),
      checkSh: alignedFiles().checkSh.replace(
        'DENO_VERSION_MAX="2.10.0"',
        `DENO_VERSION_MAX="${bad}"`,
      ),
    });
    assertEquals(withMax.length, 1, `MAX=${bad}`);
    assert(withMax[0].includes("DENO_VERSION_MAX"), `MAX=${bad}`);
  }
});

Deno.test("findProblems flags both range bounds when both are malformed", () => {
  const problems = findProblems({
    ...alignedFiles(),
    checkSh: alignedFiles().checkSh
      .replace('DENO_VERSION_MIN="2.8.0"', 'DENO_VERSION_MIN="2.8"')
      .replace('DENO_VERSION_MAX="2.10.0"', 'DENO_VERSION_MAX="2.10"'),
  });
  assertEquals(problems.length, 2);
});

Deno.test("findProblems flags a range that excludes the pin", () => {
  const files = {
    ...alignedFiles(),
    checkSh: alignedFiles().checkSh
      .replace('DENO_VERSION_MIN="2.8.0"', 'DENO_VERSION_MIN="2.10.0"')
      .replace('DENO_VERSION_MAX="2.10.0"', 'DENO_VERSION_MAX="2.11.0"'),
  };
  const problems = findProblems(files);
  assertEquals(problems.length, 1);
  assert(problems[0].includes("range"));
});

Deno.test("findProblems flags an action that stops reading mise.toml", () => {
  // The name mise.toml stays in the action's description and comments after the
  // read is replaced by a literal, so this fixture is what a "just inline the
  // version" refactor actually leaves behind.

  const files = {
    ...alignedFiles(),
    denoSetupAction: '    description: "Defaults to the pin in mise.toml."\n' +
      "    # The repository's Deno version is pinned once, in mise.toml.\n" +
      "      run: |\n" +
      '        version="2.9.4"\n',
  };
  const problems = findProblems(files);
  assertEquals(problems.length, 1);
  assert(problems[0].includes("does not read"));
});

Deno.test("findProblems flags a check.sh that stops reading mise.toml", () => {
  const files = {
    ...alignedFiles(),
    checkSh: "# The exact Deno version is pinned in mise.toml.\n" +
      'DENO_VERSION_MIN="2.8.0"\nDENO_VERSION_MAX="2.10.0"\n',
  };
  const problems = findProblems(files);
  assertEquals(problems.length, 1);
  assert(problems[0].includes("does not read"));
});

Deno.test("findProblems flags a Dockerfile stage stale behind a flag", () => {
  const files = {
    ...alignedFiles(),
    dockerfiles: {
      ...alignedFiles().dockerfiles,
      "dashboard/Dockerfile":
        "FROM --platform=linux/amd64 denoland/deno:2.5.0\n",
    },
  };
  const problems = findProblems(files);
  assertEquals(problems.length, 1);
  assert(problems[0].includes("2.5.0"));
});

Deno.test("findProblems accepts a digest-pinned image on the pin", () => {
  const files = {
    ...alignedFiles(),
    dockerfiles: {
      ...alignedFiles().dockerfiles,
      "runtime/toolshed/Dockerfile":
        "FROM denoland/deno:2.9.4@sha256:abc123 AS builder\n" +
        "FROM denoland/deno:2.9.4\n",
    },
  };
  assertEquals(findProblems(files), []);
});

Deno.test("findProblems flags a mismatched literal in the action", () => {
  const files = {
    ...alignedFiles(),
    denoSetupAction: alignedFiles().denoSetupAction +
      'default: "2.7.9"\n',
  };
  const problems = findProblems(files);
  assertEquals(problems.length, 1);
  assert(problems[0].includes("2.7.9"));
});

Deno.test("findProblems accepts a literal in the action equal to the pin", () => {
  const files = {
    ...alignedFiles(),
    denoSetupAction: alignedFiles().denoSetupAction +
      'default: "2.9.4"\n',
  };
  assertEquals(findProblems(files), []);
});

Deno.test("findProblems flags a check.sh with no range at all", () => {
  const problems = findProblems({
    ...alignedFiles(),
    checkSh: "# The exact Deno version is pinned in mise.toml.\n" +
      `DENO_VERSION_PINNED="$(sed -n 's/^deno = "\\([^"]*\\)"$/\\1/p' mise.toml | head -1)"\n`,
  });
  assertEquals(problems.length, 1);
  assert(problems[0].includes("DENO_VERSION_MIN/DENO_VERSION_MAX not found"));
});

// Writes the four files main() reads into a fresh temp tree and returns its
// root. The caller removes the tree.
async function fixtureTree(
  files: ReturnType<typeof alignedFiles>,
): Promise<string> {
  const root = await Deno.makeTempDir({ prefix: "check-deno-pins-" });
  await Deno.mkdir(join(root, "tasks"), { recursive: true });
  await Deno.mkdir(join(root, ".github", "actions", "deno-setup"), {
    recursive: true,
  });
  await Deno.writeTextFile(join(root, "mise.toml"), files.miseToml);
  for (const [path, contents] of Object.entries(files.dockerfiles)) {
    await Deno.mkdir(dirname(join(root, path)), { recursive: true });
    await Deno.writeTextFile(join(root, path), contents);
  }
  await Deno.writeTextFile(join(root, "tasks", "check.sh"), files.checkSh);
  await Deno.writeTextFile(
    join(root, ".github", "actions", "deno-setup", "action.yml"),
    files.denoSetupAction,
  );
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

Deno.test("main reports the pin and returns 0 on aligned files", async () => {
  const root = await fixtureTree(alignedFiles());
  try {
    let code = -1;
    const { out } = await captureConsole(async () => {
      code = await main(root);
    });
    assertEquals(code, 0);
    assert(out.includes("Deno toolchain pins are aligned: 2.9.4"));
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("main reports each problem and returns 1 when misaligned", async () => {
  const root = await fixtureTree({
    ...alignedFiles(),
    dockerfiles: {
      ...alignedFiles().dockerfiles,
      "runtime/toolshed/Dockerfile": "FROM denoland/deno:2.5.0 AS builder\n",
    },
    checkSh: alignedFiles().checkSh.replace(
      'DENO_VERSION_MAX="2.10.0"',
      'DENO_VERSION_MAX="2.9"',
    ),
  });
  try {
    let code = -1;
    const { err } = await captureConsole(async () => {
      code = await main(root);
    });
    assertEquals(code, 1);
    assert(err.includes("Deno toolchain pins are misaligned:"));
    assert(err.includes("2.5.0"));
    assert(err.includes("DENO_VERSION_MAX"));
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("the repository's pins are aligned", async () => {
  // The repository's actual files must be aligned; this is the same check CI
  // runs via `deno task check-deno-pins`.
  assertEquals(await main(), 0);
});

Deno.test("running the script as a command reports the aligned pin", async () => {
  // Runs the script the way `deno task check-deno-pins` does, which the calls
  // to main() above do not: they would still pass if the entry point never ran
  // it, or if the task's declared permissions were too narrow to read the
  // files.
  const output = await runDenoCommandWithTemporaryLock({
    root: REPO_ROOT,
    args: (lockPath) => [
      "run",
      "--config",
      join(REPO_ROOT, "deno.jsonc"),
      "--lock",
      lockPath,
      "--allow-read",
      join(REPO_ROOT, "tasks/check-deno-pins.ts"),
    ],
  });
  assertEquals(output.code, 0);
  assert(
    new TextDecoder().decode(output.stdout).includes(
      "Deno toolchain pins are aligned",
    ),
  );
});
