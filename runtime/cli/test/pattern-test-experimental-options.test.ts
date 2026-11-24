import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { SERVER_EXECUTION_DEFAULT_ENABLED } from "@commonfabric/memory/v2/server-execution-default";
import { patternTestExperimentalOptions } from "../lib/pattern-test-experimental-options.ts";

/** An environment reader over `vars` alone. */
function envOf(
  vars: Record<string, string>,
): (name: string) => string | undefined {
  return (name) => vars[name];
}

describe("patternTestExperimentalOptions()", () => {
  it("returns `serverExecution` as `true` when the environment sets it to `true`", () => {
    expect(
      patternTestExperimentalOptions(
        envOf({ EXPERIMENTAL_SERVER_EXECUTION: "true" }),
      ),
    ).toStrictEqual({ serverExecution: true });
  });

  it("returns `serverExecution` as `false` when the environment sets it to `false`", () => {
    expect(
      patternTestExperimentalOptions(
        envOf({ EXPERIMENTAL_SERVER_EXECUTION: "false" }),
      ),
    ).toStrictEqual({ serverExecution: false });
  });

  it("returns `serverExecution` as `true` exactly when the first-party default is on, when the environment leaves it unset", () => {
    expect(patternTestExperimentalOptions(envOf({}))).toStrictEqual(
      SERVER_EXECUTION_DEFAULT_ENABLED ? { serverExecution: true } : {},
    );
  });

  it("returns the other flags the environment sets", () => {
    expect(
      patternTestExperimentalOptions(
        envOf({
          EXPERIMENTAL_MODERN_CELL_REP: "true",
          EXPERIMENTAL_LAZY_MATERIALIZATION: "false",
        }),
      ),
    ).toStrictEqual({
      modernCellRep: true,
      lazyMaterialization: false,
      ...(SERVER_EXECUTION_DEFAULT_ENABLED ? { serverExecution: true } : {}),
    });
  });
});
