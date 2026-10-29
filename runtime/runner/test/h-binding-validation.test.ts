import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";

import { h } from "../src/builder/h.ts";

describe("bidirectional binding validation", () => {
  it("throws when `$value` is a primitive string", () => {
    expect(() => h("cf-input", { $value: "hello" })).toThrow();
  });

  it("throws when `$value` is a primitive number", () => {
    expect(() => h("cf-input", { $value: 42 })).toThrow();
  });

  it("throws when `$checked` is a primitive boolean", () => {
    expect(() => h("cf-checkbox", { $checked: true })).toThrow();
  });

  it("throws when `$value` is null", () => {
    expect(() => h("cf-input", { $value: null })).toThrow();
  });

  it("throws when `$value` is undefined", () => {
    expect(() => h("cf-input", { $value: undefined })).toThrow();
  });

  it("throws when `$value` is a plain object rather than a cell", () => {
    expect(() => h("cf-input", { $value: { someData: "test" } })).toThrow();
  });

  it("throws when `$value` is an array rather than a cell", () => {
    expect(() => h("cf-input", { $value: [1, 2, 3] })).toThrow();
  });

  it("returns a vnode for non-`$` props holding any value", () => {
    const vnode = h("div", {
      value: "string",
      count: 42,
      checked: true,
      data: { nested: "object" },
    });
    expect(vnode.type).toBe("vnode");
    expect(vnode.name).toBe("div");
  });

  it("returns a vnode given a null props object", () => {
    const vnode = h("div", null, "child");
    expect(vnode.type).toBe("vnode");
    expect(vnode.name).toBe("div");
  });

  it("names `$value` in the error it throws", () => {
    expect(() => h("cf-input", { $value: "test" })).toThrow("$value");
  });

  it("names `$checked` in the error it throws", () => {
    expect(() => h("cf-checkbox", { $checked: false })).toThrow("$checked");
  });

  it("shows a `cf-checkbox` example in the `$checked` error", () => {
    expect(() => h("cf-checkbox", { $checked: false })).toThrow("cf-checkbox");
  });

  it("shows a `cf-input` example in the `$value` error", () => {
    expect(() => h("cf-input", { $value: "test" })).toThrow("cf-input");
  });
});
