import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";

import { CommonIframeSandboxElement } from "../src/common-iframe-sandbox.ts";

describe("CommonIframeSandboxElement", () => {
  describe("instance members", () => {
    describe("presentation", () => {
      it("defaults to no presentation", () => {
        expect(new CommonIframeSandboxElement().presentation).toBeNull();
      });

      it("throws for root attributes outside the data namespace", () => {
        const element = new CommonIframeSandboxElement();
        for (const name of ["onclick", "style", "class", "data-"]) {
          expect(() => {
            element.presentation = {
              css: "",
              attributes: { [name]: "value" },
              stylesheets: [],
            };
          }).toThrow(TypeError);
        }
      });

      it("keeps a snapshot independent of the caller's mutable object", () => {
        const element = new CommonIframeSandboxElement();
        const value = {
          css: ":root { --example: first; }",
          attributes: { "data-skin": "first" },
          stylesheets: ["https://fonts.example/first.css"],
        };
        element.presentation = value;
        value.css = "";
        value.attributes["data-skin"] = "later";
        value.stylesheets.push("https://fonts.example/later.css");
        expect(element.presentation).toEqual({
          css: ":root { --example: first; }",
          attributes: { "data-skin": "first" },
          stylesheets: ["https://fonts.example/first.css"],
        });
      });
    });
  });
});
