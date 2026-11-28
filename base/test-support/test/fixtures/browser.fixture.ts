// Run by `../registration.test.ts` as a test file of its own. It loads the
// test module where `Deno` is what a page that `deno-web-test` drives offers,
// an object holding nothing but `Deno.test`. That one keeps each test it is
// given, as the page's harness does, and once the module has registered
// them, they are handed to Deno's own.

// Loaded first, while `Deno` is Deno's own: as it loads, it asks the Node
// compatibility layer which platform this is, which reads Deno's namespace.
import "@std/path";

const deno = Deno;
const given: Deno.TestDefinition[] = [];
const page: { test?: (definition: Deno.TestDefinition) => void } = Object
  .create(null);
page.test = (definition) => given.push(definition);
Object.defineProperty(globalThis, "Deno", { value: page, configurable: true });
try {
  // deno-lint-ignore cf-imports/no-inline-module-import -- the module reads what `Deno` is as it loads, so it loads once the page's stands in
  const { describe, it, beforeAll, test } = await import(
    "../../src/testing.ts"
  );
  test("runs as given", (t) => {
    console.log(`LOG ran ${t.name}`);
  });
  test("is ignored", { ignore: true }, () => {
    console.log("LOG ran is ignored");
  });
  for (
    const [what, register] of [
      ["describe", () => describe("group", () => {})],
      ["it", () => it("alone", () => {})],
      ["beforeAll", () => beforeAll(() => {})],
    ] as const
  ) {
    try {
      register();
      console.log(`LOG ${what} registered`);
    } catch (error) {
      console.log(`LOG refused: ${(error as Error).message}`);
    }
  }
} finally {
  Object.defineProperty(globalThis, "Deno", {
    value: deno,
    configurable: true,
  });
}
for (const definition of given) {
  console.log(
    `LOG registered ${definition.name}` +
      (definition.ignore === true ? " (ignored)" : ""),
  );
  deno.test(definition);
}
