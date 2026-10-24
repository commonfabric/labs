import { expect } from "@std/expect";
import { resolve } from "@std/path";
import { describe, it } from "@std/testing/bdd";
import { runDenoCommandWithTemporaryLock } from "@commonfabric/test-support/isolated-deno";

const ROOT = resolve(import.meta.dirname!, "..");
const SCRIPT = resolve(import.meta.dirname!, "write-iframe-wrapper.ts");
const decoder = new TextDecoder();

function generatedGuestHtml(source: string): string {
  const literal = source.match(/^const GUEST_HTML = (.*);$/m)?.[1];
  expect(literal).toBeDefined();
  return JSON.parse(literal!);
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

const contractPrefix = `
export interface IframeInputData { heading: string }
export interface IframeStateData { count: number }
export interface IframeOutputData { count: number }
export const DEFAULT_INPUT: IframeInputData = { heading: "Test" };
export const DEFAULT_STATE: IframeStateData = { count: 0 };
export const DEFAULT_OUTPUT: IframeOutputData = { count: 0 };
`;

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
      const generated = await Deno.readTextFile(out);
      expect(generated).toContain("react.production.js");
      expect(generated).not.toContain("@commonfabric/runner/jsx-runtime");
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
  // packages/schema-generator/test/schema/default-union.test.ts. This test is
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

        const check = await runDeno((lockPath) => [
          "run",
          "--allow-all",
          "--frozen=true",
          "--lock",
          lockPath,
          resolve(ROOT, "packages/cli/launcher.ts"),
          "check",
          out,
          "--root",
          directory,
          "--no-run",
          "--json",
        ]);
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

  it("hides embedded guest tokens from the host module scanner", async () => {
    const directory = await Deno.makeTempDir({
      prefix: "pattern-iframe-module-string-",
    });
    try {
      const contract = resolve(directory, "contract.ts");
      const guest = resolve(directory, "guest.ts");
      const html = resolve(directory, "guest.html");
      const out = resolve(directory, "main.tsx");
      await Deno.writeTextFile(
        contract,
        `${contractPrefix}
export const IFRAME_PATTERN = { name: "ModuleString" } as const;
`,
      );
      await Deno.writeTextFile(
        guest,
        `document.body.dataset.syntax = "import(";\n` +
          `document.body.dataset.replacement = "$& $\` $'";\n`,
      );
      await Deno.writeTextFile(
        html,
        "<!doctype html><body><!-- guest --><!-- PATTERN_IFRAME_SCRIPT --></body>",
      );

      const result = await generate(contract, guest, out, "--html", html);
      expect(result.code, decoder.decode(result.stderr)).toBe(0);
      const generated = await Deno.readTextFile(out);
      const moduleString = generated.match(/^const GUEST_HTML = (.*);$/m)?.[1];
      expect(moduleString).toBeDefined();
      expect(moduleString).not.toContain("import");
      expect(moduleString).not.toContain("<!--");
      expect(moduleString).not.toContain("-->");
      expect(moduleString).toContain("\\u0069mport");
      expect(moduleString).toContain("\\u003c!--");
      expect(moduleString).toContain("--\\u003e");
      expect(generatedGuestHtml(generated).match(/<!doctype html>/gi))
        .toHaveLength(1);
    } finally {
      await removeDirectory(directory);
    }
  });

  it("replaces a forced output symlink without overwriting its source", async () => {
    const directory = await Deno.makeTempDir({
      prefix: "pattern-iframe-symlink-",
    });
    try {
      const contract = resolve(directory, "contract.ts");
      const guest = resolve(directory, "guest.ts");
      const out = resolve(directory, "main.tsx");
      const guestSource = 'document.body.textContent = "guest";\n';
      await Deno.writeTextFile(
        contract,
        `${contractPrefix}
export const IFRAME_PATTERN = { name: "SymlinkSafe" } as const;
`,
      );
      await Deno.writeTextFile(guest, guestSource);
      await Deno.symlink("guest.ts", out);

      const result = await generate(contract, guest, out, "--force");

      expect(result.code).toBe(0);
      expect(await Deno.readTextFile(guest)).toBe(guestSource);
      expect((await Deno.lstat(out)).isSymlink).toBe(false);
      expect(await Deno.readTextFile(out)).toContain(
        "export default pattern<SymlinkSafeInput, SymlinkSafeOutput>",
      );
    } finally {
      await removeDirectory(directory);
    }
  });

  it("replaces a forced output hardlink without overwriting its source", async () => {
    const directory = await Deno.makeTempDir({
      prefix: "pattern-iframe-hardlink-",
    });
    try {
      const contract = resolve(directory, "contract.ts");
      const guest = resolve(directory, "guest.ts");
      const out = resolve(directory, "main.tsx");
      const guestSource = 'document.body.textContent = "guest";\n';
      await Deno.writeTextFile(
        contract,
        `${contractPrefix}
export const IFRAME_PATTERN = { name: "HardlinkSafe" } as const;
`,
      );
      await Deno.writeTextFile(guest, guestSource);
      await Deno.link(guest, out);

      const result = await generate(contract, guest, out, "--force");

      expect(result.code).toBe(0);
      expect(await Deno.readTextFile(guest)).toBe(guestSource);
      expect(await Deno.readTextFile(out)).toContain(
        "export default pattern<HardlinkSafeInput, HardlinkSafeOutput>",
      );
      expect((await Deno.stat(guest)).ino).not.toBe((await Deno.stat(out)).ino);
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
      const check = await runDeno((lockPath) => [
        "run",
        "--allow-all",
        "--frozen=true",
        "--lock",
        lockPath,
        resolve(ROOT, "packages/cli/launcher.ts"),
        "check",
        out,
        "--root",
        directory,
        "--no-run",
      ]);
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
      const check = await runDeno((lockPath) => [
        "run",
        "--allow-all",
        "--frozen=true",
        "--lock",
        lockPath,
        resolve(ROOT, "packages/cli/launcher.ts"),
        "check",
        parent,
        "--root",
        directory,
        "--no-run",
      ]);
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
        const generated = await Deno.readTextFile(out);
        expect(generated).toContain(framework.marker);
        expect(generated).toContain("const GUEST_HTML =");
        const guestHtml = generatedGuestHtml(generated);
        expect(guestHtml.match(/<!doctype html>/gi)).toHaveLength(1);
      } finally {
        await removeDirectory(directory);
      }
    }
  });
});
