import { join } from "@std/path";
import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";

import { runDenoCommandWithTemporaryLock } from "@commonfabric/test-support/isolated-deno";

const ROOT = join(import.meta.dirname!, "..", "..");

/**
 * Exported streams that a pattern wires straight to a rendered button, as
 * `onClick={stream}`, each with the pattern that declares it.
 */
const CLICK_STREAMS = [
  { path: "packages/patterns/profile-roster-live-demo.tsx", stream: "join" },
  { path: "packages/patterns/shared-profile-roster/main.tsx", stream: "join" },
  {
    path: "packages/patterns/profile-group-chat/main.tsx",
    stream: "sendMessage",
  },
  {
    path: "packages/patterns/scoped-group-chat/main-plain-inputs.tsx",
    stream: "sendMessage",
  },
  {
    path: "packages/patterns/scoped-group-chat/main-with-writable-inputs.tsx",
    stream: "sendMessage",
  },
];

async function compiledSchema(path: string): Promise<Record<string, any>> {
  const output = await runDenoCommandWithTemporaryLock({
    root: ROOT,
    cwd: ROOT,
    args: (lockPath) => [
      "run",
      "--config",
      join(ROOT, "deno.jsonc"),
      "--lock",
      lockPath,
      "--allow-net",
      "--allow-ffi",
      "--allow-read",
      "--allow-write",
      "--allow-env",
      "--allow-run",
      join(ROOT, "packages/cli/mod.ts"),
      "check",
      path,
      "--pattern-json",
    ],
  });
  expect(output.code, new TextDecoder().decode(output.stderr)).toBe(0);
  const stdout = new TextDecoder().decode(output.stdout);
  return JSON.parse(stdout.slice(stdout.indexOf("{")));
}

function resolved(schema: Record<string, any>, node: Record<string, any>) {
  const ref = typeof node.$ref === "string" ? node.$ref : undefined;
  if (!ref) return node;
  // A `$ref` that resolves to nothing must fail here, not pass below: an
  // unresolved reference would read as "no `additionalProperties`" and turn
  // this guard off silently.
  const key = ref.replace(/^#\/\$defs\//, "");
  const target = schema.$defs?.[key];
  expect(target, `${ref} does not resolve in $defs`).toBeInstanceOf(Object);
  return { ...target, ...node, $ref: undefined };
}

describe("rendered-click-streams", () => {
  // A rendered click reaches its stream as the serialized DOM event, which
  // always carries `type`, and the runner refuses any payload with an
  // undeclared field against an event schema declaring `additionalProperties:
  // false` — the schema `Record<PropertyKey, never>` compiles to. Each case
  // reads the compiled contract the way the pattern-update gate does, and
  // applies the runner's closure test to the stream's event schema.

  for (const { path, stream } of CLICK_STREAMS) {
    describe(path, () => {
      it(`declares no closed event schema on the \`${stream}\` stream`, async () => {
        const pattern = await compiledSchema(path);
        const streamSchema = pattern.resultSchema.properties[stream];
        expect(streamSchema.asCell).toContain("stream");
        const event = resolved(pattern.resultSchema, streamSchema);
        expect(event.additionalProperties).not.toBe(false);
      });
    });
  }
});
