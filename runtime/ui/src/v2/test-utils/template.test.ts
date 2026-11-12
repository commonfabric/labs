import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { html, nothing } from "lit";
import {
  boundHandler,
  boundValue,
  boundValues,
  templateText,
} from "./template.ts";

describe("template", () => {
  describe("templateText()", () => {
    it("writes bound values, nested templates, and arrays in place", () => {
      const items = ["a", "b"].map((item) => html`<li>${item}</li>`);
      const template = html`
        <ul>${items}</ul>
        <p>${3}</p>
      `;

      // The formatter lays the markup out on several lines.
      expect(templateText(template).replace(/\s/g, "")).toBe(
        "<ul><li>a</li><li>b</li></ul><p>3</p>",
      );
    });

    it("writes nothing for `null`, `undefined`, and `nothing`", () => {
      const template = html`<p>${null}${undefined}${nothing}</p>`;

      expect(templateText(template)).toBe("<p></p>");
    });
  });

  describe("boundValues()", () => {
    it("returns every value bound to the name, in document order", () => {
      const first = () => {};
      const second = () => {};
      const template =
        html`<button @click="${first}"></button>${html`<button @click=${second} .value="${"v"}"></button>`}`;

      expect(boundValues(template, "@click")).toEqual([first, second]);
      expect(boundValues(template, ".value")).toEqual(["v"]);
    });

    it("does not match a name that only ends with the one asked for", () => {
      const template = html`<div aria-label="${"label"}" data-x=${"x"}></div>`;

      expect(boundValues(template, "label")).toEqual([]);
      expect(boundValues(template, "aria-label")).toEqual(["label"]);
    });
  });

  describe("boundValue()", () => {
    it("returns the one value bound to the name", () => {
      const template = html`<input ?disabled=${true}>`;

      expect(boundValue(template, "?disabled")).toBe(true);
    });

    it("throws when the name is bound other than once", () => {
      const template = html`<a href=${"x"}></a><a href=${"y"}></a>`;

      expect(() => boundValue(template, "href")).toThrow(
        "expected one binding of href, found 2",
      );
      expect(() => boundValue(template, "title")).toThrow(
        "expected one binding of title, found 0",
      );
    });
  });

  describe("boundHandler()", () => {
    it("calls the listener with the host as `this`", () => {
      const host = { seen: [] as unknown[] };
      function listener(this: typeof host, event: Event) {
        this.seen.push(event.type);
      }
      const template = html`<button @click=${listener}></button>`;

      boundHandler(template, "@click", host)(new Event("click"));

      expect(host.seen).toEqual(["click"]);
    });

    it("throws when the binding is not a function", () => {
      const template = html`<button @click=${"not a function"}></button>`;

      expect(() => boundHandler(template, "@click", {})).toThrow(
        "the binding of @click is not a function",
      );
    });
  });
});
