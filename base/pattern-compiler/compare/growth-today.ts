/**
 * Measures what one change of a list costs today's runtime, on the
 * patterns of `fixtures/lists.tsx` that today's runtime compiles, at
 * several lengths of the list: the runs of a scheduler action, the
 * commits of the storage, the documents that the commits changed and
 * their bytes, each document whole, and the wall time. It is what
 * `growth.ts` measures of the executor, as far as today's runtime has
 * the counter.
 *
 * `deno run -A --no-check base/pattern-compiler/compare/growth-today.ts [lengths]`
 *
 * The cases are a `map` over an array of references, a `map` over an
 * array of plain values in place, which today's runtime keys by
 * position, and a `map` over the result of a `filter` of plain values in
 * place. Today's runtime has no `ArrayByKey`. Each change is a write to
 * the argument cell in a transaction of its own, and the counts are of
 * everything up to the next time the runtime is idle with the result
 * read.
 */
import { Identity } from "@commonfabric/identity";

import {
  getTimingStatsBreakdown,
  resetAllTimingStats,
} from "../../logger/src/logger.ts";
import { type Cell, sendEvent } from "../../../runtime/runner/src/cell.ts";
import { Runtime } from "../../../runtime/runner/src/runtime.ts";
import { StorageManager } from "../../../runtime/runner/src/storage/cache.deno.ts";

const SOURCE = `/// <cts-enable />
import { pattern } from "commonfabric";

interface Item {
  id: string;
  title: string;
  done: boolean;
}

export const Plain = pattern<{ items: Item[] }>(({ items }) => {
  const rows = items.map((item) => ({ label: \`\${item.title}:\${item.done}\` }));
  return { rows };
});

export const Chained = pattern<{ items: Item[] }>(({ items }) => {
  const open = items.filter((item) => !item.done);
  const rows = open.map((item) => ({ label: \`\${item.title}:\${item.done}\` }));
  return { rows };
});
`;

const item = (index: number) => ({
  id: `i${index}`,
  title: `t${index}`,
  done: false,
});

type Case = { name: string; pattern: string; references: boolean };

const CASES: Case[] = [
  { name: "references", pattern: "Plain", references: true },
  {
    name: "plain values in place, keyed by position",
    pattern: "Plain",
    references: false,
  },
  { name: "result of a filter", pattern: "Chained", references: false },
];

/** One measured change. */
export type MeasuredToday = {
  case: string;
  length: number;
  operation: string;
  actions: number;
  commits: number;
  documents: number;
  bytes: number;
  milliseconds: number;
};

const count = (name: string): number => {
  let found = 0;
  for (const [logger, keys] of Object.entries(getTimingStatsBreakdown())) {
    for (const [key, stats] of Object.entries(keys)) {
      if (`${logger}/${key}`.startsWith(name)) found += stats.count;
    }
  }
  return found;
};

