import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { fromFileUrl, join, toFileUrl } from "@std/path";

import {
  activeCapture,
  asDefinition,
  buildCapture,
  fileForName,
  MACHINERY_MODULE_SUFFIXES,
  NAME_MAP_PREFIX,
  NAME_MAP_SUFFIX,
  parseSkipList,
  readNameMaps,
  repositoryPathOf,
  repositoryRootOf,
  runDirectory,
  runningFile,
  serializeSkipList,
  writableSpool,
} from "./registration.ts";

// The fixture runner's module, as a class name would end.
const FIXTURE_RUNNER = new URL("../fixture-runner.ts", import.meta.url).href;

async function writeNameMap(
  dir: string,
  label: string,
  names: Record<string, unknown>,
  ranIn?: string,
): Promise<void> {
  await Deno.writeTextFile(
    join(dir, `${NAME_MAP_PREFIX}${label}${NAME_MAP_SUFFIX}`),
    JSON.stringify({ ...(ranIn === undefined ? {} : { dir: ranIn }), names }),
  );
}

describe("registration", () => {
  describe("MACHINERY_MODULE_SUFFIXES", () => {
    it("names the shared fixture runner", () => {
      // It calls `describe` on behalf of the file that asked for a suite,
      // so ingestion declines the class name it takes.
      expect(
        MACHINERY_MODULE_SUFFIXES.some((tail) => FIXTURE_RUNNER.endsWith(tail)),
      ).toBe(true);
    });

    it("names the runner's silent-backstop guard", () => {
      // The guard wraps `Deno.test` between the runner's clock preload and
      // each test file, and Deno names a describe's first step after it.
      const guard =
        "file:///repo/packages/runner/test/support/silent-backstop-guard.ts";
      expect(MACHINERY_MODULE_SUFFIXES.some((tail) => guard.endsWith(tail)))
        .toBe(true);
    });

    it("names no test file", () => {
      expect(
        MACHINERY_MODULE_SUFFIXES.some((tail) =>
          "packages/memory/test/space.test.ts".endsWith(tail)
        ),
      ).toBe(false);
    });
  });

  describe("repositoryPathOf()", () => {
    it("returns a file's path relative to the repository enclosing it", () => {
      expect(repositoryPathOf(import.meta.url)).toBe(
        "packages/test-support/src/records/registration.test.ts",
      );
    });

    it("returns nothing for a file inside no repository", async () => {
      const outside = await Deno.makeTempDir();
      try {
        const url = toFileUrl(join(outside, "a.test.ts")).href;
        expect(repositoryPathOf(url)).toBeUndefined();
      } finally {
        await Deno.remove(outside, { recursive: true });
      }
    });

    it("returns nothing for a URL that names no file", () => {
      expect(repositoryPathOf("https://example.com/a.test.ts"))
        .toBeUndefined();
    });
  });

  describe("runningFile()", () => {
    it("returns the test file this process runs, relative to the repository root", () => {
      expect(runningFile()).toBe(
        "packages/test-support/src/records/registration.test.ts",
      );
    });
  });

  describe("asDefinition()", () => {
    const body = () => {};

    it("takes a name and a body", () => {
      expect(asDefinition(["a name", body])).toEqual({
        name: "a name",
        fn: body,
      });
    });

    it("keeps the options a name-and-options call carried", () => {
      // Dropping these is the shape that registers a definition with no
      // body, which Deno refuses and which fails the whole module.
      expect(asDefinition(["a name", { sanitizeOps: false }, body])).toEqual({
        name: "a name",
        sanitizeOps: false,
        fn: body,
      });
    });

    it("keeps the options an options-and-body call carried", () => {
      expect(
        asDefinition([{ name: "a name", sanitizeResources: false }, body]),
      ).toEqual({ name: "a name", sanitizeResources: false, fn: body });
    });

    it("names an options-and-body call after its function", () => {
      function namedByItsFunction() {}
      expect(asDefinition([{ ignore: true }, namedByItsFunction])).toEqual({
        name: "namedByItsFunction",
        ignore: true,
        fn: namedByItsFunction,
      });
    });

    it("takes a whole definition as it is", () => {
      const definition = { name: "a name", fn: body, only: true };
      expect(asDefinition([definition])).toBe(definition);
    });

    it("names a bare function after itself", () => {
      function bodyAlone() {}
      expect(asDefinition([bodyAlone])).toEqual({
        name: "bodyAlone",
        fn: bodyAlone,
      });
    });

    it("returns undefined for a shape it does not model", () => {
      // Those reach the real registrar untouched, so Deno reports them.
      expect(asDefinition([])).toBeUndefined();
      expect(asDefinition(["a name"])).toBeUndefined();
      expect(asDefinition([{ sanitizeOps: false }, () => {}])).toBeUndefined();
      expect(asDefinition([42, body])).toBeUndefined();
    });
  });

  describe("fileForName()", () => {
    const names = new Map([
      ["outer", "packages/a/outer.test.ts"],
      ["outer > inner", "packages/a/inner.test.ts"],
      ["bare", "packages/a/bare.test.ts"],
    ]);

    it("returns the file of an exactly registered name", () => {
      expect(fileForName("bare", names)).toBe("packages/a/bare.test.ts");
    });

    it("returns the file of the longest registered prefix", () => {
      expect(fileForName("outer > one", names)).toBe(
        "packages/a/outer.test.ts",
      );
      expect(fileForName("outer > inner > deep", names)).toBe(
        "packages/a/inner.test.ts",
      );
    });

    it("returns undefined for a name no registration covers", () => {
      expect(fileForName("unheard of", names)).toBeUndefined();
      // A prefix without the separator is a different name, not a chain.
      expect(fileForName("outermost", names)).toBeUndefined();
    });
  });

  describe("readNameMaps()", () => {
    it("merges every map a spool holds", async () => {
      const dir = await Deno.makeTempDir();
      try {
        await writeNameMap(dir, "01", { one: "packages/a/one.test.ts" });
        await writeNameMap(dir, "02", { two: "packages/a/two.test.ts" });
        await Deno.writeTextFile(join(dir, "fragment-01.ndjson"), "ignored\n");
        const names = await readNameMaps(dir);
        expect(names.size).toBe(2);
        expect(names.get("one")).toBe("packages/a/one.test.ts");
        expect(names.get("two")).toBe("packages/a/two.test.ts");
      } finally {
        await Deno.remove(dir, { recursive: true });
      }
    });

    it("drops a name two files both claim", async () => {
      const dir = await Deno.makeTempDir();
      try {
        await writeNameMap(dir, "01", {
          shared: "packages/a/one.test.ts",
          own: "packages/a/one.test.ts",
        });
        await writeNameMap(dir, "02", { shared: "packages/b/two.test.ts" });
        const names = await readNameMaps(dir);
        expect(names.get("shared")).toBeUndefined();
        expect(names.get("own")).toBe("packages/a/one.test.ts");
      } finally {
        await Deno.remove(dir, { recursive: true });
      }
    });

    it("judges ambiguity within the scope it was given", async () => {
      // Every package of a workspace run writes into one spool. A name
      // two of them share is unambiguous inside either, so scoping the
      // read is what keeps both their files rather than dropping both.
      const dir = await Deno.makeTempDir();
      try {
        await writeNameMap(dir, "01", {
          shared: "packages/a/one.test.ts",
        });
        await writeNameMap(dir, "02", {
          shared: "packages/b/two.test.ts",
        });
        expect((await readNameMaps(dir)).get("shared")).toBeUndefined();
        expect(
          (await readNameMaps(dir, { ranIn: "packages/a" })).get("shared"),
        ).toBe("packages/a/one.test.ts");
        expect(
          (await readNameMaps(dir, { ranIn: "packages/b/" })).get("shared"),
        ).toBe("packages/b/two.test.ts");
      } finally {
        await Deno.remove(dir, { recursive: true });
      }
    });

    it("keeps a file outside the scope from a map written there", async () => {
      // A test task may name a file anywhere in the tree — the one that
      // holds the repository tools' own regression tests does — so a map
      // the scope's own process wrote is read whole.

      const dir = await Deno.makeTempDir();
      try {
        await writeNameMap(
          dir,
          "01",
          { "tools > wraps": "tools/wrap.test.ts" },
          "packages/a",
        );
        expect(
          (await readNameMaps(dir, { ranIn: "packages/a" })).get(
            "tools > wraps",
          ),
        ).toBe("tools/wrap.test.ts");
        // Another package's read is not offered it.
        expect(
          (await readNameMaps(dir, { ranIn: "packages/b" })).get(
            "tools > wraps",
          ),
        ).toBeUndefined();
      } finally {
        await Deno.remove(dir, { recursive: true });
      }
    });

    it("takes nothing from a map another directory wrote", async () => {
      // Its files say nothing about whose names they are: what the
      // scope's own process registered is what the scope's read wants,
      // and a name the two disagree on would otherwise be dropped from
      // both.

      const dir = await Deno.makeTempDir();
      try {
        await writeNameMap(
          dir,
          "01",
          { shared: "packages/a/one.test.ts" },
          "packages/a",
        );
        await writeNameMap(
          dir,
          "02",
          { shared: "packages/a/two.test.ts" },
          "packages/b",
        );
        expect(
          (await readNameMaps(dir, { ranIn: "packages/a" })).get("shared"),
        ).toBe("packages/a/one.test.ts");
      } finally {
        await Deno.remove(dir, { recursive: true });
      }
    });

    it("takes every file of a map naming no directory at the root", async () => {
      // The empty string is the repository root, which every
      // repository-relative file sits under.

      const dir = await Deno.makeTempDir();
      try {
        await writeNameMap(dir, "01", {
          inside: "packages/a/one.test.ts",
          outside: "tools/wrap.test.ts",
        });
        const names = await readNameMaps(dir, { ranIn: "" });
        expect(names.get("inside")).toBe("packages/a/one.test.ts");
        expect(names.get("outside")).toBe("tools/wrap.test.ts");
      } finally {
        await Deno.remove(dir, { recursive: true });
      }
    });

    it("judges a map naming no directory by its files alone", async () => {
      const dir = await Deno.makeTempDir();
      try {
        await writeNameMap(dir, "01", {
          inside: "packages/a/one.test.ts",
          outside: "tools/wrap.test.ts",
        });
        const names = await readNameMaps(dir, { ranIn: "packages/a" });
        expect(names.get("inside")).toBe("packages/a/one.test.ts");
        expect(names.get("outside")).toBeUndefined();
      } finally {
        await Deno.remove(dir, { recursive: true });
      }
    });

    it("returns an empty map for a spool that is not there", async () => {
      expect((await readNameMaps("/nonexistent-spool")).size).toBe(0);
    });

    it("skips an unparsable map and a line that is not a path", async () => {
      const dir = await Deno.makeTempDir();
      try {
        await Deno.writeTextFile(
          join(dir, `${NAME_MAP_PREFIX}01${NAME_MAP_SUFFIX}`),
          "{not json",
        );
        await writeNameMap(dir, "02", {
          good: "packages/a/one.test.ts",
          bad: 7,
        });
        const names = await readNameMaps(dir);
        expect(names.size).toBe(1);
        expect(names.get("good")).toBe("packages/a/one.test.ts");
      } finally {
        await Deno.remove(dir, { recursive: true });
      }
    });
  });

  describe("buildCapture()", () => {
    /** A registrar that records what it was handed, running nothing. */
    function recorder() {
      const seen: Deno.TestDefinition[] = [];
      return { seen, registrar: (d: Deno.TestDefinition) => void seen.push(d) };
    }

    it("hands every definition on to the registrar it was given", () => {
      const { seen, registrar } = recorder();
      const built = buildCapture({ registrar });
      built.registrar("a test", () => {});
      built.registrar({ name: "another", sanitizeOps: false }, () => {});
      expect(seen.map((d) => d.name)).toEqual(["a test", "another"]);
      expect(seen[1]!.sanitizeOps).toBe(false);
    });

    it("registers a listed test as ignored rather than dropping it", () => {
      // Dropped, the store watches the identity disappear; ignored, it
      // learns the test was deliberately not run.
      const { seen, registrar } = recorder();
      const built = buildCapture({
        registrar,
        skips: { "packages/a/one.test.ts": ["skip me"] },
      });
      // The file is the one this process runs, which is this test file,
      // so nothing matches and the skip does not apply.
      built.registrar("skip me", () => {});
      expect(seen[0]!.ignore).toBeFalsy();
      expect(built.capture.skipped("packages/a/one.test.ts", "skip me")).toBe(
        true,
      );
      expect(built.capture.skipped("packages/a/one.test.ts", "other")).toBe(
        false,
      );
      expect(built.capture.skipped(undefined, "skip me")).toBe(false);
    });

    it("captures the file each registration came from", () => {
      const { registrar } = recorder();
      const built = buildCapture({ registrar });
      built.registrar("named here", () => {});
      // This process runs this test file, so that is the file captured.
      expect(built.capture.names.get("named here")).toMatch(
        /registration\.test\.ts$/,
      );
    });

    it("carries ignore and only through their own registrars", () => {
      const { seen, registrar } = recorder();
      const built = buildCapture({ registrar });
      (built.registrar as unknown as {
        ignore: (name: string, fn: () => void) => void;
      }).ignore("ignored", () => {});
      (built.registrar as unknown as {
        only: (name: string, fn: () => void) => void;
      }).only("only this", () => {});
      expect(seen[0]!.ignore).toBe(true);
      expect(seen[1]!.only).toBe(true);
    });

    it("writes the captured map into the spool it was given", async () => {
      const spool = await Deno.makeTempDir();
      try {
        const { registrar } = recorder();
        const built = buildCapture({ registrar, spool });
        built.registrar("written out", () => {});
        built.capture.flush();
        const names = await readNameMaps(spool);
        expect(names.get("written out")).toMatch(/registration\.test\.ts$/);
      } finally {
        await Deno.remove(spool, { recursive: true });
      }
    });

    it("writes nothing when it captured nothing, or has nowhere", () => {
      const { registrar } = recorder();
      // No spool: flushing is a no-op rather than an error.
      buildCapture({ registrar }).capture.flush();
    });
  });

  describe("writableSpool()", () => {
    it("returns false where the run names no spool", () => {
      // A process whose environment names no spool has nowhere to leave a
      // name map, so it is not worth wrapping `Deno.test` for.
      expect(writableSpool(undefined)).toBe(false);
    });

    it("returns true for a spool this process may write", async () => {
      const spool = await Deno.makeTempDir();
      try {
        expect(writableSpool(spool)).toBe(true);
      } finally {
        await Deno.remove(spool, { recursive: true });
      }
    });
  });

  describe("parseSkipList()", () => {
    it("round-trips what serializeSkipList wrote", () => {
      const skips = { "packages/a/one.test.ts": ["slow > case"] };
      expect(parseSkipList(serializeSkipList(skips))).toEqual(skips);
    });

    it("accepts a list that names nothing", () => {
      expect(parseSkipList("{}")).toEqual({});
    });

    it("returns undefined for anything that is not a skip list", () => {
      expect(parseSkipList("[]")).toBeUndefined();
      expect(parseSkipList("not json")).toBeUndefined();
      expect(parseSkipList('{"a": "b"}')).toBeUndefined();
      expect(parseSkipList('{"a": [1]}')).toBeUndefined();
    });
  });
});

