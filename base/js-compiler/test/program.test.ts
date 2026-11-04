import { expect } from "@std/expect";
import * as path from "@std/path";
import { describe, it } from "@std/testing/bdd";
import {
  FileSystemProgramResolver,
  HttpProgramResolver,
  InMemoryProgram,
  readDataFileSource,
} from "../program.ts";

describe("InMemoryProgram", () => {
  it("resolves empty main and dependency sources", async () => {
    const resolver = new InMemoryProgram("/main.ts", {
      "/main.ts": "",
      "/dependency.ts": "",
    });

    expect(await resolver.main()).toEqual({
      name: "/main.ts",
      contents: "",
    });
    expect(await resolver.resolveSource("/dependency.ts")).toEqual({
      name: "/dependency.ts",
      contents: "",
    });
    expect(await resolver.resolveSource("/missing.ts")).toBeUndefined();
  });
});

describe("FileSystemProgramResolver", () => {
  it("keeps entry and dependency names grounded under filesystem root", async () => {
    const directory = await Deno.makeTempDir();
    const mainPath = `${directory}/main.ts`;
    const dependencyPath = `${directory}/dependency.ts`;
    await Deno.writeTextFile(mainPath, "export default 1;");
    await Deno.writeTextFile(dependencyPath, "export default 2;");

    try {
      const resolver = new FileSystemProgramResolver(mainPath, directory);
      expect(await resolver.main()).toEqual({
        name: "/main.ts",
        contents: "export default 1;",
      });
      expect(await resolver.resolveSource("/dependency.ts")).toEqual({
        name: "/dependency.ts",
        contents: "export default 2;",
      });

      const filesystemRoot = path.parse(directory).root;
      const mainSpecifier = `/${
        path.relative(filesystemRoot, mainPath)
          .split(path.SEPARATOR).join("/")
      }`;
      const dependencySpecifier = `/${
        path.relative(filesystemRoot, dependencyPath)
          .split(path.SEPARATOR).join("/")
      }`;
      const rootResolver = new FileSystemProgramResolver(
        mainPath,
        filesystemRoot,
      );
      expect((await rootResolver.main()).name).toBe(mainSpecifier);
      expect(await rootResolver.resolveSource(dependencySpecifier)).toEqual({
        name: dependencySpecifier,
        contents: "export default 2;",
      });
    } finally {
      await Deno.remove(directory, { recursive: true });
    }
  });

  it("rejects a main path that only shares the root's text prefix", async () => {
    const root = await Deno.makeTempDir();
    try {
      expect(() =>
        new FileSystemProgramResolver(`${root}-sibling/main.ts`, root)
      ).toThrow("must be within root directory");
    } finally {
      await Deno.remove(root, { recursive: true });
    }
  });

  it("rejects entry and dependency symlinks that leave the root", async () => {
    const root = await Deno.makeTempDir();
    const outside = await Deno.makeTempDir();
    const mainPath = `${root}/main.ts`;
    const outsideMainPath = `${outside}/main.ts`;
    const outsideDependencyPath = `${outside}/dependency.ts`;
    await Deno.writeTextFile(mainPath, "export default 1;");
    await Deno.writeTextFile(outsideMainPath, "export default 2;");
    await Deno.writeTextFile(outsideDependencyPath, "export default 3;");
    await Deno.symlink(outsideMainPath, `${root}/linked-main.ts`, {
      type: "file",
    });
    await Deno.symlink(outsideDependencyPath, `${root}/dependency.ts`, {
      type: "file",
    });

    try {
      expect(() =>
        new FileSystemProgramResolver(`${root}/linked-main.ts`, root)
      ).toThrow("must be within root directory");

      const resolver = new FileSystemProgramResolver(mainPath, root);
      expect(() => resolver.resolveSource("/dependency.ts")).toThrow(
        "resolves outside of root directory",
      );
    } finally {
      await Deno.remove(root, { recursive: true });
      await Deno.remove(outside, { recursive: true });
    }
  });

  it("retains logical names for symlinks whose targets remain inside the root", async () => {
    const root = await Deno.makeTempDir();
    const mainPath = `${root}/main.ts`;
    const dependencyPath = `${root}/dependency.ts`;
    await Deno.writeTextFile(mainPath, "export default 1;");
    await Deno.writeTextFile(dependencyPath, "export default 2;");
    await Deno.symlink(dependencyPath, `${root}/linked-dependency.ts`, {
      type: "file",
    });

    try {
      const resolver = new FileSystemProgramResolver(mainPath, root);
      expect(await resolver.resolveSource("/linked-dependency.ts")).toEqual({
        name: "/linked-dependency.ts",
        contents: "export default 2;",
      });
    } finally {
      await Deno.remove(root, { recursive: true });
    }
  });
});

