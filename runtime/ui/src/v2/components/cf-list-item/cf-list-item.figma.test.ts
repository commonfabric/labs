/**
 * The figma-to-code skill reads this mapping to turn a Figma design into
 * `cf-list-item` markup, so every name it gives on the code side has to be one
 * the component answers to.
 */

import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";
import { CFListItem } from "./index.ts";
import { figmaMapping } from "./cf-list-item.figma.ts";

const observed: readonly string[] = CFListItem.observedAttributes;
const variants = Object.values(figmaMapping.variants);

describe("cf-list-item.figma", () => {
  it("names the registered `cf-list-item` element", () => {
    expect(customElements.get(figmaMapping.element)).toBe(CFListItem);
  });

  it("maps every Figma property to an attribute the component observes", () => {
    const props: { codeProp: string; staticProps?: object }[] = variants
      .flatMap((variant) =>
        "props" in variant ? Object.values(variant.props) : []
      );
    const mapped = props.flatMap((prop) => [
      prop.codeProp,
      ...Object.keys(prop.staticProps ?? {}),
    ]);

    expect(mapped).toContain("label");
    expect(mapped.filter((name) => !observed.includes(name))).toEqual([]);
  });

  it("writes each example with only attributes the component observes", () => {
    const attributes = variants.flatMap(({ example }) => {
      const opening = /^<cf-list-item((?:\s+[a-z-]+(?:="[^"]*")?)*)\s*>/
        .exec(example);
      expect(opening).not.toBeNull();
      return [...(opening?.[1] ?? "").matchAll(/\s+([a-z-]+)(?:="[^"]*")?/g)]
        .map((match) => match[1]);
    });

    expect(attributes).toEqual(
      expect.arrayContaining(["label", "description", "expandable"]),
    );
    expect(attributes.filter((name) => !observed.includes(name))).toEqual([]);
  });
});