describe("what the capture does with what it cannot read", () => {
  it("ignores a name map that is not a map", async () => {
    const dir = await Deno.makeTempDir();
    try {
      await Deno.writeTextFile(
        join(dir, `${NAME_MAP_PREFIX}01${NAME_MAP_SUFFIX}`),
        "{not json",
      );
      await Deno.writeTextFile(
        join(dir, `${NAME_MAP_PREFIX}02${NAME_MAP_SUFFIX}`),
        '["a name"]',
      );
      await Deno.writeTextFile(
        join(dir, `${NAME_MAP_PREFIX}03${NAME_MAP_SUFFIX}`),
        "null",
      );
      await Deno.writeTextFile(
        join(dir, `${NAME_MAP_PREFIX}04${NAME_MAP_SUFFIX}`),
        JSON.stringify({ names: ["a name"] }),
      );
      await writeNameMap(dir, "05", { one: "packages/a/one.test.ts" });
      const names = await readNameMaps(dir);
      expect([...names.keys()]).toEqual(["one"]);
    } finally {
      await Deno.remove(dir, { recursive: true });
    }
  });

  it("drops a mapped file that is not a name", async () => {
    const dir = await Deno.makeTempDir();
    try {
      await Deno.writeTextFile(
        join(dir, `${NAME_MAP_PREFIX}01${NAME_MAP_SUFFIX}`),
        JSON.stringify({
          names: { a: 7, b: "", c: "packages/a/one.test.ts" },
        }),
      );
      const names = await readNameMaps(dir);
      expect([...names.keys()]).toEqual(["c"]);
    } finally {
      await Deno.remove(dir, { recursive: true });
    }
  });

  it("refuses a skip list that is not an object of lists", () => {
    for (const text of ["{not json", "null", '["a"]', '{"f.ts":"one"}']) {
      expect(parseSkipList(text)).toBeUndefined();
    }
  });
});

