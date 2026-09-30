// The RULED unresolved-input lift semantics (OW51, owner ruling
// 2026-08-21, option (a) — ow51-build-report.md §0):
//
//   "server-side should match the current client behavior exactly. also
//    note that with the lazy proxy based evaluation a lift can throw a
//    specific error and mark a tx aborted with that reason and that
//    should also be handled just like an unresolved input, i.e. being
//    retriggered when any of the reads so far change (just like a
//    regular call), and the output being `undefined`."
//
// The semantics under pin, stated once: a lift read whose LINK CHAIN
// dead-ends at a HOP TARGET the replica cannot serve (the doc is not
// there — not yet arrived, or genuinely never written) is an UNRESOLVED
// INPUT: the run is disposed as a non-event — output `undefined`, no
// action failure — with the reads so far registered, so the run
// re-triggers when any of them change (the arriving doc included). A
// dead-end at the handle's OWN root doc is NOT this shape: a fresh
// cell's doc does not exist until its first write, and the pervasive
// `cell.get() ?? fallback` idiom relies on reading `undefined` there
// (the schema default arm handles declared defaults). The line is the
// FOLLOWED HOP: a link that points into a doc we cannot serve is
// pending; a handle whose own doc is absent is absent.
//
// OW51's production shape (default-app: note.tsx's `pendingEdit.get()`
// mid-callback returning `undefined` where the schema says
// `string|null`, crashing `splitDefinitions` on BOTH the browser client
// and the toolshed's serving runtime — ow51-undefined-read-report.md)
// is exactly the hop-target dead-end: the lift's input chain crosses
// the piece's result/process doc while it is still materializing.

import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { Identity } from "@commonfabric/identity";
import * as MemoryV2Server from "@commonfabric/memory/v2/server";
import { EmulatedStorageManager } from "../src/storage/v2-emulate.ts";
import { Runtime } from "../src/runtime.ts";
import type { MemorySpace } from "../src/storage/interface.ts";
import { newSharedServer } from "./memory-v2-test-utils.ts";
import { waitForCellValue } from "@commonfabric/integration/wait-for-cell-value";

const spaceSigner = await Identity.fromPassphrase("unresolved input space");
const space = spaceSigner.did() as MemorySpace;
const readerSigner = await Identity.fromPassphrase("unresolved input reader");
const writerSigner = await Identity.fromPassphrase("unresolved input writer");

/** A lift that CRASHES on an undefined input — the OW51 shape: the
 * body's guard covers the schema's stated absent value (`null`), not
 * `undefined`, exactly like note.tsx's `splitDefinitions` readers. */
const SPLITTING_LIFT_PATTERN = [
  "import { computed, pattern, Writable } from 'commonfabric';",
  "export default pattern<",
  "  { ref: Writable<string | null> },",
  "  { out: string[] | null }",
  ">(({ ref }) => {",
  "  const out = computed(() => {",
  "    const body = ref.get();",
  "    if (body === null) return null;",
  "    return body.split('\\n');",
  "  });",
  "  return { out };",
  "});",
].join("\n");

const TARGET_SCHEMA = { type: ["string", "null"] } as never;

