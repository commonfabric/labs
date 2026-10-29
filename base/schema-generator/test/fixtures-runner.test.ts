import { assert, assertEquals, assertThrows } from "@std/assert";
import { expect } from "@std/expect";
import { ensureDir } from "@std/fs/ensure-dir";
import { dirname, resolve } from "@std/path";
import ts from "typescript";

import {
  createUnifiedDiff,
  defineFixtureSuite,
} from "@commonfabric/test-support/fixture-runner";
import {
  FabricPrimitive,
  type FabricValue,
  valueEqual,
} from "@commonfabric/data-model";
import { JsonCodecEngine } from "@commonfabric/data-model/codec-json";
import {
  fabricFromJsonValue,
  jsonFromFabricValue,
} from "@commonfabric/data-model/codecs";
import { FabricBytes } from "@commonfabric/data-model/fabric-primitives";
import { isObjectOrArray } from "@commonfabric/utils/types";
import { SchemaGenerator } from "../src/schema-generator.ts";
import {
  batchTypeCheckFixtures,
  getTypeFromCode,
  normalizeSchema,
} from "./utils.ts";

interface SchemaResult {
  normalized: unknown;
  serialized: string;
}

const TYPE_NAME = "SchemaRoot";
const FIXTURES_ROOT = "./test/fixtures/schema";

// Environment variable filtering for faster iteration
const fixtureFilter = Deno.env.get("FIXTURE");

// PERFORMANCE OPTIMIZATION: Batch Type-Checking
//
// Input fixture type-checking is ENABLED BY DEFAULT. Set SKIP_INPUT_CHECK=1 to disable.
//
// We batch type-check all fixtures upfront in a single TypeScript program instead of
// creating separate programs per fixture for significant performance improvement.
let batchedDiagnostics: Map<string, ts.Diagnostic[]> | undefined;

if (!Deno.env.get("SKIP_INPUT_CHECK")) {
  console.log("Batch type-checking schema fixtures...");
  const start = performance.now();

  // Load all fixture input files
  const fixtures: Record<string, string> = {};
  for await (const entry of Deno.readDir(FIXTURES_ROOT)) {
    if (entry.isFile && entry.name.endsWith(".input.ts")) {
      const fullPath = `${FIXTURES_ROOT}/${entry.name}`;
      const content = await Deno.readTextFile(fullPath);
      fixtures[fullPath] = content;
    }
  }

  batchedDiagnostics = await batchTypeCheckFixtures(fixtures);

  // Check for errors
  let hasErrors = false;
  for (const [filePath, diagnostics] of batchedDiagnostics) {
    const errors = diagnostics.filter((d) =>
      d.category === ts.DiagnosticCategory.Error
    );
    if (errors.length > 0) {
      hasErrors = true;
      console.error(`\nType errors in ${filePath}:`);
      for (const diag of errors) {
        const message = ts.flattenDiagnosticMessageText(diag.messageText, "\n");
        if (diag.file && diag.start !== undefined) {
          const { line, character } = diag.file.getLineAndCharacterOfPosition(
            diag.start,
          );
          console.error(`  Line ${line + 1}, Col ${character + 1}: ${message}`);
        } else {
          console.error(`  ${message}`);
        }
      }
    }
  }

  if (hasErrors) {
    console.error("\n" + "=".repeat(60));
    console.error("INPUT VALIDATION FAILED");
    console.error(
      "Fix the type errors above, or run with SKIP_INPUT_CHECK=1 to skip.",
    );
    console.error("=".repeat(60) + "\n");
    Deno.exit(1);
  }

  console.log(
    `  -> ${Object.keys(fixtures).length} fixtures in ${
      (performance.now() - start).toFixed(0)
    }ms`,
  );
}

