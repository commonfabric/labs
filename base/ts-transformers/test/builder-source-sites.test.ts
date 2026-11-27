import { expect } from "@std/expect";

import ts from "typescript";

import type { BuilderSourceSite } from "../src/core/runtime-contract.ts";
import { CommonFabricTransformerPipeline } from "../src/mod.ts";
import { COMMONFABRIC_TYPES } from "./commonfabric-test-types.ts";
import { batchTypeCheckFixtures } from "./utils.ts";
import { describe, it } from "@commonfabric/test-support/test";

const SOURCE = `import {
  computed,
  handler,
  lift,
  pattern,
  Writable,
} from "commonfabric";

const onLocal = (_: unknown, state: { value: Writable<number> }) => {
  state.value.set(1);
};
const localHandler = handler(onLocal);

function onDeclared(_: unknown, state: { value: Writable<number> }) {
  state.value.set(2);
}
const declaredHandler = handler(onDeclared);

const callbacks = {
  onProperty(_: unknown, state: { value: Writable<number> }) {
    state.value.set(3);
  },
};
const propertyHandler = handler(callbacks.onProperty);

const exportedLift = lift((value: number) => value + 1);
export { exportedLift as alpha, exportedLift as beta };

export default pattern<{ value: number }>(({ value }) => {
  const derived = computed(() => value + 2);
  return { derived };
});
`;

/** Returns the authored location where `marker` begins. */
function locationOf(
  marker: string,
  source = SOURCE,
): { line: number; col: number } {
  const offset = source.indexOf(marker);
  if (offset < 0) throw new Error(`Missing marker: \`${marker}\``);
  const prefix = source.slice(0, offset);
  const lines = prefix.split("\n");
  return { line: lines.length, col: lines.at(-1)?.length ?? 0 };
}

describe("builder-source-sites", () => {
  it("records runtime symbols beside unchanged emitted JavaScript", async () => {
    const fileName = "/main.tsx";
    const { program } = await batchTypeCheckFixtures(
      { [fileName]: SOURCE },
      { types: COMMONFABRIC_TYPES },
    );
    const original = program.getSourceFile(fileName);
    if (!original) throw new Error("Fixture source was not loaded.");

    const pipeline = new CommonFabricTransformerPipeline({
      builderSourceSites: {
        // The fixture harness injects the one-line Common Fabric helper import.
        mapSite: (_name, site): BuilderSourceSite => ({
          ...site,
          line: site.line - 1,
        }),
      },
    });
    const transformed = ts.transform(
      original,
      pipeline.toFactories(program),
    );
    try {
      const output = ts.createPrinter().printFile(transformed.transformed[0]);
      const sidecar = pipeline.getBuilderSourceSites().get(fileName);
      expect(sidecar?.formatVersion).toBe(1);
      expect(sidecar?.sites.localHandler).toEqual({
        ...locationOf("(_: unknown, state: { value: Writable<number> }) =>"),
        bindingName: "onLocal",
      });
      expect(sidecar?.sites.declaredHandler).toEqual({
        ...locationOf(
          "function onDeclared(_: unknown, state: { value: Writable<number> })",
        ),
        bindingName: "onDeclared",
      });
      // Reaching a callback through a property access is a compile error —
      // the module verifier cannot follow it, so the module is refused at
      // load, and stage 7 says so
      // (`transformers/indirect-builder-callback-validation.test.ts` pins that
      // diagnostic). Recording is independent of that rejection and is pinned
      // here anyway: this is the only coverage of the anchor-less fallback,
      // where no callback anchor is recoverable and the site comes from the
      // builder call itself. Read it as coverage of that fallback, never as a
      // spelling a pattern may use.
      expect(sidecar?.sites.propertyHandler).toEqual({
        ...locationOf("handler(callbacks.onProperty)"),
        bindingName: "propertyHandler",
      });
      expect(sidecar?.sites.alpha).toEqual({
        ...locationOf("(value: number) => value + 1"),
        bindingName: "exportedLift",
      });
      expect(sidecar?.sites.beta).toEqual(sidecar?.sites.alpha);
      expect(sidecar?.sites.default).toEqual(
        locationOf("({ value }) =>"),
      );

      const hoistedLift = Object.entries(sidecar?.sites ?? {}).find(
        ([symbol]) => /^__cfLift_\d+$/.test(symbol),
      );
      expect(hoistedLift?.[1]).toEqual({
        ...locationOf("() => value + 2"),
        bindingName: "derived",
      });
      expect(output).not.toContain("__cfBindVerifiedBinding");
      expect(output).not.toContain("bindingName");
      expect(output).not.toContain("formatVersion");
    } finally {
      transformed.dispose();
    }
  });

  it("records no site for a builder the compiler wrote itself", async () => {
    // Lowering the computed-key destructure synthesizes a whole
    // `lift(({ element, __cf_val_key }) => element[__cf_val_key])`; neither
    // that call nor its callback has an authored position.
    const source = `import { pattern, UI } from "commonfabric";

const dynamicKey = "value" as const;

interface Item {
  value: number;
}

export default pattern<{ items: Item[] }>((state) => ({
  [UI]: (
    <div>
      {state.items.map(({ [dynamicKey]: val }) => <span>{val}</span>)}
    </div>
  ),
}));
`;
    const fileName = "/main.tsx";
    const { program } = await batchTypeCheckFixtures(
      { [fileName]: source },
      { types: COMMONFABRIC_TYPES },
    );
    const original = program.getSourceFile(fileName);
    if (!original) throw new Error("Fixture source was not loaded.");

    const pipeline = new CommonFabricTransformerPipeline({
      builderSourceSites: {
        mapSite: (_name, site): BuilderSourceSite => ({
          ...site,
          line: site.line - 1,
        }),
      },
    });
    const transformed = ts.transform(original, pipeline.toFactories(program));
    try {
      const output = ts.createPrinter().printFile(transformed.transformed[0]);
      expect(output).toContain(
        "const __cfLift_1 = __cfHelpers.lift<",
      );
      const sites = pipeline.getBuilderSourceSites().get(fileName)?.sites ??
        {};
      expect(Object.hasOwn(sites, "__cfLift_1")).toBe(false);
      // The authored map callback beside it still has its site.
      expect(sites.__cfPattern_1).toEqual(
        locationOf("({ [dynamicKey]: val }) =>", source),
      );
      expect(sites.default).toEqual(locationOf("(state) =>", source));
    } finally {
      transformed.dispose();
    }
  });

  it("does not label compiler coordinates as authored without a mapper", async () => {
    const fileName = "/main.tsx";
    const { program } = await batchTypeCheckFixtures(
      { [fileName]: SOURCE },
      { types: COMMONFABRIC_TYPES },
    );
    const original = program.getSourceFile(fileName);
    if (!original) throw new Error("Fixture source was not loaded.");

    const pipeline = new CommonFabricTransformerPipeline();
    const transformed = ts.transform(original, pipeline.toFactories(program));
    try {
      expect(pipeline.getBuilderSourceSites().get(fileName)).toBeUndefined();
    } finally {
      transformed.dispose();
    }
  });
});
