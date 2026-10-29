import { expect } from "@std/expect";
import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";

import { Identity } from "@commonfabric/identity";
import { InMemoryProgram } from "@commonfabric/js-compiler";
import { entityIdFrom, Runtime } from "@commonfabric/runner";
import { StorageManager } from "@commonfabric/runner/storage/cache.deno";

import { slugIdForSpace } from "../../runner/src/slugs.ts";
import { collectLocalProgram } from "../lib/dev.ts";
import { pinProgramFabricImports } from "../lib/fabric-deps.ts";
import { argv, cf, stripAnsi } from "./utils.ts";
import { rawMetaWriteAuthorization } from "@commonfabric/runner/meta-seam";

const signer = await Identity.fromPassphrase("cli fabric deps test");
const space = signer.did();
const ENTRY = "Avcny13Rj8q-2ClANy_-k0ikWWQcXx7QTdsiqGfrC1c";

describe("cli fabric deps", () => {
  let storageManager: ReturnType<typeof StorageManager.emulate>;
  let runtime: Runtime;

  beforeEach(() => {
    storageManager = StorageManager.emulate({ as: signer });
    runtime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager,
    });
  });

  afterEach(async () => {
    await runtime?.dispose();
    await storageManager?.close();
  });

  // Write a piece cell carrying the content-addressed `patternIdentity` pointer
  // and slug-redirect to it, so the fabric ref chase resolves to its identity.
  async function writePatternSlug(slug: string): Promise<void> {
    const piece = runtime.getCell(
      space,
      { space, random: `piece-${slug}` },
    );
    await runtime.editWithRetry((tx) => {
      const pieceWithTx = piece.withTx(tx);
      pieceWithTx.set({ name: "piece" });
      pieceWithTx.setMetaRaw("patternIdentity", {
        identity: ENTRY,
        symbol: "default",
      }, rawMetaWriteAuthorization);
    });
    const slugCell = runtime.getCellFromEntityId(
      space,
      entityIdFrom(slugIdForSpace(space, slug)),
    );
    await runtime.editWithRetry((tx) => {
      const slugWithTx = slugCell.withTx(tx);
      slugWithTx.setRawUntyped(
        piece.withTx(tx).getAsWriteRedirectLink({ base: slugWithTx }),
      );
    });
  }

  it("pins mutable fabric imports in a runtime program", async () => {
    await writePatternSlug("dep");
    const result = await pinProgramFabricImports(runtime, space, {
      main: "/main.tsx",
      files: [
        {
          name: "/main.tsx",
          contents: `import dep from "cf:dep";\nexport default dep;`,
        },
      ],
    });

    expect(result.program.files[0].contents).toBe(
      `import dep from "cf:dep@${ENTRY}";\nexport default dep;`,
    );
    expect(result.rewrites).toEqual([
      {
        file: "/main.tsx",
        specifier: "cf:dep",
        pinned: `cf:dep@${ENTRY}`,
        resolvedIdentity: ENTRY,
        line: 1,
      },
    ]);
  });

  it("leaves an attached data file's bytes alone while pinning", async () => {
    await writePatternSlug("dep");
    // The data file's text reads as a mutable fabric import. Storing it
    // verbatim is the whole point of attaching it, so pinning must not touch
    // it — a rewrite here would be silent data corruption.
    const dataContents = `import dep from "cf:dep";\nnot code at all`;
    const result = await pinProgramFabricImports(runtime, space, {
      main: "/main.tsx",
      dataFiles: ["/data/notes.txt"],
      files: [
        {
          name: "/main.tsx",
          contents: `import dep from "cf:dep";\nexport default dep;`,
        },
        { name: "/data/notes.txt", contents: dataContents },
      ],
    });

    expect(
      result.program.files.find((file) => file.name === "/data/notes.txt")
        ?.contents,
    ).toBe(dataContents);
    expect(result.rewrites.map((rewrite) => rewrite.file)).toEqual([
      "/main.tsx",
    ]);
  });

  it("pins fabric imports across every file of a program", async () => {
    await writePatternSlug("dep");
    const result = await pinProgramFabricImports(runtime, space, {
      main: "/main.tsx",
      files: [
        {
          name: "/main.tsx",
          contents: `import { s } from "./schemas.tsx";\nexport default s;`,
        },
        {
          name: "/schemas.tsx",
          contents: `import dep from "cf:dep";\nexport const s = dep;`,
        },
      ],
    });

    expect(result.rewrites).toEqual([
      {
        file: "/schemas.tsx",
        specifier: "cf:dep",
        pinned: `cf:dep@${ENTRY}`,
        resolvedIdentity: ENTRY,
        line: 1,
      },
    ]);
    expect(result.program.files[0].contents).toContain("./schemas.tsx");
    expect(result.program.files[1].contents).toContain(`cf:dep@${ENTRY}`);
  });

  it("rejects subpaths instead of pinning them to the entry", async () => {
    await writePatternSlug("dep");

    await expect(
      pinProgramFabricImports(runtime, space, {
        main: "/main.tsx",
        files: [
          {
            name: "/main.tsx",
            contents:
              `import schema from "cf:dep/schemas";\nexport default schema;`,
          },
        ],
      }),
    ).rejects.toThrow("subpaths not yet supported (M4): cf:dep/schemas");
  });

  it("collectLocalProgram walks local files and dispatches on fabric refs", async () => {
    const resolver = new InMemoryProgram("/main.tsx", {
      "/main.tsx": `import { s } from "./schemas.tsx";\nexport default s;`,
      "/schemas.tsx": `import dep from "cf:dep";\nexport const s = dep;`,
    });

    const program = await collectLocalProgram(resolver, {
      fabricImports: "allow",
    });
    expect(program.files.map((f) => f.name)).toEqual([
      "/main.tsx",
      "/schemas.tsx",
    ]);

    await expect(
      collectLocalProgram(resolver, { fabricImports: "reject" }),
    ).rejects.toThrow("fabric imports require a space context");
  });

  it("collectLocalProgram surfaces malformed fabric specifiers as parse errors", async () => {
    const resolver = new InMemoryProgram("/main.tsx", {
      "/main.tsx": `import dep from "cf:module/abc";\nexport default dep;`,
    });

    await expect(
      collectLocalProgram(resolver, { fabricImports: "allow" }),
    ).rejects.toThrow("compiler-internal namespaces");
  });

  it("collectLocalProgram refuses an import that escapes the program root", async () => {
    // No compile stands behind this walk, so an unrefused escape is a
    // silently collected wrong file in `cf check` and `cf deps`.
    const resolver = new InMemoryProgram("/main.tsx", {
      "/main.tsx": `import { x } from "../outside.ts";\nexport default x;`,
      "/outside.ts": "export const x = 1;",
    });

    await expect(
      collectLocalProgram(resolver, { fabricImports: "allow" }),
    ).rejects.toThrow(
      'Import "../outside.ts" in "/main.tsx" escapes the program root.',
    );
  });

  it("collectLocalProgram collects a parent import that stays inside", async () => {
    const resolver = new InMemoryProgram("/core/main.tsx", {
      "/core/main.tsx":
        `import { x } from "../util/mod.ts";\nexport default x;`,
      "/util/mod.ts": "export const x = 1;",
    });

    const program = await collectLocalProgram(resolver, {
      fabricImports: "allow",
    });
    expect(program.files.map((f) => f.name).toSorted()).toEqual([
      "/core/main.tsx",
      "/util/mod.ts",
    ]);
  });

  it("exposes deps update help", async () => {
    const { code, stdout } = await cf(argv`deps update --help`);

    expect(code).toBe(0);
    expect(stripAnsi(stdout.join("\n"))).toContain("--check");
  });
});
