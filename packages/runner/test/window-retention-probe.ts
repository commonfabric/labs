// Retained heap while a list projects a window over a long list.
//
//   deno run -A --v8-flags=--expose-gc \
//     packages/runner/test/window-retention-probe.ts [shape] [moves] \
//     [rowBytes] [walk]
//
// Two movement patterns, selected by the fourth argument:
//   toggle (default) — the window alternates between two positions, so every
//                      move re-shows rows the run has already shown
//   walk             — the window steps forward, so every move shows a
//                      position the run has never shown, the way a reader
//                      pages forward through a long list
//
// Shapes select what the projection does with each element:
//   inline   — elements are plain values, the element pattern returns fields
//   child    — the element pattern also instantiates a nested pattern
//   cells    — elements are stable child cells, projected the same way
//   opaque   — elements are stable child cells, and the nested pattern takes
//              one of them as an opaque cell input
//   index    — rows live in their own documents, linked from an index
//              document, each carrying rowBytes of filler and an opaque
//              manifest the row does not read
//
// The heap is reported after a forced collection, so the figures are reachable
// memory rather than uncollected garbage.

import { Identity } from "@commonfabric/identity";
import { Runtime } from "../src/runtime.ts";
import { StorageManager } from "../src/storage/cache.deno.ts";
import type { RuntimeProgram } from "../src/harness/types.ts";

const signer = await Identity.fromPassphrase("window retention probe");
const space = signer.did();

const WINDOW_SIZE = 20;

const PROGRAMS: Record<string, string> = {
  inline: `
import { computed, pattern } from 'commonfabric';

const Row = pattern<{ label: string }, { label: string; shout: string }>(
  ({ label }) => ({ label, shout: computed(() => label + '!') }),
);

export default pattern<
  { items: { label: string }[]; start: number; size: number }
>(({ items, start, size }) => {
  const shown = computed(() => items.slice(start, start + size));
  return { rows: shown.map((item) => Row({ label: item.label })) };
});
`,
  child: `
import { computed, pattern } from 'commonfabric';

const Detail = pattern<{ label: string }, { text: string }>(
  ({ label }) => ({ text: computed(() => 'detail ' + label) }),
);

const Row = pattern<
  { label: string },
  { label: string; detail: { text: string } }
>(({ label }) => ({ label, detail: Detail({ label }) }));

export default pattern<
  { items: { label: string }[]; start: number; size: number }
>(({ items, start, size }) => {
  const shown = computed(() => items.slice(start, start + size));
  return { rows: shown.map((item) => Row({ label: item.label })) };
});
`,
  cells: `
import { computed, type OpaqueCell, pattern } from 'commonfabric';

interface Payload {}

const Detail = pattern<{ label: string }, { text: string }>(
  ({ label }) => ({ text: computed(() => 'detail ' + label) }),
);

const Row = pattern<
  { label: string; payload: OpaqueCell<Payload> },
  { label: string; detail: { text: string } }
>(({ label }) => ({ label, detail: Detail({ label }) }));

export default pattern<
  {
    items: { label: string; payload: OpaqueCell<Payload> }[];
    start: number;
    size: number;
  }
>(({ items, start, size }) => {
  const shown = computed(() => items.slice(start, start + size));
  return {
    rows: shown.map((item) => Row({ label: item.label, payload: item.payload })),
  };
});
`,
  opaque: `
import { computed, type OpaqueCell, pattern } from 'commonfabric';

interface Payload {}

const Detail = pattern<
  { label: string; payload: OpaqueCell<Payload> },
  { text: string }
>(({ label }) => ({ text: computed(() => 'detail ' + label) }));

const Row = pattern<
  { label: string; payload: OpaqueCell<Payload> },
  { label: string; detail: { text: string } }
>(({ label, payload }) => ({ label, detail: Detail({ label, payload }) }));

export default pattern<
  {
    items: { label: string; payload: OpaqueCell<Payload> }[];
    start: number;
    size: number;
  }
>(({ items, start, size }) => {
  const shown = computed(() => items.slice(start, start + size));
  return {
    rows: shown.map((item) => Row({ label: item.label, payload: item.payload })),
  };
});
`,
  index: `
import { computed, type OpaqueCell, pattern } from 'commonfabric';

interface Manifest {}

interface RowInput {
  label: string;
  filler: string;
  manifest: OpaqueCell<Manifest>;
}

const Detail = pattern<
  { label: string; manifest: OpaqueCell<Manifest> },
  { text: string }
>(({ label }) => ({ text: computed(() => 'detail ' + label) }));

const Row = pattern<
  { element: RowInput },
  { label: string; size: number; detail: { text: string } }
>(({ element }) => ({
  label: element.label,
  size: computed(() => (element.filler ?? '').length),
  detail: Detail({ label: element.label, manifest: element.manifest }),
}));

export default pattern<
  {
    index: { rows: OpaqueCell<RowInput>[] };
    start: number;
    size: number;
  }
>(({ index, start, size }) => {
  const shown = computed(() => (index?.rows ?? []).slice(start, start + size));
  // deno-lint-ignore no-explicit-any
  const projected = (shown as any).mapWithPattern(Row as any, {});
  return { rows: projected };
});
`,
};

