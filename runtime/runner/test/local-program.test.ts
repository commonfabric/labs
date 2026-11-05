import { assertEquals, assertRejects, assertThrows } from "@std/assert";
import { describe, it } from "@std/testing/bdd";
import { join } from "@std/path";
import type { ProgramResolver } from "@commonfabric/js-compiler";
import type { RuntimeProgram } from "../src/harness/types.ts";
import {
  attachDataFiles,
  resolveLocalProgram,
} from "../src/harness/local-program.deno.ts";

// Walks a resolver's own closure and returns it as a program, standing in for
// the harness's compile. Following the imports is the compiler's job, so this
// reads the entry and whatever the test names as reachable from it.
function collectingResolve(
  reachable: readonly string[] = [],
): (resolver: ProgramResolver) => Promise<RuntimeProgram> {
  return async (resolver) => {
    const main = await resolver.main();
    const files = [main];
    for (const identifier of reachable) {
      const source = await resolver.resolveSource(identifier);
      if (source) files.push(source);
    }
    return { main: main.name, files };
  };
}

// Writes the named files into a fresh temp tree and returns its root. The
// caller removes the tree.
async function tree(files: Record<string, string>): Promise<string> {
  const root = await Deno.makeTempDir({ prefix: "local-program-" });
  for (const [path, contents] of Object.entries(files)) {
    const full = join(root, path);
    await Deno.mkdir(join(full, ".."), { recursive: true });
    await Deno.writeTextFile(full, contents);
  }
  return root;
}

describe("resolveLocalProgram", () => {
  it("names the entry relative to the root it is given", async () => {
    const root = await tree({ "src/main.tsx": "export default 1;\n" });
    try {
      const program = await resolveLocalProgram(collectingResolve(), {
        main: join(root, "src/main.tsx"),
        root,
      });
      assertEquals(program.main, "/src/main.tsx");
      assertEquals(program.files.map((file) => file.name), ["/src/main.tsx"]);
    } finally {
      await Deno.remove(root, { recursive: true });
    }
  });

  it("defaults the root to the directory holding everything named", async () => {
    const root = await tree({
      "pattern/main.tsx": "export default 1;\n",
      "pattern/data/cities.json": "[]\n",
    });
    try {
      const program = await resolveLocalProgram(collectingResolve(), {
        main: join(root, "pattern/main.tsx"),
        dataFilePaths: [join(root, "pattern/data/cities.json")],
      });
      // The common directory is `pattern/`, so both names hang off it.
      assertEquals(program.main, "/main.tsx");
      assertEquals(program.dataFiles, ["/data/cities.json"]);
    } finally {
      await Deno.remove(root, { recursive: true });
    }
  });

  it("merges a test entry's closure into the program", async () => {
    const root = await tree({
      "main.tsx": "export default 1;\n",
      "main.test.tsx": "export const t = 1;\n",
    });
    try {
      const program = await resolveLocalProgram(collectingResolve(), {
        main: join(root, "main.tsx"),
        root,
        testPaths: [join(root, "main.test.tsx")],
      });
      assertEquals(program.main, "/main.tsx");
      assertEquals(program.sourceRoots, ["/main.test.tsx"]);
      assertEquals(
        program.files.map((file) => file.name).sort(),
        ["/main.test.tsx", "/main.tsx"],
      );
    } finally {
      await Deno.remove(root, { recursive: true });
    }
  });

  it("keeps one copy of a file two entries both reach", async () => {
    const root = await tree({
      "main.tsx": "export default 1;\n",
      "main.test.tsx": "export const t = 1;\n",
      "shared.ts": "export const shared = 1;\n",
    });
    try {
      const program = await resolveLocalProgram(
        collectingResolve(["/shared.ts"]),
        {
          main: join(root, "main.tsx"),
          root,
          testPaths: [join(root, "main.test.tsx")],
        },
      );
      assertEquals(
        program.files.filter((file) => file.name === "/shared.ts").length,
        1,
      );
    } finally {
      await Deno.remove(root, { recursive: true });
    }
  });

  it("refuses two files that share a name and differ in content", async () => {
    const root = await tree({
      "main.tsx": "export default 1;\n",
      "main.test.tsx": "export const t = 1;\n",
    });
    try {
      // The second entry resolves the same name to different bytes, which no
      // single program can hold.
      let call = 0;
      const resolve = async (
        resolver: ProgramResolver,
      ): Promise<RuntimeProgram> => {
        const main = await resolver.main();
        return {
          main: main.name,
          files: [main, {
            name: "/shared.ts",
            contents: `export const shared = ${call++};\n`,
          }],
        };
      };
      await assertRejects(
        () =>
          resolveLocalProgram(resolve, {
            main: join(root, "main.tsx"),
            root,
            testPaths: [join(root, "main.test.tsx")],
          }),
        Error,
        'conflicting files named "/shared.ts"',
      );
    } finally {
      await Deno.remove(root, { recursive: true });
    }
  });

  it("carries the data files the resolve step attached", async () => {
    const root = await tree({ "main.tsx": "export default 1;\n" });
    try {
      const program = await resolveLocalProgram(async (resolver) => {
        const main = await resolver.main();
        return {
          main: main.name,
          files: [main, { name: "/data/cities.json", contents: "[]\n" }],
          dataFiles: ["/data/cities.json"],
        };
      }, { main: join(root, "main.tsx"), root });
      assertEquals(program.dataFiles, ["/data/cities.json"]);
    } finally {
      await Deno.remove(root, { recursive: true });
    }
  });

  it("adds a given path to what the resolve step attached", async () => {
    const root = await tree({
      "main.tsx": "export default 1;\n",
      "data/notes.txt": "note\n",
    });
    try {
      const program = await resolveLocalProgram(async (resolver) => {
        const main = await resolver.main();
        return {
          main: main.name,
          files: [main, { name: "/data/cities.json", contents: "[]\n" }],
          dataFiles: ["/data/cities.json"],
        };
      }, {
        main: join(root, "main.tsx"),
        root,
        dataFilePaths: [join(root, "data/notes.txt")],
      });
      assertEquals(program.dataFiles, ["/data/cities.json", "/data/notes.txt"]);
    } finally {
      await Deno.remove(root, { recursive: true });
    }
  });

  it("carries the named export through", async () => {
    const root = await tree({ "main.tsx": "export const view = 1;\n" });
    try {
      const program = await resolveLocalProgram(collectingResolve(), {
        main: join(root, "main.tsx"),
        root,
        mainExport: "view",
      });
      assertEquals(program.mainExport, "view");
    } finally {
      await Deno.remove(root, { recursive: true });
    }
  });
});

