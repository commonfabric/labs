import { expect } from "@std/expect";
import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";

import { Identity } from "@commonfabric/identity";

import {
  instanceNameOfPartialCause,
  instancePartialCause,
  nameInstance,
} from "../../src/builder/instance-name.ts";
import { lift } from "../../src/builder/module.ts";
import { pattern, popFrame, pushFrame } from "../../src/builder/pattern.ts";
import { stream } from "../../src/builder/reactive.ts";
import type { Frame, Pattern } from "../../src/builder/types.ts";
import { Runtime } from "../../src/runtime.ts";
import { StorageManager } from "../../src/storage/cache.deno.ts";

const signer = await Identity.fromPassphrase("instance-name");
const space = signer.did();

describe("instance-name", () => {
  let runtime: Runtime;
  let storageManager: ReturnType<typeof StorageManager.emulate>;
  let frame: Frame;

  beforeEach(() => {
    storageManager = StorageManager.emulate({ as: signer });
    runtime = new Runtime({ apiUrl: new URL(import.meta.url), storageManager });
    frame = pushFrame({
      space,
      generatedIdCounter: 0,
      reactives: new Set(),
      runtime,
    });
  });

  afterEach(async () => {
    popFrame(frame);
    await runtime?.dispose();
    await storageManager?.close();
  });

  const double = lift((x: number) => x * 2);
  const child = () =>
    pattern<{ x: number }>(({ x }) => ({ doubled: double(x) }));

  // The partial causes of the sub-pattern instances `parent` holds, in node
  // order, each with the positional cause it records in place of a name.
  const instanceCauses = (parent: Pattern) =>
    parent.nodes
      .filter((node) => (node.module as { type?: string }).type === "pattern")
      .map((node) => {
        const partialCause =
          (node.outputs as { $alias: { partialCause: unknown } }).$alias
            .partialCause;
        const descriptor = parent.derivedInternalCells?.find((candidate) =>
          JSON.stringify(candidate.partialCause) ===
            JSON.stringify(partialCause)
        );
        return {
          partialCause,
          legacyPartialCause: descriptor?.legacyPartialCause,
        };
      });

  describe("nameInstance()", () => {
    it("gives the instance its name as its partial cause, recording the positional cause it takes the place of", () => {
      const Child = child();
      const parent = pattern<{ x: number }>(({ x }) => {
        const a = nameInstance(Child({ x }), "a");
        return { views: [a] };
      });

      expect(instanceCauses(parent)).toEqual([
        {
          partialCause: instancePartialCause("a"),
          legacyPartialCause: { $generated: 0 },
        },
      ]);
    });

    it("names neither of two instances given one name", () => {
      const Child = child();
      const parent = pattern<{ x: number }>(({ x }) => {
        const a = nameInstance(Child({ x }), "a");
        const b = nameInstance(Child({ x }), "a");
        return { views: [a, b] };
      });

      const [a, b] = instanceCauses(parent);
      expect(a.partialCause).toEqual({ $generated: expect.any(Number) });
      expect(b.partialCause).toEqual({ $generated: expect.any(Number) });
      expect(a.partialCause).not.toEqual(b.partialCause);
      expect([a.legacyPartialCause, b.legacyPartialCause]).toStrictEqual([
        undefined,
        undefined,
      ]);
    });

    it("names an instance that shares its name with a stream root, and leaves the stream root at its positional cause", () => {
      const Child = child();
      const parent = pattern<{ x: number }>(({ x }) => {
        const s = nameInstance(stream<number>(), "a");
        const a = nameInstance(Child({ x }), "a");
        return { views: [s, a] };
      });

      expect({
        instances: instanceCauses(parent).map(({ partialCause }) =>
          partialCause
        ),
        streams: parent.derivedInternalCells
          ?.map(({ partialCause }) => partialCause)
          .filter((partialCause) =>
            (partialCause as { $kind?: string }).$kind === "stream"
          ),
      }).toEqual({
        instances: [instancePartialCause("a")],
        streams: [{ $generated: expect.any(Number), $kind: "stream" }],
      });
    });

    it("leaves an instance named by a result key under that key", () => {
      const Child = child();
      const parent = pattern<{ x: number }>(({ x }) => {
        const a = nameInstance(Child({ x }), "a");
        return { shown: a };
      });

      expect(instanceCauses(parent)).toStrictEqual([
        { partialCause: "shown", legacyPartialCause: undefined },
      ]);
    });

    it("leaves an instance it does not name at its positional cause", () => {
      const Child = child();
      const parent = pattern<{ x: number }>(({ x }) => {
        const a = Child({ x });
        return { views: [a] };
      });

      expect(instanceCauses(parent)).toStrictEqual([
        { partialCause: { $generated: 0 }, legacyPartialCause: undefined },
      ]);
    });

    it("returns a value that is not a cell as it is", () => {
      const value = { x: 1 };

      expect(nameInstance(value, "a")).toBe(value);
    });
  });

  describe("instancePartialCause()", () => {
    it("returns a record whose one key, `$instance`, holds the name", () => {
      expect(instancePartialCause("a")).toStrictEqual({ $instance: "a" });
    });
  });

  describe("instanceNameOfPartialCause()", () => {
    it("returns the name an instance's partial cause carries", () => {
      expect(instanceNameOfPartialCause(instancePartialCause("a"))).toBe("a");
    });

    it("returns `undefined` for a positional cause, a name under another key, and a cause with a key added", () => {
      expect([
        instanceNameOfPartialCause({ $generated: 0 }),
        instanceNameOfPartialCause({ $generated: "instance", name: "a" }),
        instanceNameOfPartialCause({ ...instancePartialCause("a"), x: 1 }),
      ]).toStrictEqual([undefined, undefined, undefined]);
    });

    it("returns `undefined` for a cause whose `$instance` is not a string", () => {
      expect(instanceNameOfPartialCause({ $instance: 1 })).toBeUndefined();
    });
  });
});
