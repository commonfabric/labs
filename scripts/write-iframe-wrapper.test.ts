import { expect } from "@std/expect";
import { dirname, resolve } from "@std/path";
import { describe, it } from "@std/testing/bdd";

import { runDenoCommandWithTemporaryLock } from "@commonfabric/test-support/isolated-deno";

const ROOT = resolve(import.meta.dirname!, "..");
const SCRIPT = resolve(import.meta.dirname!, "write-iframe-wrapper.ts");
const decoder = new TextDecoder();

/** Expects nothing to be at any of `paths`, a dangling symlink included. */
async function expectAbsent(...paths: string[]): Promise<void> {
  for (const path of paths) {
    await expect(Deno.lstat(path)).rejects.toBeInstanceOf(
      Deno.errors.NotFound,
    );
  }
}

async function removeDirectory(path: string): Promise<void> {
  try {
    await Deno.remove(path, { recursive: true });
  } catch (error) {
    if (!(error instanceof Deno.errors.NotFound)) throw error;
  }
}

async function runDeno(args: (lockPath: string) => string[]) {
  return await runDenoCommandWithTemporaryLock({
    root: ROOT,
    args,
  });
}

async function generate(
  contract: string,
  guest: string,
  out: string,
  ...args: string[]
) {
  return await runDeno((lockPath) => [
    "run",
    "--allow-all",
    "--frozen=true",
    "--lock",
    lockPath,
    SCRIPT,
    "--contract",
    contract,
    "--guest",
    guest,
    "--out",
    out,
    ...args,
  ]);
}

/** Runs this checkout's `cf check` on `entry`, in a program rooted at `root`. */
async function cfCheck(entry: string, root: string, ...args: string[]) {
  return await runDeno((lockPath) => [
    "run",
    "--allow-all",
    "--frozen=true",
    "--lock",
    lockPath,
    resolve(ROOT, "runtime/cli/launcher.ts"),
    "check",
    entry,
    "--root",
    root,
    ...args,
  ]);
}

const contractPrefix = `
export interface IframeInputData { heading: string }
export interface IframeStateData { count: number }
export interface IframeOutputData { count: number }
export const DEFAULT_INPUT: IframeInputData = { heading: "Test" };
export const DEFAULT_STATE: IframeStateData = { count: 0 };
export const DEFAULT_OUTPUT: IframeOutputData = { count: 0 };
`;

/**
 * Runs `body` with a fresh temporary directory whose name starts with
 * `prefix`, and removes the directory afterward.
 */
async function inTemporaryDirectory(
  prefix: string,
  body: (directory: string) => Promise<void>,
): Promise<void> {
  const directory = await Deno.makeTempDir({ prefix });
  try {
    await body(directory);
  } finally {
    await removeDirectory(directory);
  }
}

/**
 * Writes a contract whose `IFRAME_PATTERN` is the source `iframePattern`, and
 * a guest that sets the body's text, into `directory`. Returns their paths and
 * the paths of the files the generator writes for a wrapper at `out`, which is
 * relative to `directory`.
 */
async function writeFixture(
  directory: string,
  iframePattern: string,
  out = "main.tsx",
) {
  const contract = resolve(directory, "contract.ts");
  const guest = resolve(directory, "guest.ts");
  const wrapper = resolve(directory, out);
  await Deno.writeTextFile(
    contract,
    `${contractPrefix}
export const IFRAME_PATTERN = ${iframePattern} as const;
`,
  );
  await Deno.writeTextFile(guest, "document.body.textContent = 'guest';\n");
  return {
    contract,
    guest,
    out: wrapper,
    script: resolve(wrapper, "..", "guest.js"),
    html: resolve(wrapper, "..", "guest.html"),
  };
}

