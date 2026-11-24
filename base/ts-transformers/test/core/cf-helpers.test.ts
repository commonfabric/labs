import { assertMatch } from "@std/assert";
import { transformCfDirective } from "../../src/mod.ts";

Deno.test("transformCfDirective injects helpers by default", () => {
  const source = [
    'import { pattern } from "commonfabric";',
    "export default pattern<{ value: string }>(({ value }) => ({ value }));",
  ].join("\n");

  const transformed = transformCfDirective(source);

  assertMatch(
    transformed,
    /^import \{ __cfHelpers \} from "commonfabric";/m,
  );
  assertMatch(transformed, /function h\(\.\.\.args: any\[\]\)/);
});
