// First, so that the document it installs is there when Lit loads.
import "../test-utils/dom.ts";

import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";
import { dirname, fromFileUrl, join } from "@std/path";

const COMPONENTS_ROOT = dirname(fromFileUrl(import.meta.url));

/** Attributes any element accepts, which no component declares. */
const GLOBAL_ATTRIBUTES = new Set(["class", "id", "slot", "style"]);

/**
 * The `figmaMapping` export of every `*.figma.ts` file, by file name, with
 * every element a mapping names defined by importing its component directory.
 */
async function loadMappings(): Promise<Map<string, unknown>> {
  const mappings = new Map<string, unknown>();
  for await (const directory of Deno.readDir(COMPONENTS_ROOT)) {
    if (!directory.isDirectory) continue;
    const path = join(COMPONENTS_ROOT, directory.name);
    for await (const file of Deno.readDir(path)) {
      if (!file.name.endsWith(".figma.ts")) continue;
      const module = await import(`./${directory.name}/${file.name}`);
      mappings.set(file.name, module.figmaMapping);
      await defineElements([directory.name, ...referencedTags(module)]);
    }
  }
  return mappings;
}

/** Every `cf-` tag a value names as an element or uses in an example. */
function referencedTags(value: unknown): string[] {
  return [...JSON.stringify(value).matchAll(/(?:"element":"|<)(cf-[\w-]+)/g)]
    .map((match) => match[1]);
}

/** Imports the component directory named after each tag, where one exists. */
async function defineElements(tags: string[]): Promise<void> {
  for (const tag of tags) {
    try {
      await Deno.stat(join(COMPONENTS_ROOT, tag, "index.ts"));
    } catch (error) {
      if (error instanceof Deno.errors.NotFound) continue;
      throw error;
    }
    await import(`./${tag}/index.ts`);
  }
}

/** Whether `tag` declares `name` as a property or as an attribute. */
function declares(tag: string, name: string): boolean {
  const ctor = customElements.get(tag);
  if (!ctor) throw new Error(`<${tag}> is not a registered element`);
  const attributes: unknown = Reflect.get(ctor, "observedAttributes");
  return (Array.isArray(attributes) && attributes.includes(name)) ||
    name in new ctor();
}

/**
 * Every claim a mapping makes about a component, as a list of problems: an
 * element that is not registered, a code property the element does not
 * declare, and an example that uses an unregistered element or an attribute
 * its element does not declare.
 */
function problemsIn(value: unknown, element: string | undefined): string[] {
  if (Array.isArray(value)) {
    return value.flatMap((item) => problemsIn(item, element));
  }
  if (typeof value !== "object" || value === null) return [];
  const problems: string[] = [];
  const record = Object(value);
  if (typeof record.element === "string") {
    element = record.element;
    if (!customElements.get(record.element)) {
      problems.push(`<${record.element}> is not a registered element`);
    }
  }
  const named = [
    ...(typeof record.codeProp === "string" ? [record.codeProp] : []),
    ...(Array.isArray(record.codeProps) ? record.codeProps : []),
    ...Object.keys(Object(record.staticProps ?? {})),
  ];
  for (const name of named) {
    if (name.startsWith("slot")) continue;
    if (element === undefined || !declares(element, name)) {
      problems.push(`<${element}> declares no "${name}"`);
    }
  }
  const nested = Object.entries(record).flatMap(([key, child]) =>
    key === "example"
      ? exampleProblems(String(child))
      : problemsIn(child, element)
  );
  return problems.concat(nested);
}

function exampleProblems(example: string): string[] {
  const problems: string[] = [];
  const template = document.createElement("template");
  template.innerHTML = example;
  for (const used of template.content.querySelectorAll("*")) {
    const tag = used.localName;
    if (!tag.startsWith("cf-")) continue;
    if (!customElements.get(tag)) {
      problems.push(`example uses unregistered <${tag}>`);
      continue;
    }
    for (const attribute of used.getAttributeNames()) {
      const name = attribute.replace(/^\$/, "");
      if (GLOBAL_ATTRIBUTES.has(name) || declares(tag, name)) continue;
      problems.push(`example sets undeclared ${attribute} on <${tag}>`);
    }
  }
  return problems;
}

describe("figma mappings", () => {
  it("names only registered elements and the properties they declare", async () => {
    const mappings = await loadMappings();
    expect([...mappings.keys()].sort()).toEqual([
      "cf-alert.figma.ts",
      "cf-button.figma.ts",
      "cf-card.figma.ts",
      "cf-list-item.figma.ts",
      "cf-tab-bar.figma.ts",
    ]);
    const problems = Object.fromEntries(
      [...mappings].map((
        [file, mapping],
      ) => [file, problemsIn(mapping, undefined)]),
    );
    expect(problems).toEqual({
      "cf-alert.figma.ts": [],
      "cf-button.figma.ts": [],
      "cf-card.figma.ts": [],
      "cf-list-item.figma.ts": [],
      "cf-tab-bar.figma.ts": [],
    });
  });

  it("reports a property, element, or example attribute that does not exist", async () => {
    await defineElements(["cf-button"]);
    expect(problemsIn({
      element: "cf-button",
      props: {
        a: { codeProp: "nonesuch" },
        b: { codeProps: ["variant", "flavor"] },
        c: { codeProp: "slot", staticProps: { disabled: true } },
        d: { codeProp: null },
      },
      tags: [{ element: "cf-nonesuch" }],
      example:
        `<cf-button size="sm" $value={x} wobble><cf-zzz></cf-zzz></cf-button>`,
    }, undefined)).toEqual([
      `<cf-button> declares no "nonesuch"`,
      `<cf-button> declares no "flavor"`,
      `<cf-nonesuch> is not a registered element`,
      `example sets undeclared $value on <cf-button>`,
      `example sets undeclared wobble on <cf-button>`,
      `example uses unregistered <cf-zzz>`,
    ]);
  });
});
