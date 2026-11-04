import { assert, assertMatch, assertNotMatch } from "@std/assert";
import { StaticCache } from "@commonfabric/static";
import { transformSource } from "../utils.ts";

const staticCache = StaticCache.fromFileSystem();
const commonfabric = await staticCache.getText("types/commonfabric.d.ts");
const commonfabricSchema = await staticCache.getText(
  "types/commonfabric-schema.d.ts",
);
const options = {
  types: {
    "commonfabric.d.ts": commonfabric,
    "commonfabric-schema.d.ts": commonfabricSchema,
  },
};

Deno.test("Closure Transformer hoists nested computed callbacks that close over module-scoped helpers", async () => {
  const source = `    import { computed, pattern, UI } from "commonfabric";

    const formatDateShort = (dateStr: string) => dateStr.toUpperCase();

    export default pattern<{ values: string[] }>((state) => ({
      [UI]: (
        <div>
          {state.values.map((dateStr) => (
            <span>
              {computed(() => formatDateShort(dateStr))}
            </span>
          ))}
        </div>
      ),
    }));
`;

  const output = await transformSource(source, options);
  const normalized = output.replace(/\s+/g, " ");

  // After CT-1644 Phase 2 the computed lowers to a lift whose WHOLE call is
  // hoisted to a module-scope `const __cfLift_N = __cfHelpers.lift(...)`, with
  // the callback inline (no separate `__cfModuleCallback` hardened wrapper —
  // CT-1644 subsumes lift from the CT-1585 callback hoister). The hoisted
  // const is module-scope, which is the property this test guards: a computed
  // closing over the module-scoped helper `formatDateShort` becomes a named,
  // module-scope, self-contained unit.
  // lift is function-first: the callback leads, schemas trail. The hoisted call
  // carries explicit `<In, Out>` type args, so match `lift<…>(` then the callback.
  const hoistedMatch = normalized.match(
    /const (__cfLift_\d+) = __cfHelpers\.lift<[\s\S]*?>\(\(\{ dateStr \}\) => formatDateShort\(dateStr\)/,
  );

  assert(hoistedMatch, `expected hoisted lift in output:\n${output}`);

  const hoistedName = hoistedMatch[1]!;
  // The original site applies the captures to the hoisted name.
  assertMatch(
    normalized,
    new RegExp(`${hoistedName}\\(\\{ dateStr: dateStr \\}\\)`),
  );
});

Deno.test("Closure Transformer does not hoist nested handler callbacks that also capture factory parameters", async () => {
  const source = `    import { handler } from "commonfabric";

    const normalize = (value: string) => value.trim();

    export const makeHandler = (allowed: string[]) =>
      handler((event: { status?: string } | undefined) => {
        const status = normalize(event?.status ?? "");
        if (!allowed.includes(status)) {
          return;
        }
      });
`;

  const output = await transformSource(source, options);
  const normalized = output.replace(/\s+/g, " ");

  assertNotMatch(
    normalized,
    /const \S+ = __cfHardenFn\(\(event: \{ status\?: string \} \| undefined\) =>/,
  );
  assertMatch(
    normalized,
    /const makeHandler = .*handler\(.*\(event: \{ status\?: string; \} \| undefined\) => \{.*allowed\.includes\(status\)/,
  );
});

Deno.test("CT-1655: whole synthesized mapWithPattern pattern() call is hoisted to module scope", async () => {
  // Source shape: a .map() callback whose body invokes a module-level
  // pattern factory (`EntryRow`) and reads a module-level constant
  // (`UI`). After the closure transformer rewrites .map() to
  // `.mapWithPattern(__cfHelpers.pattern(cb, inSchema, outSchema), { params })`,
  // the synthesized pattern callback closes only over module-scoped references —
  // there are no per-call-site captures (the params object is empty).
  //
  // CT-1585 originally hoisted just the *callback* to `__cfModuleCallback_N`.
  // CT-1655 instead hoists the WHOLE `pattern(...)` call (the first argument of
  // mapWithPattern) to a module-scope `const __cfPattern_N = __cfHelpers
  // .pattern(...)`, with the callback inline, and rewrites the mapWithPattern
  // first argument to reference the hoisted name. (Hoisting the callback here
  // too — the CT-1585 mechanic — would double-hoist into a module-load TDZ, so
  // `pattern` is removed from that hoister's set.) The property this test
  // guards is unchanged: a module-scope-only pattern becomes a named,
  // module-scope, self-contained unit.
  const source = `    import { pattern, UI } from "commonfabric";

    interface Entry { piece: string }
    interface RowOutput { rendered: string; [UI]: string }

    const EntryRow = pattern<Entry, RowOutput>((input) => ({
      rendered: input.piece,
      [UI]: input.piece,
    }));

    export default pattern<{ filtered: Entry[] }>(({ filtered }) => ({
      [UI]: (
        <div>
          {filtered.map((entry) => {
            const row = EntryRow({ piece: entry.piece });
            return row[UI];
          })}
        </div>
      ),
    }));
`;

  const output = await transformSource(source, options);
  const normalized = output.replace(/\s+/g, " ");

  // The whole pattern() call is hoisted to module scope with its callback
  // inline. Hoisting runs *after* PatternCallbackLowering, so the inline
  // callback has the fully-lowered shape
  // `__cf_pattern_input => { const entry = __cf_pattern_input.key("element"); ... }`.
  // The exact const name is generated; capture it for the call-site assertion.
  const hoistedMatch = normalized.match(
    /const (__cfPattern_\d+) = __cfHelpers\.pattern\(\s*__cf_pattern_input\b/,
  );
  assert(
    hoistedMatch,
    `expected whole pattern() call hoisted to module scope. Output was:\n${output}`,
  );

  const hoistedName = hoistedMatch[1]!;
  // The mapWithPattern call site references the hoisted name as its first
  // argument (callback no longer inline at the site).
  assertMatch(
    normalized,
    new RegExp(`mapWithPattern\\(\\s*${hoistedName}\\b`),
  );
  // And the CT-1585 callback-hoist no longer fires for pattern (no separate
  // hardened `__cfModuleCallback_N` wrapper for this callback).
  assertNotMatch(
    normalized,
    /const __cfModuleCallback_\d+ = __cfHardenFn\(\(?__cf_pattern_input\b/,
  );
});
