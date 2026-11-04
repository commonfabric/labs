import { assert, assertEquals } from "@std/assert";

// Embedded hosts have no Toolshed routes on their origin. These components
// depend on those routes, or carry an intentionally excluded heavy dependency.
const excluded = new Map([
  ["cf-chart", "heavy"],
  ["cf-updater", "/api/integrations/bg"],
  ["cf-webhook", "/api/webhooks"],
  ["cf-voice-input", "/api/ai/voice/transcribe"],
  ["cf-oauth", "/api/integrations"],
  ["cf-google-oauth", "/api/integrations/google-oauth"],
  ["cf-plaid-link", "/api/plaid"],
  ["cf-link-preview", "/api/link-preview"],
]);

Deno.test("the embedded palette makes an explicit decision for every component", async () => {
  const source = await Deno.readTextFile(
    new URL("../src/embedded-components.ts", import.meta.url),
  );
  const imported = new Set(
    Array.from(
      source.matchAll(/components\/([a-z][a-z-]*)\/index\.ts/g),
      (match) => match[1],
    ),
  );
  const components = new Set<string>();
  for await (
    const entry of Deno.readDir(
      new URL("../src/v2/components/", import.meta.url),
    )
  ) {
    if (!entry.isDirectory) continue;
    try {
      await Deno.stat(
        new URL(`../src/v2/components/${entry.name}/index.ts`, import.meta.url),
      );
      components.add(entry.name);
    } catch (error) {
      if (!(error instanceof Deno.errors.NotFound)) throw error;
    }
  }
  assert(components.size > 0);
  assertEquals([
    ...components.difference(imported).difference(new Set(excluded.keys())),
  ], []);
  assertEquals([...new Set(excluded.keys()).difference(components)], []);
  assertEquals([...imported.intersection(new Set(excluded.keys()))], []);
  assert(imported.has("cf-map"));
  assert(imported.has("cf-code-editor"));
  const instructions = await Deno.readTextFile(
    new URL("../LLM-COMPONENT-INSTRUCTIONS.md", import.meta.url),
  );
  for (const [tag] of instructions.matchAll(/cf-[a-z][a-z-]+/g)) {
    const name = tag === "cf-form" ? "form" : tag;
    if (components.has(name) && !excluded.has(name)) {
      assert(imported.has(name), name);
    }
  }
  for (
    const path of [
      "../../../patterns/apps/shared-note/main.tsx",
      "../../../patterns/system/profile-create/profile-create.tsx",
    ]
  ) {
    const template = await Deno.readTextFile(new URL(path, import.meta.url));
    for (const [, tag] of template.matchAll(/<(cf-[a-z0-9-]+)/g)) {
      assert(imported.has(tag), tag);
    }
  }
});