describe("iframe pattern wrapper generator", () => {
  it("bundles React TSX with the guest-owned React instance", async () => {
    const directory = await Deno.makeTempDir({
      prefix: "pattern-iframe-react-",
    });
    try {
      const contract = resolve(directory, "contract.ts");
      const guest = resolve(directory, "guest.tsx");
      const out = resolve(directory, "main.tsx");
      await Deno.writeTextFile(
        contract,
        `${contractPrefix}
export const IFRAME_PATTERN = { name: "ReactGuest" } as const;
`,
      );
      await Deno.writeTextFile(
        guest,
        `import React from "npm:react@19.2.8";
import { createRoot } from "npm:react-dom@19.2.8/client";
createRoot(document.querySelector("#root")!).render(
  <button type="button">React {React.version}</button>,
);
`,
      );

      const result = await generate(contract, guest, out, "--react");

      expect(result.code, decoder.decode(result.stderr)).toBe(0);
      const bundle = await Deno.readTextFile(resolve(directory, "guest.js"));
      expect(bundle).toContain("react.production.js");
      expect(bundle).not.toContain("@commonfabric/runner/jsx-runtime");
    } finally {
      await removeDirectory(directory);
    }
  });

  it("keeps state and output scoped to the active viewer", async () => {
    const directory = await Deno.makeTempDir({
      prefix: "pattern-iframe-scopes-",
    });
    try {
      const contract = resolve(directory, "contract.ts");
      const guest = resolve(directory, "guest.ts");
      const out = resolve(directory, "main.tsx");
      await Deno.writeTextFile(
        contract,
        `${contractPrefix}
export const IFRAME_PATTERN = {
  name: "ScopedState",
  stateScope: "user",
  outputScope: "session",
} as const;
`,
      );
      await Deno.writeTextFile(guest, "document.body.textContent = 'guest';\n");

      const result = await generate(contract, guest, out);
      expect(result.code, decoder.decode(result.stderr)).toBe(0);
      const generated = await Deno.readTextFile(out);
      expect(generated).toContain(
        "state?: PerUser<Writable<Default<IframeStateData, typeof DEFAULT_STATE>>>;",
      );
      expect(generated).toContain(
        "output?: PerSession<Writable<Default<IframeOutputData, typeof DEFAULT_OUTPUT>>>;",
      );
      expect(generated).toMatch(
        /\(\(\{\s*input,\s*state,\s*output,\s*\}\) => \{/,
      );
      expect(generated).toContain(
        "const iframeInput = input ?? DEFAULT_INPUT;",
      );
      expect(generated).toContain("input: iframeInput,");
      expect(generated).toContain(
        " * ScopedState, run as an iframe guest: the guest's\n",
      );
      expect(generated).not.toContain("new Writable.perUser");
      expect(generated).not.toContain("new Writable.perSession");
    } finally {
      await removeDirectory(directory);
    }
  });

  // Whether a contract default reaches the compiled schema is decided by the
  // schema generator, not by this script's text: the wrapper is a single
  // spelling of `Default<T, typeof DEFAULT_T>` over a const imported from the
  // contract, and the generator's handling of that spelling is pinned in
  // base/schema-generator/test/schema/default-union.test.ts. This test is
  // the end-to-end wiring check — generate, compile with `cf check`, read the
  // defaults back — so a change on either side that stops them arriving is
  // caught here even when the wrapper text still looks right.
  //
  // The compiled output is the JS the CLI emits, so the default is recovered
  // as a balanced-brace object literal after `"default":` inside the named
  // property; the fixture deliberately uses a nested default so a shallow
  // slice cannot pass by accident.
  function compiledDefault(main: string, name: string): string {
    const property = main.indexOf(`${name}: {`);
    expect(property, `${name} property in pattern schema`).not.toBe(-1);
    // The property's own members sit one indent deeper than the property;
    // the next line at the property's indent is where it ends.
    const indent = main.slice(main.lastIndexOf("\n", property) + 1, property);
    const end = main.indexOf(`\n${indent}}`, property);
    const marker = main.indexOf('"default": {', property);
    expect(
      marker !== -1 && end !== -1 && marker < end,
      `${name} default in pattern schema`,
    ).toBe(true);
    let depth = 0;
    for (let i = main.indexOf("{", marker); i < main.length; i++) {
      if (main[i] === "{") depth++;
      if (main[i] === "}" && --depth === 0) {
        return main.slice(marker, i + 1).replace(/\s+/g, " ");
      }
    }
    throw new Error(`unbalanced default literal for ${name}`);
  }

  for (
    const [stateScope, outputScope] of [
      ["space", "space"],
      ["user", "session"],
    ] as const
  ) {
    it(`compiles the contract defaults into the pattern schema (state ${stateScope}, output ${outputScope})`, async () => {
      const directory = await Deno.makeTempDir({
        prefix: "pattern-iframe-defaults-",
      });
      try {
        const contract = resolve(directory, "contract.ts");
        const guest = resolve(directory, "guest.ts");
        const out = resolve(directory, "main.tsx");
        await Deno.writeTextFile(
          contract,
          `
export interface IframeInputData { heading: string; tags: string[] }
export interface IframeStateData { count: number; last: { by: string } | null }
export interface IframeOutputData { count: number }
export const DEFAULT_INPUT: IframeInputData = { heading: "Test", tags: [] };
export const DEFAULT_STATE: IframeStateData = { count: 0, last: { by: "" } };
export const DEFAULT_OUTPUT: IframeOutputData = { count: 0 };
export const IFRAME_PATTERN = {
  name: "Defaulted",
  stateScope: ${JSON.stringify(stateScope)},
  outputScope: ${JSON.stringify(outputScope)},
} as const;
`,
        );
        await Deno.writeTextFile(
          guest,
          "document.body.textContent = 'guest';\n",
        );

        const result = await generate(contract, guest, out);
        expect(result.code, decoder.decode(result.stderr)).toBe(0);

        const check = await cfCheck(out, directory, "--no-run", "--json");
        expect(check.code, decoder.decode(check.stderr)).toBe(0);
        const compiled = JSON.parse(decoder.decode(check.stdout)) as {
          files: { output: string }[];
        };
        const output = compiled.files[0].output;
        const main = output.slice(output.indexOf("exports.default"));
        expect(compiledDefault(main, "input")).toBe(
          '"default": { heading: "Test", tags: [] }',
        );
        // A space-scoped resource is a Writable the wrapper constructs from
        // the contract value; the other scopes declare it as a pattern input
        // whose schema carries the default.
        for (
          const [name, scope, literal] of [
            ["state", stateScope, '"default": { count: 0, last: { by: "" } }'],
            ["output", outputScope, '"default": { count: 0 }'],
          ] as const
        ) {
          if (scope === "space") {
            // The bundler's import aliases carry numerals that move with
            // import order; match the shape, not the digits.
            expect(main).toMatch(
              new RegExp(
                String
                  .raw`new \w+\.Writable\(\w+\.DEFAULT_${name.toUpperCase()}`,
              ),
            );
          } else {
            expect(compiledDefault(main, name)).toBe(literal);
          }
        }
      } finally {
        await removeDirectory(directory);
      }
    });
  }

  it("keeps the guest's text out of the wrapper module", async () => {
    // SES refuses a module whose source holds an import expression or an HTML
    // comment, even inside a string. The wrapper holds none of the guest's
    // text, only the `dataFile()` reads of the files that do, so the host
    // module loads whatever the guest's document and bundle contain.

    await inTemporaryDirectory(
      "pattern-iframe-module-string-",
      async (directory) => {
        const { contract, guest, out, script, html } = await writeFixture(
          directory,
          `{ name: "ModuleString" }`,
        );
        await Deno.writeTextFile(
          guest,
          `document.body.dataset.syntax = "import(";\n`,
        );
        const document =
          "<!doctype html><body><!-- guest --><!-- PATTERN_IFRAME_SCRIPT --></body>";
        await Deno.writeTextFile(html, document);

        const result = await generate(contract, guest, out, "--html", html);
        expect(result.code, decoder.decode(result.stderr)).toBe(0);
        const generated = await Deno.readTextFile(out);
        expect(generated).not.toContain("import(");
        expect(generated).not.toContain("<!--");
        expect(generated).not.toContain("-->");
        expect(generated).toContain(
          'const GUEST_HTML = dataFile("./guest.html");',
        );
        expect(generated).toContain(
          'const GUEST_SCRIPT = dataFile("./guest.js");',
        );
        const bundle = await Deno.readTextFile(script);
        expect(bundle).toContain("import(");
        expect(await Deno.readTextFile(html)).toBe(document);

        const check = await cfCheck(out, directory);
        expect(check.code, decoder.decode(check.stderr)).toBe(0);
      },
    );
  });

  it("replaces a forced output symlink without overwriting its source", async () => {
    // Each file the generator writes is a link to the guest's source here.

    const directory = await Deno.makeTempDir({
      prefix: "pattern-iframe-symlink-",
    });
    try {
      const contract = resolve(directory, "contract.ts");
      const guest = resolve(directory, "guest.ts");
      const out = resolve(directory, "main.tsx");
      const script = resolve(directory, "guest.js");
      const html = resolve(directory, "guest.html");
      const guestSource = 'document.body.textContent = "guest";\n';
      await Deno.writeTextFile(
        contract,
        `${contractPrefix}
export const IFRAME_PATTERN = { name: "SymlinkSafe" } as const;
`,
      );
      await Deno.writeTextFile(guest, guestSource);
      for (const output of [out, script, html]) {
        await Deno.symlink("guest.ts", output);
      }

      const result = await generate(contract, guest, out, "--force");

      expect(result.code, decoder.decode(result.stderr)).toBe(0);
      expect(await Deno.readTextFile(guest)).toBe(guestSource);
      for (const output of [out, script, html]) {
        expect((await Deno.lstat(output)).isSymlink).toBe(false);
      }
      expect(await Deno.readTextFile(out)).toContain(
        "export default pattern<SymlinkSafeInput, SymlinkSafeOutput>",
      );
      expect(await Deno.readTextFile(script)).toContain(
        'document.body.textContent="guest"',
      );
      expect(await Deno.readTextFile(html)).toContain("<!doctype html>");
    } finally {
      await removeDirectory(directory);
    }
  });

  it("writes nothing, even with --force, when --out names a directory", async () => {
    await inTemporaryDirectory(
      "pattern-iframe-out-directory-",
      async (directory) => {
        const fixture = await writeFixture(directory, `{ name: "Blocked" }`);
        await Deno.mkdir(fixture.out);

        const result = await generate(
          fixture.contract,
          fixture.guest,
          fixture.out,
          "--force",
        );

        expect(result.code).not.toBe(0);
        expect(decoder.decode(result.stderr)).toContain(
          `--out names ${fixture.out}, which is a directory.`,
        );
        await expectAbsent(fixture.script, fixture.html);
      },
    );
  });

  it("replaces a forced output hardlink without overwriting its source", async () => {
    // Each file the generator writes is a link to the guest's source here.

    const directory = await Deno.makeTempDir({
      prefix: "pattern-iframe-hardlink-",
    });
    try {
      const contract = resolve(directory, "contract.ts");
      const guest = resolve(directory, "guest.ts");
      const out = resolve(directory, "main.tsx");
      const script = resolve(directory, "guest.js");
      const html = resolve(directory, "guest.html");
      const guestSource = 'document.body.textContent = "guest";\n';
      await Deno.writeTextFile(
        contract,
        `${contractPrefix}
export const IFRAME_PATTERN = { name: "HardlinkSafe" } as const;
`,
      );
      await Deno.writeTextFile(guest, guestSource);
      for (const output of [out, script, html]) {
        await Deno.link(guest, output);
      }

      const result = await generate(contract, guest, out, "--force");

      expect(result.code, decoder.decode(result.stderr)).toBe(0);
      expect(await Deno.readTextFile(guest)).toBe(guestSource);
      expect(await Deno.readTextFile(out)).toContain(
        "export default pattern<HardlinkSafeInput, HardlinkSafeOutput>",
      );
      expect(await Deno.readTextFile(script)).toContain(
        'document.body.textContent="guest"',
      );
      expect(await Deno.readTextFile(html)).toContain("<!doctype html>");
      const guestInode = (await Deno.stat(guest)).ino;
      for (const output of [out, script, html]) {
        expect((await Deno.stat(output)).ino).not.toBe(guestInode);
      }
    } finally {
      await removeDirectory(directory);
    }
  });

  it("keeps public SQLite names separate from generated bindings", async () => {
    const directory = await Deno.makeTempDir({
      prefix: "pattern-iframe-names-",
    });
    try {
      const contract = resolve(directory, "contract.ts");
      const guest = resolve(directory, "guest.ts");
      const out = resolve(directory, "main.tsx");
      await Deno.writeTextFile(
        contract,
        `${contractPrefix}
const columns = {
  ["__proto__"]: "text",
  ["constructor"]: "text",
};
export const IFRAME_PATTERN = {
  name: "SafeNames",
  databases: {
    ["class"]: { tables: { ["__proto__"]: columns } },
    ["table"]: { tables: {} },
    ["app"]: { tables: {} },
    ["appTables"]: { tables: {} },
    ["constructor"]: { tables: {} },
    ["__proto__"]: { tables: {} },
  },
} as const;
`,
      );
      await Deno.writeTextFile(guest, "document.body.textContent = 'guest';\n");

      const result = await generate(contract, guest, out);
      expect(result.code).toBe(0);
      const generated = await Deno.readTextFile(out);
      expect(generated).toContain("const iframeDatabase0Tables = {");
      expect(generated).toContain('["__proto__"]: table({');
      expect(generated).toContain('["__proto__"]: "text"');
      expect(generated).toContain('["class"]: iframeDatabase0');
      expect(generated).toContain('["constructor"]: "sqlite"');
      expect(generated).not.toContain("const class");
      expect(generated).not.toContain("const appTables");

      const format = await runDeno(() => ["fmt", out]);
      expect(format.code, decoder.decode(format.stderr)).toBe(0);
    } finally {
      await removeDirectory(directory);
    }
  });

  it("grants a presence room as a second context name for the cell whose field it follows", async () => {
    const directory = await Deno.makeTempDir({
      prefix: "pattern-iframe-presence-",
    });
    try {
      const contract = resolve(directory, "contract.ts");
      const guest = resolve(directory, "guest.ts");
      const out = resolve(directory, "main.tsx");
      await Deno.writeTextFile(
        contract,
        `${contractPrefix}
export const IFRAME_PATTERN = {
  name: "Cursors",
  outputScope: "user",
  presence: { cursors: "state", ["__proto__"]: "output" },
} as const;
`,
      );
      await Deno.writeTextFile(guest, "document.body.textContent = 'guest';\n");

      const result = await generate(contract, guest, out);
      expect(result.code, decoder.decode(result.stderr)).toBe(0);
      const generated = await Deno.readTextFile(out);
      expect(generated).toContain(
        '"cursors": Writable<Default<IframeStateData, typeof DEFAULT_STATE>>;',
      );
      expect(generated).toContain('["cursors"]: state,');
      expect(generated).toContain('["cursors"]: "presence",');
      expect(generated).toContain(
        '"__proto__": Writable<Default<IframeOutputData, typeof DEFAULT_OUTPUT>>;',
      );
      expect(generated).toContain('["__proto__"]: output,');
      expect(generated).toContain('["__proto__"]: "presence",');

      // The wrapper is only as good as its compile: the context names one
      // cell twice, and the kind `presence` has to be one `cf-iframe` takes.
      const check = await cfCheck(out, directory, "--no-run");
      expect(check.code, decoder.decode(check.stderr)).toBe(0);
    } finally {
      await removeDirectory(directory);
    }
  });

  for (
    const [presence, message] of [
      [
        `{ state: "state" }`,
        `Presence room name "state" must be non-empty and distinct from input, state, output, and every database.`,
      ],
      [
        `{ app: "state" }`,
        `Presence room name "app" must be non-empty and distinct from input, state, output, and every database.`,
      ],
      [
        `{ cursors: "input" }`,
        `Presence room "cursors" must name "state" or "output", the resource whose field it follows.`,
      ],
    ]
  ) {
    it(`writes no wrapper for the presence rooms ${presence}`, async () => {
      const directory = await Deno.makeTempDir({
        prefix: "pattern-iframe-presence-refused-",
      });
      try {
        const contract = resolve(directory, "contract.ts");
        const guest = resolve(directory, "guest.ts");
        const out = resolve(directory, "main.tsx");
        await Deno.writeTextFile(
          contract,
          `${contractPrefix}
export const IFRAME_PATTERN = {
  name: "Cursors",
  databases: { app: { tables: {} } },
  presence: ${presence},
} as const;
`,
        );
        await Deno.writeTextFile(
          guest,
          "document.body.textContent = 'guest';\n",
        );

        const result = await generate(contract, guest, out);
        expect(result.code).not.toBe(0);
        expect(decoder.decode(result.stderr)).toContain(message);
        await expect(Deno.lstat(out)).rejects.toBeInstanceOf(
          Deno.errors.NotFound,
        );
      } finally {
        await removeDirectory(directory);
      }
    });
  }

  it("takes each stream as a pattern input and grants it to the guest", async () => {
    const directory = await Deno.makeTempDir({
      prefix: "pattern-iframe-streams-",
    });
    try {
      const contract = resolve(directory, "contract.ts");
      const guest = resolve(directory, "guest.ts");
      const out = resolve(directory, "main.tsx");
      // `context` is also the name of a local in the wrapper's body, which a
      // stream bound under its own name would collide with.
      await Deno.writeTextFile(
        contract,
        `${contractPrefix}
export interface IframeStreamEvents {
  addItem: { text: string };
  context: { reason: string };
}
export const IFRAME_PATTERN = {
  name: "Verbs",
  streams: ["addItem", "context"],
} as const;
`,
      );
      await Deno.writeTextFile(guest, "document.body.textContent = 'guest';\n");

      const result = await generate(contract, guest, out);
      expect(result.code, decoder.decode(result.stderr)).toBe(0);
      const generated = await Deno.readTextFile(out);
      expect(generated).toContain("  type IframeStreamEvents,\n");
      expect(generated).toContain(
        '  addItem: Stream<IframeStreamEvents["addItem"], unknown>;\n',
      );
      expect(generated).toContain(
        '  "addItem": Stream<IframeStreamEvents["addItem"], unknown>;\n',
      );
      expect(generated).toContain("  addItem: iframeStream0,\n");
      expect(generated).toContain("  context: iframeStream1,\n");
      expect(generated).toContain('["addItem"]: iframeStream0,');
      expect(generated).toContain('["context"]: iframeStream1,');
      expect(generated).toContain('["addItem"]: "stream",');
      expect(generated).toContain('["context"]: "stream",');

      // The kind `stream` has to be one `cf-iframe` takes, the stream inputs
      // have to pass through the context pattern as streams, and a verb that
      // declares a result has to be one the frame takes.
      const parent = resolve(directory, "parent.tsx");
      await Deno.writeTextFile(
        parent,
        `import { action, pattern } from "commonfabric";
import Frame from "./main.tsx";

export default pattern(() => {
  const addItem = action<{ text: string }, { added: boolean }>(() => ({
    added: true,
  }));
  const context = action<{ reason: string }>(() => {});
  return Frame({ addItem, context });
});
`,
      );
      const check = await cfCheck(parent, directory, "--no-run");
      expect(check.code, decoder.decode(check.stderr)).toBe(0);
    } finally {
      await removeDirectory(directory);
    }
  });

  it("imports no stream types for a contract that declares no streams", async () => {
    const directory = await Deno.makeTempDir({
      prefix: "pattern-iframe-no-streams-",
    });
    try {
      const contract = resolve(directory, "contract.ts");
      const guest = resolve(directory, "guest.ts");
      const out = resolve(directory, "main.tsx");
      await Deno.writeTextFile(
        contract,
        `${contractPrefix}
export const IFRAME_PATTERN = { name: "NoVerbs" } as const;
`,
      );
      await Deno.writeTextFile(guest, "document.body.textContent = 'guest';\n");

      const result = await generate(contract, guest, out);
      expect(result.code, decoder.decode(result.stderr)).toBe(0);
      const generated = await Deno.readTextFile(out);
      expect(generated).not.toContain("Stream");
    } finally {
      await removeDirectory(directory);
    }
  });

  for (
    const [streams, message] of [
      [
        `"addItem"`,
        "IFRAME_PATTERN.streams must be an array of names.",
      ],
      [
        "null",
        "IFRAME_PATTERN.streams must be an array of names.",
      ],
      [
        `["add-item"]`,
        `Stream name "add-item" must be a TypeScript identifier such as addItem.`,
      ],
      [
        `["__proto__"]`,
        `Stream name "__proto__" must be a TypeScript identifier such as addItem.`,
      ],
      [
        `["state"]`,
        `Stream name "state" must be distinct from input, state, output, every database, every presence room, and every other stream.`,
      ],
      [
        `["app"]`,
        `Stream name "app" must be distinct from input, state, output, every database, every presence room, and every other stream.`,
      ],
      [
        `["cursors"]`,
        `Stream name "cursors" must be distinct from input, state, output, every database, every presence room, and every other stream.`,
      ],
      [
        `["addItem", "addItem"]`,
        `Stream name "addItem" must be distinct from input, state, output, every database, every presence room, and every other stream.`,
      ],
    ]
  ) {
    it(`writes no wrapper for the streams ${streams}`, async () => {
      const directory = await Deno.makeTempDir({
        prefix: "pattern-iframe-streams-refused-",
      });
      try {
        const contract = resolve(directory, "contract.ts");
        const guest = resolve(directory, "guest.ts");
        const out = resolve(directory, "main.tsx");
        await Deno.writeTextFile(
          contract,
          `${contractPrefix}
export const IFRAME_PATTERN = {
  name: "Verbs",
  databases: { app: { tables: {} } },
  presence: { cursors: "state" },
  streams: ${streams},
} as const;
`,
        );
        await Deno.writeTextFile(
          guest,
          "document.body.textContent = 'guest';\n",
        );

        const result = await generate(contract, guest, out);
        expect(result.code).not.toBe(0);
        expect(decoder.decode(result.stderr)).toContain(message);
        await expect(Deno.lstat(out)).rejects.toBeInstanceOf(
          Deno.errors.NotFound,
        );
      } finally {
        await removeDirectory(directory);
      }
    });
  }

  it("writes the guest's bundle to guest.js beside the wrapper", async () => {
    await inTemporaryDirectory("pattern-iframe-bundle-", async (directory) => {
      const { contract, guest, out, script } = await writeFixture(
        directory,
        `{ name: "Bundled" }`,
        "pattern/main.tsx",
      );
      await Deno.writeTextFile(
        guest,
        'document.body.dataset.probe = "bundle-probe";\n',
      );

      const result = await generate(contract, guest, out);

      expect(result.code, decoder.decode(result.stderr)).toBe(0);
      expect(await Deno.readTextFile(script)).toContain("bundle-probe");
      await expectAbsent(resolve(directory, "guest.js"));
      const generated = await Deno.readTextFile(out);
      expect(generated).not.toContain("bundle-probe");
      expect(generated).toContain('} from "../contract.ts";');
      expect(generated).toContain(
        'const GUEST_SCRIPT = dataFile("./guest.js");',
      );
      expect(generated).toContain("script={GUEST_SCRIPT}");
    });
  });

  it("writes a default document to guest.html beside the wrapper", async () => {
    await inTemporaryDirectory(
      "pattern-iframe-document-",
      async (directory) => {
        const { contract, guest, out, html } = await writeFixture(
          directory,
          `{ name: "Documented", displayName: "Notes <&> more" }`,
          "pattern/main.tsx",
        );

        const result = await generate(contract, guest, out);

        expect(result.code, decoder.decode(result.stderr)).toBe(0);
        const document = await Deno.readTextFile(html);
        expect(document).toContain("<title>Notes &lt;&amp;&gt; more</title>");
        expect(document).toContain('<div id="root"></div>');
        expect(document).not.toContain("<script");
        await expectAbsent(resolve(directory, "guest.html"));
        const generated = await Deno.readTextFile(out);
        expect(generated).toContain(
          'const GUEST_HTML = dataFile("./guest.html");',
        );
        expect(generated).toContain("src={GUEST_HTML}");
      },
    );
  });

  for (
    const [existing, message] of [
      ["guest.js", "already exists; pass --force to regenerate it."],
      [
        "guest.html",
        "already exists; pass --force to regenerate it, or --html to read it as the guest's document.",
      ],
    ]
  ) {
    it(`replaces an existing ${existing} beside the wrapper only when forced`, async () => {
      await inTemporaryDirectory(
        "pattern-iframe-existing-",
        async (directory) => {
          const fixture = await writeFixture(directory, `{ name: "Existing" }`);
          const authored = resolve(directory, existing);
          await Deno.writeTextFile(authored, "authored\n");

          const refused = await generate(
            fixture.contract,
            fixture.guest,
            fixture.out,
          );

          expect(refused.code).not.toBe(0);
          expect(decoder.decode(refused.stderr)).toContain(
            `${authored} ${message}`,
          );
          expect(await Deno.readTextFile(authored)).toBe("authored\n");
          await expectAbsent(
            fixture.out,
            ...[fixture.script, fixture.html].filter((path) =>
              path !== authored
            ),
          );

          const forced = await generate(
            fixture.contract,
            fixture.guest,
            fixture.out,
            "--force",
          );

          expect(forced.code, decoder.decode(forced.stderr)).toBe(0);
          expect(await Deno.readTextFile(authored)).not.toBe("authored\n");
        },
      );
    });
  }

  it("reads the document --html names in place", async () => {
    await inTemporaryDirectory("pattern-iframe-html-", async (directory) => {
      const { contract, guest, out, html } = await writeFixture(
        directory,
        `{ name: "OwnDocument" }`,
      );
      await Deno.mkdir(resolve(directory, "pages"));
      const own = resolve(directory, "pages", "page.html");
      const document =
        '<!doctype html><title>Own</title><div id="app"></div>\n';
      await Deno.writeTextFile(own, document);

      const result = await generate(contract, guest, out, "--html", own);

      expect(result.code, decoder.decode(result.stderr)).toBe(0);
      expect(await Deno.readTextFile(own)).toBe(document);
      await expectAbsent(html);
      expect(await Deno.readTextFile(out)).toContain(
        'const GUEST_HTML = dataFile("./pages/page.html");',
      );

      // Running the wrapper reads the document by the path it names.
      const check = await cfCheck(out, directory);
      expect(check.code, decoder.decode(check.stderr)).toBe(0);
    });
  });

  for (
    const { description, guest, out, args, message } of [
      {
        description: "an --html that names no file",
        guest: "guest.ts",
        out: "main.tsx",
        args: (directory: string) => [
          "--html",
          resolve(directory, "missing.html"),
        ],
        message: "missing.html, which is not a file.",
      },
      {
        description: "a guest source named guest.js beside --out",
        guest: "guest.js",
        out: "main.tsx",
        args: () => [],
        message: "guest.js beside --out must not replace a source file.",
      },
      {
        description: "an --out named guest.js",
        guest: "guest.ts",
        out: "guest.js",
        args: () => [],
        message:
          "--out must not be guest.js, which the generator writes beside it.",
      },
      {
        description: "an --out named guest.html and no --html",
        guest: "guest.ts",
        out: "guest.html",
        args: () => [],
        message:
          "--out must not be guest.html, which the generator writes beside it.",
      },
    ]
  ) {
    it(`writes nothing for ${description}`, async () => {
      await inTemporaryDirectory(
        "pattern-iframe-outputs-refused-",
        async (directory) => {
          const fixture = await writeFixture(directory, `{ name: "Refused" }`);
          const guestPath = resolve(directory, guest);
          if (guestPath !== fixture.guest) {
            await Deno.rename(fixture.guest, guestPath);
          }
          const outPath = resolve(directory, out);

          const result = await generate(
            fixture.contract,
            guestPath,
            outPath,
            ...args(directory),
          );

          expect(result.code).not.toBe(0);
          expect(decoder.decode(result.stderr)).toContain(message);
          await expectAbsent(
            ...[outPath, fixture.script, fixture.html].filter((path) =>
              path !== guestPath
            ),
          );
        },
      );
    });
  }

  describe("assets", () => {
    it("passes no `assets` for a contract that declares none", async () => {
      await inTemporaryDirectory(
        "pattern-iframe-no-assets-",
        async (directory) => {
          const { contract, guest, out } = await writeFixture(
            directory,
            `{ name: "Plain" }`,
          );

          const result = await generate(contract, guest, out);

          expect(result.code, decoder.decode(result.stderr)).toBe(0);
          const generated = await Deno.readTextFile(out);
          expect(generated).not.toContain("GUEST_ASSETS");
          expect(generated).not.toContain("assets=");
        },
      );
    });

    it("passes a directory as `dataFile.urls()` of its path from the wrapper", async () => {
      await inTemporaryDirectory(
        "pattern-iframe-asset-directory-",
        async (directory) => {
          await Deno.mkdir(resolve(directory, "assets"));
          await Deno.writeFile(
            resolve(directory, "assets/glaze.png"),
            new Uint8Array([0x89, 0x50, 0x4e, 0x47]),
          );
          const { contract, guest, out } = await writeFixture(
            directory,
            `{ name: "Sprites", assets: "./assets" }`,
            "pattern/main.tsx",
          );

          const result = await generate(contract, guest, out);

          expect(result.code, decoder.decode(result.stderr)).toBe(0);
          const generated = await Deno.readTextFile(out);
          expect(generated).toContain(
            'const GUEST_ASSETS = dataFile.urls("../assets");',
          );
          expect(generated).toContain("          assets={GUEST_ASSETS}\n");
          // Evaluating the wrapper lists the directory and reads each asset.
          const check = await cfCheck(out, directory, "--pattern-json");
          expect(check.code, decoder.decode(check.stderr)).toBe(0);
          expect(decoder.decode(check.stdout)).toContain(
            '"glaze": "data:image/png;base64,iVBORw=="',
          );
        },
      );
    });

    it("passes each named file as `dataFile.url()` of its path from the wrapper", async () => {
      await inTemporaryDirectory(
        "pattern-iframe-asset-files-",
        async (directory) => {
          for (const file of ["images/glaze.png", "fonts/menu.woff2"]) {
            await Deno.mkdir(resolve(directory, dirname(file)), {
              recursive: true,
            });
            await Deno.writeFile(resolve(directory, file), new Uint8Array([0]));
          }
          const { contract, guest, out } = await writeFixture(
            directory,
            `{
  name: "Glazed",
  assets: {
    glaze: "./images/glaze.png",
    ["menu-font"]: "fonts/menu.woff2",
  },
}`,
            "pattern/main.tsx",
          );

          const result = await generate(contract, guest, out);

          expect(result.code, decoder.decode(result.stderr)).toBe(0);
          const generated = await Deno.readTextFile(out);
          expect(generated).toContain(`const GUEST_ASSETS = {
  ["glaze"]: dataFile.url("../images/glaze.png"),
  ["menu-font"]: dataFile.url("../fonts/menu.woff2"),
};
`);
          expect(generated).toContain("          assets={GUEST_ASSETS}\n");
          const check = await cfCheck(out, directory);
          expect(check.code, decoder.decode(check.stderr)).toBe(0);
        },
      );
    });

    const notAPathOrRecord =
      "IFRAME_PATTERN.assets must be a directory path or a record from an asset name to a file path.";
    for (
      const [assets, message] of [
        ["42", notAPathOrRecord],
        [`""`, notAPathOrRecord],
        [`["./glaze.png"]`, notAPathOrRecord],
        [
          `{ "glaze.small": "./glaze.png" }`,
          `Asset name "glaze.small" must be made of letters, digits, "_", and "-", such as glaze.`,
        ],
        [
          `{ "": "./glaze.png" }`,
          `Asset name "" must be made of letters, digits, "_", and "-", such as glaze.`,
        ],
        [`{ glaze: "" }`, `Asset "glaze" must have a file path string.`],
        [`{ glaze: 1 }`, `Asset "glaze" must have a file path string.`],
        [
          `{ notes: "./notes.txt" }`,
          `Asset "notes" must name an image, font, or sound file that dataFile.url() reads, such as a .png, .woff2, or .mp3; found "./notes.txt".`,
        ],
        [
          `{ constructor: "./glaze.png" }`,
          `Asset name "constructor" is reserved: setup refuses "__proto__" and "constructor" as keys of the record it stores.`,
        ],
        [`"./missing"`, "missing, which is not a directory."],
        [`"./glaze.png"`, "glaze.png, which is not a directory."],
        [`{ glaze: "./missing.png" }`, "missing.png, which is not a file."],
        [
          `"./dotted"`,
          "has no asset name: `glaze.small` holds characters other than letters, digits, `_`, and `-`.",
        ],
        [
          `"./reserved"`,
          `Asset name "constructor" is reserved: setup refuses "__proto__" and "constructor" as keys of the record it stores.`,
        ],
      ]
    ) {
      it(`writes nothing for the assets ${assets}`, async () => {
        await inTemporaryDirectory(
          "pattern-iframe-assets-refused-",
          async (directory) => {
            await Deno.writeFile(
              resolve(directory, "glaze.png"),
              new Uint8Array([0]),
            );
            await Deno.writeTextFile(resolve(directory, "notes.txt"), "notes");
            for (
              const [folder, file] of [
                ["dotted", "glaze.small.png"],
                ["reserved", "constructor.png"],
              ]
            ) {
              await Deno.mkdir(resolve(directory, folder));
              await Deno.writeFile(
                resolve(directory, folder, file),
                new Uint8Array([0]),
              );
            }
            const fixture = await writeFixture(
              directory,
              `{ name: "Refused", assets: ${assets} }`,
            );

            const result = await generate(
              fixture.contract,
              fixture.guest,
              fixture.out,
            );

            expect(result.code).not.toBe(0);
            expect(decoder.decode(result.stderr)).toContain(message);
            await expectAbsent(fixture.out, fixture.script, fixture.html);
          },
        );
      });
    }
  });

  it("bundles D3, Phaser, and Babylon.js guests", async () => {
    const frameworks = [
      {
        name: "D3Guest",
        marker: "d3-guide-probe",
        source: `import { select } from "npm:d3@7.9.0";
select(document.body).append("svg").attr("data-framework", "d3-guide-probe");
`,
      },
      {
        name: "PhaserGuest",
        marker: "phaser-guide-probe",
        source: `import Phaser from "npm:phaser@4.2.1";
new Phaser.Game({
  type: Phaser.CANVAS,
  width: 320,
  height: 180,
  scene: { create() { this.add.text(16, 16, "phaser-guide-probe"); } },
});
`,
      },
      {
        name: "BabylonGuest",
        marker: "babylon-guide-probe",
        source:
          `import { Engine } from "npm:@babylonjs/core@9.23.0/Engines/engine.js";
import { CreateBox } from "npm:@babylonjs/core@9.23.0/Meshes/Builders/boxBuilder.js";
import { Scene } from "npm:@babylonjs/core@9.23.0/scene.js";
const canvas = document.createElement("canvas");
canvas.dataset.framework = "babylon-guide-probe";
document.body.append(canvas);
const engine = new Engine(canvas);
const scene = new Scene(engine);
CreateBox("box", {}, scene);
engine.runRenderLoop(() => scene.render());
`,
      },
    ] as const;

    for (const framework of frameworks) {
      const directory = await Deno.makeTempDir({
        prefix: `pattern-iframe-${framework.name.toLowerCase()}-`,
      });
      try {
        const contract = resolve(directory, "contract.ts");
        const guest = resolve(directory, "guest.ts");
        const out = resolve(directory, "main.tsx");
        await Deno.writeTextFile(
          contract,
          `${contractPrefix}
export const IFRAME_PATTERN = { name: "${framework.name}" } as const;
`,
        );
        await Deno.writeTextFile(guest, framework.source);

        const result = await generate(contract, guest, out);

        expect(result.code, decoder.decode(result.stderr)).toBe(0);
        const bundle = await Deno.readTextFile(resolve(directory, "guest.js"));
        expect(bundle).toContain(framework.marker);
        const generated = await Deno.readTextFile(out);
        expect(generated).not.toContain(framework.marker);
        expect(generated).toContain(
          'const GUEST_SCRIPT = dataFile("./guest.js");',
        );
        const guestHtml = await Deno.readTextFile(
          resolve(directory, "guest.html"),
        );
        expect(guestHtml).not.toContain(framework.marker);
      } finally {
        await removeDirectory(directory);
      }
    }
  });
});