describe("attachDataFiles", () => {
  const program: RuntimeProgram = {
    main: "/main.tsx",
    files: [{ name: "/main.tsx", contents: "export default 1;\n" }],
  };

  it("returns the program untouched when nothing is attached", async () => {
    const root = await tree({});
    try {
      assertEquals(attachDataFiles(program, [], root), program);
      assertEquals(attachDataFiles(program, undefined, root), program);
    } finally {
      await Deno.remove(root, { recursive: true });
    }
  });

  it("stores a data file's bytes under its name below the root", async () => {
    const root = await tree({ "data/cities.json": '["Oslo"]\n' });
    try {
      const attached = attachDataFiles(
        program,
        [join(root, "data/cities.json")],
        root,
      );
      assertEquals(attached.dataFiles, ["/data/cities.json"]);
      assertEquals(
        attached.files.find((file) => file.name === "/data/cities.json")
          ?.contents,
        '["Oslo"]\n',
      );
    } finally {
      await Deno.remove(root, { recursive: true });
    }
  });

  it("attaches a file named twice only once", async () => {
    const root = await tree({ "data/cities.json": "[]\n" });
    try {
      const path = join(root, "data/cities.json");
      const attached = attachDataFiles(program, [path, path], root);
      assertEquals(attached.dataFiles, ["/data/cities.json"]);
      assertEquals(attached.files.length, 2);
    } finally {
      await Deno.remove(root, { recursive: true });
    }
  });

  it("refuses a data file the program already compiles", async () => {
    const root = await tree({ "main.tsx": "export default 1;\n" });
    try {
      assertThrows(
        () => attachDataFiles(program, [join(root, "main.tsx")], root),
        Error,
        '"/main.tsx" is also a source module',
      );
    } finally {
      await Deno.remove(root, { recursive: true });
    }
  });
});
