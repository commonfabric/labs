import { expect } from "@std/expect";
import { describe, it } from "@commonfabric/test-support/test";
import { recordingArguments } from "./recording-arguments.ts";

describe("recordingArguments()", () => {
  const paths = { spool: "/s" };

  it("grants the spool where the flags name no write permission", () => {
    expect(recordingArguments(["--allow-env", "a.test.ts"], paths)).toEqual([
      "--allow-write=/s",
    ]);
    expect(recordingArguments([], paths)).toEqual(["--allow-write=/s"]);
  });

  it("grants the skip list where there is one", () => {
    expect(
      recordingArguments(["--allow-env"], { ...paths, skipList: "/o/k.json" }),
    ).toEqual(["--allow-read=/o/k.json", "--allow-write=/s"]);
  });

  it("grants on top of path lists the flags name of their own", () => {
    expect(
      recordingArguments(
        ["--allow-read=/tmp", "--allow-write=/tmp", "a.test.ts"],
        { ...paths, skipList: "/o/k.json" },
      ),
    ).toEqual(["--allow-read=/o/k.json", "--allow-write=/s"]);
  });

  it("grants nothing for a permission the flags already hold everywhere", () => {
    // Beside `-A` or `--allow-all` Deno refuses the combination and the
    // run never starts. Beside a bare flag the list would cut that grant
    // down to itself.

    const withList = { ...paths, skipList: "/o/k.json" };
    for (const flag of ["-A", "--allow-all"]) {
      expect(recordingArguments([flag, "a.test.ts"], withList)).toEqual([]);
    }
    for (const flag of ["-W", "--allow-write"]) {
      expect(recordingArguments([flag, "a.test.ts"], withList)).toEqual([
        "--allow-read=/o/k.json",
      ]);
    }
    for (const flag of ["-R", "--allow-read"]) {
      expect(recordingArguments([flag, "a.test.ts"], withList)).toEqual([
        "--allow-write=/s",
      ]);
    }
  });

  it("reads a cluster of short flags as each of its letters", () => {
    const withList = { ...paths, skipList: "/o/k.json" };
    expect(recordingArguments(["-RW", "a.test.ts"], withList)).toEqual([]);
    expect(recordingArguments(["-RN", "a.test.ts"], withList)).toEqual([
      "--allow-write=/s",
    ]);
  });

  it("reads a permission flag only as a whole word", () => {
    expect(
      recordingArguments(["--allow-read", "--allow-write-elsewhere"], paths),
    ).toEqual(["--allow-write=/s"]);
  });

  it("refuses a path that is not absolute", () => {
    // An empty list ends the run, and a relative path names a different
    // place in each package the invocations run in.

    expect(() => recordingArguments([], { spool: "" })).toThrow();
    expect(() => recordingArguments([], { spool: "spool" })).toThrow();
    expect(() => recordingArguments([], { ...paths, skipList: "k.json" }))
      .toThrow();
    expect(recordingArguments([], { spool: "/spool" })).toEqual([
      "--allow-write=/spool",
    ]);
  });

  it("refuses a path holding a comma, whether or not it is granted", () => {
    // A comma separates one path from the next inside a permission's
    // path list, so such a path is granted as two paths that are not it.

    expect(() => recordingArguments([], { spool: "/a,b/spool" })).toThrow();
    expect(() => recordingArguments(["-A"], { ...paths, skipList: "/a,b" }))
      .toThrow();
  });
});
