import { assertFalse, assertStringIncludes } from "@std/assert";
import { COMMONFABRIC_TYPES } from "./commonfabric-test-types.ts";
import { transformSource } from "./utils.ts";

Deno.test("closure conversion ignores identifiers declared only in type space", async () => {
  const output = await transformSource(
    `/// <cts-enable />
import { action, pattern } from "commonfabric";

export default pattern(() => {
  const fire = action(() => {
    const target = {} as unknown as {
      send: (event: Record<string, never>) => void;
    };
    target.send({});
  });
  return { fire };
});`,
    { types: COMMONFABRIC_TYPES },
  );

  // `event` is the parameter of a function type, not a runtime closure value.
  // Capturing it emits `event: event` at the applied handler site, where the
  // DOM global is undefined and the required handler context becomes invalid.
  assertStringIncludes(output, "const __cfHandler_1");
  assertFalse(output.includes("event: event"));
  assertFalse(output.includes('required: ["event"]'));
});
