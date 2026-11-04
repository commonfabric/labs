import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { getPatternEnvironment, setPatternEnvironment } from "../src/env.ts";
import type { PatternEnvironment } from "../src/builder/env.ts";

describe("pattern environment", () => {
  let originalEnv: PatternEnvironment;

  beforeEach(() => {
    originalEnv = getPatternEnvironment();
  });

  afterEach(() => {
    setPatternEnvironment(originalEnv);
  });

  it("copies the stored environment when setting it", () => {
    const env = {
      apiUrl: new URL("https://good.example/"),
    };

    setPatternEnvironment(env);
    env.apiUrl.href = "https://evil.example/";

    expect(getPatternEnvironment().apiUrl.href).toBe("https://good.example/");
  });

  it("returns a fresh snapshot on each read", () => {
    setPatternEnvironment({
      apiUrl: new URL("https://good.example/"),
    });

    const first = getPatternEnvironment();
    first.apiUrl.href = "https://evil.example/";

    expect(getPatternEnvironment().apiUrl.href).toBe("https://good.example/");
  });
});