describe("readDataFileSource", () => {
  it("grounds a data file under the deployment root", async () => {
    const root = await Deno.makeTempDir();
    const dataDirectory = `${root}/data`;
    await Deno.mkdir(dataDirectory);
    await Deno.writeTextFile(`${dataDirectory}/cities.json`, '{"a": 1}');

    try {
      expect(readDataFileSource(`${dataDirectory}/cities.json`, root)).toEqual({
        name: "/data/cities.json",
        contents: '{"a": 1}',
      });
    } finally {
      await Deno.remove(root, { recursive: true });
    }
  });

  it("reads bytes verbatim without treating them as TypeScript", async () => {
    const root = await Deno.makeTempDir();
    const contents = 'import x from "./nowhere.ts";\n\u00e9\t{ not code';
    await Deno.writeTextFile(`${root}/notes.txt`, contents);

    try {
      expect(readDataFileSource(`${root}/notes.txt`, root).contents).toBe(
        contents,
      );
    } finally {
      await Deno.remove(root, { recursive: true });
    }
  });

  it("keeps a byte order mark in the contents", async () => {
    const root = await Deno.makeTempDir();
    const bytes = new Uint8Array([0xef, 0xbb, 0xbf, 0x7b, 0x7d]);
    await Deno.writeFile(`${root}/bom.json`, bytes);

    try {
      // The mark is part of the file, and a data file is stored byte-for-byte.
      expect(readDataFileSource(`${root}/bom.json`, root).contents).toBe(
        "\uFEFF{}",
      );
    } finally {
      await Deno.remove(root, { recursive: true });
    }
  });

  it("rejects a data file outside the root", async () => {
    const root = await Deno.makeTempDir();
    const outside = await Deno.makeTempDir();
    await Deno.writeTextFile(`${outside}/data.json`, "{}");

    try {
      expect(() => readDataFileSource(`${outside}/data.json`, root)).toThrow(
        "must be within root directory",
      );
    } finally {
      await Deno.remove(root, { recursive: true });
      await Deno.remove(outside, { recursive: true });
    }
  });

  it("rejects a data file symlinked out of the root", async () => {
    const root = await Deno.makeTempDir();
    const outside = await Deno.makeTempDir();
    await Deno.writeTextFile(`${outside}/data.json`, "{}");
    await Deno.symlink(`${outside}/data.json`, `${root}/data.json`, {
      type: "file",
    });

    try {
      expect(() => readDataFileSource(`${root}/data.json`, root)).toThrow(
        "must be within root directory",
      );
    } finally {
      await Deno.remove(root, { recursive: true });
      await Deno.remove(outside, { recursive: true });
    }
  });

  it("rejects bytes that are not valid UTF-8 text", async () => {
    const root = await Deno.makeTempDir();
    await Deno.writeFile(`${root}/blob.bin`, new Uint8Array([0xc3, 0x28]));

    try {
      expect(() => readDataFileSource(`${root}/blob.bin`, root)).toThrow(
        "is not valid UTF-8 text",
      );
    } finally {
      await Deno.remove(root, { recursive: true });
    }
  });
});

