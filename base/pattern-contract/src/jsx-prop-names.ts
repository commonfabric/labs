/**
 * @fileoverview What a JSX prop's name tells the renderer to do with it.
 *
 * A JSX prop sets the element's JavaScript property of that name, so its name
 * is the property's: `defaultSize`, `className`, `htmlFor`. Three kinds of
 * name are not properties. A name starting `on` listens for the event it
 * names (`onClick`, `oncf-change`). A `data-*` or `aria-*` name is set as
 * that attribute, since those attributes have no property of their own name.
 * Any other name with a hyphen in it names no property at all: assigned, it
 * would add a property nothing reads, so the compiler refuses it and names
 * the property to write instead.
 *
 * The compiler and the renderer both decide by these functions, so a name
 * the compiler lets through is one the renderer applies as the compiler
 * assumed.
 *
 * Elements are created in the HTML namespace. SVG elements written as JSX
 * would need their hyphenated names (`stroke-width`) set as attributes, and
 * the misnamed rule would have to exempt them.
 */

/** Whether a prop listens for an event rather than setting a value. */
export function isEventPropName(name: string): boolean {
  return name.startsWith("on");
}

/** Whether a prop is set as the attribute of its own name. */
export function isAttributePropName(name: string): boolean {
  return name.startsWith("data-") || name.startsWith("aria-");
}

/**
 * Whether a prop's name can name no property: it holds a hyphen and is
 * neither an event nor an attribute prop.
 */
export function isMisnamedPropName(name: string): boolean {
  return name.includes("-") && !isEventPropName(name) &&
    !isAttributePropName(name);
}

/** The camel-case form of a hyphenated name: `default-size` → `defaultSize`. */
export function camelCasePropName(name: string): string {
  return name.replace(
    /-([a-z0-9])/g,
    (_, letter: string) => letter.toUpperCase(),
  );
}
