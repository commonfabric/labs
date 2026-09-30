import { join, resolve } from "@std/path";
import { describe, it } from "@std/testing/bdd";

import {
  createTestSpace,
  env,
  waitFor,
  waitForCondition,
} from "@commonfabric/integration";
import { ShellIntegration } from "@commonfabric/integration/shell-utils";
import { writeTempIdentity } from "@commonfabric/integration/temp-identity";
import { waitForCellValue } from "@commonfabric/integration/wait-for-cell-value";

import "../src/globals.ts";

import { expect } from "@std/expect";

import { PieceController, PiecesController } from "@commonfabric/piece/ops";

import { clickPierce } from "./shadow-dom.ts";

const { API_URL, FRONTEND_URL } = env;
const REPO_ROOT = resolve(import.meta.dirname!, "../../..");
const decoder = new TextDecoder();

async function runCfPieceNewWithSlug(options: {
  sourcePath: string;
  identityPath: string;
  space: string;
  slug: string;
  /** Take a name that already points somewhere, which `cf` refuses without. */
  force?: boolean;
}): Promise<string> {
  const command = new Deno.Command(Deno.execPath(), {
    cwd: REPO_ROOT,
    args: [
      "run",
      "-A",
      join(REPO_ROOT, "packages", "cli", "mod.ts"),
      "piece",
      "new",
      options.sourcePath,
      "--identity",
      options.identityPath,
      "--api-url",
      API_URL,
      "--space",
      options.space,
      "--slug",
      options.slug,
      ...(options.force ? ["--force"] : []),
    ],
    env: {
      CF_LOG_LEVEL: "error",
    },
  });
  const result = await command.output();
  const stdout = decoder.decode(result.stdout);
  const stderr = decoder.decode(result.stderr);
  if (!result.success) {
    throw new Error(
      `cf piece new failed with ${result.code}\nstdout:\n${stdout}\nstderr:\n${stderr}`,
    );
  }
  const pieceId = stdout.match(/fid1:[^\s]+/)?.[0];
  if (!pieceId) {
    throw new Error(`cf piece new did not print a fid1 id:\n${stdout}`);
  }
  return pieceId;
}

async function waitForSlugPieceMarker(
  shell: ShellIntegration,
  expectedText: string,
): Promise<void> {
  await waitForCondition(
    shell.page(),
    (probe, expected) =>
      probe.collect("#slug-piece-marker").some((el) =>
        probe.deepText(el).trim() === expected
      ),
    { args: [expectedText] },
  );
}

async function getClientEngineCompileCount(
  page: ReturnType<ShellIntegration["page"]>,
): Promise<number> {
  return await page.evaluate(async () => {
    const rt = globalThis.commonfabric?.rt;
    if (!rt) {
      throw new Error("Runtime client was not exposed");
    }
    const { timing } = await rt.getLoggerCounts();
    return timing.engine?.compile?.count ?? 0;
  });
}

async function waitForSpaceRootPattern(
  page: ReturnType<ShellIntegration["page"]>,
): Promise<void> {
  await waitForCondition(page, () => {
    const rootView = document.querySelector("x-root-view");
    const appView = rootView?.shadowRoot?.querySelector("x-app-view") as
      | {
        _spaceRootPattern?: {
          value?: {
            id(): string;
          };
        };
      }
      | null;
    return !!appView?._spaceRootPattern?.value?.id?.();
  });
}

