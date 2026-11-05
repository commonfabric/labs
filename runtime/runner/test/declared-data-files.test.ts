import { assertEquals, assertRejects } from "@std/assert";
import { beforeAll, describe, it } from "@std/testing/bdd";
import type { ProgramResolver, Source } from "@commonfabric/js-compiler";
import { attachDeclaredDataFiles } from "../src/harness/declared-data-files.ts";
import { ensureCompilerStack } from "../src/harness/deferred-compiler-stack.ts";
import type { RuntimeProgram } from "../src/harness/types.ts";

const READS_CITIES = 'import { dataFile } from "commonfabric";\n' +
  'export default () => dataFile("/data/cities.json");\n';

/** A resolver over a fixed set of sources, with no data-file read of its own. */
function sourceOnly(files: Record<string, string>): ProgramResolver {
  return {
    main: () => Promise.resolve({ name: "/main.tsx", contents: "" }),
    resolveSource: (name) =>
      Promise.resolve(
        name in files ? { name, contents: files[name] } : undefined,
      ),
  };
}

/** A resolver that reads data files through its own path. */
function withDataReader(
  files: Record<string, string>,
  data: Record<string, string>,
): ProgramResolver & { dataReads: string[] } {
  const dataReads: string[] = [];
  return {
    dataReads,
    main: () => Promise.resolve({ name: "/main.tsx", contents: "" }),
    resolveSource: (name) =>
      Promise.resolve(
        name in files ? { name, contents: files[name] } : undefined,
      ),
    resolveDataFile: (name): Promise<Source | undefined> => {
      dataReads.push(name);
      return Promise.resolve(
        name in data ? { name, contents: data[name] } : undefined,
      );
    },
  };
}

const program = (contents: string): RuntimeProgram => ({
  main: "/main.tsx",
  files: [{ name: "/main.tsx", contents }],
});