/** Measures the changes of one case at one length, each on a new run. */
export const measureToday = async (
  { name, pattern, references }: Case,
  length: number,
): Promise<MeasuredToday[]> => {
  const measured: MeasuredToday[] = [];
  const run = async (
    operation: string,
    change: (
      items: Cell<unknown[]>,
      // deno-lint-ignore no-explicit-any
      made: (index: number) => unknown,
    ) => void,
  ) => {
    const signer = await Identity.fromPassphrase(
      `pattern-compiler-growth ${name} ${length} ${operation}`,
    );
    const space = signer.did();
    const storageManager = StorageManager.emulate({ as: signer });
    const runtime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager,
    });
    const changed = new Map<string, { id: string; scope?: string }>();
    storageManager.subscribe({
      // deno-lint-ignore no-explicit-any
      next(notification: any) {
        if (notification.type !== "commit") return undefined;
        for (const { address } of notification.changes) {
          changed.set(JSON.stringify([address.id, address.scope]), address);
        }
        return undefined;
      },
    });
    const taken = () => {
      // deno-lint-ignore no-explicit-any
      const replica = storageManager.open(space as any).replica as any;
      let bytes = 0;
      for (const { id, scope } of changed.values()) {
        bytes += (JSON.stringify(replica.getDocument(id, scope)) ?? "").length;
      }
      return { documents: changed.size, bytes };
    };
    try {
      const compiled = await runtime.patternManager.compilePattern(
        {
          main: "/main.tsx",
          files: [{ name: "/main.tsx", contents: SOURCE }],
          mainExport: pattern,
        },
        { space },
      );
      resetAllTimingStats();
      changed.clear();
      const began = performance.now();
      const start = runtime.edit();
      // deno-lint-ignore no-explicit-any
      const made = (index: number, tx: any) => {
        if (!references) return item(index);
        const cell = runtime.getCell(space, `item ${index}`, undefined, tx);
        cell.set(item(index));
        return cell;
      };
      const argument = {
        items: Array.from({ length }, (_, index) => made(index, start)),
      };
      const result = runtime.getCell<Record<string, unknown>>(
        space,
        `growth ${name}`,
        compiled.resultSchema,
        start,
      );
      runtime.run(start, compiled, argument, result);
      runtime.prepareTxForCommit(start);
      const { error } = await start.commit().settled;
      if (error !== undefined) throw error;
      const read = async () => {
        await result.pull();
        await runtime.settled();
        const tx = runtime.edit();
        try {
          JSON.stringify(result.withTx(tx).get());
        } finally {
          tx.abort();
        }
      };
      await read();
      if (operation === "settle") {
        measured.push({
          case: name,
          length,
          operation,
          actions: count("scheduler/scheduler/run/action"),
          commits: count("storage.v2.transaction/commit/commitNative"),
          ...taken(),
          milliseconds: Math.round((performance.now() - began) * 100) / 100,
        });
        return;
      }
      resetAllTimingStats();
      changed.clear();
      const at = performance.now();
      const tx = runtime.edit();
      const items = result.getArgumentCell<{ items: unknown[] }>()!.withTx(tx)
        .key("items") as unknown as Cell<unknown[]>;
      change(items, (index) => made(index, tx));
      runtime.prepareTxForCommit(tx);
      const written = await tx.commit().settled;
      if (written.error !== undefined) throw written.error;
      await read();
      measured.push({
        case: name,
        length,
        operation,
        actions: count("scheduler/scheduler/run/action"),
        commits: count("storage.v2.transaction/commit/commitNative"),
        ...taken(),
        milliseconds: Math.round((performance.now() - at) * 100) / 100,
      });
    } finally {
      await runtime.dispose();
      await storageManager.close();
    }
  };
  await run("settle", () => {});
  await run("append", (items, made) => {
    items.push(made(length));
  });
  // A removal and a prepend are written as a handler writes them: the
  // array that the cell gives, changed, is set again.
  await run("prepend", (items, made) => {
    items.set([made(length), ...items.get()]);
  });
  await run("edit one field", (items) => {
    // deno-lint-ignore no-explicit-any
    (items.key(0) as any).key("title").set("edited");
  });
  await run("remove first", (items) => {
    items.set(items.get().slice(1));
  });
  await run("remove last", (items) => {
    items.set(items.get().slice(0, -1));
  });
  return measured;
};

const ROWS = `/// <cts-enable />
import { handler, lift, pattern, Writable } from "commonfabric";

interface Item {
  id: string;
  title: string;
  done: boolean;
}

const toggle = handler<unknown, { open: Writable<boolean> }>((_, { open }) => {
  open.set(!open.get());
});

const rename = handler<{ text: string }, { item: Writable<Item> }>(
  (event, { item }) => {
    item.key("title").set(event.text);
  },
);

const loud = lift((input: { title: string }) => input.title.toUpperCase());

const Detail = pattern<{ item: Item }>(({ item }) => {
  const note = Writable.of("");
  return { title: item.title, note };
});

export const Plain = pattern<{ items: Item[] }>(({ items }) => {
  const rows = items.map((item) => {
    const open = Writable.of(false);
    return {
      loud: loud({ title: item.title }),
      open,
      toggle: toggle({ open }),
      rename: rename({ item }),
      detail: Detail({ item }),
    };
  });
  return { rows };
});
`;

