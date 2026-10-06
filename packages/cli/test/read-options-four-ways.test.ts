/**
 * The exit criterion of the read options: **the same cell, reached four ways,
 * renders identically under the same selection.**
 *
 * One cell is seeded once. Each of the four arrivals — `cf cell get`,
 * `cf piece call`, `cf wish`, `cf exec` — is driven at its own outermost
 * in-process seam against that cell, under one selection, and the four
 * SELECTED VALUES are compared byte for byte. A vocabulary that answers from
 * two starting points and silently does nothing from the other two teaches a
 * rule that is false half the time, and only a comparison across all four can
 * witness that.
 *
 * The selected value is the whole of what is compared here, and deliberately
 * so: the envelope around it is each command's own. A verb arrival wraps its
 * answer in the Invocation JSON, a read arrival writes the value alone, and
 * those bytes therefore differ by design — comparing raw stdout across the
 * four would assert a sameness the commands do not have and should not. What
 * the envelope is, at each arrival, is pinned separately below and in
 * test/exec-read-options.test.ts.
 *
 * The cell is the profile the `#profile` wish resolves to, because that is the
 * one cell a wish can be made to arrive at without inventing a target: a wish
 * resolves a query rather than an address, so the other three arrivals are
 * pointed at what the wish found rather than the other way round.
 *
 * The runtime is real and emulated-storage-backed. Only the piece controller
 * and the callable cell are doubles, and each is the seam its own command
 * resolves through — the selection step under test is the production one in
 * every arrival.
 */

import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { dirname, join } from "@std/path";
import { Identity } from "@commonfabric/identity";
import {
  type Cell,
  type JSONSchema,
  type MemorySpace,
  type NormalizedFullLink,
  Runtime,
} from "@commonfabric/runner";
import { StorageManager } from "@commonfabric/runner/storage/cache.deno";
import {
  type CallableResolution,
  executeResolvedCallable,
} from "../lib/callable.ts";
import { getCellValue } from "../lib/piece.ts";
import { projectWishValue, resolveWish } from "../lib/wish.ts";
import {
  type ExecutedMountedCallableFile,
  executeMountedCallableFile,
} from "../lib/exec.ts";
import { renderExecOutcome } from "../commands/exec.ts";
import { writeMountState } from "../lib/fuse.ts";
import {
  type CellSelection,
  parseCellSelectionOptions,
} from "../lib/cell-selection.ts";
import { safeStringify } from "../lib/render.ts";
import { sendThroughStandIn } from "./utils.ts";

const userIdentity = await Identity.fromPassphrase("cf-four-ways-user");

const profileSpace = (await Identity.fromPassphrase("cf-four-ways-profile"))
  .did();

