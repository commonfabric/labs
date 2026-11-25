import { expect } from "@std/expect";
import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { Identity } from "@commonfabric/identity";

import type { Artifact } from "../../../../base/pattern-compiler/exec/executor.ts";
import { argumentOf } from "../../../../base/pattern-compiler/exec/store.ts";
import type { Cell, MemorySpace } from "../../src/cell.ts";
import {
  type CompiledPiece,
  startCompiledPiece,
} from "../../src/compiled/piece.ts";
import { isWriteRedirectLink, parseLink } from "../../src/link-utils.ts";
import { Runtime } from "../../src/runtime.ts";
import { openStorage } from "./storage.ts";

const FIXTURE = new URL(
  "../../../../base/pattern-compiler/compare/fixtures/cell-writes",
  import.meta.url,
);

/** The pattern `name` of `fixtures/cell-writes.tsx`, as the crate emits it. */
const artifact = async (name: string): Promise<Artifact> => {
  const [{ patterns }] = JSON.parse(
    await Deno.readTextFile(new URL(`${FIXTURE.href}.emit.json`)),
  ) as { patterns: Artifact[] }[];
  return patterns.find((pattern) => pattern.name === name)!;
};

type Path = "today's path" | "compiled piece";

interface Item {
  title: string;
}

/**
 * `fixtures/cell-writes.tsx`: `Writer`'s handlers write cells that are
 * inputs of the pattern, and `Owner` returns state cells it makes. Each
 * pattern runs either on today's path, compiled from the same source, or as
 * a compiled piece. Today's path is the reference: what a write does there
 * is what a write of a compiled piece has to do.
 */
