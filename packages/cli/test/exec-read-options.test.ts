import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { dirname, join } from "@std/path";
import type { JSONSchema } from "@commonfabric/api";
import type { Cell } from "@commonfabric/runner";
import {
  type ExecutedMountedCallableFile,
  executeMountedCallableFile,
} from "../lib/exec.ts";
import {
  exitExecFailure,
  parseExecSelection,
  renderExecOutcome,
} from "../commands/exec.ts";
import { invocationPhaseReporter } from "../commands/piece.ts";
import { writeMountState } from "../lib/fuse.ts";
import { CF_RUNTIME_ERROR_LOG } from "../lib/callable.ts";
import {
  type CellSelection,
  parseCellSelectionOptions,
} from "../lib/cell-selection.ts";
import { cf, relevantStderr, sendThroughStandIn } from "./utils.ts";

/**
 * `cf exec`'s read options and the shape it emits.
 *
 * The end-to-end proof that a selection reaching this arrival actually shapes
 * the value lives in test/read-options-four-ways.test.ts, which drives exec
 * against a real runtime beside the other three arrivals. What is asserted
 * here is the wiring either side of that step: that the caller's selection
 * reaches it at all from both callable kinds, and that what exec writes is the
 * declared shape rather than prose.
 */
describe("cf exec read options", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await Deno.makeTempDir({ prefix: "cf-exec-read-options-" });
  });

  afterEach(async () => {
    await Deno.remove(tmpDir, { recursive: true });
  });

  /** The slice of `Cell` each callable double below implements. */
  interface CallableCellDouble extends Record<string, unknown> {
    get(): unknown;
    getRaw(): unknown;
  }

  /** A mounted callable file, its `meta.json`, and a live mount state entry. */
  async function mountCallable(name: string): Promise<string> {
    const mountpoint = join(tmpDir, "mount");
    const filePath = join(
      mountpoint,
      `home/pieces/notes/result/${name}`,
    );
    await Deno.mkdir(dirname(filePath), { recursive: true });
    await Deno.writeTextFile(filePath, "");
    await Deno.writeTextFile(
      join(dirname(dirname(filePath)), "meta.json"),
      JSON.stringify({ id: "of:piece-123", name: "Fixture Piece" }),
    );
    await writeMountState(join(tmpDir, "state"), {
      pid: Deno.pid,
      mountpoint,
      apiUrl: "http://localhost:8000",
      identity: "/tmp/test-identity.pem",
      startedAt: "2026-08-15T00:00:00.000Z",
    });
    return filePath;
  }

  /** Minimal doubles around one callable cell. The runtime is a double here:
   * the selection step itself is stubbed through its own seam, and what these
   * assert is what reaches it. */
  function harness(callable: CallableCellDouble, cellKey: string) {
    const rootCell: Record<string, unknown> = {
      schema: undefined,
      get: () => ({ [cellKey]: callable.get() }),
      getRaw: () => ({ [cellKey]: callable.getRaw() }),
      key: () => callable,
      asSchemaFromLinks: () => callable,
    };
    const piece = {
      id: "of:piece-123",
      getCell: () => ({ pull: () => Promise.resolve() }),
      input: { getCell: () => Promise.resolve(rootCell) },
      result: { getCell: () => Promise.resolve(rootCell) },
    };
    const resultCell = {
      get: () => ({ items: [{ id: "a", title: "Alpha", extra: 1 }] }),
      pull: () =>
        Promise.resolve({ items: [{ id: "a", title: "Alpha", extra: 1 }] }),
      key: () => resultCell,
      asSchemaFromLinks: () => resultCell,
      getAsNormalizedFullLink: () => ({
        id: "of:tool-result-cell",
        space: "did:key:test-home",
        scope: "user",
        path: [],
      }),
    };
    const receiptCell = {
      pull: () => Promise.resolve({ title: "Milk" }),
      getRaw: () => ({ title: "Milk" }),
      get: () => ({ title: "Milk" }),
      key: () => receiptCell,
      asSchemaFromLinks: () => receiptCell,
      getAsNormalizedFullLink: () => ({
        id: "of:receipt-cell",
        space: "did:key:test-home",
        scope: "space",
        path: [],
      }),
    };
    const pieces = {
      getSpace: () => "did:key:test-home",
      synced: () => Promise.resolve(),
      runtime: {
        [CF_RUNTIME_ERROR_LOG]: [] as Array<{ message: string }>,
        storageManager: {
          synced: () => Promise.resolve(),
          pendingCommitsSettled: async () => {},
        },
        edit: () => ({
          commit: () => Promise.resolve(),
          status: () => ({ status: "done", journal: { novelty: () => [] } }),
        }),
        prepareTxForCommit: () => {},
        getCell: () => resultCell,
        getCellFromLink: () => receiptCell,
        run: () => ({ sink: () => () => {} }),
        idle: () => Promise.resolve(),
        settled: () => Promise.resolve(),
      },
    };
    return { pieces, piece, resultCell, receiptCell };
  }

  /** A tool-shaped callable cell double. */
  function toolCell(): CallableCellDouble {
    const inputSchema: JSONSchema = {
      type: "object",
      properties: { query: { type: "string" } },
    };
    const value = {
      pattern: { argumentSchema: inputSchema },
      extraParams: {},
    };
    const cell: CallableCellDouble = {
      schema: {
        type: "object",
        properties: {
          pattern: { type: "object" },
          extraParams: { type: "object" },
        },
      } as JSONSchema,
      get: () => value,
      getRaw: () => value,
      asSchemaFromLinks: () => cell,
      getAsNormalizedFullLink: () => ({
        id: "of:callable-cell",
        space: "did:key:test-home",
        scope: "user",
        path: [],
      }),
    };
    cell.key = (key: string) => ({
      get: () => (value as Record<string, unknown>)[key],
      getRaw: () => (value as Record<string, unknown>)[key],
    });
    return cell;
  }

  /** A handler-shaped callable cell double whose send files a receipt. */
  function handlerCell(): CallableCellDouble {
    const cell: CallableCellDouble = {
      schema: { asCell: ["stream"] } as JSONSchema,
      get: () => ({ $stream: true }),
      getRaw: () => ({ $stream: true }),
      isStream: () => true,
      asSchemaFromLinks: () => cell,
      send: (_value: unknown, onCommit?: (tx: unknown) => void) => {
        onCommit?.({
          status: () => ({ status: "done", journal: { novelty: () => [] } }),
          handlingReceiptLink: {
            id: "of:receipt-cell",
            space: "did:key:test-home",
            scope: "space",
            path: [],
          },
        });
      },
    };
    cell.key = () => cell;
    return cell;
  }

  it("hands a tool's selection to the selection step, over the tool's own result cell", async () => {
    const filePath = await mountCallable("search.tool");
    const { pieces, piece, resultCell } = harness(toolCell(), "search");
    const selection = await parseCellSelectionOptions({ select: "items" });
    const seen: Array<{ source: unknown; selection: CellSelection }> = [];

    const result = await executeMountedCallableFile(
      filePath,
      ["--query", "milk"],
      {
        stateDir: join(tmpDir, "state"),
        // deno-lint-ignore no-explicit-any
        loadPieces: () => Promise.resolve(pieces as any),
        // deno-lint-ignore no-explicit-any
        loadPiece: () => Promise.resolve(piece as any),
        deriveSelectedValue: (
          _runtime,
          _space,
          source: Cell<unknown>,
          received: CellSelection,
        ) => {
          seen.push({ source, selection: received });
          return Promise.resolve({ shaped: true });
        },
      },
      { selection: selection! },
    );

    // The caller's own selection, over the cell the tool wrote — not a fresh
    // one, and not the callable cell.
    expect(seen).toHaveLength(1);
    expect(seen[0].selection).toBe(selection);
    expect(seen[0].source).toBe(resultCell as unknown as Cell<unknown>);
    // And the SHAPED value is what reaches stdout. An implementation that
    // handed the selection down and then wrote the unshaped result would pass
    // the two assertions above and fail this one.
    expect(JSON.parse(result.outputText!)).toEqual({ shaped: true });
  });

  it("leaves a tool's output unshaped when no read option is given", async () => {
    const filePath = await mountCallable("search.tool");
    const { pieces, piece } = harness(toolCell(), "search");
    let called = false;

    const result = await executeMountedCallableFile(
      filePath,
      ["--query", "milk"],
      {
        stateDir: join(tmpDir, "state"),
        // deno-lint-ignore no-explicit-any
        loadPieces: () => Promise.resolve(pieces as any),
        // deno-lint-ignore no-explicit-any
        loadPiece: () => Promise.resolve(piece as any),
        deriveSelectedValue: () => {
          called = true;
          return Promise.resolve(undefined);
        },
      },
    );

    expect(called).toBe(false);
    expect(JSON.parse(result.outputText!)).toEqual({
      items: [{ id: "a", title: "Alpha", extra: 1 }],
    });
  });

  it("settles a handler under an invocation of its own, so a result exists to shape", async () => {
    const filePath = await mountCallable("add.handler");
    const { pieces, piece } = harness(handlerCell(), "add");

    const result = await executeMountedCallableFile(
      filePath,
      ["invoke"],
      {
        sendEvent: sendThroughStandIn,
        stateDir: join(tmpDir, "state"),
        // deno-lint-ignore no-explicit-any
        loadPieces: () => Promise.resolve(pieces as any),
        // deno-lint-ignore no-explicit-any
        loadPiece: () => Promise.resolve(piece as any),
        isStdinTerminal: () => true,
      },
    );

    // A dispatch naming no invocation files under no receipt and answers with
    // nothing at all, leaving a read option nothing to be about. The id is
    // minted per call, so the envelope names one and carries the address the
    // handling settled to.
    expect(result.invocation?.status).toBe("settled");
    expect(result.invocation?.id).toBeTruthy();
    // The address is the one canonical reference string `--piece` takes back
    // in, and the call's own space is the one it targeted, so it carries no
    // `@did` prefix.
    expect(result.invocation?.receipt).toBe("/of:receipt-cell");
  });

  it("reaches the committed phase before a selection can fail the call", async () => {
    const filePath = await mountCallable("add.handler");
    const { pieces, piece } = harness(handlerCell(), "add");
    const phases: string[] = [];

    // A projection naming a field the result does not have: it materializes
    // nothing, which the selection step refuses — and it can only refuse AFTER
    // the handling has committed, because there is no result to shape until
    // then. This is the ordering the failure report exists for.
    const selection = await parseCellSelectionOptions({
      select: "nosuchfield",
    });

    await expect(executeMountedCallableFile(
      filePath,
      ["invoke"],
      {
        sendEvent: sendThroughStandIn,
        stateDir: join(tmpDir, "state"),
        // deno-lint-ignore no-explicit-any
        loadPieces: () => Promise.resolve(pieces as any),
        // deno-lint-ignore no-explicit-any
        loadPiece: () => Promise.resolve(piece as any),
        isStdinTerminal: () => true,
        onPhase: (phase) => phases.push(phase),
      },
      { selection },
    )).rejects.toThrow();

    // The mutation landed and only then did the call fail, so a caller that
    // simply reran the command would commit a second time. `cf exec` mints a
    // fresh pair per call and takes no `--invocation`, which is why the phase
    // has to be reported rather than inferred from the exit code.
    expect(phases).toContain("committed");
    expect(phases.indexOf("dispatched")).toBeLessThan(
      phases.indexOf("committed"),
    );
  });

  it("writes a handler's outcome as the Invocation JSON on stdout", () => {
    const out: string[] = [];
    const err: string[] = [];
    renderExecOutcome(
      {
        invocation: {
          id: "inv-1",
          status: "settled",
          result: { title: "Milk" },
        },
        // deno-lint-ignore no-explicit-any
      } as any as ExecutedMountedCallableFile,
      { write: (text) => out.push(text), writeError: (text) => err.push(text) },
    );

    // The envelope `cf piece call` declares, not silence and not prose.
    expect(JSON.parse(out[0])).toEqual({
      invocation: "inv-1",
      status: "settled",
      result: { title: "Milk" },
    });
    expect(err).toEqual([]);
  });

  it("writes a tool's result cell as an address the next command takes", () => {
    const out: string[] = [];
    const err: string[] = [];
    renderExecOutcome(
      {
        outputText: "{}",
        resultRef: {
          id: "of:tool-result",
          space: "did:key:test-home",
          scope: "user",
        },
        // deno-lint-ignore no-explicit-any
      } as any as ExecutedMountedCallableFile,
      { write: (text) => out.push(text), writeError: (text) => err.push(text) },
    );

    // The result stays on stdout; stderr carries a complete reference with
    // explicit scope for a reader whose context is unknown.
    expect(out).toEqual(["{}"]);
    expect(err).toHaveLength(1);
    expect(err[0]).not.toContain("(space ");
    // All three parts of the address inside the one token. Dropping the space
    // leaves a command that runs and reads whichever space the caller happens
    // to have configured — `cf exec` takes its space from the mount, so the
    // two need not agree. The token carrying it is what lets the suggested
    // command name no `--space` at all.
    expect(err[0]).not.toContain("--space");
    expect(err[0]).toContain(
      "cf cell get //did:key:test-home/of:tool-result@user",
    );
  });

  it("writes an explicit space scope for a reader with unknown context", () => {
    const err: string[] = [];
    renderExecOutcome(
      {
        outputText: "{}",
        resultRef: {
          id: "of:tool-result",
          space: "did:key:test-home",
          scope: "space",
        },
        // deno-lint-ignore no-explicit-any
      } as any as ExecutedMountedCallableFile,
      { write: () => {}, writeError: (text) => err.push(text) },
    );

    expect(err[0]).toContain(
      "cf cell get //did:key:test-home/of:tool-result@space`)",
    );
  });

  it("refuses a malformed selection as a data error, before any lookup", async () => {
    const errs: string[] = [];
    const codes: number[] = [];

    await expect(parseExecSelection({ filter: "" }, {
      printError: (text) => errs.push(text),
      exit: (code): never => {
        codes.push(code);
        throw new Error("exit-sentinel");
      },
    })).rejects.toThrow("exit-sentinel");

    expect(codes).toEqual([1]);
    expect(errs.join("\n")).toContain("--filter predicate must not be empty");
    // A flag error, so it names no invocation and no phase: nothing was
    // dispatched, and offering a retry key here would be offering one for a
    // call that was never made.
    expect(errs.join("\n")).not.toContain("phase:");
  });

  it("passes a well-formed selection through untouched", async () => {
    const selection = await parseExecSelection({ select: "id,title" });
    expect(selection).toEqual(
      await parseCellSelectionOptions({ select: "id,title" }),
    );
    expect(await parseExecSelection({})).toBeUndefined();
  });

  it("reports a pre-dispatch failure without naming an invocation", () => {
    const errs: string[] = [];
    const codes: number[] = [];
    expect(() =>
      exitExecFailure(
        new Error("no mount covers /tmp/nope"),
        "inv-unspent",
        "initial_sync",
        {
          printError: (text) => errs.push(text),
          exit: (code): never => {
            codes.push(code);
            throw new Error("exit-sentinel");
          },
        },
      )
    ).toThrow("exit-sentinel");

    expect(codes).toEqual([1]);
    expect(errs).toEqual(["no mount covers /tmp/nope"]);
    // Nothing dispatched, so the id was never spent and never announced.
    // Printing it would offer a retry key for a call that never happened —
    // and a tool, which never enters these phases, would get one every time.
    expect(errs.join("\n")).not.toContain("inv-unspent");
    expect(errs.join("\n")).not.toContain("phase:");
  });

  it("names the invocation and phase once a failure is past dispatch", () => {
    const errs: string[] = [];
    const codes: number[] = [];
    expect(() =>
      exitExecFailure(
        new Error("selection kept nothing"),
        "inv-7",
        "committed",
        {
          printError: (text) => errs.push(text),
          exit: (code): never => {
            codes.push(code);
            throw new Error("exit-sentinel");
          },
        },
      )
    ).toThrow("exit-sentinel");

    expect(codes).toEqual([1]);
    // The message, then the retry key beside the furthest phase — the shape
    // `cf piece call` prints, so a script reads one format either way. The
    // phase is what says the handling may already have committed, which is
    // the whole reason a caller must not simply run the command again.
    expect(errs).toEqual([
      "selection kept nothing",
      "invocation: inv-7 phase: committed",
    ]);
  });

  it("announces the invocation pair on stderr at dispatch, before the commit", () => {
    const announced: string[] = [];
    const seen: string[] = [];
    const onPhase = invocationPhaseReporter(
      { id: "inv-9", session: "sess-3" },
      (next) => seen.push(next),
      (message) => announced.push(message),
    );

    onPhase("initial_sync");
    onPhase("dispatched");
    onPhase("committed");

    // Both halves, before the commit phase is reached: a caller whose process
    // dies after the dispatch still holds the pair, and `cf exec` accepts no
    // `--invocation`, so this announcement is the only place it is ever named.
    expect(announced).toEqual(["invocation: inv-9", "session: sess-3"]);
    expect(seen).toEqual(["initial_sync", "dispatched", "committed"]);
  });

  it("consumes a read option before the file and leaves the rest to the callable", async () => {
    const missing = join(tmpDir, "not-a-mount", "search.tool");
    const { code, stderr } = await cf(
      `exec --select id ${missing} --query milk`,
    );
    const relevant = relevantStderr(stderr).filter((line) =>
      !line.includes("deno run ")
    ).join("\n");

    expect(code).not.toBe(0);
    // Through real cliffy parsing with `.stopEarly()`: `--select id` was taken
    // as exec's own flag and the FILE was taken as the positional, which is
    // what naming the file here proves. A `--select` that landed in the
    // positional would put "--select" or "id" in this message instead, and
    // `--query milk` would have been rejected as an unknown flag rather than
    // left for the callable to parse.
    expect(relevant).toContain(missing);
    expect(relevant).not.toContain("Unknown option");
    // Pre-dispatch: nothing was resolved, nothing ran, and no invocation was
    // spent — so the failure names none. This is the action body's own path,
    // which no unit test reaches.
    expect(relevant).not.toContain("invocation:");
    expect(relevant).not.toContain("phase:");
  });

  it("refuses --select beside --schema, which name one projection twice", async () => {
    const { code, stderr } = await cf(
      `exec --select id --schema id ${join(tmpDir, "search.tool")}`,
    );

    expect(code).not.toBe(0);
    const relevant = relevantStderr(stderr).filter((line) =>
      !line.includes("deno run ")
    );
    expect(relevant.join("\n")).toContain("--schema");
    expect(relevant.join("\n")).toContain("--select");
  });
});