describe("read options, four ways", () => {
  let storageManager: ReturnType<typeof StorageManager.emulate>;
  let runtime: Runtime;
  let tmpDir: string;

  beforeEach(async () => {
    storageManager = StorageManager.emulate({ as: userIdentity });
    runtime = new Runtime({
      apiUrl: new URL("https://example.com"),
      storageManager,
    });
    tmpDir = await Deno.makeTempDir({ prefix: "cf-four-ways-" });
  });

  afterEach(async () => {
    await runtime.dispose();
    await storageManager.close();
    await Deno.remove(tmpDir, { recursive: true });
  });

  /** The one cell every arrival ends up reading, seeded into its own space and
   * hung off the user's home space as the default profile. */
  const PROFILE: Record<string, unknown> = {
    name: "Ada Lovelace",
    initialNameApplied: "Ada Lovelace",
    avatar: "ada.png",
    bio: "Mathematician & first programmer.",
    elements: [],
  };

  async function seedProfile(): Promise<Cell<unknown>> {
    let tx = runtime.edit();
    const profileSpaceCell = runtime.getSpaceCell(profileSpace, undefined, tx);
    const profileCell = runtime.getCell(
      profileSpace,
      "profile-default",
      undefined,
      tx,
    );
    profileCell.set({ ...PROFILE });
    profileSpaceCell.key("defaultPattern").set(profileCell);
    await tx.commit().settled;
    await runtime.idle();

    tx = runtime.edit();
    const homeSpaceCell = runtime.getHomeSpaceCell(tx);
    const homeDefaultCell = runtime.getCell(
      userIdentity.did(),
      "home-default-profile-link",
      undefined,
      tx,
    );
    homeDefaultCell.key("profiles").set([
      runtime.getCell(profileSpace, "profile-default", undefined, tx),
    ]);
    // deno-lint-ignore no-explicit-any
    (homeSpaceCell as any).key("defaultPattern").set(homeDefaultCell);
    await tx.commit().settled;
    await runtime.idle();

    return runtime.getCell(profileSpace, "profile-default") as Cell<unknown>;
  }

  /** A `Cell` double standing in for a piece's callable slot: a stream whose
   * send files its handling receipt at `receipt`. The dispatch is the double;
   * the readback and the selection over it are production code. */
  function handlerCell(receipt: NormalizedFullLink): Cell<unknown> {
    const schema: JSONSchema = { asCell: ["stream"] };
    const cell = {
      schema,
      get: () => ({ $stream: true }),
      getRaw: () => ({ $stream: true }),
      key: () => cell,
      asSchemaFromLinks: () => cell,
      isStream: () => true,
      send: (
        _value: unknown,
        onCommit?: (tx: unknown) => void,
      ) => {
        onCommit?.({
          status: () => ({ status: "done" }),
          handlingReceiptLink: receipt,
        });
      },
    };
    return cell as unknown as Cell<unknown>;
  }

  /** The piece controller each command resolves through, wrapping the REAL
   * runtime so every arrival's selection runs against production machinery. */
  function controllerFor(rootCell: unknown, space: MemorySpace) {
    const piece = {
      id: "of:four-ways-piece",
      getCell: () => ({ pull: () => Promise.resolve() }),
      input: { getCell: () => Promise.resolve(rootCell) },
      result: { getCell: () => Promise.resolve(rootCell) },
    };
    const pieces = {
      runtime,
      getSpace: () => space,
      synced: () => Promise.resolve(),
      get: () => Promise.resolve(piece),
    };
    return { pieces, piece };
  }

  /** `cf cell get <piece>` — the read that arrives by address. */
  async function viaPieceGet(
    profile: Cell<unknown>,
    selection: CellSelection,
  ): Promise<unknown> {
    const { pieces, piece } = controllerFor(profile, profileSpace);
    return await getCellValue(
      {
        apiUrl: "https://example.com",
        space: profileSpace,
        identity: "/tmp/four-ways.key",
        piece: "of:four-ways-piece",
      },
      [],
      { selection },
      {
        // deno-lint-ignore no-explicit-any
        loadPieces: () => Promise.resolve(pieces as any),
        loadPieceForRead: () => Promise.resolve(piece as never),
        resolvePieceAddress: (_pieces, id) => Promise.resolve(id),
      },
    );
  }

  /** `cf piece call <verb>` — the read that arrives through a verb's receipt. */
  async function viaPieceCall(
    profile: Cell<unknown>,
    selection: CellSelection,
  ): Promise<unknown> {
    const link = profile.getAsNormalizedFullLink();
    const resolution: CallableResolution = {
      callableCell: handlerCell(link),
      callableKind: "handler",
      cellKey: "readProfile",
      pieces: { runtime, getSpace: () => profileSpace },
      space: profileSpace,
      // deno-lint-ignore no-explicit-any
    } as any;
    const executed = await executeResolvedCallable(resolution, {}, {
      sendEvent: sendThroughStandIn,
      invocation: { id: "inv-four-ways", session: "ses:four-ways" },
      selection,
    });
    return executed.invocation?.result;
  }

  /** `cf wish '#profile'` — the read that arrives by query, and the only one
   * whose value passes through the handle-stripping walk afterwards. */
  async function viaWish(selection: CellSelection): Promise<unknown> {
    const { result, error } = await resolveWish(runtime, userIdentity.did(), {
      query: "#profile",
      selection,
    });
    expect(error).toBeUndefined();
    return projectWishValue(result);
  }

  /** `cf exec <mountedFile>` — the read that arrives through a filesystem
   * mount. A real mount-state file and a real mounted callable path; the
   * runtime under it is the same one the other three read through.
   *
   * Answers with `cf exec`'s whole outcome, so both the selected value and the
   * envelope written around it can be read from one drive of the command. */
  async function execOutcome(
    profile: Cell<unknown>,
    selection: CellSelection,
  ): Promise<ExecutedMountedCallableFile> {
    const mountpoint = join(tmpDir, "mount");
    const filePath = join(
      mountpoint,
      "home/pieces/profile-piece/result/readProfile.handler",
    );
    await Deno.mkdir(dirname(filePath), { recursive: true });
    await Deno.writeTextFile(filePath, "");
    await Deno.writeTextFile(
      join(dirname(dirname(filePath)), "meta.json"),
      JSON.stringify({ id: "of:four-ways-piece", name: "Four Ways" }),
    );
    await writeMountState(join(tmpDir, "state"), {
      pid: Deno.pid,
      mountpoint,
      apiUrl: "https://example.com",
      identity: "/tmp/four-ways.key",
      startedAt: "2026-08-15T00:00:00.000Z",
    });

    const callable = handlerCell(profile.getAsNormalizedFullLink());
    const rootCell = {
      schema: undefined,
      get: () => ({ readProfile: { $stream: true } }),
      getRaw: () => ({ readProfile: { $stream: true } }),
      key: () => callable,
      asSchemaFromLinks: () => callable,
    };
    const { pieces, piece } = controllerFor(rootCell, profileSpace);

    const executed = await executeMountedCallableFile(
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
      { selection },
    );
    return executed;
  }

  async function viaExec(
    profile: Cell<unknown>,
    selection: CellSelection,
  ): Promise<unknown> {
    return (await execOutcome(profile, selection)).invocation?.result;
  }

  /** The four arrivals, each rendered as `render()` would write it. */
  async function renderFourWays(
    profile: Cell<unknown>,
    selection: CellSelection,
  ): Promise<Record<string, string>> {
    return {
      "piece get": safeStringify(await viaPieceGet(profile, selection)),
      "piece call": safeStringify(await viaPieceCall(profile, selection)),
      "wish": safeStringify(await viaWish(selection)),
      "exec": safeStringify(await viaExec(profile, selection)),
    };
  }

  /** Each arrival's rendering, read back as the value it wrote. */
  function parseEach(
    rendered: Record<string, string>,
  ): Record<string, unknown> {
    return Object.fromEntries(
      Object.entries(rendered).map(([arrival, text]) => [
        arrival,
        JSON.parse(text),
      ]),
    );
  }

  it("renders one cell identically through get, call, wish and exec", async () => {
    const profile = await seedProfile();
    const selection = await parseCellSelectionOptions({ select: "name,bio" });

    const rendered = await renderFourWays(profile, selection!);

    // What each arrival answered, not merely that none errored. An arrival
    // that dropped the selection answers the whole profile — `avatar`,
    // `elements` and `initialNameApplied` beside these two — and one that
    // answered nothing answers `null` or `{}`. Both fail this.
    const expected = {
      name: "Ada Lovelace",
      bio: "Mathematician & first programmer.",
    };
    expect(parseEach(rendered)).toEqual({
      "piece get": expected,
      "piece call": expected,
      "wish": expected,
      "exec": expected,
    });

    // And identically in the order the selection names: one expected rendering,
    // not four values that happen to agree in content. Key order is part of
    // what a caller diffs, so the comparison is over the bytes `render()`
    // writes.
    const expectedRendering = safeStringify(expected);
    expect(rendered).toEqual({
      "piece get": expectedRendering,
      "piece call": expectedRendering,
      "wish": expectedRendering,
      "exec": expectedRendering,
    });
  });

  it("names one cell's address through get, call, wish and exec", async () => {
    const profile = await seedProfile();
    const selection = await parseCellSelectionOptions({ select: "@" });

    const rendered = await renderFourWays(profile, selection!);

    // Every arrival answers with the address of the cell itself, so a caller
    // holding one from any of them holds the same position. An arrival that
    // ignored the selection answers the profile's contents; one that composed
    // the marker against a value with no cell behind it — the wish's
    // handle-stripping walk run first — has no address to compose and answers
    // nothing at all.
    //
    // One canonical reference string, not four fields to reassemble. The three
    // arrivals that target the profile's own space name it with no prefix; the
    // wish reads from the user's space and resolves ACROSS into the profile's,
    // so its address says which space it crossed into. That is the difference
    // an address must carry to stay readable from where it was handed out —
    // both spellings name the one cell, and each is the one `--piece` takes
    // back in from the arrival that wrote it.
    const id = profile.getAsNormalizedFullLink().id;
    expect(parseEach(rendered)).toEqual({
      "piece get": { $link: `/${id}` },
      "piece call": { $link: `/${id}` },
      "wish": { $link: `//${profileSpace}/${id}` },
      "exec": { $link: `/${id}` },
    });
    // And the three that share a target space share their bytes, key order
    // included: one rendering, not three that happen to agree in content.
    const sameSpace = ["piece get", "piece call", "exec"]
      .map((arrival) => rendered[arrival]);
    expect(new Set(sameSpace).size).toBe(1);
  });

  it("wraps the identical selected value in each arrival's own envelope", async () => {
    const profile = await seedProfile();
    const selection = await parseCellSelectionOptions({ select: "name" });

    const written: string[] = [];
    const executed = await execOutcome(profile, selection!);
    renderExecOutcome(executed, {
      write: (text) => written.push(text),
      writeError: () => {},
    });

    // The selected value agrees with the other three arrivals — that is the
    // test above — and here is what `cf exec` actually WRITES around it. The
    // envelope is the Invocation JSON, so stdout is not the bare value and a
    // comparison of raw output across the four would fail on this by design
    // rather than on any disagreement about the selection.
    const envelope = JSON.parse(written[0]) as Record<string, unknown>;
    expect(envelope.result).toEqual({ name: "Ada Lovelace" });
    expect(envelope.invocation).toBe(executed.invocation?.id);
    expect(envelope.status).toBe("settled");
    // Not the bare value: the wrapper is real, so raw stdout is not what the
    // four-way comparison could ever have been over.
    expect(written[0]).not.toBe(safeStringify({ name: "Ada Lovelace" }));
  });
});