describe("a write through a cell that another document holds", () => {
  let space: MemorySpace;
  let runtime: Runtime;
  const pieces: CompiledPiece[] = [];
  const cancels: (() => void)[] = [];

  beforeEach(async () => {
    const signer = await Identity.fromPassphrase("compiled cell writes");
    space = signer.did();
    runtime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager: openStorage(signer),
      cfcFlowLabels: "persist",
      experimental: { compiledPatterns: true },
      servingPosture: true,
    });
  });

  afterEach(async () => {
    for (const cancel of cancels.splice(0)) cancel();
    for (const piece of pieces.splice(0)) piece.stop();
    await runtime.scheduler.idleWithPendingCommits();
    await runtime.dispose();
  });

  const settled = async () => {
    await runtime.idle();
    await runtime.scheduler.idleWithPendingCommits();
  };

  const commit = async (write: (tx: ReturnType<Runtime["edit"]>) => void) => {
    const tx = runtime.edit();
    write(tx);
    runtime.prepareTxForCommit(tx);
    expect((await tx.commit().settled).error).toBeUndefined();
    await settled();
  };

  /** The value a cell holds, with every link followed. */
  const valueOf = <T>(cell: Cell<T>): T => {
    const tx = runtime.edit();
    try {
      return JSON.parse(JSON.stringify(cell.withTx(tx).get())) as T;
    } finally {
      tx.abort?.();
    }
  };

  /**
   * Runs the pattern `name` of the fixture on `path`, over `argument`, with
   * its result in the document `id`.
   */
  const run = async (
    path: Path,
    name: string,
    argument: Record<string, unknown>,
    id: string,
  ): Promise<Cell<Record<string, unknown>>> => {
    const result = runtime.getCell<Record<string, unknown>>(space, id);
    if (path === "compiled piece") {
      const compiled = await artifact(name);
      await commit((tx) => {
        const piece = startCompiledPiece(
          runtime,
          tx,
          compiled,
          argument,
          result.withTx(tx),
        );
        pieces.push(piece);
      });
      expect(pieces.at(-1)!.refusals).toEqual([]);
      return result;
    }
    const source = await Deno.readTextFile(new URL(`${FIXTURE.href}.tsx`));
    const pattern = await runtime.patternManager.compilePattern({
      main: "/main.tsx",
      files: [{
        name: "/main.tsx",
        contents: `${source}\nexport default ${name};\n`,
      }],
    }, { space });
    const given = runtime.getCell<Record<string, unknown>>(
      space,
      `${id} argument`,
    );
    await commit((tx) => given.withTx(tx).set(argument));
    await commit((tx) => {
      runtime.run(tx, pattern, given, result.withTx(tx));
    });
    cancels.push(result.sink(() => {}));
    await settled();
    return result;
  };

  /** Sends `event` to the stream `stream` of a result, and settles. */
  const send = async (
    result: Cell<Record<string, unknown>>,
    stream: string,
    event: unknown,
  ) => {
    result.key(stream).send(event as never);
    await settled();
  };

  /** The document a stored link at `key` of `holder` names, and whether it is a write redirect. */
  const storedLink = (holder: Cell<Record<string, unknown>>, key: string) => {
    const tx = runtime.edit();
    try {
      const raw = holder.withTx(tx).getRaw() as Record<string, unknown>;
      const link = parseLink(raw[key], holder);
      return {
        id: link?.id,
        redirect: isWriteRedirectLink(raw[key]),
      };
    } finally {
      tx.abort?.();
    }
  };

  const idOf = (cell: Cell<unknown>) => cell.getAsNormalizedFullLink().id;

  for (const writer of ["today's path", "compiled piece"] as const) {
    describe(`a handler on the ${writer} given a cell whose position holds a write redirect`, () => {
      /**
       * A holder document whose `count` and `selected` are write redirects
       * to a number and to an item, and the writer over them.
       */
      const started = async () => {
        const count = runtime.getCell<number>(space, "redirected count");
        const item = runtime.getCell<Item>(space, "redirected item");
        const other = runtime.getCell<Item>(space, "other item");
        const holder = runtime.getCell<Record<string, unknown>>(
          space,
          "holder of redirects",
        );
        await commit((tx) => {
          count.withTx(tx).set(1);
          item.withTx(tx).set({ title: "first" });
          other.withTx(tx).set({ title: "other" });
          holder.withTx(tx).setRaw({
            count: count.getAsWriteRedirectLink({ base: holder }),
            selected: item.getAsWriteRedirectLink({ base: holder }),
          } as never);
        });
        const result = await run(writer, "Writer", {
          target: holder.key("count"),
          selected: holder.key("selected"),
          other,
          owner: holder,
        }, `writer over redirects on the ${writer}`);
        return { count, item, other, holder, result };
      };

      it("writes a value to the target of the redirect, and keeps the redirect", async () => {
        const { count, holder, result } = await started();

        await send(result, "put", { value: 5 });

        expect(valueOf(count)).toBe(5);
        expect(storedLink(holder, "count")).toEqual({
          id: idOf(count),
          redirect: true,
        });
      });

      it("writes a reference to another cell to the target of the redirect, and keeps the redirect", async () => {
        const { item, holder, result } = await started();

        await send(result, "point", {});

        expect(storedLink(holder, "selected")).toEqual({
          id: idOf(item),
          redirect: true,
        });
        expect(valueOf(holder.key("selected"))).toEqual({ title: "other" });
      });

      it("writes a member below the cell in the target of the redirect", async () => {
        const { item, holder, result } = await started();

        await send(result, "rename", { title: "renamed" });

        expect(valueOf(item)).toEqual({ title: "renamed" });
        expect(storedLink(holder, "selected")).toEqual({
          id: idOf(item),
          redirect: true,
        });
      });

      it("writes a value reached by key through the holder to the target of the redirect", async () => {
        const { count, holder, result } = await started();

        await send(result, "putIn", { value: 7 });

        expect(valueOf(count)).toBe(7);
        expect(storedLink(holder, "count")).toEqual({
          id: idOf(count),
          redirect: true,
        });
      });
    });
  }

  for (const writer of ["today's path", "compiled piece"] as const) {
    describe(`a handler on the ${writer} that writes a record at the top of a chain of write redirects and plain links`, () => {
      // The chain of `schema-links.test.ts` ("with asCell: returns Cell
      // pointing one step past first non-redirect"), with `=>` a write
      // redirect and `->` a plain link:
      // start => redir => first -> second -> data, and a holder whose
      // `ref` => redir. A write follows the redirects and replaces the
      // plain link it reaches.
      const started = async () => {
        const cell = (name: string) =>
          runtime.getCell<unknown>(space, `chain ${name}`);
        const [data, second, first, redir, start, holder] = [
          "data",
          "second",
          "first",
          "redir",
          "start",
          "holder",
        ].map(cell);
        await commit((tx) => {
          data.withTx(tx).set({ test: "foo" });
          second.withTx(tx).setRaw(data.getAsLink() as never);
          first.withTx(tx).setRaw(second.getAsLink() as never);
          redir.withTx(tx).setRaw(first.getAsWriteRedirectLink() as never);
          start.withTx(tx).setRaw(redir.getAsWriteRedirectLink() as never);
          holder.withTx(tx).setRaw(
            { ref: redir.getAsWriteRedirectLink() } as never,
          );
        });
        const result = await run(
          writer,
          "Writer",
          { chain: start, holder },
          `writer of a chain on the ${writer}`,
        );
        return { data, second, first, redir, start, result };
      };

      /** The stored value of `cell`, and the document a link there names. */
      const raw = (cell: Cell<unknown>) => {
        const tx = runtime.edit();
        try {
          const value = cell.withTx(tx).getRaw();
          const link = parseLink(value, cell);
          return link === undefined ? { value } : {
            link: link.id,
            redirect: isWriteRedirectLink(value),
          };
        } finally {
          tx.abort?.();
        }
      };

      for (const stream of ["replace", "replaceIn"]) {
        it(`replaces the plain link of the first position past the redirects, through \`${stream}\``, async () => {
          const { data, second, first, redir, start, result } = await started();

          await send(result, stream, {});

          expect(raw(first)).toEqual({ value: { test: "replaced" } });
          expect(raw(second)).toEqual({ link: idOf(data), redirect: false });
          expect(valueOf(data)).toEqual({ test: "foo" });
          expect(raw(redir)).toEqual({ link: idOf(first), redirect: true });
          expect(raw(start)).toEqual({ link: idOf(redir), redirect: true });
        });
      }
    });
  }

  /** The stored value at `cell`, or the position a link stored there names. */
  const pointerAt = (cell: Cell<unknown>) => {
    const tx = runtime.edit();
    try {
      const value = cell.withTx(tx).getRaw();
      const link = parseLink(value, cell);
      return link === undefined ? { value } : {
        id: link.id,
        path: [...link.path],
        redirect: isWriteRedirectLink(value),
      };
    } finally {
      tx.abort?.();
    }
  };

  const positionOf = (cell: Cell<unknown>) => {
    const { id, path } = cell.getAsNormalizedFullLink();
    return { id, path: [...path], redirect: false };
  };

  for (const writer of ["today's path", "compiled piece"] as const) {
    describe(`a handler on the ${writer} that stores what a cell it is given is into another cell`, () => {
      // The handler is given `selected` and writes `{ current: … }` to
      // `kept`: `keepValue` the value `selected.get()` reads,
      // `keepResolved` the cell `selected.resolveAsCell()` gives, and
      // `keepCell` `selected` itself. `resolveAsCell()` follows every
      // link. A value read from a cell carries a position, and writing it
      // stores a link to that position. Here the two paths differ. On
      // today's path the position is the cell's own past its write
      // redirects (`toCell` in `back-to-cell.ts`), and a handler is given
      // its cell one link past the position its state names, so that a
      // state cell that holds a link gives the handler the cell the link
      // names. A compiled piece gives a handler that position itself, past
      // the link of an argument alone, and a read follows one link past
      // the write redirects and gives the position it reaches
      // (`Handle.#fromPosition`), so that each read of a cell of cells
      // gives one level.
      const today = writer === "today's path";

      describe("given the position of a holder that holds a plain link to an item document", () => {
        const started = async () => {
          const item = runtime.getCell<Item>(space, "selection item");
          const next = runtime.getCell<Item>(space, "next item");
          const holder = runtime.getCell<Record<string, unknown>>(
            space,
            "selection holder",
          );
          const kept = runtime.getCell<Record<string, unknown>>(space, "kept");
          await commit((tx) => {
            item.withTx(tx).set({ title: "first" });
            next.withTx(tx).set({ title: "next" });
            holder.withTx(tx).setRaw(
              { selected: item.getAsLink({ base: holder }) } as never,
            );
            kept.withTx(tx).set({ current: { title: "none" } });
          });
          const result = await run(writer, "Writer", {
            selected: holder.key("selected"),
            kept,
          }, `keeper of a holder's link on the ${writer}`);
          /** Points the holder's position at the next item. */
          const repoint = () =>
            commit((tx) =>
              holder.withTx(tx).key("selected").setRaw(
                next.getAsLink({ base: holder }) as never,
              )
            );
          return { item, holder, kept, result, repoint };
        };

        it("stores a plain link to the holder's position through `keepCell`, which names the item the position is pointed at after", async () => {
          const { holder, kept, result, repoint } = await started();

          await send(result, "keepCell", {});
          const stored = pointerAt(kept.key("current"));
          await repoint();

          expect(stored).toEqual(positionOf(holder.key("selected")));
          expect(valueOf(kept.key("current"))).toEqual({ title: "next" });
        });

        it("stores a plain link to the item document through `keepResolved`, which names that item after the holder's position is pointed at another", async () => {
          const { item, kept, result, repoint } = await started();

          await send(result, "keepResolved", {});
          const stored = pointerAt(kept.key("current"));
          await repoint();

          expect(stored).toEqual(positionOf(item));
          expect(valueOf(kept.key("current"))).toEqual({ title: "first" });
        });

        if (today) {
          it("stores a plain link to the holder's position through `keepValue`, which names the item the position is pointed at after", async () => {
            const { holder, kept, result, repoint } = await started();

            await send(result, "keepValue", {});
            const stored = pointerAt(kept.key("current"));
            await repoint();

            expect(stored).toEqual(positionOf(holder.key("selected")));
            expect(valueOf(kept.key("current"))).toEqual({ title: "next" });
          });
        } else {
          it("stores a plain link to the item document through `keepValue`, which names that item after the holder's position is pointed at another", async () => {
            const { item, kept, result, repoint } = await started();

            await send(result, "keepValue", {});
            const stored = pointerAt(kept.key("current"));
            await repoint();

            expect(stored).toEqual(positionOf(item));
            expect(valueOf(kept.key("current"))).toEqual({ title: "first" });
          });
        }

        it(
          today
            ? "stores a plain link to the item document for what value code returns of a read of the cell"
            : "stores a plain link to the input's position in the argument for what value code returns of a read of the cell",
          async () => {
            // `Reader` returns `computed(() => ({ current: selected.get() }))`.
            // Today's runtime reads the cell as a value input and points at
            // the end of its links. The crate emits the read as the input
            // itself, which points at the input's position in the argument:
            // the value is the same, and value code is evaluated again when
            // what the position leads to changes, so where it points matters
            // to no reader of the value.

            const { item, holder } = await started();

            const reader = await run(writer, "Reader", {
              selected: holder.key("selected"),
            }, `reader of a holder's link on the ${writer}`);

            expect(pointerAt(reader.key("snapshot").key("current"))).toEqual(
              today ? positionOf(item) : {
                id: `of:${argumentOf(idOf(reader))}`,
                path: ["selected"],
                redirect: false,
              },
            );
            expect(valueOf(reader.key("snapshot").key("current"))).toEqual({
              title: "first",
            });
          },
        );
      });

      describe("given the position of a holder that holds a plain link to an item in place in the holder's list", () => {
        const started = async () => {
          const holder = runtime.getCell<Record<string, unknown>>(
            space,
            "list holder",
          );
          const kept = runtime.getCell<Record<string, unknown>>(space, "kept");
          await commit((tx) => {
            holder.withTx(tx).setRaw({
              items: [{ title: "first" }, { title: "next" }],
              selected: holder.key("items").key(0).getAsLink({ base: holder }),
            } as never);
            kept.withTx(tx).set({ current: { title: "none" } });
          });
          const result = await run(writer, "Writer", {
            selected: holder.key("selected"),
            kept,
          }, `keeper of a list position on the ${writer}`);
          /** Points the holder's position at the next item of the list. */
          const repoint = () =>
            commit((tx) =>
              holder.withTx(tx).key("selected").setRaw(
                holder.key("items").key(1).getAsLink({ base: holder }) as never,
              )
            );
          return { holder, kept, result, repoint };
        };

        it("stores a plain link to the holder's position through `keepCell`, which names the item the position is pointed at after", async () => {
          const { holder, kept, result, repoint } = await started();

          await send(result, "keepCell", {});
          const stored = pointerAt(kept.key("current"));
          await repoint();

          expect(stored).toEqual(positionOf(holder.key("selected")));
          expect(valueOf(kept.key("current"))).toEqual({ title: "next" });
        });

        if (today) {
          it("stores a plain link to the holder's position through `keepValue`, which names the item the position is pointed at after", async () => {
            const { holder, kept, result, repoint } = await started();

            await send(result, "keepValue", {});
            const stored = pointerAt(kept.key("current"));
            await repoint();

            expect(stored).toEqual(positionOf(holder.key("selected")));
            expect(valueOf(kept.key("current"))).toEqual({ title: "next" });
          });

          it("stores a copy of the item through `keepResolved`, which is that item after the holder's position is pointed at another", async () => {
            // `resolveAsCell()` gives a cell of a snapshot of an element
            // in place in an array (`maybeConvertArrayPathToImmutableLink`
            // in `cell.ts`), and a write stores its value.

            const { kept, result, repoint } = await started();

            await send(result, "keepResolved", {});
            const stored = pointerAt(kept.key("current"));
            await repoint();

            expect(stored).toEqual({ value: { title: "first" } });
            expect(valueOf(kept.key("current"))).toEqual({ title: "first" });
          });
        } else {
          it("stores a copy of the item through `keepValue`, which is that item after the holder's position is pointed at another", async () => {
            // The read follows the holder's link to a plain value in place,
            // which a body reads as a copy (ruling Z25).

            const { kept, result, repoint } = await started();

            await send(result, "keepValue", {});
            const stored = pointerAt(kept.key("current"));
            await repoint();

            expect(stored).toEqual({ value: { title: "first" } });
            expect(valueOf(kept.key("current"))).toEqual({ title: "first" });
          });

          it("stores a plain link to the item's position in the list through `keepResolved`, which names that item after the holder's position is pointed at another", async () => {
            const { holder, kept, result, repoint } = await started();

            await send(result, "keepResolved", {});
            const stored = pointerAt(kept.key("current"));
            await repoint();

            expect(stored).toEqual(positionOf(holder.key("items").key(0)));
            expect(valueOf(kept.key("current"))).toEqual({ title: "first" });
          });
        }
      });

      describe("given a state cell of its pattern that holds a plain link to the item a handler chose", () => {
        // `Selector`'s `selectFirst` and `selectSecond` write
        // `selected.set(item)` to its state cell `selected`.

        const started = async () => {
          const first = runtime.getCell<Item>(space, "first item");
          const second = runtime.getCell<Item>(space, "second item");
          const kept = runtime.getCell<Record<string, unknown>>(space, "kept");
          await commit((tx) => {
            first.withTx(tx).set({ title: "first" });
            second.withTx(tx).set({ title: "second" });
            kept.withTx(tx).set({ current: { title: "none" } });
          });
          const result = await run(writer, "Selector", {
            first,
            second,
            kept,
          }, `selector on the ${writer}`);
          await send(result, "selectFirst", {});
          return { first, second, kept, result };
        };

        for (const stream of ["keepValue", "keepResolved"]) {
          it(`stores a plain link to the chosen item's document through \`${stream}\``, async () => {
            const { first, kept, result } = await started();

            await send(result, stream, {});

            expect(pointerAt(kept.key("current"))).toEqual(positionOf(first));
          });
        }

        if (today) {
          it("stores a plain link to the chosen item's document through `keepCell`", async () => {
            const { first, kept, result } = await started();

            await send(result, "keepCell", {});

            expect(pointerAt(kept.key("current"))).toEqual(positionOf(first));
          });

          it("writes a link to the second item into the first item's document when the second is chosen", async () => {
            // The handler is given the first item's cell, one link past the
            // state cell, so `selected.set(second)` lands there.

            const { first, second, result } = await started();

            await send(result, "selectSecond", {});

            expect(valueOf(result.key("shown"))).toBe("second");
            expect(pointerAt(first)).toEqual(positionOf(second));
          });
        } else {
          it("stores a plain link to the state cell through `keepCell`", async () => {
            const { kept, result } = await started();

            await send(result, "keepCell", {});

            expect(pointerAt(kept.key("current"))).toEqual({
              ...pointerAt(result.key("selected")),
              redirect: false,
            });
          });

          it("leaves the first item's document as it was when the second is chosen", async () => {
            const { first, result } = await started();

            await send(result, "selectSecond", {});

            expect(valueOf(result.key("shown"))).toBe("second");
            expect(pointerAt(first)).toEqual({ value: { title: "first" } });
          });
        }
      });

      describe("given an item document itself", () => {
        const started = async () => {
          const item = runtime.getCell<Item>(space, "given item");
          const kept = runtime.getCell<Record<string, unknown>>(space, "kept");
          await commit((tx) => {
            item.withTx(tx).set({ title: "first" });
            kept.withTx(tx).set({ current: { title: "none" } });
          });
          const result = await run(writer, "Writer", {
            selected: item,
            kept,
          }, `keeper of an item on the ${writer}`);
          return { item, kept, result };
        };

        for (const stream of ["keepValue", "keepResolved", "keepCell"]) {
          it(`stores a plain link to the item document through \`${stream}\``, async () => {
            const { item, kept, result } = await started();

            await send(result, stream, {});

            expect(pointerAt(kept.key("current"))).toEqual(positionOf(item));
          });
        }
      });

      for (const owner of ["today's path", "compiled piece"] as const) {
        describe(`given a state cell that a pattern on the ${owner} returns`, () => {
          const started = async () => {
            const kept = runtime.getCell<Record<string, unknown>>(
              space,
              "kept",
            );
            await commit((tx) =>
              kept.withTx(tx).set({ current: { title: "none" } })
            );
            const owned = await run(
              owner,
              "Owner",
              { label: "owned" },
              `owner on the ${owner}`,
            );
            const result = await run(writer, "Writer", {
              selected: owned.key("selected"),
              kept,
            }, `keeper of the owner on the ${writer}`);
            return { owned, kept, result };
          };

          for (const stream of ["keepValue", "keepResolved"]) {
            it(`stores a plain link to the state cell through \`${stream}\``, async () => {
              const { owned, kept, result } = await started();

              await send(result, stream, {});

              expect(pointerAt(kept.key("current"))).toEqual(
                positionOf(owned.key("selected").resolveAsCell()),
              );
            });
          }

          it("stores a plain link to the result's position through `keepCell`", async () => {
            const { owned, kept, result } = await started();

            await send(result, "keepCell", {});

            expect(pointerAt(kept.key("current"))).toEqual(
              positionOf(owned.key("selected")),
            );
          });
        });
      }
    });
  }

  for (const owner of ["today's path", "compiled piece"] as const) {
    for (const writer of ["today's path", "compiled piece"] as const) {
      describe(`a handler on the ${writer} that writes a state cell a pattern on the ${owner} returns`, () => {
        const started = async () => {
          const other = runtime.getCell<Item>(space, "other item");
          await commit((tx) => other.withTx(tx).set({ title: "other" }));
          const owned = await run(
            owner,
            "Owner",
            { label: "owned" },
            `owner on the ${owner}`,
          );
          const result = await run(writer, "Writer", {
            target: owned.key("count"),
            selected: owned.key("selected"),
            other,
            owner: owned,
          }, `writer of the owner on the ${writer}`);
          return { owned, result };
        };

        it("writes a value that the owner then reads", async () => {
          const { owned, result } = await started();

          await send(result, "put", { value: 5 });

          expect(valueOf(owned.key("doubled"))).toBe(10);
          expect(valueOf(owned.key("count"))).toBe(5);
        });

        it("writes a value from what it reads, which the owner then reads", async () => {
          const { owned, result } = await started();

          await send(result, "bump", {});

          expect(valueOf(owned.key("doubled"))).toBe(4);
        });

        it("writes a reference to another cell that the owner then reads through", async () => {
          const { owned, result } = await started();

          await send(result, "point", {});

          expect(valueOf(owned.key("shown"))).toBe("owned: other");
        });

        it("writes a member below the cell that the owner then reads", async () => {
          const { owned, result } = await started();

          await send(result, "rename", { title: "renamed" });

          expect(valueOf(owned.key("shown"))).toBe("owned: renamed");
        });

        it("writes a value reached by key through the owner's result that the owner then reads", async () => {
          const { owned, result } = await started();

          await send(result, "putIn", { value: 7 });

          expect(valueOf(owned.key("doubled"))).toBe(14);
        });

        it("writes a member reached by key through the owner's result that the owner then reads", async () => {
          const { owned, result } = await started();

          await send(result, "renameIn", { title: "by key" });

          expect(valueOf(owned.key("shown"))).toBe("owned: by key");
        });
      });
    }
  }
});
