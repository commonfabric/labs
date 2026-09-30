/**
 * Browser ladder for commit preparation while opening a labeled thread.
 *
 * `CF_CFC_PREPARE_LADDER=1 deno task integration patterns cfc-prepare` uses
 * isolated harness servers. `CF_CFC_PREPARE_SIZES` and `CF_CFC_PREPARE_REPS`
 * choose the size ladder and repetition count; `CF_CFC_PREPARE_OUT` chooses
 * where raw counters, labels, load, and worker profiles are written.
 */
import { expect } from "@std/expect";
import { join } from "@std/path";
import { afterAll, beforeAll, describe, it } from "@std/testing/bdd";

import { Identity } from "@commonfabric/identity";
import {
  attachWorkerProfiler,
  awaitViewSettled,
  env,
  type Page,
  type ProbeApi,
  startWorkerProfile,
  waitForCondition,
  writeWorkerProfile,
} from "@commonfabric/integration";
import { ShellIntegration } from "@commonfabric/integration/shell-utils";
import { isCfcEnforcementRejection } from "@commonfabric/runner";
import { cfcLabelViewForResolvedCellWithStatus } from "@commonfabric/runner/cfc";
import { resolveLocalProgram } from "@commonfabric/runner/local-program.deno";
import type { CellHandle, CellRef } from "@commonfabric/runtime-client";

import {
  clickMarked,
  collectBrowserLoadSummary,
  StepTimer,
  waitForText,
} from "./cfc-browser-helpers.ts";
import {
  initializePiecesController,
  type PiecesController,
} from "./pieces-controller.ts";

const enabled = Deno.env.get("CF_CFC_PREPARE_LADDER") === "1";
const sizes = (Deno.env.get("CF_CFC_PREPARE_SIZES") ?? "11,25,50,100")
  .split(",").map(Number);
const repetitions = Number(Deno.env.get("CF_CFC_PREPARE_REPS") ?? "3");
const firstRepetition =
  Number(Deno.env.get("CF_CFC_PREPARE_START_REP") ?? "1") - 1;
const output = Deno.env.get("CF_CFC_PREPARE_OUT") ??
  "/tmp/cfc-round2-browser";

/** Read exact worker counters without the load summary's top-row truncation. */
async function workerStats(page: Page) {
  return await page.evaluate(async () => {
    const stats = await globalThis.commonfabric.rt!.getLoggerCounts();
    return { cfc: stats.cfc, timing: stats.timing };
  });
}

/** Mark the settled native control and record its actual click event. */
function markOpen(probe: ProbeApi, token: string): boolean {
  const host = probe.collect("#cfc-open")[0];
  const button = host?.shadowRoot?.querySelector<HTMLButtonElement>(
    "[data-cf-button]",
  );
  if (!button || button.disabled) return false;
  const box = button.getBoundingClientRect();
  if (box.width <= 0 || box.height <= 0) return false;
  button.setAttribute("data-cfc-click-target", token);
  button.addEventListener("click", () => {
    (globalThis as typeof globalThis & { __cfcClickAt: number })
      .__cfcClickAt = performance.now();
  }, { once: true });
  return true;
}

/** Finish on visible DOM content, without requesting additional runtime work. */
function rendered(probe: ProbeApi, count: number) {
  const elements = probe.collect(".cfc-bubble");
  if (elements.length !== count) return false;
  const contents = elements.map((element) => {
    const box = element.getBoundingClientRect();
    const style = getComputedStyle(element);
    return {
      text: element.textContent ?? "",
      className: element.className,
      visible: box.width > 0 && box.height > 0 &&
        style.display !== "none" && style.visibility !== "hidden",
    };
  });
  if (!contents.every((element) => element.visible)) return false;
  const timing = globalThis as typeof globalThis & {
    __cfcClickAt?: number;
    __cfcVisibleMs?: number;
  };
  if (timing.__cfcClickAt === undefined) return false;
  timing.__cfcVisibleMs = performance.now() - timing.__cfcClickAt;
  return contents;
}