describe("unresolved-input lift semantics (RULED 2026-08-21)", () => {
  let server: MemoryV2Server.Server;
  let readerManager: EmulatedStorageManager;
  let readerRuntime: Runtime;
  let writerManager: EmulatedStorageManager | undefined;
  let writerRuntime: Runtime | undefined;
  let actionFailures: string[];

  beforeEach(() => {
    server = newSharedServer({ subscriptionRefreshDelayMs: 0 });
    actionFailures = [];
    writerManager = undefined;
    writerRuntime = undefined;
    readerManager = EmulatedStorageManager.connectTo(server, {
      as: readerSigner,
    });
    readerRuntime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager: readerManager,
      errorHandlers: [(error) => {
        actionFailures.push(String(error));
      }],
    });
  });

  afterEach(async () => {
    await writerRuntime?.dispose();
    await writerManager?.close();
    await readerRuntime?.dispose();
    await readerManager?.close();
    await server.close();
  });

  /** A second, late-opened runtime: the doc's writer. Opened only when
   * needed so its space bootstrap never races the reader's setup
   * commits (two runtimes bootstrapping one fresh space concurrently
   * conflict on the space's root docs). */
  const openWriter = (): Runtime => {
    writerManager = EmulatedStorageManager.connectTo(server, {
      as: writerSigner,
    });
    writerRuntime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager: writerManager,
    });
    return writerRuntime;
  };

  /** Compile the lift pattern and run it over `argName`/`resultName`
   * on the reader runtime. */
  const standUp = async (argName: string, resultName: string) => {
    const compiled = await readerRuntime.patternManager.compilePattern({
      main: "/main.tsx",
      files: [{ name: "/main.tsx", contents: SPLITTING_LIFT_PATTERN }],
    }, { space });
    const argument = readerRuntime.getCell<{ ref: unknown }>(
      space,
      argName,
      undefined,
    );
    const result = readerRuntime.getCell<Record<string, unknown>>(
      space,
      resultName,
      compiled.resultSchema,
    );
    await argument.sync();
    await result.sync();
    {
      const tx = readerRuntime.edit();
      readerRuntime.run(tx, compiled, argument, result);
      readerRuntime.prepareTxForCommit(tx);
      expect((await tx.commit()).error).toBeUndefined();
    }
    return { argument, result };
  };

  it("a hop-target dead-end DISPOSES the run (output undefined, no action failure) and the run re-triggers when the doc arrives", async () => {
    // The reader itself seeds the ARGUMENT doc with `ref` = a LINK to a
    // target doc NOBODY has written: reading `ref` through the link is
    // a FOLLOWED HOP into a doc no replica can serve yet.
    const target = readerRuntime.getCell<string | null>(
      space,
      "hop-target",
      TARGET_SCHEMA,
    );
    const arg = readerRuntime.getCell<{ ref: unknown }>(
      space,
      "unresolved-arg",
      undefined,
    );
    await arg.sync();
    {
      const seed = readerRuntime.edit();
      arg.withTx(seed).key("ref").set(target as never);
      expect((await seed.commit()).error).toBeUndefined();
    }
    await readerRuntime.idle();
    await readerRuntime.storageManager.synced();

    const { result } = await standUp("unresolved-arg", "unresolved-result");
    const cancel = result.sink(() => {});
    await readerRuntime.idle();

    // THE RULED DISPOSITION: the run could not proceed on the data
    // available — a non-event, not a fault. Output `undefined`, and no
    // action failure was surfaced (pre-fix this is the OW51 TypeError:
    // `body.split` on the undefined that flowed into the body).
    expect(actionFailures).toEqual([]);
    expect(result.key("out").get()).toBeUndefined();

    // The doc ARRIVES: a separate writer runtime creates the target.
    // The registered reads re-trigger the disposed run — "retriggered
    // when any of the reads so far change (just like a regular call)" —
    // and the output heals to the computed value.
    {
      const writer = openWriter();
      const writerTarget = writer.getCell<string | null>(
        space,
        "hop-target",
        TARGET_SCHEMA,
      );
      await writerTarget.sync();
      const tx = writer.edit();
      writerTarget.withTx(tx).set("hello\nworld");
      expect((await tx.commit()).error).toBeUndefined();
      await writer.idle();
      await writer.storageManager.synced();
    }

    // The re-trigger's output arrives on the result cell's own sink, and
    // is read once the reader's scheduler is quiescent.
    await waitForCellValue<string[]>(
      readerRuntime,
      result.key("out"),
      (out) => Array.isArray(out) && out.length === 2,
      { stuckLabel: "the lift's output to hold both entries" },
    );
    expect(result.key("out").get()).toEqual(["hello", "world"]);
    expect(actionFailures).toEqual([]);
    cancel();
  });

  it("the schema's stated absent value still flows: a link to a doc that EXISTS as null runs the body with null (the guard's own arm)", async () => {
    // The target exists (as the stated null) from the same commit that
    // links to it — this control has no absent doc anywhere.
    const target = readerRuntime.getCell<string | null>(
      space,
      "null-target",
      TARGET_SCHEMA,
    );
    const arg = readerRuntime.getCell<{ ref: unknown }>(
      space,
      "null-arg",
      undefined,
    );
    await arg.sync();
    await target.sync();
    {
      const seed = readerRuntime.edit();
      target.withTx(seed).set(null);
      arg.withTx(seed).key("ref").set(target as never);
      expect((await seed.commit()).error).toBeUndefined();
    }
    await readerRuntime.idle();
    await readerRuntime.storageManager.synced();

    const { result } = await standUp("null-arg", "null-result");
    const cancel = result.sink(() => {});
    await readerRuntime.idle();

    await waitForCellValue<string[] | null>(
      readerRuntime,
      result.key("out"),
      (out) => out === null,
      { stuckLabel: "the lift's output to fall back to null" },
    );
    expect(actionFailures).toEqual([]);
    cancel();
  });
});
