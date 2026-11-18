import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";

import ports from "@commonfabric/ports" with { type: "json" };

import { defaultApiUrl } from "../../src/builder/env.ts";

describe("env", () => {
  describe("defaultApiUrl()", () => {
    const page = { location: { href: "https://app.example:8443/space/x?y#z" } };

    it("returns the local toolshed under Deno, whatever page there is", () => {
      expect(defaultApiUrl(true, page).href).toBe(
        `http://localhost:${ports.toolshed}/`,
      );
    });

    it("returns the origin of the page outside Deno", () => {
      expect(defaultApiUrl(false, page).href).toBe(
        "https://app.example:8443/",
      );
    });
  });
});
