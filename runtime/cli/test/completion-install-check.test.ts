import {
  assert,
  assertEquals,
  assertFalse,
  assertStringIncludes,
} from "@std/assert";
import {
  missingCommandWarning,
  type PathProbe,
  resolvesOnPath,
} from "../lib/completion/install-check.ts";

/** A probe backed by a literal map, so no real PATH or filesystem is touched. */
function probeFor(
  entries: Record<string, { isFile: boolean; mode: number | null }>,
): PathProbe {
  return (path) => entries[path];
}

Deno.test("an executable on PATH resolves", () => {
  assert(resolvesOnPath("cf", {
    path: "/usr/bin:/opt/labs/bin",
    separator: ":",
    probe: probeFor({
      "/opt/labs/bin/cf": { isFile: true, mode: 0o755 },
    }),
  }));
});

Deno.test("a name absent from every PATH entry does not resolve", () => {
  assertFalse(resolvesOnPath("cf", {
    path: "/usr/bin:/opt/labs/bin",
    separator: ":",
    probe: probeFor({ "/usr/bin/deno": { isFile: true, mode: 0o755 } }),
  }));
});

Deno.test("a non-executable file does not count as installed", () => {
  // A stray `cf` data file on PATH must not suppress the warning: the shell
  // would not run it either, so completion would still be dead.
  assertFalse(resolvesOnPath("cf", {
    path: "/opt/labs/bin",
    separator: ":",
    probe: probeFor({ "/opt/labs/bin/cf": { isFile: true, mode: 0o644 } }),
  }));
});

Deno.test("a directory named cf does not count as installed", () => {
  assertFalse(resolvesOnPath("cf", {
    path: "/opt/labs/bin",
    separator: ":",
    probe: probeFor({ "/opt/labs/bin/cf": { isFile: false, mode: 0o755 } }),
  }));
});

Deno.test("an unreported mode is accepted rather than warned about", () => {
  // Filesystems that do not report mode would otherwise produce a confusing
  // warning on a setup that actually works.
  assert(resolvesOnPath("cf", {
    path: "/opt/labs/bin",
    separator: ":",
    probe: probeFor({ "/opt/labs/bin/cf": { isFile: true, mode: null } }),
  }));
});

Deno.test("empty PATH entries are skipped, not read as the root", () => {
  assertFalse(resolvesOnPath("cf", {
    path: "::",
    separator: ":",
    probe: probeFor({ "/cf": { isFile: true, mode: 0o755 } }),
  }));
});

Deno.test("a trailing slash on a PATH entry still resolves", () => {
  assert(resolvesOnPath("cf", {
    path: "/opt/labs/bin/",
    separator: ":",
    probe: probeFor({ "/opt/labs/bin/cf": { isFile: true, mode: 0o755 } }),
  }));
});

Deno.test("an absent PATH resolves nothing rather than throwing", () => {
  assertFalse(resolvesOnPath("cf", {
    path: "",
    separator: ":",
    probe: probeFor({}),
  }));
});

Deno.test("the real filesystem probe is the one that ships", async () => {
  // Every other case injects a probe, which leaves the default one — the code
  // that actually runs in production — unexercised. This drives it against a
  // real directory: a hit, a miss (its catch path), and a file the shell would
  // refuse to run.
  const dir = await Deno.makeTempDir({ prefix: "cf-probe-" });
  try {
    const executable = `${dir}/cf`;
    await Deno.writeTextFile(executable, "#!/bin/sh\n");
    await Deno.chmod(executable, 0o755);

    assert(resolvesOnPath("cf", { path: dir }));
    assertFalse(resolvesOnPath("not-there", { path: dir }));

    await Deno.chmod(executable, 0o644);
    assertFalse(resolvesOnPath("cf", { path: dir }));
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("the warning names the failure and both installs", () => {
  const warning = missingCommandWarning("cf");
  assertStringIncludes(warning, "not on your PATH");
  assertStringIncludes(warning, "cf completion complete");
  assertStringIncludes(warning, "deno task install-cf");
  assertStringIncludes(warning, "ln -s");
});

Deno.test("the symlink hint is pasteable from the checkout", () => {
  assertStringIncludes(
    missingCommandWarning("cf"),
    'ln -s "$PWD/bin/cf" ~/.local/bin/cf',
  );
});

Deno.test("the warning is a single block with no stdout-looking prefix", () => {
  // It is printed alongside a shell script on stdout; a line that could be
  // mistaken for script text would be confusing when both land in a terminal.
  const lines = missingCommandWarning("cf").split("\n");
  assertEquals(lines[0].startsWith("warning:"), true);
});
