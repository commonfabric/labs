/**
 * A pattern sets a component's property, never its attribute, so a style a
 * component keys on one of its properties' attributes, as `:host([full-width])`
 * is, applies only when that property reflects to the attribute. This holds
 * every component to it.
 */

import { expect } from "@std/expect";
import { LitElement } from "lit";
import * as ui from "../index.ts";

/** Each component class the library exports, finalized. */
function componentClasses(): (typeof LitElement)[] {
  return Object.values(ui).filter((value): value is typeof LitElement =>
    typeof value === "function" && value.prototype instanceof LitElement
  ).map((component) => {
    // Reading observedAttributes finalizes the class, which fills in its
    // elementProperties and elementStyles.
    void component.observedAttributes;
    return component;
  });
}

/** The attribute names a component's own styles select its host by. */
function hostAttributesInStyles(component: typeof LitElement): Set<string> {
  const names = new Set<string>();
  for (const style of component.elementStyles) {
    const text = style instanceof CSSStyleSheet
      ? [...style.cssRules].map((rule) => rule.cssText).join("\n")
      : style.cssText;
    for (const match of text.matchAll(/:host\(\s*\[([a-zA-Z0-9-]+)/g)) {
      names.add(match[1]!.toLowerCase());
    }
  }
  return names;
}

Deno.test("a property whose attribute a component's host styles select by reflects to it", () => {
  const unreflected: string[] = [];
  for (const component of componentClasses()) {
    const selected = hostAttributesInStyles(component);
    for (const [property, options] of component.elementProperties) {
      if (options.attribute === false || options.state) continue;
      const attribute = typeof options.attribute === "string"
        ? options.attribute
        : String(property).toLowerCase();
      if (selected.has(attribute) && !options.reflect) {
        unreflected.push(
          `${component.name}.${String(property)} [${attribute}]`,
        );
      }
    }
  }
  expect(unreflected).toEqual([]);
});