describe("HttpProgramResolver", () => {
  it("invokes the default fetch with the host global as receiver", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = function (
      this: typeof globalThis,
      _input: RequestInfo | URL,
      _init?: RequestInit,
    ): Promise<Response> {
      if (this !== globalThis) throw new TypeError("Illegal invocation");
      return Promise.resolve(new Response("export default 42"));
    } as typeof globalThis.fetch;

    try {
      const resolver = new HttpProgramResolver(
        "https://patterns.example/main.ts",
      );
      expect(await resolver.main()).toEqual({
        name: "/main.ts",
        contents: "export default 42",
      });
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("invokes an injected fetch with the host global as receiver", async () => {
    const fetchImpl = function (
      this: typeof globalThis,
      _input: RequestInfo | URL,
      _init?: RequestInit,
    ): Promise<Response> {
      if (this !== globalThis) throw new TypeError("Illegal invocation");
      return Promise.resolve(new Response("export default 42"));
    } as typeof globalThis.fetch;

    const resolver = new HttpProgramResolver(
      "https://patterns.example/main.ts",
      fetchImpl,
    );
    expect(await resolver.main()).toEqual({
      name: "/main.ts",
      contents: "export default 42",
    });
  });
});

describe("FileSystemProgramResolver.resolveDataFile", () => {
  // Writes the named files into a fresh temp tree and returns its root. The
  // caller removes the tree.
  async function tree(files: Record<string, string>): Promise<string> {
    const root = await Deno.makeTempDir({ prefix: "resolve-data-file-" });
    for (const [name, contents] of Object.entries(files)) {
      const full = path.join(root, name);
      await Deno.mkdir(path.join(full, ".."), { recursive: true });
      await Deno.writeTextFile(full, contents);
    }
    return root;
  }

  it("reads the file the name grounds to", async () => {
    const root = await tree({
      "main.tsx": "export default 1;\n",
      "data/cities.json": '["Oslo"]\n',
    });
    try {
      const resolver = new FileSystemProgramResolver(
        path.join(root, "main.tsx"),
        root,
      );
      const source = await resolver.resolveDataFile("/data/cities.json");
      expect(source).toEqual({
        name: "/data/cities.json",
        contents: '["Oslo"]\n',
      });
    } finally {
      await Deno.remove(root, { recursive: true });
    }
  });

  it("keeps a byte order mark that reading a module would consume", async () => {
    const root = await tree({ "main.tsx": "export default 1;\n" });
    try {
      await Deno.writeFile(
        path.join(root, "marked.txt"),
        new Uint8Array([0xef, 0xbb, 0xbf, 0x68, 0x69]),
      );
      const resolver = new FileSystemProgramResolver(
        path.join(root, "main.tsx"),
        root,
      );
      const source = await resolver.resolveDataFile("/marked.txt");
      expect(source?.contents).toBe("\uFEFFhi");
    } finally {
      await Deno.remove(root, { recursive: true });
    }
  });

  it("refuses bytes that are not UTF-8 rather than storing replacements", async () => {
    const root = await tree({ "main.tsx": "export default 1;\n" });
    try {
      await Deno.writeFile(
        path.join(root, "bad.bin"),
        new Uint8Array([0xff, 0xfe, 0x00]),
      );
      const resolver = new FileSystemProgramResolver(
        path.join(root, "main.tsx"),
        root,
      );
      await expect(resolver.resolveDataFile("/bad.bin")).rejects.toThrow(
        "is not valid UTF-8 text",
      );
    } finally {
      await Deno.remove(root, { recursive: true });
    }
  });

  it("returns undefined for a name with no file behind it", async () => {
    const root = await tree({ "main.tsx": "export default 1;\n" });
    try {
      const resolver = new FileSystemProgramResolver(
        path.join(root, "main.tsx"),
        root,
      );
      expect(await resolver.resolveDataFile("/data/absent.json")).toBe(
        undefined,
      );
    } finally {
      await Deno.remove(root, { recursive: true });
    }
  });

  it("returns undefined for a name that is not grounded", async () => {
    const root = await tree({ "main.tsx": "export default 1;\n" });
    try {
      const resolver = new FileSystemProgramResolver(
        path.join(root, "main.tsx"),
        root,
      );
      expect(await resolver.resolveDataFile("data/cities.json")).toBe(
        undefined,
      );
    } finally {
      await Deno.remove(root, { recursive: true });
    }
  });

  it("refuses a name that climbs out of the root", async () => {
    const root = await tree({ "inner/main.tsx": "export default 1;\n" });
    try {
      await Deno.writeTextFile(path.join(root, "outside.json"), "[]\n");
      const resolver = new FileSystemProgramResolver(
        path.join(root, "inner", "main.tsx"),
        path.join(root, "inner"),
      );
      await expect(resolver.resolveDataFile("/../outside.json")).rejects
        .toThrow("outside of root directory");
    } finally {
      await Deno.remove(root, { recursive: true });
    }
  });

  it("refuses a link inside the root that names a file outside it", async () => {
    const root = await tree({ "inner/main.tsx": "export default 1;\n" });
    try {
      await Deno.writeTextFile(path.join(root, "outside.json"), "[]\n");
      await Deno.symlink(
        path.join(root, "outside.json"),
        path.join(root, "inner", "linked.json"),
      );
      const resolver = new FileSystemProgramResolver(
        path.join(root, "inner", "main.tsx"),
        path.join(root, "inner"),
      );
      // The written path stays inside the root; only following the link shows
      // that it does not.
      await expect(resolver.resolveDataFile("/linked.json")).rejects.toThrow(
        "outside of root directory",
      );
    } finally {
      await Deno.remove(root, { recursive: true });
    }
  });
});

describe("HttpProgramResolver.resolveDataFile", () => {
  const at = (url: string | URL, body: string, status = 200) =>
    new HttpProgramResolver(
      url,
      () => Promise.resolve(new Response(body, { status })),
    );

  it("fetches the file the name grounds to", async () => {
    const resolver = at("https://example.com/main.tsx", '["Oslo"]');
    expect(await resolver.resolveDataFile("/data/cities.json")).toEqual({
      name: "/data/cities.json",
      contents: '["Oslo"]',
    });
  });

  it("returns undefined when the fetch does not find it", async () => {
    const resolver = at("https://example.com/main.tsx", "nope", 404);
    expect(await resolver.resolveDataFile("/data/absent.json")).toBe(undefined);
  });

  it("returns undefined for a name that is not grounded", async () => {
    const resolver = at("https://example.com/main.tsx", "[]");
    expect(await resolver.resolveDataFile("data/cities.json")).toBe(undefined);
  });

  it("reports a refusal as a refusal, not as a missing file", async () => {
    for (const status of [401, 403, 500]) {
      const resolver = at("https://example.com/main.tsx", "no", status);
      await expect(resolver.resolveDataFile("/data/cities.json")).rejects
        .toThrow(`${status}`);
    }
  });
});
