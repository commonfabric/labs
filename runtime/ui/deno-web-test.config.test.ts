import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";

import config from "./deno-web-test.config.ts";

describe("deno-web-test.config", () => {
  it("passes the browser one `--blink-settings` flag and nothing else", () => {
    expect(config.args).toHaveLength(1);
    expect(config.args[0]).toMatch(/^--blink-settings=/);
  });

  it("tells the browser its only pointer is a hover-capable fine one", () => {
    // Blink numbers hover types as none 1, hover 2, and pointer types as
    // none 1, coarse 2, fine 4; an available-types setting is a bit set of
    // them.

    const settings = Object.fromEntries(
      config.args[0].slice("--blink-settings=".length).split(",").map(
        (setting) => setting.split("="),
      ),
    );
    expect(settings).toEqual({
      primaryHoverType: "2",
      availableHoverTypes: "2",
      primaryPointerType: "4",
      availablePointerTypes: "4",
    });
  });
});
