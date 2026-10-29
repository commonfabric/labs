/**
 * End-to-end coverage of the `cf view` command and its non-interactive entry
 * (mod.ts). Each case runs the real CLI as a subprocess: with stdout piped the
 * viewer prints the colorized text and exits, like `less` when redirected, so
 * these exercise the command wiring, argument handling, input reading and the
 * print path without a terminal.
 */

import { assert, assertEquals } from "@std/assert";
import { expect } from "@std/expect";
import { join } from "@std/path";
import { describe, it } from "@std/testing/bdd";

import { runDenoCommandWithTemporaryLock } from "@commonfabric/test-support/isolated-deno";

import { MAX_BINARY_VIEW_BYTES } from "../lib/view/languages/binary/binary.ts";
import { argv, cf } from "./utils.ts";

const SRC = "export const x = pattern(() => ({ value: 1 }));\nconst y = x;\n";
const CLI_PACKAGE_DIR = join(import.meta.dirname!, "..");
const REPO_ROOT = join(CLI_PACKAGE_DIR, "..", "..");
const DIFF = `diff --git a/m.ts b/m.ts
index 0000000..1111111 100644
--- a/m.ts
+++ b/m.ts
@@ -1,2 +1,2 @@
-const old = 1;
+const next = 2;
 const ctx = next;
`;

function runViewForBytes(args: string[]): Promise<Deno.CommandOutput> {
  return runDenoCommandWithTemporaryLock({
    root: REPO_ROOT,
    cwd: CLI_PACKAGE_DIR,
    args: (lockPath) => [
      "run",
      `--lock=${lockPath}`,
      "--frozen=true",
      "--allow-net",
      "--allow-ffi",
      "--allow-read",
      "--allow-write",
      "--allow-env",
      "--allow-run",
      "./mod.ts",
      ...args,
    ],
  });
}

Deno.test("cf view --plain prints colorized source and exits 0", async () => {
  const { code, stdout } = await cf(argv`view --plain`, { stdin: SRC });
  assertEquals(code, 0);
  assert(stdout.join("\n").includes("pattern"), stdout.join("\n"));
});

Deno.test("cf view --plain --color never prints without escapes", async () => {
  const { code, stdout } = await cf(argv`view --plain --color never`, {
    stdin: SRC,
  });
  assertEquals(code, 0);
  assert(!stdout.join("\n").includes("\x1b["), "no ANSI escapes");
});

Deno.test("cf view --plain --color always emits escapes", async () => {
  const { code, stdout } = await cf(argv`view --plain --color always`, {
    stdin: SRC,
  });
  assertEquals(code, 0);
  assert(stdout.join("\n").includes("\x1b["), "has ANSI escapes");
});

Deno.test("cf view --plain --line-numbers exits 0", async () => {
  const { code } = await cf(argv`view --plain --line-numbers`, { stdin: SRC });
  assertEquals(code, 0);
});

Deno.test("cf view --plain --line-numbers prefixes lines with numbers", async () => {
  const { code, stdout } = await cf(
    argv`view --plain --line-numbers --color never`,
    { stdin: SRC },
  );
  assertEquals(code, 0);
  // The two source lines are printed with a right-aligned line-number gutter.
  assert(
    stdout.some((line) => /^\s*1 export const x = pattern/.test(line)),
    stdout.join("\n"),
  );
  assert(
    stdout.some((line) => /^\s*2 const y = x;/.test(line)),
    stdout.join("\n"),
  );
});

describe("cf view byte-preserving output", () => {
  it("preserves a UTF-8 BOM when formatting redirected text", async () => {
    const dir = Deno.makeTempDirSync();
    try {
      const path = join(dir, "value.txt");
      const bom = new Uint8Array([0xef, 0xbb, 0xbf]);
      Deno.writeFileSync(
        path,
        new Uint8Array([...bom, ...new TextEncoder().encode("value\n")]),
      );
      const result = await runViewForBytes([
        "view",
        "--plain",
        "--line-numbers",
        "--color",
        "never",
        path,
      ]);

      expect(result.code, new TextDecoder().decode(result.stderr)).toBe(0);
      expect(result.stdout).toEqual(
        new Uint8Array([
          ...bom,
          ...new TextEncoder().encode("  1 value\n  2 "),
        ]),
      );
    } finally {
      Deno.removeSync(dir, { recursive: true });
    }
  });
});

Deno.test("cf view --plain without --line-numbers has no number gutter", async () => {
  const { code, stdout } = await cf(argv`view --plain --color never`, {
    stdin: SRC,
  });
  assertEquals(code, 0);
  assert(
    stdout.some((line) => /^export const x = pattern/.test(line)),
    stdout.join("\n"),
  );
});