describe("attachDeclaredDataFiles", () => {
  // Reading a `dataFile()` call out of a module is the compiler stack's work,
  // and every flow that parses awaits it before starting. Here that flow is
  // the suite.
  beforeAll(async () => {
    await ensureCompilerStack();
  });

  it("attaches the file the source declares", async () => {
    const resolver = withDataReader({}, { "/data/cities.json": '["Oslo"]\n' });
    const result = await attachDeclaredDataFiles(
      program(READS_CITIES),
      resolver,
    );
    assertEquals(result.dataFiles, ["/data/cities.json"]);
    assertEquals(
      result.files.find((f) => f.name === "/data/cities.json")?.contents,
      '["Oslo"]\n',
    );
    assertEquals(resolver.dataReads, ["/data/cities.json"]);
  });

  it("reads through resolveSource when the resolver has no data read", async () => {
    const result = await attachDeclaredDataFiles(
      program(READS_CITIES),
      sourceOnly({ "/data/cities.json": '["Lima"]\n' }),
    );
    assertEquals(result.dataFiles, ["/data/cities.json"]);
    assertEquals(
      result.files.find((f) => f.name === "/data/cities.json")?.contents,
      '["Lima"]\n',
    );
  });

  it("attaches a sibling read under the reading module's directory", async () => {
    const nested: RuntimeProgram = {
      main: "/main.tsx",
      files: [
        { name: "/main.tsx", contents: 'export * from "./lists/read.ts";\n' },
        {
          name: "/lists/read.ts",
          contents: 'import { dataFile } from "commonfabric";\n' +
            'export default () => dataFile("./cities.json");\n',
        },
      ],
    };
    const resolver = withDataReader({}, { "/lists/cities.json": '["Oslo"]\n' });
    const result = await attachDeclaredDataFiles(nested, resolver);
    assertEquals(result.dataFiles, ["/lists/cities.json"]);
    assertEquals(resolver.dataReads, ["/lists/cities.json"]);
  });

  it("attaches a parent read above the reading module's directory", async () => {
    const nested: RuntimeProgram = {
      main: "/main.tsx",
      files: [
        { name: "/main.tsx", contents: 'export * from "./lists/read.ts";\n' },
        {
          name: "/lists/read.ts",
          contents: 'import { dataFile } from "commonfabric";\n' +
            'export default () => dataFile("../shared/cities.json");\n',
        },
      ],
    };
    const resolver = withDataReader({}, {
      "/shared/cities.json": '["Lima"]\n',
    });
    const result = await attachDeclaredDataFiles(nested, resolver);
    assertEquals(result.dataFiles, ["/shared/cities.json"]);
  });

  it("names the resolved path in a refusal, not the one written", async () => {
    // The reader wrote a path relative to itself; the file has to be stored at
    // the path that resolves to, and that is the path worth reporting.
    const nested: RuntimeProgram = {
      main: "/main.tsx",
      files: [
        { name: "/main.tsx", contents: 'export * from "./lists/read.ts";\n' },
        {
          name: "/lists/read.ts",
          contents: 'import { dataFile } from "commonfabric";\n' +
            'export default () => dataFile("./cities.json");\n',
        },
      ],
    };
    await assertRejects(
      () => attachDeclaredDataFiles(nested, sourceOnly({})),
      Error,
      '"/lists/read.ts" reads the data file "/lists/cities.json"',
    );
  });

  it("refuses a read that climbs above the program root", async () => {
    const escaping: RuntimeProgram = {
      main: "/main.tsx",
      files: [
        {
          name: "/main.tsx",
          contents: 'import { dataFile } from "commonfabric";\n' +
            'export default () => dataFile("../outside.json");\n',
        },
      ],
    };
    await assertRejects(
      () => attachDeclaredDataFiles(escaping, sourceOnly({})),
      Error,
      'Data file "../outside.json" read in "/main.tsx" escapes',
    );
  });

  it("leaves a program whose source declares nothing alone", async () => {
    const plain = program("export default 1;\n");
    assertEquals(await attachDeclaredDataFiles(plain, sourceOnly({})), plain);
  });

  it("refuses a declared name the resolver cannot produce", async () => {
    await assertRejects(
      () => attachDeclaredDataFiles(program(READS_CITIES), sourceOnly({})),
      Error,
      'reads the data file "/data/cities.json"',
    );
  });

  it("names the module that declared the missing file", async () => {
    const across: RuntimeProgram = {
      main: "/main.tsx",
      files: [
        { name: "/main.tsx", contents: 'export * from "./reader.ts";\n' },
        { name: "/reader.ts", contents: READS_CITIES },
      ],
    };
    await assertRejects(
      () => attachDeclaredDataFiles(across, sourceOnly({})),
      Error,
      '"/reader.ts" reads the data file',
    );
  });

  it("passes over a name the program already compiles as a module", async () => {
    // Reading a module's own text is not an attachment: the program would have
    // to both compile the file and store it uninterpreted.
    const both: RuntimeProgram = {
      main: "/main.tsx",
      files: [
        {
          name: "/main.tsx",
          contents: 'import { dataFile } from "commonfabric";\n' +
            'export default () => dataFile("/helper.ts");\n',
        },
        { name: "/helper.ts", contents: "export const x = 1;\n" },
      ],
    };
    const result = await attachDeclaredDataFiles(both, sourceOnly({}));
    assertEquals(result.dataFiles, undefined);
    assertEquals(result.files.length, 2);
  });

  it("keeps a data file the caller already attached", async () => {
    const given: RuntimeProgram = {
      ...program(READS_CITIES),
      dataFiles: ["/data/notes.txt"],
    };
    given.files = [...given.files, {
      name: "/data/notes.txt",
      contents: "note\n",
    }];
    const result = await attachDeclaredDataFiles(
      given,
      sourceOnly({ "/data/cities.json": "[]\n" }),
    );
    assertEquals(result.dataFiles, ["/data/notes.txt", "/data/cities.json"]);
  });

  it("never reads an attached data file as source", async () => {
    // The bytes of this data file happen to read as a module that declares
    // another one. It is data, so it is not parsed and declares nothing.
    const program: RuntimeProgram = {
      main: "/main.tsx",
      files: [
        { name: "/main.tsx", contents: "export default 1;\n" },
        {
          name: "/data/sample.txt",
          contents: 'import { dataFile } from "commonfabric";\n' +
            'export default () => dataFile("/data/absent.json");\n',
        },
      ],
      dataFiles: ["/data/sample.txt"],
    };
    const resolved = await attachDeclaredDataFiles(
      program,
      sourceOnly({}),
    );
    assertEquals(resolved.dataFiles, ["/data/sample.txt"]);
  });
});