describe("repositoryRootOf()", () => {
  it("finds the root above a file inside the repository", () => {
    const root = repositoryRootOf(fromFileUrl(import.meta.url));
    expect(root).toBeDefined();
    expect(Deno.statSync(join(root!, ".git"))).toBeDefined();
  });

  it("is nothing for a path under no repository at all", async () => {
    // The climb reaches the filesystem root and stops there. Answering
    // with the root itself would make every test file's path relative
    // to "/", which names no file in any repository.
    const outside = await Deno.makeTempDir();
    try {
      expect(repositoryRootOf(join(outside, "a.test.ts"))).toBeUndefined();
    } finally {
      await Deno.remove(outside, { recursive: true });
    }
  });
});

describe("runDirectory()", () => {
  it("names the working directory as the repository sees it", () => {
    const dir = runDirectory();
    expect(dir).toBeDefined();
    // Repository-relative, so that a caller can compare it against a
    // workspace member's path: it neither starts at the filesystem root
    // nor climbs out of the repository.
    expect(dir!.startsWith("/")).toBe(false);
    expect(dir!.split("/")).not.toContain("..");
    const root = repositoryRootOf(join(Deno.cwd(), "a.ts"));
    expect(join(root!, dir!)).toBe(Deno.cwd());
  });
});

