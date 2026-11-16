// First, so that the document it installs is there when Lit loads.
import { mount } from "../../../test-utils/dom.ts";

import { expect } from "@std/expect";
import { afterEach, describe, it } from "@std/testing/bdd";
import { CFAreaMark, CFBarMark, CFDotMark, CFLineMark } from "../index.ts";

describe("mark elements", () => {
  afterEach(() => document.body.replaceChildren());

  describe("CFLineMark", () => {
    it("registers as `cf-line-mark`, of mark type `line`", () => {
      expect(customElements.get("cf-line-mark")).toBe(CFLineMark);
      expect(new CFLineMark().markType).toBe("line");
    });

    it("defaults to a linear curve 2 pixels wide", () => {
      const mark = new CFLineMark();
      expect(mark.strokeWidth).toBe(2);
      expect(mark.curve).toBe("linear");
    });

    it("reads its own attributes and the common mark attributes", async () => {
      const mark = await mount(new CFLineMark());
      mark.setAttribute("strokewidth", "4");
      mark.setAttribute("curve", "step");
      mark.setAttribute("x", "day");
      expect(mark.strokeWidth).toBe(4);
      expect(mark.curve).toBe("step");
      expect(mark.x).toBe("day");
    });
  });

  describe("CFAreaMark", () => {
    it("registers as `cf-area-mark`, of mark type `area`", () => {
      expect(customElements.get("cf-area-mark")).toBe(CFAreaMark);
      expect(new CFAreaMark().markType).toBe("area");
    });

    it("defaults to a linear curve 2 pixels wide, filled at 20% opacity down to the axis", () => {
      const mark = new CFAreaMark();
      expect(mark.strokeWidth).toBe(2);
      expect(mark.curve).toBe("linear");
      expect(mark.opacity).toBe(0.2);
      expect(mark.y2).toBeUndefined();
    });

    it("reads its own attributes and the common mark attributes", async () => {
      const mark = await mount(new CFAreaMark());
      mark.setAttribute("opacity", "0.5");
      mark.setAttribute("curve", "monotone");
      mark.setAttribute("y", "count");
      expect(mark.opacity).toBe(0.5);
      expect(mark.curve).toBe("monotone");
      expect(mark.y).toBe("count");
    });
  });

  describe("CFBarMark", () => {
    it("registers as `cf-bar-mark`, of mark type `bar`", () => {
      expect(customElements.get("cf-bar-mark")).toBe(CFBarMark);
      expect(new CFBarMark().markType).toBe("bar");
    });

    it("defaults to opaque bars with 20% padding between them", () => {
      const mark = new CFBarMark();
      expect(mark.opacity).toBe(1);
      expect(mark.barPadding).toBe(0.2);
    });

    it("reads its own attributes and the common mark attributes", async () => {
      const mark = await mount(new CFBarMark());
      mark.setAttribute("barpadding", "0.4");
      mark.setAttribute("color", "teal");
      expect(mark.barPadding).toBe(0.4);
      expect(mark.color).toBe("teal");
    });
  });

  describe("CFDotMark", () => {
    it("registers as `cf-dot-mark`, of mark type `dot`", () => {
      expect(customElements.get("cf-dot-mark")).toBe(CFDotMark);
      expect(new CFDotMark().markType).toBe("dot");
    });

    it("defaults to a radius of 3 pixels", () => {
      expect(new CFDotMark().radius).toBe(3);
    });

    it("reads its own attributes and the common mark attributes", async () => {
      const mark = await mount(new CFDotMark());
      mark.setAttribute("radius", "6");
      mark.setAttribute("label", "Visits");
      expect(mark.radius).toBe(6);
      expect(mark.label).toBe("Visits");
    });
  });
});