describe("shell piece tests", () => {
  const shell = new ShellIntegration();
  shell.bindLifecycle();

  it("can view and interact with a piece", async () => {
    const page = shell.page();
    await using tempIdentity = await writeTempIdentity({
      implementation: "noble",
    });
    const { identity, path: identityPath } = tempIdentity;
    const spaceDid = await createTestSpace(identity);
    // Initialized as the first step inside the try below, so a failure there
    // still runs the finally that tears the runtimes down.
    let cc: PiecesController | undefined;
    let piece: PieceController | undefined;
    const logDebugSnapshot = async (label: string) => {
      console.log(label, {
        shellState: await shell.state(),
        pieceValue: piece ? await piece.result.get(["value"]) : undefined,
        clientEngineCompileCount: await getClientEngineCompileCount(page)
          .catch((error) => error instanceof Error ? error.message : error),
        page: await page.evaluate(() => {
          const rootView = document.querySelector("x-root-view");
          const typedRootView = rootView as
            | {
              accessForTestingOnly?: {
                rt?: {
                  status?: unknown;
                  value?: unknown;
                  error?: {
                    message?: string;
                  };
                };
              };
              app?: {
                identity?: unknown;
              };
            }
            | null;
          const appView = rootView?.shadowRoot?.querySelector("x-app-view") as
            | {
              _patterns?: {
                status?: unknown;
                value?: {
                  activePattern?: {
                    id(): string;
                  };
                };
              };
              _selectedPattern?: {
                status?: unknown;
                value?: {
                  id(): string;
                };
                error?: {
                  message?: string;
                };
              };
              _spaceRootPattern?: {
                status?: unknown;
                value?: {
                  id(): string;
                };
              };
            }
            | null;
          return {
            href: globalThis.location.href,
            hasRuntime: !!globalThis.commonfabric?.rt,
            hasRootView: !!rootView,
            rootRuntimeStatus: typedRootView?.accessForTestingOnly?.rt?.status,
            hasRootRuntimeValue: !!typedRootView?.accessForTestingOnly?.rt
              ?.value,
            rootRuntimeError: typedRootView?.accessForTestingOnly?.rt?.error
              ?.message,
            rootHasIdentity: !!typedRootView?.app?.identity,
            hasAppView: !!appView,
            patternsStatus: appView?._patterns?.status,
            selectedPatternStatus: appView?._selectedPattern?.status,
            spaceRootPatternStatus: appView?._spaceRootPattern?.status,
            activePatternId: appView?._patterns?.value?.activePattern?.id?.(),
            selectedPatternId: appView?._selectedPattern?.value?.id?.(),
            spaceRootPatternId: appView?._spaceRootPattern?.value?.id?.(),
            patternError: appView?._selectedPattern?.error?.message,
            bodyText: document.body.textContent?.trim().slice(0, 200),
          };
        }),
      });
    };

    try {
      const controller = await PiecesController.initialize({
        space: spaceDid,
        apiUrl: new URL(API_URL),
        identity: identity,
      });
      cc = controller;
      const sourcePath = join(
        import.meta.dirname!,
        "..",
        "..",
        "patterns",
        "counter",
        "counter.tsx",
      );
      const slug = `compile-cache-${crypto.randomUUID()}`;
      const pieceId = await runCfPieceNewWithSlug({
        sourcePath,
        identityPath,
        space: spaceDid,
        slug,
      });
      const currentPiece = await controller.get(pieceId, false);
      piece = currentPiece;

      // Read the piece's committed result value at quiescence. Each call sinks
      // on the result cell, drains the scheduler, and resolves once the value
      // reaches its target, so the sequential checks (0, then -1, then -2) each
      // wait on a real committed change rather than a timer.
      const resultCell = controller.getResult(currentPiece.getCell());
      const awaitResultValue = (target: number): Promise<unknown> =>
        waitForCellValue<{ value?: number }>(
          controller.runtime,
          resultCell,
          (value) => value?.value === target,
        );

      await awaitResultValue(0);
      // A fresh reload of the piece has no sink; poll until its own sync round
      // trip reads the committed value back.
      await waitFor(async () => {
        const reloadedPiece = await controller.get(pieceId, true);
        return (await reloadedPiece.result.get(["value"])) === 0;
      });
      await shell.goto({
        frontendUrl: FRONTEND_URL,
        view: {
          spaceDid,
        },
        identity,
      });

      await waitForCondition(page, () => !!globalThis.commonfabric?.rt);
      await waitForSpaceRootPattern(page);
      // First in-browser load of the piece: pieces are no longer eagerly
      // started when the space loads (CT-1623 — the header used to start every
      // piece just to label its menu), so this navigation performs the cold
      // in-client compile and seeds the compilation cache. The cache contract
      // is asserted below against a fresh worker.
      await page.evaluate(async (spaceDid, pieceId) => {
        await globalThis.app.setView({ spaceDid, pieceId });
      }, { args: [spaceDid, pieceId] });
      await shell.waitForState({
        view: {
          spaceDid,
          pieceSlug: slug,
        },
        identity,
      });

      const waitForActivePattern = async () => {
        await waitForCondition(page, (_probe, expectedPieceId) => {
          const rootView = document.querySelector("x-root-view");
          const appView = rootView?.shadowRoot?.querySelector("x-app-view") as
            | {
              _patterns?: {
                value?: {
                  activePattern?: {
                    id(): string;
                  };
                };
              };
            }
            | null;
          const activePattern = appView?._patterns?.value?.activePattern;
          return activePattern?.id() === expectedPieceId;
        }, { args: [pieceId] });
      };

      await waitForActivePattern();

      await awaitResultValue(0);

      await clickPierce(page, "#counter-decrement");
      await awaitResultValue(-1);

      await clickPierce(page, "#counter-decrement");
      await awaitResultValue(-2);

      // Compilation-cache contract: the piece's cold compile above was written
      // back to the content-addressed cell cache. A FRESH worker must then load
      // the piece from that cache — zero in-client compilations during the
      // piece load. Flush the write-backs first: a write still in flight when
      // the fresh worker reads the cache forces a recompile (the flake this
      // guard exists for).
      await page.evaluate(async () => {
        await globalThis.commonfabric?.rt?.flushCompileCacheWrites();
      });
      await page.evaluate(async () => {
        try {
          await globalThis.commonfabric?.rt?.dispose();
        } finally {
          if (globalThis.commonfabric) globalThis.commonfabric.rt = undefined;
        }
      });
      await shell.goto({
        frontendUrl: FRONTEND_URL,
        view: {
          spaceDid,
        },
        identity,
      });
      await waitForCondition(page, () => !!globalThis.commonfabric?.rt);
      await waitForSpaceRootPattern(page);
      // Settle the space-root chain's own loads before baselining (a trailing
      // root compile landing inside the measurement window would show up as a
      // false piece recompile): drain the scheduler, then the compile-cache
      // write-backs — both deterministic completion signals, no timed waits.
      await page.evaluate(async () => {
        await globalThis.commonfabric?.rt?.idle();
        await globalThis.commonfabric?.rt?.flushCompileCacheWrites();
      });
      const compileCountBeforePieceLoad = await getClientEngineCompileCount(
        page,
      );
      await page.evaluate(async (spaceDid, pieceId) => {
        await globalThis.app.setView({ spaceDid, pieceId });
      }, { args: [spaceDid, pieceId] });
      await shell.waitForState({
        view: {
          spaceDid,
          pieceSlug: slug,
        },
        identity,
      });
      await waitForActivePattern();
      const compileCountAfterPieceLoad = await getClientEngineCompileCount(
        page,
      );
      if (compileCountAfterPieceLoad !== compileCountBeforePieceLoad) {
        throw new Error(
          `Expected 0 in-client compilations while a fresh worker loads the ` +
            `cached cf-created piece ${pieceId}; engine compile count ` +
            `changed from ${compileCountBeforePieceLoad} to ` +
            `${compileCountAfterPieceLoad}`,
        );
      }

      await awaitResultValue(-2);
    } catch (error) {
      if (piece) {
        await logDebugSnapshot("shell piece test debug");
      }
      throw error;
    } finally {
      // Both disposals are awaited to completion: disposeRuntime() awaits the
      // browser runtime's teardown (worker Dispose round trip and transport
      // close), and cc.dispose() awaits the in-process runtime's. Both
      // finish before the keyfile goes, since `await using` removes it when
      // the test's own scope ends.
      await shell.disposeRuntime();
      await cc?.dispose();
    }
  });

  it("loads a slug piece and reloads when cf piece new repoints the slug", async () => {
    const slug = `slug-repoint-${crypto.randomUUID()}`;
    await using tempIdentity = await writeTempIdentity({
      implementation: "noble",
    });
    const { identity, path: identityPath } = tempIdentity;
    const spaceDid = await createTestSpace(identity);
    const firstSource = join(
      import.meta.dirname!,
      "fixtures",
      "slug-piece-v1.tsx",
    );
    const secondSource = join(
      import.meta.dirname!,
      "fixtures",
      "slug-piece-v2.tsx",
    );

    const firstPieceId = await runCfPieceNewWithSlug({
      sourcePath: firstSource,
      identityPath,
      space: spaceDid,
      slug,
    });

    await shell.goto({
      frontendUrl: FRONTEND_URL,
      view: {
        spaceDid,
        pieceSlug: slug,
      },
      identity,
    });
    await waitForSlugPieceMarker(shell, "slug piece v1");
    await shell.waitForState({
      view: {
        spaceDid,
        pieceSlug: slug,
      },
      identity,
    });

    // Repointing is what this test is about, and taking a name that already
    // points somewhere is what `--force` is for.
    const secondPieceId = await runCfPieceNewWithSlug({
      sourcePath: secondSource,
      identityPath,
      space: spaceDid,
      slug,
      force: true,
    });
    expect(secondPieceId).not.toBe(firstPieceId);

    await waitForSlugPieceMarker(shell, "slug piece v2");
    const href = await shell.page().evaluate(() => globalThis.location.href);
    expect(href).toContain(`/${spaceDid}/${slug}`);
  });

  it("tears the runtime down cleanly on logout while a piece is rendered", async () => {
    const slug = `logout-teardown-${crypto.randomUUID()}`;
    await using tempIdentity = await writeTempIdentity({
      implementation: "noble",
    });
    const { identity, path: identityPath } = tempIdentity;
    const spaceDid = await createTestSpace(identity);
    const source = join(
      import.meta.dirname!,
      "fixtures",
      "slug-piece-v1.tsx",
    );

    await runCfPieceNewWithSlug({
      sourcePath: source,
      identityPath,
      space: spaceDid,
      slug,
    });

    await shell.goto({
      frontendUrl: FRONTEND_URL,
      view: { spaceDid, pieceSlug: slug },
      identity,
    });
    // The piece is rendered: the renderer, the favorites subscription, and
    // the slug-target poll are all live.
    await waitForSlugPieceMarker(shell, "slug piece v1");

    // In-app logout clears the identity, which disposes the runtime via the
    // RootView swap while those consumers are still active. Proactive
    // cancellation must tear them all down without recording a console error
    // — the harness afterEach fails the test on any (no allowlist).
    //
    // The RootView task disposes the previous RuntimeInternals fire-and-forget
    // and drops the promise, so there is nothing to await after the swap. Wrap
    // dispose() before triggering logout to hold onto the exact promise the
    // swap starts; awaiting it below settles all disposal-raced async work
    // (the abort's synchronous consumer teardowns, the worker Dispose round
    // trip, and the transport close) on a real completion instead of a timer.
    await shell.page().evaluate(async () => {
      const rootView = document.querySelector("x-root-view") as
        | {
          accessForTestingOnly?: {
            rt?: { value?: { dispose(): Promise<void> } };
          };
        }
        | null;
      const internals = rootView?.accessForTestingOnly?.rt?.value;
      if (!internals) {
        throw new Error(
          "Runtime internals not available to observe disposal",
        );
      }
      const global = globalThis as unknown as {
        __ctRuntimeDisposed?: Promise<void>;
      };
      global.__ctRuntimeDisposed = undefined;
      const disposeInternals = internals.dispose.bind(internals);
      internals.dispose = () => {
        global.__ctRuntimeDisposed = disposeInternals();
        return global.__ctRuntimeDisposed;
      };
      await globalThis.app.setIdentity(undefined);
    });
    // The swap clears the global only after it has called the wrapped
    // dispose(), so once the runtime is gone the disposal promise is stashed.
    await waitForCondition(
      shell.page(),
      () => !globalThis.commonfabric?.rt,
    );
    // Await the disposal the swap started, so all disposal-raced async work
    // has settled before afterEach inspects the recorded console errors.
    await shell.page().evaluate(async () => {
      await (globalThis as unknown as {
        __ctRuntimeDisposed?: Promise<void>;
      }).__ctRuntimeDisposed;
    });
  });
});
