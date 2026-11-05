import { assert, assertEquals, assertFalse, assertRejects } from "@std/assert";
import { fromFileUrl, join } from "@std/path";
import {
  ALLOWLIST,
  main,
  namesResolverInCode,
  scan,
} from "./check-local-program.ts";

// Builds a git repository holding the named files and returns its root. The
// scan reads what git tracks, so a fixture has to be a repository with the
// files added to its index. The caller removes the tree.
async function fixtureRepo(
  files: Record<string, string>,
): Promise<string> {
  const root = await Deno.makeTempDir({ prefix: "check-local-program-" });
  for (const [path, contents] of Object.entries(files)) {
    const full = join(root, path);
    await Deno.mkdir(join(full, ".."), { recursive: true });
    await Deno.writeTextFile(full, contents);
  }
  const git = async (...args: string[]) => {
    const { success, stderr } = await new Deno.Command("git", {
      args,
      cwd: root,
    }).output();
    if (!success) throw new Error(new TextDecoder().decode(stderr));
  };
  await git("init", "--quiet");
  await git("add", "--all");
  return root;
}

// Runs `body` with console.log and console.error captured, returning what each
// received. Restores the originals afterward.
async function captureConsole(
  body: () => Promise<void>,
): Promise<{ out: string; err: string }> {
  const out: string[] = [];
  const err: string[] = [];
  const origLog = console.log;
  const origError = console.error;
  console.log = (...args) => out.push(args.map(String).join(" "));
  console.error = (...args) => err.push(args.map(String).join(" "));
  try {
    await body();
  } finally {
    console.log = origLog;
    console.error = origError;
  }
  return { out: out.join("\n"), err: err.join("\n") };
}

Deno.test("namesResolverInCode finds a direct construction", () => {
  assert(
    namesResolverInCode(
      `const program = await resolve(new FileSystemProgramResolver(main, root));`,
      "runtime/foo/bar.ts",
    ),
  );
});

Deno.test("namesResolverInCode finds the import that an alias renames", () => {
  assert(
    namesResolverInCode(
      `import { FileSystemProgramResolver as Resolver } from "@commonfabric/js-compiler";
const program = await resolve(new Resolver(main, root));`,
      "runtime/foo/bar.ts",
    ),
  );
});

Deno.test("namesResolverInCode finds a type-position reference", () => {
  assert(
    namesResolverInCode(
      `let resolver: FileSystemProgramResolver | undefined;`,
      "runtime/foo/bar.ts",
    ),
  );
});

Deno.test("namesResolverInCode ignores a line comment", () => {
  assertFalse(
    namesResolverInCode(
      `// Do not reach for FileSystemProgramResolver here.\nexport const x = 1;`,
      "runtime/foo/bar.ts",
    ),
  );
});

Deno.test("namesResolverInCode ignores a doc comment", () => {
  assertFalse(
    namesResolverInCode(
      `/**\n * Prefer this to a bare FileSystemProgramResolver.\n */\nexport const x = 1;`,
      "runtime/foo/bar.ts",
    ),
  );
});

Deno.test("namesResolverInCode ignores a string literal", () => {
  assertFalse(
    namesResolverInCode(
      `throw new Error("Use resolveLocalProgram, not FileSystemProgramResolver.");`,
      "runtime/foo/bar.ts",
    ),
  );
});

Deno.test("namesResolverInCode reads past a comment marker inside a string", () => {
  // A scan that blanked a line from its first `//` would stop reading here at
  // the URL and never reach the construction that follows it.

  assert(
    namesResolverInCode(
      `const docs = "https://example.com/x"; const r = new FileSystemProgramResolver(m);`,
      "runtime/foo/bar.ts",
    ),
  );
});

Deno.test("namesResolverInCode reads past a block-comment marker inside a string", () => {
  // Likewise for a block-comment opener: taken literally it would swallow the
  // rest of the file.

  assert(
    namesResolverInCode(
      `const glob = "/*"; const r = new FileSystemProgramResolver(m);\nconst end = "*/";`,
      "runtime/foo/bar.ts",
    ),
  );
});

Deno.test("namesResolverInCode parses markup in a .tsx file", () => {
  assert(
    namesResolverInCode(
      `const view = <div class="x">text</div>;\nconst r = new FileSystemProgramResolver(m);`,
      "runtime/foo/bar.tsx",
    ),
  );
});

