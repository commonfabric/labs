import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import ts from "typescript";
import {
  isDefaultLibraryFileName,
  isDefaultLibrarySourceFile,
} from "../src/typescript/default-library.ts";

describe("default-library provenance", () => {
  it("recognizes the names the libraries ship under", () => {
    for (
      const name of [
        "lib.d.ts",
        "/some/where/lib.d.ts",
        "/some/where/lib.es2020.d.ts",
        "$types/es2023.d.ts",
        "$types/dom.d.ts",
        "$types/jsx.d.ts",
        "ES2023.d.ts",
        "DOM.d.ts",
        "C:\\libs\\lib.es5.d.ts",
        "/repo/node_modules/@types/node/index.d.ts",
      ]
    ) {
      expect(isDefaultLibraryFileName(name)).toBe(true);
    }
  });

  it("does not mistake authored or framework declarations for the library", () => {
    for (
      const name of [
        "test.ts",
        "/repo/packages/api/index.ts",
        "$types/commonfabric.d.ts",
        "$types/commonfabric-schema.d.ts",
        "$types/turndown.d.ts",
        "/src/esbuild.d.ts",
        "/src/dom-utils.d.ts",
        "/src/library.d.ts",
      ]
    ) {
      expect(isDefaultLibraryFileName(name)).toBe(false);
    }
  });

  it("believes a supplied program answer over the file name, either way", () => {
    const library = ts.createSourceFile(
      "$types/es2023.d.ts",
      "",
      ts.ScriptTarget.ES2023,
    );
    const authored = ts.createSourceFile("main.ts", "", ts.ScriptTarget.ES2023);
    expect(
      isDefaultLibrarySourceFile(library, {
        isDefaultLibrarySourceFile: () => false,
      }),
    ).toBe(false);
    expect(
      isDefaultLibrarySourceFile(authored, {
        isDefaultLibrarySourceFile: () => true,
      }),
    ).toBe(true);
  });

  it("falls back to the file name only when no program answer is supplied", () => {
    const library = ts.createSourceFile(
      "$types/es2023.d.ts",
      "",
      ts.ScriptTarget.ES2023,
    );
    const authored = ts.createSourceFile("main.ts", "", ts.ScriptTarget.ES2023);
    expect(isDefaultLibrarySourceFile(library, {})).toBe(true);
    expect(isDefaultLibrarySourceFile(authored, {})).toBe(false);
  });
});