describe("activeCapture()", () => {
  it("is one capture for the whole process, or none", () => {
    // Whether a capture is installed depends on whether this run was
    // preloaded, so that is not what is asserted. What holds either way
    // is that there is at most one: the bdd re-exports and the wrapper
    // must be writing names into the same map, and a getter that built a
    // capture per call would give each of them its own.
    const first = activeCapture();
    expect(activeCapture()).toBe(first);
    if (first !== undefined) {
      expect(typeof first.flush).toBe("function");
      expect(first.names instanceof Map).toBe(true);
    }
  });
});

describe("the wrapper over a shape it does not model", () => {
  it("hands the real registrar the arguments it was given", () => {
    const seen: unknown[][] = [];
    const built = buildCapture({
      registrar: ((...args: unknown[]) => {
        seen.push(args);
      }) as unknown as typeof Deno.test,
    });
    // No name anywhere, so `asDefinition` recognizes nothing. The call
    // still reaches the registrar, which is what reports its own error.
    (built.registrar as unknown as (...args: unknown[]) => void)(7, 8);
    expect(seen).toEqual([[7, 8]]);
  });
});

describe("what the capture does when it cannot write", () => {
  const registrar = (() => {}) as unknown as typeof Deno.test;

  it("does nothing at all when there is no spool", () => {
    const { capture } = buildCapture({ registrar });
    capture.names.set("a test", "packages/a/one.test.ts");
    // No spool is a run that was never recording, not a failed write.
    capture.flush();
  });

  it("does nothing when it learned no names", async () => {
    const spool = await Deno.makeTempDir();
    try {
      buildCapture({ registrar, spool }).capture.flush();
      expect([...Deno.readDirSync(spool)]).toEqual([]);
    } finally {
      await Deno.remove(spool, { recursive: true });
    }
  });

  it("writes the names it learned into the spool", async () => {
    const spool = await Deno.makeTempDir();
    try {
      const { capture } = buildCapture({ registrar, spool });
      capture.names.set("a test", "packages/a/one.test.ts");
      capture.flush();
      const names = await readNameMaps(spool);
      expect(names.get("a test")).toBe("packages/a/one.test.ts");
    } finally {
      await Deno.remove(spool, { recursive: true });
    }
  });

  it("writes the directory it was told it was running in", async () => {
    const spool = await Deno.makeTempDir();
    try {
      const { capture } = buildCapture({
        registrar,
        spool,
        dir: "packages/b",
      });
      capture.names.set("a test", "tools/one.test.ts");
      capture.flush();
      // A read scoped to that directory takes the map whole, file and
      // all, where a read scoped elsewhere is offered nothing: the file
      // sits under neither directory.
      expect(
        (await readNameMaps(spool, { ranIn: "packages/b" })).get("a test"),
      ).toBe("tools/one.test.ts");
      expect(
        (await readNameMaps(spool, { ranIn: "packages/a" })).get("a test"),
      ).toBeUndefined();
    } finally {
      await Deno.remove(spool, { recursive: true });
    }
  });

  it("writes the empty directory of a run at the repository root", async () => {
    const spool = await Deno.makeTempDir();
    try {
      const { capture } = buildCapture({ registrar, spool, dir: "" });
      capture.names.set("a test", "packages/a/one.test.ts");
      capture.flush();
      expect(
        (await readNameMaps(spool, { ranIn: "" })).get("a test"),
      ).toBe("packages/a/one.test.ts");
      expect(
        (await readNameMaps(spool, { ranIn: "packages/a" })).get("a test"),
      ).toBeUndefined();
    } finally {
      await Deno.remove(spool, { recursive: true });
    }
  });

  it("says so and carries on when the spool cannot be made", async () => {
    // A file where the directory should be. Failing to record must not
    // fail the test run that was recording.
    const parent = await Deno.makeTempDir();
    const spool = join(parent, "in-the-way");
    await Deno.writeTextFile(spool, "");
    const said: string[] = [];
    const warn = console.warn;
    console.warn = (...parts: unknown[]) => said.push(parts.join(" "));
    try {
      const { capture } = buildCapture({ registrar, spool });
      capture.names.set("a test", "packages/a/one.test.ts");
      capture.flush();
    } finally {
      console.warn = warn;
      await Deno.remove(parent, { recursive: true });
    }
    expect(said.join("\n")).toContain("cannot write a name map");
  });
});

describe("the skip list a capture was built with", () => {
  const registrar = (() => {}) as unknown as typeof Deno.test;

  it("skips only the named test in the named file", () => {
    const { capture } = buildCapture({
      registrar,
      skips: { "packages/a/one.test.ts": ["a test"] },
    });
    expect(capture.skipped("packages/a/one.test.ts", "a test")).toBe(true);
    expect(capture.skipped("packages/a/one.test.ts", "another")).toBe(false);
    expect(capture.skipped("packages/a/two.test.ts", "a test")).toBe(false);
  });

  it("skips nothing when the file is unknown", () => {
    // A test whose file could not be recovered cannot be matched against
    // a list keyed by file, so it runs.
    const { capture } = buildCapture({
      registrar,
      skips: { "packages/a/one.test.ts": ["a test"] },
    });
    expect(capture.skipped(undefined, "a test")).toBe(false);
  });

  it("skips nothing when there is no list", () => {
    const { capture } = buildCapture({ registrar });
    expect(capture.skipped("packages/a/one.test.ts", "a test")).toBe(false);
  });
});
