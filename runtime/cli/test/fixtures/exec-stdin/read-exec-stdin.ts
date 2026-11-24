/**
 * Reads a `cf exec` payload from this process's stdin the way a callable
 * without injected readers does, and prints what it resolved to as JSON. The
 * argument is the input mode: `json` for `--json`, `value` for
 * `--value-file -`.
 */
import {
  parseExecArgs,
  resolveParsedExecInput,
} from "../../../lib/exec-schema.ts";

const mode = Deno.args[0];
const spec = {
  callableKind: "tool" as const,
  defaultVerb: "run" as const,
  inputSchema: mode === "json"
    ? {
      type: "object" as const,
      properties: { n: { type: "number" as const } },
    }
    : { type: "number" as const },
};
const parsed = parseExecArgs(
  spec,
  mode === "json" ? ["--json"] : ["--value-file", "-"],
);
console.log(JSON.stringify(await resolveParsedExecInput(spec, parsed)));
