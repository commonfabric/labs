/**
 * `cf piece getsrc` writes a recovered source package to disk, and the files
 * it writes carry no record of which were data. A later `setsrc` re-derives
 * that from the source, so what it cannot re-derive is what getsrc has to say
 * out loud.
 */

import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import type { RuntimeProgram } from "@commonfabric/runner";
import { join } from "@std/path";
import {
  undeclaredDataFiles,
  undeclaredDataFileWarning,
  writeSourcePackage,
} from "../lib/piece.ts";

const READS_CITIES = 'import { dataFile } from "commonfabric";\n' +
  'export default () => dataFile("/data/cities.json");\n';

function program(
  files: Record<string, string>,
  dataFiles?: string[],
): RuntimeProgram {
  return {
    main: "/main.tsx",
    files: Object.entries(files).map(([name, contents]) => ({
      name,
      contents,
    })),
    ...(dataFiles === undefined ? {} : { dataFiles }),
  };
}

describe("undeclaredDataFiles", () => {
  it("says nothing about a file the source reads by name", () => {
    expect(
      undeclaredDataFiles(
        program({ "/main.tsx": READS_CITIES, "/data/cities.json": "[]" }, [
          "/data/cities.json",
        ]),
      ),
    ).toEqual([]);
  });

  it("names a file the source never reads", () => {
    expect(
      undeclaredDataFiles(
        program({ "/main.tsx": "export default 1;\n", "/extra.txt": "hi" }, [
          "/extra.txt",
        ]),
      ),
    ).toEqual(["/extra.txt"]);
  });

  it("names only the file the source cannot account for", () => {
    expect(
      undeclaredDataFiles(
        program({
          "/main.tsx": READS_CITIES,
          "/data/cities.json": "[]",
          "/extra.txt": "hi",
        }, ["/data/cities.json", "/extra.txt"]),
      ),
    ).toEqual(["/extra.txt"]);
  });

  it("says nothing about a program carrying no data at all", () => {
    expect(undeclaredDataFiles(program({ "/main.tsx": "export default 1;\n" })))
      .toEqual([]);
  });

  it("reads a declaration from any module of the program", () => {
    expect(
      undeclaredDataFiles(
        program({
          "/main.tsx": 'export { default } from "./reader.ts";\n',
          "/reader.ts": READS_CITIES,
          "/data/cities.json": "[]",
        }, ["/data/cities.json"]),
      ),
    ).toEqual([]);
  });
});

describe("undeclaredDataFileWarning", () => {
  it("says nothing when the source accounts for every data file", () => {
    expect(
      undeclaredDataFileWarning(
        program({ "/main.tsx": READS_CITIES, "/data/cities.json": "[]" }, [
          "/data/cities.json",
        ]),
      ),
    ).toBe(undefined);
  });

  it("spells out the flag that puts a file back on the next revision", () => {
    const warning = undeclaredDataFileWarning(
      program({ "/main.tsx": "export default 1;\n", "/extra.txt": "hi" }, [
        "/extra.txt",
      ]),
    );
    expect(warning).toContain("1 data file(s)");
    expect(warning).toContain("--datafile ./extra.txt");
    expect(warning).toContain("setsrc");
  });

  it("names every file it cannot account for", () => {
    const warning = undeclaredDataFileWarning(
      program({
        "/main.tsx": "export default 1;\n",
        "/a.txt": "a",
        "/b.txt": "b",
      }, ["/a.txt", "/b.txt"]),
    );
    expect(warning).toContain("2 data file(s)");
    expect(warning).toContain("--datafile ./a.txt");
    expect(warning).toContain("--datafile ./b.txt");
  });
});

describe("writeSourcePackage", () => {
  // Writes `program` into a fresh temp tree, runs `body` against that tree,
  // and removes it.
  async function written(
    program: RuntimeProgram,
    body: (out: string) => Promise<void>,
  ): Promise<void> {
    const out = await Deno.makeTempDir({ prefix: "source-package-" });
    try {
      await writeSourcePackage(program, out);
      await body(out);
    } finally {
      await Deno.remove(out, { recursive: true });
    }
  }

  it("lays a file out under the name the package stores it by", async () => {
    await written(
      program({ "/main.tsx": READS_CITIES }),
      async (out) => {
        expect(await Deno.readTextFile(join(out, "main.tsx"))).toBe(
          READS_CITIES,
        );
      },
    );
  });

  it("writes a data file beside the code, in its own directory", async () => {
    await written(
      program({ "/main.tsx": READS_CITIES, "/data/cities.json": "[]" }, [
        "/data/cities.json",
      ]),
      async (out) => {
        // The nested directory is what makes a `setsrc` from here resolve the
        // same `/data/cities.json` the piece was built with.
        expect(await Deno.readTextFile(join(out, "data/cities.json"))).toBe(
          "[]",
        );
      },
    );
  });

  it("writes a file's bytes unchanged", async () => {
    const authored = '{ "cities":  ["Oslo"] }\n';
    await written(
      program({ "/main.tsx": READS_CITIES, "/data/cities.json": authored }),
      async (out) => {
        // Spacing a formatter would not produce, so a re-serialization
        // anywhere on the way out shows up here.
        expect(await Deno.readTextFile(join(out, "data/cities.json"))).toBe(
          authored,
        );
      },
    );
  });

  it("refuses a name that belongs to no layout", async () => {
    const out = await Deno.makeTempDir({ prefix: "source-package-" });
    try {
      await expect(
        writeSourcePackage(
          program({ "main.tsx": "export default 1;\n" }),
          out,
        ),
      ).rejects.toThrow("Ungrounded file in pattern");
    } finally {
      await Deno.remove(out, { recursive: true });
    }
  });
});
