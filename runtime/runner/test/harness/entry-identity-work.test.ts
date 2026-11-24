import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";
import { spy } from "@std/testing/mock";

import * as compiler from "../../src/harness/compiler-stack.ts";
import { ensureCompilerStack } from "../../src/harness/deferred-compiler-stack.ts";
import {
  computeEntryIdentity,
  resolveEntryIdentity,
} from "../../src/harness/entry-identity.ts";

// This file's isolated runtime installs the counting loader; the identity
// parity tests use the real compiler stack in their own file. All three scans
// the stack offers are counted, so a step that parses a module through any of
// them shows up here.
const scans = spy(compiler.scanModuleDeclarations);
const importScans = spy(compiler.collectImportSpecifiers);
const dataFileScans = spy(compiler.collectDataFileNames);
await ensureCompilerStack(() =>
  Promise.resolve({
    ...compiler,
    scanModuleDeclarations: scans,
    collectImportSpecifiers: importScans,
    collectDataFileNames: dataFileScans,
  })
);

/** Runs `work` and returns the name of every module it scanned, in order. */
async function scannedDuring(work: () => unknown): Promise<string[]> {
  const starts = [scans, importScans, dataFileScans].map((s) => s.calls.length);
  await work();
  return [scans, importScans, dataFileScans].flatMap((s, i) =>
    s.calls.slice(starts[i]).map((call) => call.args[0].name)
  );
}

describe("entry-identity", () => {
  it("parses each file once whatever the root count", async () => {
    const sourceRoots = Array.from({ length: 32 }, (_, i) => `/root-${i}.ts`);
    const files = [
      { name: "/entry.ts", contents: "export default 1;" },
      { name: "/shared.ts", contents: "export const shared = 1;" },
      ...sourceRoots.map((name) => ({
        name,
        contents: 'export { shared } from "./shared.ts";',
      })),
    ];
    let identity = "";
    const scanned = await scannedDuring(() => {
      identity = computeEntryIdentity("/entry.ts", files, { sourceRoots });
    });

    expect(identity).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(scanned).toHaveLength(files.length);
    expect(new Set(scanned).size).toBe(files.length);
  });

  it("parses each module of a resolved program once, and its data file never", async () => {
    const sources = new Map([
      [
        "/main.tsx",
        [
          'import { dataFile } from "commonfabric";',
          'import { words } from "./words.ts";',
          'export default () => words(dataFile("./words.txt"));',
        ].join("\n"),
      ],
      [
        "/words.ts",
        "export const words = (text: string) => text.split(`\\n`);",
      ],
      ["/words.txt", 'import "./not-a-module.ts";\nalpha\nbeta\n'],
    ]);
    const readFile = (name: string) => {
      const contents = sources.get(name);
      return contents === undefined
        ? Promise.reject(new Error(`no file ${name}`))
        : Promise.resolve(contents);
    };

    let identity = "";
    const scanned = await scannedDuring(async () => {
      identity = await resolveEntryIdentity("/main.tsx", readFile);
    });

    expect(identity).toBe(
      computeEntryIdentity(
        "/main.tsx",
        [...sources].map(([name, contents]) => ({ name, contents })),
        { dataFiles: ["/words.txt"] },
      ),
    );
    expect(scanned.toSorted()).toEqual(["/main.tsx", "/words.ts"]);
  });
});
