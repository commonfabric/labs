import { expect } from "@std/expect";

import { sourcePackageOwners } from "../src/harness/declared-data-files.ts";
import { ensureCompilerStack } from "../src/harness/deferred-compiler-stack.ts";
import { beforeAll, describe, it } from "@commonfabric/test-support/test";

describe("sourcePackageOwners()", () => {
  // Reading a `dataFile()` call out of a module is the compiler stack's work.
  beforeAll(async () => {
    await ensureCompilerStack();
  });

  it("gives a module the assets of a directory it reads, and the entry the rest", () => {
    const owners = sourcePackageOwners({
      main: "/main.tsx",
      sourceRoots: [],
      dataPaths: [
        "/donuts/assets/glaze.png",
        "/donuts/assets/notes.md",
        "/donuts/assets/old/glaze.png",
      ],
      modules: [
        { name: "/main.tsx", contents: 'export * from "./donuts/read.ts";\n' },
        {
          name: "/donuts/read.ts",
          contents: 'import { dataFile } from "commonfabric";\n' +
            'export const assets = dataFile.urls("./assets");\n',
        },
      ],
    });

    expect(owners).toEqual([
      {
        ownerPath: "/main.tsx",
        rootPaths: [],
        dataPaths: ["/donuts/assets/notes.md", "/donuts/assets/old/glaze.png"],
      },
      {
        ownerPath: "/donuts/read.ts",
        rootPaths: [],
        dataPaths: ["/donuts/assets/glaze.png"],
      },
    ]);
  });
});