Deno.test("cf view --plain --diff renders a forced diff", async () => {
  const { code, stdout } = await cf(argv`view --plain --diff`, { stdin: DIFF });
  assertEquals(code, 0);
  assert(stdout.join("\n").includes("next"), stdout.join("\n"));
});

Deno.test("cf view --plain auto-detects a diff", async () => {
  const { code, stdout } = await cf(argv`view --plain`, { stdin: DIFF });
  assertEquals(code, 0);
  assert(stdout.join("\n").includes("next"));
});

Deno.test("cf view --plain --no-diff is accepted and views a diff as source", async () => {
  const { code } = await cf(argv`view --plain --no-diff`, { stdin: DIFF });
  assertEquals(code, 0);
});

Deno.test("cf view --filename selects piped source by its virtual name", async () => {
  const source = "# Title with **weight**\n";
  const { code, stdout } = await cf(
    argv`view --plain --rendered --color never --filename notes.md`,
    { stdin: source },
  );
  assertEquals(code, 0);
  assertEquals(stdout, ["Title with weight"]);
});

Deno.test("cf view --language aliases override a piped virtual filename", async () => {
  const source = "# Title with **weight**\n";
  const { code, stdout } = await cf(
    argv`view --plain --rendered --color never --language md --filename notes.txt`,
    { stdin: source },
  );
  assertEquals(code, 0);
  assertEquals(stdout, ["Title with weight"]);
});

describe("cf view binary input", () => {
  it("renders piped bytes as a hex dump for `--language binary`", async () => {
    const { code, stdout } = await cf(
      argv`view --plain --color never --language binary`,
      { stdin: new Uint8Array([0x41, 0x00, 0xff]) },
    );

    expect(code).toBe(0);
    expect(stdout.length).toBe(2);
    expect(stdout[0].startsWith("00000000  41 00 ff")).toBe(true);
    expect(stdout[0].endsWith("|A␀␦|")).toBe(true);
    expect(stdout[1]).toBe("00000003");
  });

  it("detects binary content and binary virtual filenames", async () => {
    for (
      const [command, input] of [
        [argv`view --plain --color never`, new Uint8Array([0xff])],
        [
          argv`view --plain --color never --filename asset.png`,
          new TextEncoder().encode("PNG"),
        ],
      ] as const
    ) {
      const { code, stdout } = await cf(command, { stdin: input });
      expect(code).toBe(0);
      expect(stdout[0].startsWith("00000000")).toBe(true);
    }
  });

  it("streams a complete large binary file in plain mode", async () => {
    const dir = Deno.makeTempDirSync();
    try {
      const file = `${dir}/large.png`;
      Deno.writeFileSync(
        file,
        new Uint8Array(MAX_BINARY_VIEW_BYTES + 16).fill(0x41),
      );
      const { code, stdout } = await cf(
        argv`view --plain --color never ${file}`,
      );

      expect(code).toBe(0);
      expect(stdout.length).toBe(MAX_BINARY_VIEW_BYTES / 16 + 2);
      expect(stdout.at(-1)).toBe("00040010");
      expect(stdout.some((line) => line.includes("omitted"))).toBe(false);
    } finally {
      Deno.removeSync(dir, { recursive: true });
    }
  });

  it("detects and streams a large unknown binary file in plain mode", async () => {
    const dir = Deno.makeTempDirSync();
    try {
      const file = `${dir}/large.data`;
      const bytes = new Uint8Array(MAX_BINARY_VIEW_BYTES + 16).fill(0x41);
      bytes[0] = 0xff;
      Deno.writeFileSync(file, bytes);
      const { code, stdout } = await cf(
        argv`view --plain --color never ${file}`,
      );

      expect(code).toBe(0);
      expect(stdout.length).toBe(MAX_BINARY_VIEW_BYTES / 16 + 2);
      expect(stdout[0].startsWith("00000000  ff 41")).toBe(true);
      expect(stdout.at(-1)).toBe("00040010");
      expect(stdout.some((line) => line.includes("omitted"))).toBe(false);
    } finally {
      Deno.removeSync(dir, { recursive: true });
    }
  });

  it("lets explicit text decoding override a binary virtual filename", async () => {
    const { code, stdout } = await cf(
      argv`view --plain --color never --language plain-text --filename asset.png`,
      { stdin: "PNG\n" },
    );

    expect(code).toBe(0);
    expect(stdout).toEqual(["PNG"]);
  });

  it("reports bytes that the selected text decoder rejects", async () => {
    const { code, stderr } = await cf(
      argv`view --plain --language plain-text`,
      { stdin: new Uint8Array([0xff]) },
    );

    expect(code).toBe(1);
    expect(stderr.join("\n")).toContain("cannot be decoded as utf-8");
  });
});

