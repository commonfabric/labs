import { assertEquals } from "@std/assert";
import { dirname, fromFileUrl, join, relative } from "@std/path";

async function filesUnder(root: string): Promise<string[]> {
  const files: string[] = [];
  for await (const entry of Deno.readDir(root)) {
    const path = join(root, entry.name);
    if (
      entry.isDirectory &&
      !["test", "tests", "fixtures", "vendor"].includes(entry.name)
    ) {
      for (const file of await filesUnder(path)) files.push(file);
    } else if (entry.isFile && path.endsWith(".ts")) files.push(path);
  }
  return files.sort();
}

Deno.test("removed legacy factory APIs and writers stay absent", async () => {
  const packageRoot = dirname(dirname(fromFileUrl(import.meta.url)));
  const repoRoot = dirname(dirname(packageRoot));
  const roots = ["base", "connectors", "dashboard", "runtime"].map((root) =>
    join(repoRoot, root)
  );
  const forbidden = [
    "patternTool",
    "PatternToolResult",
    "PatternToolFunction",
    "extraParams",
  ];
  const migrationDiagnostic = join(
    repoRoot,
    "base/ts-transformers/src/transformers/factory-authoring-validation.ts",
  );
  const hits: string[] = [];

  for (const root of roots) {
    for (const path of await filesUnder(root)) {
      if (path.endsWith(".test.ts") || path.endsWith("_test.ts")) continue;
      const source = await Deno.readTextFile(path);
      for (const token of forbidden) {
        // The compiler names the two removed spellings only to provide a
        // focused migration diagnostic; this is neither an API nor a writer.
        if (
          path === migrationDiagnostic &&
          (token === "patternTool" || token === "extraParams")
        ) continue;
        if (source.includes(token)) {
          hits.push(`${relative(repoRoot, path)}:${token}`);
        }
      }
    }
  }

  assertEquals(hits, []);
});