/**
 * What one keystroke in the title of one row costs today's runtime, on
 * the pattern of `fixtures/rows-state.tsx` without `asInstance()`,
 * which today's runtime does not have: the child of a row is the
 * pattern called in the body. The array is one of plain values in
 * place, which today's runtime keys by position. The mean over twenty
 * events, each sent when the runtime was idle.
 */
export const keystrokesToday = async (length: number) => {
  const signer = await Identity.fromPassphrase(
    `pattern-compiler-keystrokes ${length}`,
  );
  const space = signer.did();
  const storageManager = StorageManager.emulate({ as: signer });
  const runtime = new Runtime({
    apiUrl: new URL(import.meta.url),
    storageManager,
  });
  const changed = new Map<string, { id: string; scope?: string }>();
  let changes = 0;
  storageManager.subscribe({
    // deno-lint-ignore no-explicit-any
    next(notification: any) {
      if (notification.type !== "commit") return undefined;
      for (const { address } of notification.changes) {
        changes += 1;
        changed.set(JSON.stringify([address.id, address.scope]), address);
      }
      return undefined;
    },
  });
  try {
    const compiled = await runtime.patternManager.compilePattern(
      {
        main: "/main.tsx",
        files: [{ name: "/main.tsx", contents: ROWS }],
        mainExport: "Plain",
      },
      { space },
    );
    const start = runtime.edit();
    const result = runtime.getCell<Record<string, unknown>>(
      space,
      "keystrokes",
      compiled.resultSchema,
      start,
    );
    runtime.run(start, compiled, {
      items: Array.from({ length }, (_, index) => item(index)),
    }, result);
    runtime.prepareTxForCommit(start);
    const { error } = await start.commit().settled;
    if (error !== undefined) throw error;
    const read = async () => {
      await result.pull();
      await runtime.settled();
      const tx = runtime.edit();
      try {
        JSON.stringify(result.withTx(tx).get());
      } finally {
        tx.abort();
      }
    };
    await read();
    const total = changed.size;
    resetAllTimingStats();
    changed.clear();
    changes = 0;
    const strokes = 20;
    const row = Math.floor(length / 2);
    const at = performance.now();
    for (let stroke = 1; stroke <= strokes; stroke++) {
      sendEvent(
        result.key("rows").key(row).key("rename") as Cell<unknown>,
        { text: "x".repeat(stroke) } as never,
      );
      await read();
    }
    const milliseconds = (performance.now() - at) / strokes;
    // deno-lint-ignore no-explicit-any
    const replica = storageManager.open(space as any).replica as any;
    let bytes = 0;
    for (const { id, scope } of changed.values()) {
      bytes += (JSON.stringify(replica.getDocument(id, scope)) ?? "").length;
    }
    return {
      case: "plain values in place, keyed by position (today's runtime)",
      length,
      documentsAfterSettle: total,
      actions: count("scheduler/scheduler/run/action") / strokes,
      commits: count("storage.v2.transaction/commit/commitNative") / strokes,
      documentChanges: changes / strokes,
      distinctDocuments: changed.size,
      bytesOfThoseDocuments: bytes,
      milliseconds: Math.round(milliseconds * 100) / 100,
    };
  } finally {
    await runtime.dispose();
    await storageManager.close();
  }
};

if (import.meta.main && Deno.args[0] === "keystrokes") {
  for (const length of Deno.args.slice(1).map(Number)) {
    console.log(JSON.stringify(await keystrokesToday(length)));
  }
} else if (import.meta.main) {
  const lengths = Deno.args.length > 0
    ? Deno.args.map(Number)
    : [100, 1_000, 10_000];
  for (const one of CASES) {
    for (const length of lengths) {
      for (const row of await measureToday(one, length)) {
        console.log(JSON.stringify(row));
      }
    }
  }
}