Deno.test("cf view rejects an unknown --language", async () => {
  const { code, stderr } = await cf(argv`view --plain --language ruby`, {
    stdin: SRC,
  });
  assertEquals(code, 1);
  assert(
    stderr.join("\n").includes('unknown language "ruby"'),
    stderr.join("\n"),
  );
  assert(stderr.join("\n").includes("python"), stderr.join("\n"));
});

Deno.test("cf view rejects source selection combined with forced diff mode", async () => {
  for (
    const selector of [
      argv`--language plain-text`,
      argv`--filename virtual.ts`,
    ]
  ) {
    const { code, stderr } = await cf(
      argv`view --plain --diff ${selector}`,
      { stdin: DIFF },
    );
    assertEquals(code, 1);
    assert(
      stderr.join("\n").includes(
        "--diff cannot be combined with --language or --filename",
      ),
      stderr.join("\n"),
    );
  }
});

Deno.test("cf view rejects an invalid --color", async () => {
  const { code, stderr } = await cf(argv`view --plain --color bogus`, {
    stdin: SRC,
  });
  assertEquals(code, 1);
  assert(stderr.join("\n").toLowerCase().includes("color"), stderr.join("\n"));
});

Deno.test("cf view reports empty piped input", async () => {
  const { code, stderr } = await cf(argv`view --plain`, { stdin: "" });
  assertEquals(code, 1);
  assert(
    stderr.join("\n").toLowerCase().includes("no input"),
    stderr.join("\n"),
  );
});

Deno.test("cf view reads and prints a file argument", async () => {
  const dir = Deno.makeTempDirSync();
  try {
    const file = `${dir}/transformed.ts`;
    Deno.writeTextFileSync(file, SRC);
    const { code, stdout } = await cf(argv`view --plain ${file}`);
    assertEquals(code, 0);
    assert(stdout.join("\n").includes("pattern"));
  } finally {
    Deno.removeSync(dir, { recursive: true });
  }
});

describe("cf view redirected byte output", () => {
  it("preserves a UTF-8 BOM in redirected source output", async () => {
    const dir = Deno.makeTempDirSync();
    try {
      const path = join(dir, "bom.txt");
      const bytes = new Uint8Array([0xef, 0xbb, 0xbf, 0x68, 0x69, 0x0a]);
      Deno.writeFileSync(path, bytes);
      const result = await runViewForBytes([
        "view",
        "--plain",
        "--color",
        "never",
        path,
      ]);
      expect(result.code).toBe(0);
      expect(result.stdout).toEqual(bytes);
    } finally {
      Deno.removeSync(dir, { recursive: true });
    }
  });
});

Deno.test("cf view rejects piped-input overrides with a file argument", async () => {
  const dir = Deno.makeTempDirSync();
  try {
    const file = `${dir}/source.txt`;
    Deno.writeTextFileSync(file, SRC);
    const { code, stderr } = await cf(
      argv`view --plain --language typescript ${file}`,
    );
    assertEquals(code, 1);
    assert(
      stderr.join("\n").includes("cannot be used with a file argument"),
      stderr.join("\n"),
    );
  } finally {
    Deno.removeSync(dir, { recursive: true });
  }
});

Deno.test("cf view --rendered formats a named Markdown file", async () => {
  const dir = Deno.makeTempDirSync();
  try {
    const file = `${dir}/notes.md`;
    Deno.writeTextFileSync(file, "# Title with **weight**\n");
    const { code, stdout } = await cf(
      argv`view --plain --rendered --color never ${file}`,
    );
    assertEquals(code, 0);
    assert(stdout.includes("Title with weight"), stdout.join("\n"));
    assert(!stdout.join("\n").includes("# Title"), stdout.join("\n"));
  } finally {
    Deno.removeSync(dir, { recursive: true });
  }
});

Deno.test("cf view reports an empty file argument", async () => {
  const dir = Deno.makeTempDirSync();
  try {
    const file = `${dir}/empty.ts`;
    Deno.writeTextFileSync(file, "   \n\n");
    const { code, stderr } = await cf(argv`view --plain ${file}`);
    assertEquals(code, 1);
    assert(
      stderr.join("\n").toLowerCase().includes("empty"),
      stderr.join("\n"),
    );
  } finally {
    Deno.removeSync(dir, { recursive: true });
  }
});

describe("cf view known binary files", () => {
  it("accepts an empty known binary file", async () => {
    const dir = Deno.makeTempDirSync();
    try {
      const file = `${dir}/empty.png`;
      Deno.writeFileSync(file, new Uint8Array());
      const { code, stdout } = await cf(
        argv`view --plain --color never ${file}`,
      );
      expect(code).toBe(0);
      expect(stdout).toEqual(["00000000"]);
    } finally {
      Deno.removeSync(dir, { recursive: true });
    }
  });
});
