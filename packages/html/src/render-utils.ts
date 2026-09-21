export type SetPropHandler = <T>(
  target: T,
  key: string,
  value: unknown,
) => void;

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

/**
 * Converts a React-style CSS object to a CSS string.
 * Supports vendor prefixes, pixel value shorthand, and comprehensive CSS properties.
 * @param styleObject - The style object with React-style camelCase properties
 * @returns A CSS string suitable for the style attribute
 */
export const styleObjectToCssString = (
  styleObject: Record<string, any>,
): string => {
  return Object.entries(styleObject)
    .map(([key, value]) => {
      // Skip if value is null or undefined
      if (value == null) return "";

      // Convert camelCase to kebab-case, handling vendor prefixes
      let cssKey = key;

      // CSS custom properties (--*) are case-sensitive and should not be transformed
      if (!key.startsWith("--")) {
        // Handle vendor prefixes (WebkitTransform -> -webkit-transform)
        if (/^(webkit|moz|ms|o)[A-Z]/.test(key)) {
          cssKey = "-" + key;
        }

        // Convert camelCase to kebab-case
        cssKey = cssKey.replace(/([A-Z])/g, "-$1").toLowerCase();
      }

      // Convert value to string
      let cssValue = value;

      // Add 'px' suffix to numeric values for properties that need it
      // Exceptions: properties that accept unitless numbers
      const unitlessProperties = new Set([
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

      if (
        typeof value === "number" &&
        !cssKey.startsWith("--") && // CSS custom properties should never get px
        !unitlessProperties.has(cssKey) &&
        value !== 0
      ) {
        cssValue = `${value}px`;
      } else {
        cssValue = String(value);
      }

      return `${cssKey}: ${cssValue}`;
    })
    .filter((s) => s !== "")
    .join("; ");
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
    target instanceof Element
  ) {
    // If value is null or undefined, remove the attribute
    if (value == null) {
      if (target.hasAttribute(key)) {
        target.removeAttribute(key);
      }
    } else {
      const currentValue = target.getAttribute(key);
      const newValue = String(value);
      if (currentValue !== newValue) {
        target.setAttribute(key, newValue);
      }
    }
  } else if (!Object.is(target[key as keyof T], value)) {
    // `Object.is`, not `!==`: a `NaN` prop must not be re-assigned on every
    // pass (custom elements often re-render on any property set).
    target[key as keyof T] = value as T[keyof T];
  }
};