const shape = Deno.args[0] ?? "child";
const moves = Number(Deno.args[1] ?? 10);
const rowBytes = Number(Deno.args[2] ?? 100);
const walk = Deno.args[3] === "walk";
// A walk needs a position per move, plus the two the warm-up visits.
const rowCount = walk ? WINDOW_SIZE * (moves + 2) : WINDOW_SIZE * 4;
const source = PROGRAMS[shape];
if (source === undefined) {
  throw new Error(`unknown shape ${shape}; try ${Object.keys(PROGRAMS)}`);
}
const program: RuntimeProgram = {
  main: "/main.tsx",
  files: [{ name: "/main.tsx", contents: source }],
};

const gc = (globalThis as { gc?: () => void }).gc;
function heapMb(): number {
  gc?.();
  gc?.();
  gc?.();
  return Deno.memoryUsage().heapUsed / 1024 / 1024;
}

const storageManager = StorageManager.emulate({ as: signer });
const runtime = new Runtime({
  apiUrl: new URL(import.meta.url),
  storageManager,
});
try {
  const compiled = await runtime.patternManager.compilePattern(program, {
    space,
  });
  const tx = runtime.edit();
  const usesCells = shape === "cells" || shape === "opaque";
  const items = Array.from({ length: rowCount }, (_, index) => {
    if (!usesCells) return { label: `row-${index}` };
    const payload = runtime.getCell<{ text: string }>(
      space,
      `payload-${index}`,
      undefined,
      tx,
    );
    payload.set({ text: `payload ${index}` });
    return { label: `row-${index}`, payload };
  });
  const result = runtime.getCell<{ rows: unknown[] }>(
    space,
    "window-result",
    compiled.resultSchema,
    tx,
  );
  const argument = runtime.getCell<
    { items: unknown; index?: unknown; start: number; size: number }
  >(space, "window-argument", undefined, tx);
  if (shape === "index") {
    // Rows live in their own documents, linked from an index document, the way
    // a connector publishes a session index.
    const rows = Array.from({ length: rowCount }, (_, position) => {
      const manifest = runtime.getCell<{ text: string }>(
        space,
        `manifest-${position}`,
        undefined,
        tx,
      );
      manifest.set({ text: `manifest ${position}` });
      const row = runtime.getCell<
        { label: string; filler: string; manifest: unknown }
      >(space, `row-${position}`, undefined, tx);
      row.set({
        label: `row-${position}`,
        filler: "x".repeat(rowBytes),
        manifest,
      });
      return row;
    });
    const indexCell = runtime.getCell<{ rows: unknown[] }>(
      space,
      "window-index",
      undefined,
      tx,
    );
    indexCell.set({ rows });
    argument.set({ index: indexCell, items: [], start: 0, size: WINDOW_SIZE });
  } else {
    argument.set({ items, start: 0, size: WINDOW_SIZE });
  }
  runtime.run(tx, compiled, argument, result);
  await tx.commit().settled;
  const stopReading = result.key("rows").sink(() => {});
  await runtime.idle();

  const moveWindow = async (start: number) => {
    const moveTx = runtime.edit();
    argument.withTx(moveTx).key("start").set(start);
    await moveTx.commit().settled;
    await runtime.idle();
  };
  await moveWindow(WINDOW_SIZE);
  await moveWindow(0);

  const baseline = heapMb();
  console.log(
    `shape=${shape} rows=${rowCount} window=${WINDOW_SIZE} ` +
      `moves=${moves} ${walk ? "walk" : "toggle"}`,
  );
  console.log(
    `after the window has visited both positions: ${baseline.toFixed(1)} MB`,
  );
  for (let move = 0; move < moves; move++) {
    await moveWindow(
      walk ? (move + 2) * WINDOW_SIZE : move % 2 === 0 ? WINDOW_SIZE : 0,
    );
    if (walk || move % 2 === 1) {
      const heap = heapMb();
      console.log(
        `after ${move + 1} more moves: ${heap.toFixed(1)} MB ` +
          `(+${(heap - baseline).toFixed(1)})`,
      );
    }
  }
  stopReading();
} finally {
  await runtime.dispose();
  await storageManager.close();
}
