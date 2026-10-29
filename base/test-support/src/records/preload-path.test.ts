import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { preloadArgument, recordingArguments } from "./preload-path.ts";

describe("preload-path", () => {
  // `/r` stands for a repository root that does not exist, which the
  // grant names as it is given.

  const paths = { spool: "/s", root: "/r" };
  const preload = preloadArgument();

  it("names the preload by an absolute path", () => {
    expect(preload.startsWith("--preload=/")).toBe(true);
    expect(preload.endsWith("/preload.ts")).toBe(true);
  });

  it("grants the marker and the spool where the flags name neither permission", () => {
    expect(recordingArguments(["--allow-env", "a.test.ts"], paths)).toEqual([
      preload,
      "--allow-read=/r/.git",
      "--allow-write=/s",
    ]);
    expect(recordingArguments([], paths)).toEqual([
      preload,
      "--allow-read=/r/.git",
      "--allow-write=/s",
    ]);
  });

  it("grants the skip list beside the marker where there is one", () => {
    expect(
      recordingArguments(["--allow-env"], { ...paths, skipList: "/o/k.json" }),
    ).toEqual([preload, "--allow-read=/r/.git,/o/k.json", "--allow-write=/s"]);
  });

  it("grants on top of path lists the flags name of their own", () => {
    expect(
      recordingArguments(
        ["--allow-read=/tmp", "--allow-write=/tmp", "a.test.ts"],
        paths,
      ),
    ).toEqual([preload, "--allow-read=/r/.git", "--allow-write=/s"]);
  });

  it("grants nothing for a permission the flags already hold everywhere", () => {
    // Beside `-A` or `--allow-all` Deno refuses the combination and the
    // run never starts. Beside a bare flag the list would cut that grant
    // down to itself.

    for (const flag of ["-A", "--allow-all"]) {
      expect(recordingArguments([flag, "a.test.ts"], paths)).toEqual([
        preload,
      ]);
    }
    for (const flag of ["-W", "--allow-write"]) {
      expect(recordingArguments([flag, "a.test.ts"], paths)).toEqual([
        preload,
        "--allow-read=/r/.git",
      ]);
    }
    for (const flag of ["-R", "--allow-read"]) {
      expect(recordingArguments([flag, "a.test.ts"], paths)).toEqual([
        preload,
        "--allow-write=/s",
      ]);
    }
  });

  it("reads a cluster of short flags as each of its letters", () => {
    expect(recordingArguments(["-RW", "a.test.ts"], paths)).toEqual([
      preload,
    ]);
    expect(recordingArguments(["-RN", "a.test.ts"], paths)).toEqual([
      preload,
      "--allow-write=/s",
    ]);
  });

  it("reads a permission flag only as a whole word", () => {
    expect(
      recordingArguments(["--allow-read", "--allow-write-elsewhere"], paths),
    ).toEqual([preload, "--allow-write=/s"]);
  });

  it("grants the marker under the root as given and under its canonical path", async () => {
    // Deno names the main module by the path the command gave it,
    // resolved against the working directory, which is canonical, where
    // that path is relative. A grant is checked against a path exactly as
    // the grant writes it, so the preload needs whichever one it climbs.

    const real = await Deno.makeTempDir({ prefix: "preload-path-" });
    const link = `${real}-link`;
    try {
      await Deno.symlink(real, link);
      const canonical = await Deno.realPath(real);
      expect(link).not.toEqual(canonical);
      expect(recordingArguments(["-W"], { ...paths, root: link })).toEqual([
        preload,
        `--allow-read=${link}/.git,${canonical}/.git`,
      ]);
      expect(recordingArguments(["-W"], { ...paths, root: canonical }))
        .toEqual([preload, `--allow-read=${canonical}/.git`]);
    } finally {
      await Deno.remove(link);
      await Deno.remove(real);
    }
  });

  it("refuses a root it cannot resolve for any reason but its absence", async () => {
    // A root that does not exist is granted as given, since there is no
    // other path to it. Any other failure to resolve one leaves the path
    // the preload climbs unknown.

    const file = await Deno.makeTempFile({ prefix: "preload-path-" });
    try {
      expect(() => recordingArguments([], { ...paths, root: `${file}/repo` }))
        .toThrow(Deno.errors.NotADirectory);
      expect(recordingArguments(["-W"], { ...paths, root: "/r/repo" }))
        .toEqual([preload, "--allow-read=/r/repo/.git"]);
    } finally {
      await Deno.remove(file);
    }
  });

  it("refuses a path that is not absolute", () => {
    // An empty list ends the run, and a relative path names a different
    // place in each package the invocations run in.

    expect(() => recordingArguments([], { ...paths, spool: "" })).toThrow();
    expect(() => recordingArguments([], { ...paths, spool: "spool" }))
      .toThrow();
    expect(() => recordingArguments([], { ...paths, root: "repo" }))
      .toThrow();
    expect(() => recordingArguments([], { ...paths, skipList: "k.json" }))
      .toThrow();
  });

  it("refuses a path holding a comma, whether or not it is granted", () => {
    // A comma separates one path from the next inside a permission's
    // path list, so such a path is granted as two paths that are not it.

    expect(() => recordingArguments([], { ...paths, spool: "/a,b/spool" }))
      .toThrow();
    expect(() => recordingArguments(["-A"], { ...paths, skipList: "/a,b" }))
      .toThrow();
  });
});