Deno.test("namesResolverInCode ignores a same-named property of another object", () => {
  // A property access still names the resolver, so it counts; a property whose
  // name merely resembles it does not.

  assertFalse(
    namesResolverInCode(
      `const x = { fileSystemProgramResolver: 1 };`,
      "runtime/foo/bar.ts",
    ),
  );
});

Deno.test("every allowlisted file still names the resolver in code", async () => {
  for (const path of ALLOWLIST.keys()) {
    const source = await Deno.readTextFile(
      new URL(`../${path}`, import.meta.url),
    );
    assert(
      namesResolverInCode(source, path),
      `${path} no longer names the resolver, so its exemption is dead.`,
    );
  }
});

Deno.test("the allowlist records a reason for every exemption", () => {
  for (const [path, reason] of ALLOWLIST) {
    assertEquals(typeof reason, "string");
    assert(reason.length > 0, `${path} is exempt without a reason.`);
  }
});

Deno.test("scan names a file that constructs the resolver", async () => {
  const root = await fixtureRepo({
    "runtime/foo/build.ts":
      "export const r = new FileSystemProgramResolver(main);\n",
  });
  try {
    assertEquals(await scan(root), ["runtime/foo/build.ts"]);
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("scan passes over a file that only writes about the resolver", async () => {
  const root = await fixtureRepo({
    "runtime/foo/notes.ts":
      "// Never construct a FileSystemProgramResolver here.\nexport const x = 1;\n",
    "docs/guide.md": "Do not use `FileSystemProgramResolver`.\n",
  });
  try {
    assertEquals(await scan(root), []);
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("scan passes over an allowlisted file that does construct it", async () => {
  const root = await fixtureRepo({
    "base/js-compiler/program.ts":
      "export class FileSystemProgramResolver {}\n",
  });
  try {
    assertEquals(await scan(root), []);
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("scan tolerates a tracked file deleted from the working tree", async () => {
  const root = await fixtureRepo({
    "runtime/foo/gone.ts":
      "export const r = new FileSystemProgramResolver(main);\n",
  });
  try {
    await Deno.remove(join(root, "runtime/foo/gone.ts"));
    assertEquals(await scan(root), []);
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test(
  "check-local-program main reports success and returns 0 on a clean tree",
  async () => {
    const root = await fixtureRepo({
      "runtime/foo/build.ts": "export const x = 1;\n",
    });
    try {
      let code = -1;
      const { out } = await captureConsole(async () => {
        code = await main(root);
      });
      assertEquals(code, 0);
      assert(out.includes("Local programs are built through one operation"));
    } finally {
      await Deno.remove(root, { recursive: true });
    }
  },
);

Deno.test("main reports the offender and the route to take instead", async () => {
  const root = await fixtureRepo({
    "runtime/foo/build.ts":
      "export const r = new FileSystemProgramResolver(main);\n",
  });
  try {
    let code = -1;
    const { err } = await captureConsole(async () => {
      code = await main(root);
    });
    assertEquals(code, 1);
    assert(err.includes("runtime/foo/build.ts"));
    assert(err.includes("resolveLocalProgram"));
    assert(err.includes("tasks/check-local-program.ts"));
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("scan reports a tracked path it cannot read for another reason", async () => {
  // A tracked path that has become a directory is not a deletion, so the read
  // fails for a reason the scan has no answer for and the failure carries.

  const root = await fixtureRepo({
    "runtime/foo/build.ts":
      "export const r = new FileSystemProgramResolver(main);\n",
  });
  try {
    const path = join(root, "runtime/foo/build.ts");
    await Deno.remove(path);
    await Deno.mkdir(path);
    await assertRejects(() => scan(root), Deno.errors.IsADirectory);
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("the check runs as a program over this repository", async () => {
  // Runs the check the way CI does, as a program rather than as an import. The
  // repository passes it, so this doubles as the end-to-end case: the entry
  // point wires the scan to an exit code, and the tree it ships is clean.

  const script = fromFileUrl(
    new URL("./check-local-program.ts", import.meta.url),
  );
  const { success, stdout } = await new Deno.Command(Deno.execPath(), {
    args: [
      "run",
      "--allow-read",
      "--allow-env",
      "--allow-run=git",
      script,
    ],
  }).output();
  assert(
    success,
    "the repository has a program built from local files by hand",
  );
  assert(
    new TextDecoder().decode(stdout).includes(
      "Local programs are built through one operation",
    ),
  );
});
