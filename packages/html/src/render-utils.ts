import { utf8SortedKeysOf } from "@commonfabric/utils/utf8";

export type SetPropHandler = <T>(
  target: T,
  key: string,
  value: unknown,
) => void;

/**
 * What a render shows in place of content its confidentiality ceiling
 * refuses, and what a host showing a value it was refused shows instead, so
 * that the two say the same thing.
 */
export const CFC_POLICY_PLACEHOLDER_TEXT = "Content hidden by policy";

export const isEventProp = (key: string) => key.startsWith("on");

/**
 * Get the event type from an event prop name.
 * E.g., "onClick" -> "click", "onMouseMove" -> "mousemove"
 */
export const getEventType = (key: string): string => {
  if (!key.startsWith("on") || key.length <= 2) return key;
  return key.slice(2).toLowerCase();
};

/**
 * Check if a value is an event handler function.
 */
export const isEventHandler = (
  value: unknown,
): value is (event: unknown) => void => {
  return typeof value === "function";
};

/**
 * Check if a prop name is a bidirectional binding (starts with $).
 */
export const isBindingProp = (key: string): boolean => {
  return key.startsWith("$");
};

/**
 * Get the property name from a binding prop.
 * E.g., "$value" -> "value", "$checked" -> "checked"
 */
export const getBindingPropName = (key: string): string => {
  return key.startsWith("$") ? key.slice(1) : key;
};

/** CSS properties whose numeric value is a bare number, not a length. */
const UNITLESS_PROPERTIES: ReadonlySet<string> = new Set([
  "animation-iteration-count",
  "column-count",
  "fill-opacity",
  "flex",
  "flex-grow",
  "flex-shrink",
  "font-weight",
  "line-height",
  "opacity",
  "order",
  "orphans",
  "stroke-opacity",
  "widows",
  "z-index",
  "zoom",
]);

/**
 * Converts a style object with React-style camelCase keys to the text of a
 * `style` attribute. A vendor-prefixed key becomes its leading-dash form, a
 * custom property (`--*`) keeps its case, a number other than `0` takes `px`
 * unless its property is unitless, and a `null` or `undefined` value is left
 * out.
 *
 * The declarations come out in the UTF-8 order of the object's keys, whatever
 * order the object enumerates them in. The order an object's keys were
 * inserted in is not part of a fabric value, and a runtime can hold one stored
 * object under either order: as its writer listed the keys, or as the store's
 * encoding sorted them. Text that followed the enumeration would differ
 * between two renders of the same value.
 */
export const styleObjectToCssString = (
  styleObject: Record<string, unknown>,
): string => {
  const declarations: string[] = [];
  for (const key of utf8SortedKeysOf(styleObject)) {
    const value = styleObject[key];
    if (value == null) continue;

    let cssKey = key;
    // A custom property is case-sensitive, and is written as it is.
    if (!key.startsWith("--")) {
      // `WebkitTransform` and `webkitTransform` are both `-webkit-transform`.
      if (/^(webkit|moz|ms|o)[A-Z]/.test(key)) {
        cssKey = "-" + key;
      }
      cssKey = cssKey.replace(/([A-Z])/g, "-$1").toLowerCase();
    }

    const cssValue = typeof value === "number" &&
        !cssKey.startsWith("--") &&
        !UNITLESS_PROPERTIES.has(cssKey) &&
        value !== 0
      ? `${value}px`
      : String(value);

    declarations.push(`${cssKey}: ${cssValue}`);
  }
  return declarations.join("; ");
};

export const setPropDefault = <T>(target: T, key: string, value: unknown) => {
  // Handle style object specially - set as attribute.
  if (
    key === "style" &&
    target instanceof HTMLElement &&
    typeof value === "string"
  ) {
    if (target.getAttribute("style") !== value) {
      target.setAttribute("style", value);
    }
    return;
  }

  // ARIA names and data-* keys are attributes; assigning a hyphenated
  // property does not expose them to accessibility APIs or dataset.
  if (
    (key.startsWith("data-") || key.startsWith("aria-")) &&
    (target as Element | null | undefined)?.nodeType === 1
  ) {
    const element = target as Element;
    // If value is null or undefined, remove the attribute
    if (value == null) {
      if (element.hasAttribute(key)) {
        element.removeAttribute(key);
      }
    } else {
      const currentValue = element.getAttribute(key);
      const newValue = String(value);
      if (currentValue !== newValue) {
        element.setAttribute(key, newValue);
      }
    }
  } else if (!Object.is(target[key as keyof T], value)) {
    // `Object.is`, not `!==`: a `NaN` prop must not be re-assigned on every
    // pass (custom elements often re-render on any property set).
    target[key as keyof T] = value as T[keyof T];
  }
};