describe({ name: "cfc-prepare", ignore: !enabled }, () => {
  const shell = new ShellIntegration();
  shell.bindLifecycle();
  let identity: Identity;
  let controller: PiecesController;

  beforeAll(async () => {
    await Deno.mkdir(output, { recursive: true });
    identity = await Identity.generate({ implementation: "noble" });
    controller = await initializePiecesController({
      space: env.SPACE_NAME,
      apiUrl: new URL(env.API_URL),
      identity,
      cfcEnforcementMode: "enforce-explicit",
      cfcFlowLabels: "persist",
    });
    await controller.ensureDefaultPattern();
  });

  afterAll(async () => await controller?.dispose());

  it("renders every labeled bubble across the interleaved size ladder", async () => {
    const program = await resolveLocalProgram(
      (resolver) => controller.runtime.harness.resolve(resolver),
      {
        main: join(import.meta.dirname!, "fixtures/cfc-prepare/main.tsx"),
        root: join(import.meta.dirname!, ".."),
      },
    );
    for (
      let repetition = firstRepetition;
      repetition < firstRepetition + repetitions;
      repetition++
    ) {
      // Rotating the size order distributes startup and machine drift.
      const ordered = sizes.slice(repetition).concat(
        sizes.slice(0, repetition),
      );
      for (const count of ordered) {
        const label = `n${count}-r${repetition + 1}`;
        const piece = await controller.create(program, { start: true });
        await piece.result.set({ count }, ["seed"]);
        await controller.runtime.idle();
        await controller.synced();
        const page = shell.page();
        await shell.disposeRuntime();
        await shell.goto({
          frontendUrl: env.FRONTEND_URL,
          view: { spaceName: env.SPACE_NAME, pieceId: piece.id },
          identity,
        });
        await waitForText(page, "#cfc-open", "Open thread");
        await awaitViewSettled(page);
        const clickToken = `cfc-prepare-${label}`;
        await waitForCondition(page, markOpen, { args: [clickToken] });
        const profiler = await attachWorkerProfiler(shell.wsEndpoint());
        await page.evaluate(async () => {
          await globalThis.commonfabric.rt!.resetLoggerBaselines();
        });
        const before = await workerStats(page);
        const load = await new Deno.Command("uptime", { stdout: "piped" })
          .output();
        const profileStarted = profiler &&
          await startWorkerProfile(profiler, label);
        const timer = new StepTimer();
        let contents: unknown;
        try {
          contents = await timer.run("click-to-visible", async () => {
            const visible = waitForCondition(page, rendered, { args: [count] });
            await clickMarked(page, clickToken);
            return await visible;
          });
        } finally {
          if (profileStarted) {
            await writeWorkerProfile(profiler, {
              pathPrefix: join(output, label),
              label,
            });
          }
          profiler?.close();
        }
        expect(contents).toEqual(
          Array.from({ length: count }, (_, index) => ({
            text: `Message ${index}`,
            className: index % 2 === 0 ? "cfc-bubble me" : "cfc-bubble",
            visible: true,
          })),
        );
        const visibleMs = await page.evaluate(() =>
          (globalThis as typeof globalThis & { __cfcVisibleMs: number })
            .__cfcVisibleMs
        );
        const after = await workerStats(page);
        const summary = await collectBrowserLoadSummary(page, label);
        await awaitViewSettled(page);
        const elementLabels = await page.evaluate(async (ref: CellRef) => {
          const rt = globalThis.commonfabric.rt!;
          const cell = rt.getCellFromRef({
            ...ref,
            path: [...ref.path, "elements"],
          }).asSchema<CellHandle<unknown>[]>({
            type: "array",
            items: { asCell: ["cell"] },
          });
          const elements = await cell.sync();
          return await Promise.all((elements ?? []).map(async (element) => {
            const resolved = await element.resolveAsCell();
            const value = await resolved.sync();
            const fields = await Promise.all([
              ["children", "0"],
              ["props", "className"],
            ].map(async (path) => {
              const field = rt.getCellFromRef({
                ...resolved.ref(),
                path: [...resolved.ref().path, ...path],
              });
              const target = await field.resolveAsCell();
              await target.sync();
              return {
                path,
                value: await field.sync(),
                view: await field.getCfcLabel(),
                resolvedRef: target.ref(),
                resolvedView: await target.getCfcLabel(),
              };
            }));
            return {
              ref: element.ref(),
              resolvedRef: resolved.ref(),
              view: await resolved.getCfcLabel(),
              value,
              fields,
            };
          }));
        }, { args: [piece.getCell().getAsNormalizedFullLink()] });
        expect(elementLabels).toHaveLength(count);
        const resolvedLabels = [];
        for (const element of elementLabels) {
          expect(
            element.fields[0].view?.entries.map((entry) => ({
              path: entry.path,
              observes: entry.observes,
              confidentiality: entry.label.confidentiality,
            })),
          ).toEqual(["value", "followRef"].map((observes) => ({
            path: [],
            observes,
            confidentiality: ["cfc-prepare-messages"],
          })));
          for (const field of element.fields) {
            expect(field.resolvedRef.cfcLabelView).toBeDefined();
            for (const entry of field.resolvedRef.cfcLabelView!.entries) {
              expect(entry.label.confidentiality).toEqual([
                "cfc-prepare-messages",
              ]);
            }
          }
          expect(element.ref.cfcLabelView).toEqual({
            version: 1,
            entries: [
              {
                path: [],
                label: { confidentiality: ["cfc-prepare-messages"] },
              },
              ...["shape", "value"].map((observes) => ({
                path: ["length"],
                label: { confidentiality: ["cfc-prepare-messages"] },
                observes,
              })),
            ],
          });
          const cell = controller.runtime.getCellFromLink(element.resolvedRef);
          await cell.sync();
          const status = cfcLabelViewForResolvedCellWithStatus(cell);
          expect(status.readFailed).toBe(false);
          resolvedLabels.push(status);
        }
        const rowCell = await piece.result.getCell(["thread", "result", "0"]);
        const sourceLabel = cfcLabelViewForResolvedCellWithStatus(rowCell);
        expect(sourceLabel).toEqual({
          readFailed: false,
          view: {
            version: 1,
            entries: [{
              path: ["packed"],
              label: { confidentiality: ["cfc-prepare-messages"] },
              observes: "value",
            }],
          },
        });
        const tx = controller.runtime.edit();
        tx.setCfcEnforcementMode("enforce-strict");
        const row = rowCell.resolveAsCell().withTx(tx).getRaw();
        const target = controller.runtime.getCell(
          rowCell.getAsNormalizedFullLink().space,
          `cfc-prepare-strict-${label}`,
          undefined,
          tx,
        );
        target.set({ copied: row });
        tx.prepareCfc();
        const refusal = await tx.commit();
        expect(isCfcEnforcementRejection(refusal.error)).toBe(true);
        const strictReason = refusal.error!.message.replaceAll(
          target.getAsNormalizedFullLink().id,
          "<target>",
        );
        expect(strictReason).toBe(
          "CFC enforcement rejected commit: relevant transaction was not " +
            "prepared: writer-fit confidentiality misfit for <target> at / " +
            '(canWrite, §8.12.4): "cfc-prepare-messages"',
        );
        const result = {
          label,
          count,
          repetition: repetition + 1,
          uptime: new TextDecoder().decode(load.stdout).trim(),
          timing: timer.rows(),
          visibleMs,
          before,
          after,
          sourceLabel,
          elementLabels,
          resolvedLabels,
          strictReason,
          contents,
          summary,
        };
        await Deno.writeTextFile(
          join(output, `${label}.json`),
          JSON.stringify(result, null, 2),
        );
        console.log(
          `CFC_PREPARE ${
            JSON.stringify({ label, visibleMs, timing: timer.rows() })
          }`,
        );
      }
    }
  });
});
