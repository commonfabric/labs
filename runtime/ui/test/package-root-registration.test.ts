import { assert, assertEquals } from "@std/assert";
import { join, relative, toFileUrl } from "@std/path";

const UI_ROOT = join(import.meta.dirname!, "..");
const COMPONENTS_ROOT = join(UI_ROOT, "src", "v2", "components");
const PACKAGE_ENTRYPOINT = join(UI_ROOT, "src", "index.ts");
const README = join(UI_ROOT, "README.md");
const V2_ENTRYPOINT = join(UI_ROOT, "src", "v2", "index.ts");

type Registration = {
  tag: string;
  exportPath: string;
};

async function collectComponentRegistrations(): Promise<Registration[]> {
  const registrations: Registration[] = [];

  for await (const entry of Deno.readDir(COMPONENTS_ROOT)) {
    if (!entry.isDirectory) {
      continue;
    }

    const indexPath = join(COMPONENTS_ROOT, entry.name, "index.ts");

    let source: string;
    try {
      source = await Deno.readTextFile(indexPath);
    } catch (error) {
      if (error instanceof Deno.errors.NotFound) {
        continue;
      }
      throw error;
    }

    const exportPath = `./components/${entry.name}/index.ts`;

    for (const match of source.matchAll(/customElements\.define\("([^"]+)"/g)) {
      const tag = match[1];
      if (tag.startsWith("cf-")) {
        registrations.push({ tag, exportPath });
      }
    }
  }

  registrations.sort((left, right) => left.tag.localeCompare(right.tag));

  return registrations;
}

async function collectRegistrationDecorators(
  dir: string,
): Promise<string[]> {
  const files: string[] = [];

  for await (const entry of Deno.readDir(dir)) {
    const path = join(dir, entry.name);

    if (entry.isDirectory) {
      for (const file of await collectRegistrationDecorators(path)) {
        files.push(file);
      }
      continue;
    }

    if (
      !entry.isFile || !entry.name.endsWith(".ts") ||
      entry.name.endsWith(".test.ts") ||
      entry.name.endsWith(".browser.test.ts")
    ) {
      continue;
    }

    const source = await Deno.readTextFile(path);
    if (source.includes("@customElement(")) {
      files.push(relative(UI_ROOT, path).replaceAll("\\", "/"));
    }
  }

  return files.sort();
}

function duplicateTags(registrations: Registration[]): string[] {
  const counts = new Map<string, number>();
  for (const { tag } of registrations) {
    counts.set(tag, (counts.get(tag) ?? 0) + 1);
  }

  return Array.from(counts)
    .filter(([, count]) => count > 1)
    .map(([tag]) => tag)
    .sort();
}

function duplicateStrings(values: string[]): string[] {
  const counts = new Map<string, number>();
  for (const value of values) {
    counts.set(value, (counts.get(value) ?? 0) + 1);
  }

  return Array.from(counts)
    .filter(([, count]) => count > 1)
    .map(([value]) => value)
    .sort();
}

function decode(bytes: Uint8Array): string {
  return new TextDecoder().decode(bytes);
}

Deno.test("package root exports every component registrar", async () => {
  const registrations = await collectComponentRegistrations();
  const packageSource = await Deno.readTextFile(PACKAGE_ENTRYPOINT);
  const v2Source = await Deno.readTextFile(V2_ENTRYPOINT);
  const duplicateTagNames = duplicateTags(registrations);

  assert(registrations.length > 0, "expected cf-* component registrations");
  assertEquals(duplicateTagNames, []);
  assert(
    packageSource.includes('export * from "./v2/index.ts";'),
    "package root should re-export the UI component entrypoint",
  );

  const expectedExports = Array.from(
    new Set(registrations.map(({ exportPath }) => exportPath)),
  ).sort();
  const missingExports = expectedExports.filter((exportPath) =>
    !v2Source.includes(`export * from "${exportPath}";`)
  );

  assertEquals(missingExports, []);
});

Deno.test("README component list matches registered cf elements", async () => {
  const registrations = await collectComponentRegistrations();
  const expectedTags = registrations.map(({ tag }) => tag);
  const readme = await Deno.readTextFile(README);
  const section = readme.match(
    /## 📖 Components\n(?<body>[\s\S]*?)\n## 🔒 Security Constraints/,
  )?.groups?.body;

  assert(section, "README should have a Components section");

  const documentedTags = Array.from(
    section.matchAll(/`(cf-[a-z0-9-]+)`/g),
    (match) => match[1],
  ).sort();

  assertEquals(duplicateStrings(documentedTags), []);
  assertEquals(documentedTags, expectedTags);
});

Deno.test("component files do not self-register with customElement decorators", async () => {
  const decoratorFiles = await collectRegistrationDecorators(COMPONENTS_ROOT);

  assertEquals(decoratorFiles, []);
});

Deno.test("package root registers every exported cf element", async () => {
  const registrations = await collectComponentRegistrations();
  const expectedTags = registrations.map(({ tag }) => tag);
  const entrypointUrl = toFileUrl(PACKAGE_ENTRYPOINT).href;

  const checkScript = `
const expectedTags = ${JSON.stringify(expectedTags)};
const entrypointUrl = ${JSON.stringify(entrypointUrl)};

const { registry } = await import(${
    JSON.stringify(toFileUrl(join(UI_ROOT, "test", "registration-dom.ts")).href)
  });

await import(entrypointUrl);

const missing = expectedTags.filter((tag) => !customElements.get(tag));
const registeredCfTags = Array.from(registry.keys())
  .filter((tag) => tag.startsWith("cf-"))
  .sort();
const unexpected = registeredCfTags.filter((tag) => !expectedTags.includes(tag));
console.log(JSON.stringify({ missing, registeredCfTags, unexpected }));
`;

  const output = await new Deno.Command(Deno.execPath(), {
    args: ["eval", checkScript],
    cwd: UI_ROOT,
    stdout: "piped",
    stderr: "piped",
  }).output();

  if (!output.success) {
    console.error(decode(output.stdout));
    console.error(decode(output.stderr));
  }

  assert(output.success, "package root import should complete");

  const result = JSON.parse(decode(output.stdout)) as {
    missing: string[];
    registeredCfTags: string[];
    unexpected: string[];
  };

  assertEquals(result.missing, []);
  assertEquals(result.unexpected, []);
  assertEquals(result.registeredCfTags.length, expectedTags.length);
});