defineFixtureSuite<SchemaResult, string>({
  suiteName: "Schema fixtures",
  rootDir: FIXTURES_ROOT,
  expectedPath: ({ stem }) => `${stem}.expected.json`,
  skip: (fixture) => {
    if (fixtureFilter && fixture.baseName !== fixtureFilter) {
      return true;
    }
    return false;
  },
  async execute(fixture) {
    return await runSchemaTransform(fixture.inputPath);
  },
  async loadExpected(fixture) {
    return await Deno.readTextFile(fixture.expectedPath);
  },
  async determinismCheck(actual, fixture) {
    const rerun = await runSchemaTransform(fixture.inputPath);
    expect(actual.serialized).toEqual(rerun.serialized);
  },
  compare(actual, expectedText, fixture) {
    let expectedValue;
    try {
      expectedValue = decodeGolden(expectedText);
    } catch (error) {
      throw new Error(
        `Golden decoding failed for ${fixture.id}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }

    // A generated schema is a `FabricValue`; `normalizeArrayOrdering` is typed
    // loosely because it walks arbitrary structure.
    const normalizedActual = normalizeArrayOrdering(
      actual.normalized,
    ) as FabricValue;
    const normalizedExpected = normalizeArrayOrdering(
      expectedValue,
    ) as FabricValue;

    // `valueEqual` is the value model's own equality: `Object.is` at primitive
    // leaves, so -0 does not pass as 0 and NaN equals itself, and it knows the
    // whole `FabricValue` vocabulary the decoded golden can contain.
    if (!valueEqual(normalizedActual, normalizedExpected)) {
      const diff = createUnifiedDiff(
        expectedText.trim(),
        actual.serialized.trim(),
      );
      const message = [
        "",
        `Fixture semantic mismatch for ${fixture.id}`,
        `Input:    ${resolve(fixture.inputPath)}`,
        `Expected: ${resolve(fixture.expectedPath)}`,
        "",
        "=== UNIFIED DIFF (expected vs actual) ===",
        diff,
      ].join("\n");
      throw new Error(message);
    }
  },
  async updateGolden(actual, fixture) {
    await writeText(fixture.expectedPath, actual.serialized);
  },
});

async function runSchemaTransform(inputPath: string): Promise<SchemaResult> {
  const code = await Deno.readTextFile(inputPath);
  const { type, checker, typeNode } = await getTypeFromCode(code, TYPE_NAME);
  const transformer = new SchemaGenerator();
  const normalized = normalizeSchema(
    transformer.generateSchema(type, checker, typeNode),
  );
  return { normalized, serialized: encodeGolden(normalized) };
}

/**
 * Render a value as golden-file text: its fabric JSON encoding, pretty-printed.
 *
 * `JSON.stringify()` cannot represent every `FabricValue`, and the schema
 * generator is free to produce ones it cannot. Worse, it mostly does not refuse
 * them: it substitutes quietly, rendering `-0` as `0` and `NaN` and the
 * infinities as `null`. (A bigint is the exception that throws outright.) A
 * golden that cannot hold a value cannot guard it, and a golden that silently
 * flattens one agrees with buggy output instead of catching it. The fabric
 * encoding has a representation for every `FabricValue`, so the golden holds
 * whatever the generator produced.
 *
 * The encoding's prefix tag identifies it on the wire but is not part of the
 * JSON, so it cannot survive pretty-printing. Taking it off and putting it back
 * goes through `JsonCodecEngine`'s test-only helpers, which is what keeps the tag
 * defined in exactly one place. Key order needs no help: a conforming encoder
 * emits plain-object keys in canonical order.
 */
function encodeGolden(value: unknown): string {
  const body = JSON.parse(
    JsonCodecEngine.unwrapEncodedValueForTesting(
      jsonFromFabricValue(value as FabricValue),
    ),
  );
  return JSON.stringify(body, null, 2) + "\n";
}

/** Inverse of {@link encodeGolden}. */
function decodeGolden(text: string): unknown {
  return fabricFromJsonValue(
    JsonCodecEngine.wrapEncodedValueForTesting(text.trim()),
  );
}

async function writeText(path: string, data: string) {
  await ensureDir(dirname(path));
  await Deno.writeTextFile(path, data);
}

function normalizeArrayOrdering(obj: unknown): unknown {
  if (Array.isArray(obj)) {
    return obj.map(normalizeArrayOrdering);
  }
  // A `FabricPrimitive` (`FabricBytes` and the like) has no enumerable own
  // properties, so `Object.entries` would flatten it to `{}` and hide whatever
  // it carried -- and then `valueEqual`, which this feeds, would compare two
  // different primitives as equal. Treat it as a leaf.
  //
  // TODO(danfuzz): A `FabricInstance` (the other `FabricSpecialObject`
  // subclass) is NOT a leaf -- it wraps nested `FabricValue`s -- but there is
  // no faithful `Object.entries` descent for it either, so it still flattens to
  // `{}` here. Handle it when the golden path needs to carry one.
  if (
    isObjectOrArray(obj) && !(obj instanceof FabricPrimitive)
  ) {
    const entries = Object.entries(obj as Record<string, unknown>)
      .map(([key, value]) => {
        if (key === "required" && Array.isArray(value)) {
          return [key, [...value].sort()];
        }
        return [key, normalizeArrayOrdering(value)];
      });
    return Object.fromEntries(entries);
  }
  return obj;
}

//
// The golden format exists to hold values plain JSON cannot. Guard that
// directly: a fixture cannot reach these values on its own yet, and a golden
// that silently flattens them would agree with buggy output instead of
// catching it.
//

Deno.test("golden encoding preserves values JSON cannot represent", () => {
  const schema = {
    type: "object",
    properties: {
      negZero: { type: "number", default: -0 },
      nan: { type: "number", default: NaN },
      inf: { type: "number", default: Infinity },
      negInf: { type: "number", default: -Infinity },
      big: { type: "integer", default: 12345678901234567890n },
      ordinary: { type: "number", default: -1 },
    },
  };

  const decoded = decodeGolden(encodeGolden(schema)) as {
    properties: Record<string, { default: unknown }>;
  };
  const back = decoded.properties;

  // Asserted leaf by leaf with `Object.is`: a structural compare would let -0
  // through as 0, which is one of the conflations under test.
  assert(Object.is(back.negZero!.default, -0), "-0 lost its sign");
  assert(Object.is(back.nan!.default, NaN), "NaN did not survive");
  assertEquals(back.inf!.default, Infinity);
  assertEquals(back.negInf!.default, -Infinity);
  assertEquals(back.big!.default, 12345678901234567890n);
  assertEquals(back.ordinary!.default, -1);

  assert(valueEqual(schema as FabricValue, decoded as FabricValue));
});

Deno.test("plain JSON would lose exactly those values", () => {
  // Not a test of our code -- an executable statement of why the golden format
  // is what it is. If these ever stop holding, the encoding indirection can go.
  const roundTrip = (v: unknown) => JSON.parse(JSON.stringify({ v })).v;

  assert(Object.is(roundTrip(-0), 0), "JSON kept the sign of -0");
  assertEquals(roundTrip(NaN), null);
  assertEquals(roundTrip(Infinity), null);
  assertEquals(roundTrip(-Infinity), null);
  assertThrows(() => JSON.stringify({ v: 1n }), TypeError);
});

Deno.test("golden compare keeps `FabricSpecialObject`s distinct, not flattened to {}", () => {
  // Both normalizers walk objects by key. A `FabricSpecialObject` has no
  // enumerable own properties, so walking it flattens it to `{}` -- and then
  // `valueEqual` sees only `{}` on each side and calls two different values
  // equal. That is exactly the silent agreement this whole harness exists to
  // rule out, so it has to hold for special objects too, not only for the
  // special numbers that motivated the format.
  //
  // The generator does not mint a `FabricBytes` default today, so the
  // post-`normalizeSchema` shape is built directly and driven through the same
  // encode -> decode -> normalize -> `valueEqual` path the fixture runner uses.
  const schemaWithBytes = (bytes: number[]) =>
    ({
      type: "object",
      properties: { blob: { type: "string" } },
      default: { blob: new FabricBytes(new Uint8Array(bytes)) },
    }) as unknown as Record<string, unknown>;

  // "Expected" side: as a golden would be read back and normalized.
  const throughGolden = (normalized: Record<string, unknown>) =>
    normalizeArrayOrdering(
      decodeGolden(encodeGolden(normalized)),
    ) as FabricValue;

  // "Actual" side: as the runner normalizes fresh output.
  const actual = normalizeArrayOrdering(
    normalizeSchema(schemaWithBytes([1, 2, 3])),
  ) as FabricValue;

  // Same bytes still compare equal after the full round trip.
  expect(
    valueEqual(
      actual,
      throughGolden(normalizeSchema(schemaWithBytes([1, 2, 3]))),
    ),
  )
    .toBe(true);

  // Different bytes are still seen as different. This is the assertion that
  // fails if either normalizer flattens the `FabricBytes` to `{}`.
  expect(
    valueEqual(
      actual,
      throughGolden(normalizeSchema(schemaWithBytes([4, 5, 6]))),
    ),
  )
    .toBe(false);
});
