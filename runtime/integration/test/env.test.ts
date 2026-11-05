import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";
import { stub } from "@std/testing/mock";

describe("env", () => {
  describe("HEADLESS", () => {
    const cases = [
      { label: "unset", value: undefined, expected: true },
      { label: "empty", value: "", expected: true },
      { label: "1", value: "1", expected: true },
      { label: "true", value: "true", expected: true },
      { label: "0", value: "0", expected: false },
      { label: "false", value: "false", expected: false },
    ];

    for (const { label, value, expected } of cases) {
      it(`is \`${expected}\` when \`HEADLESS\` is ${label}`, async () => {
        using _env = stub(
          Deno.env,
          "get",
          (name) => name === "HEADLESS" ? value : undefined,
        );
        // Each import evaluates the environment under that case's settings.
        const env = await import(`../env.ts?headless=${label}`);

        expect(env.HEADLESS).toBe(expected);
        expect(env.PIPE_CONSOLE).toBe(false);
      });
    }
  });
});
