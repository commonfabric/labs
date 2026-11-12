import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";

import {
  camelCasePropName,
  isAttributePropName,
  isEventPropName,
  isMisnamedPropName,
} from "../src/jsx-prop-names.ts";

describe("jsx-prop-names", () => {
  it("calls a hyphenated name that is neither an event nor data-* nor aria-* misnamed", () => {
    for (const name of ["default-size", "timing-strategy", "accept-charset"]) {
      expect(isMisnamedPropName(name)).toBe(true);
    }
  });

  it("leaves event names alone, however they are spelled", () => {
    for (const name of ["onClick", "oncf-change", "onbacklink-create"]) {
      expect(isEventPropName(name)).toBe(true);
      expect(isMisnamedPropName(name)).toBe(false);
    }
  });

  it("leaves data-* and aria-* names alone, as attributes", () => {
    for (const name of ["data-id", "aria-label", "data-ui-action"]) {
      expect(isAttributePropName(name)).toBe(true);
      expect(isMisnamedPropName(name)).toBe(false);
    }
  });

  it("leaves property names alone", () => {
    for (const name of ["defaultSize", "className", "htmlFor", "$value"]) {
      expect(isMisnamedPropName(name)).toBe(false);
    }
  });

  it("names the camel-case property for a hyphenated name", () => {
    expect(camelCasePropName("default-size")).toBe("defaultSize");
    expect(camelCasePropName("accept-charset")).toBe("acceptCharset");
    expect(camelCasePropName("hide-when-stacked")).toBe("hideWhenStacked");
  });
});
