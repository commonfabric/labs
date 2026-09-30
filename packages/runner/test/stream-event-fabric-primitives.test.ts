// A stream event payload goes through `convertCellsToLinks()` on its way to the
// handler. That walk rebuilds each plain object it meets from its enumerable
// own properties, and a `FabricPrimitive` keeps its state in private fields and
// has none — so an unguarded rebuild delivers a bare `{}` to the handler, with
// class, identity, and contents gone.

import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { Identity } from "@commonfabric/identity";
import {
  FabricBytes,
  FabricEpochNsec,
} from "@commonfabric/data-model/fabric-primitives";

import { StorageManager } from "@commonfabric/runner/storage/cache.deno";
import { convertCellsToLinks } from "../src/cell.ts";
import { Runtime } from "../src/runtime.ts";
import type { RuntimeProgram } from "../src/harness/types.ts";

const signer = await Identity.fromPassphrase("stream-event-fabric-primitives");
const space = signer.did();

// Echoes the payload's byte length back into the result, which is only
// computable if the value arrived as a real `FabricBytes`.
const FIXTURE_SRC = `
import { handler, pattern, schema, type Stream } from "commonfabric";
import "commonfabric/schema";

interface Input {
  seen: number;
}

interface Output {
  seen: number;
  record: Stream<{ payload?: unknown }>;
}

const model = schema({
  type: "object",
  properties: {
    seen: { type: "number", default: -1, asCell: ["cell"] },
  },
  default: { seen: -1 },
});

const record = handler(
  {
    type: "object",
    properties: { payload: {} },
  } as const,
  model,
  (event, state) => {
    const payload = event?.payload as { length?: number } | undefined;
    state.seen.set(typeof payload?.length === "number" ? payload.length : -1);
  },
);

export const echoPattern = pattern<Input, Output>(
  (cell) => ({ seen: cell.seen, record: record(cell) }),
  model,
);
`;

describe("stream event payloads carrying a FabricPrimitive", () => {
  describe("convertCellsToLinks() directly", () => {
    let runtime: Runtime;
    let storageManager: ReturnType<typeof StorageManager.emulate>;

    beforeEach(() => {
      storageManager = StorageManager.emulate({ as: signer });
      runtime = new Runtime({
        apiUrl: new URL(import.meta.url),
        storageManager,
      });
    });
    afterEach(async () => {
      await runtime?.dispose();
      await storageManager?.close();
    });

    it("keeps a FabricPrimitive whole at the top level", () => {
      const bytes = new FabricBytes(new Uint8Array([9, 7]));
      const out = convertCellsToLinks(bytes);
      expect(out).toBeInstanceOf(FabricBytes);
      expect([...(out as FabricBytes).slice()]).toEqual([9, 7]);
    });

    it("keeps a FabricPrimitive whole inside an object and an array", () => {
      const stamp = new FabricEpochNsec(123n);
      const wrapped = convertCellsToLinks({ stamp, n: 1 }) as {
        stamp: unknown;
        n: number;
      };
      expect(wrapped.stamp).toBeInstanceOf(FabricEpochNsec);
      expect(wrapped.n).toBe(1);

      const listed = convertCellsToLinks([stamp]) as unknown[];
      expect(listed[0]).toBeInstanceOf(FabricEpochNsec);
    });

    it("converts a native payload to a primitive rather than flattening it", () => {
      // `shallowFabricFromConvertibleJsValue()` mints the primitive just before
      // the container dispatch, so a native arrives as the converted form and
      // must survive the same way an already-built one does.
      const out = convertCellsToLinks({ payload: new Uint8Array([4, 5, 6]) });
      const payload = (out as { payload: unknown }).payload;
      expect(payload).toBeInstanceOf(FabricBytes);
      expect([...(payload as FabricBytes).slice()]).toEqual([4, 5, 6]);
    });
  });

  describe("end to end, through a handler", () => {
    let storageManager: ReturnType<typeof StorageManager.emulate>;

    beforeEach(() => {
      storageManager = StorageManager.emulate({ as: signer });
    });
    afterEach(async () => {
      await storageManager?.close();
    });

    it("delivers a FabricBytes payload to the handler intact", async () => {
      const runtime = new Runtime({
        apiUrl: new URL(import.meta.url),
        storageManager,
      });
      try {
        const program: RuntimeProgram = {
          main: "/main.tsx",
          mainExport: "echoPattern",
          files: [{ name: "/main.tsx", contents: FIXTURE_SRC }],
        };
        const tx = runtime.edit();
        const compiled = await runtime.patternManager.compilePattern(program, {
          space,
          tx,
        });
        const resultCell = runtime.getCell<Record<string, unknown>>(
          space,
          "stream-event-primitive-result",
          undefined,
          tx,
        );
        const run = runtime.run(tx, compiled, {}, resultCell);
        await tx.commit();
        await run.pull();

        run.key("record").send({
          payload: new FabricBytes(new Uint8Array([1, 2, 3, 4, 5])),
        });
        const after = await run.pull() as { seen: number };

        // A flattened `{}` has no `length`, so the handler records -1.
        expect(after.seen).toBe(5);
      } finally {
        await runtime.dispose();
      }
    });
  });
});
