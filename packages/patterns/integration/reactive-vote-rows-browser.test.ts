/** Verifies rendered nested filters and mapped rows after writes from another replica. */

import { Identity } from "@commonfabric/identity";
import {
  Browser,
  createTestSpace,
  env,
  type Page,
} from "@commonfabric/integration";
import { login } from "@commonfabric/integration/shell-utils";
import type { Cell } from "@commonfabric/runner";
import { resolveLocalProgram } from "@commonfabric/runner/local-program.deno";
import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { join } from "@std/path";
import { initializePiecesController } from "./pieces-controller.ts";
import { settleView, waitForSettledText } from "./cfc-browser-helpers.ts";
import { waitForPieceView } from "./topics-navigation-helpers.ts";

const networkControlUrl = Deno.env.get("CF_ROW_RECONNECT_CONTROL_URL");

/** Controls the local relay used by the optional browser reconnect run. */
async function controlNetwork(action: "pause" | "resume"): Promise<void> {
  if (!networkControlUrl) return;
  const response = await fetch(new URL(action, networkControlUrl), {
    method: "POST",
  });
  if (!response.ok) {
    throw new Error(`Network relay ${action}: ${response.status}`);
  }
  const result = await response.json();
  if (action === "pause") expect(result.closedSockets).toBeGreaterThan(0);
}

const root = join(import.meta.dirname!, "..");
const fixtureRoot = join(import.meta.dirname!, "fixtures/reactive-vote-rows");

interface FixtureOutput {
  cast: { key: string; optionId: string; color: string };
  rename: { key: string; name: string };
  retract: { key: string };
}

/** Reads row order and nested swatches across the shell's shadow roots. */
async function renderedRows(page: Page) {
  return await page.evaluate(() => {
    function collect(root: Document | ShadowRoot): {
      id: string;
      text: string;
      swatches: string[];
    }[] {
      const rows = [...root.querySelectorAll("[data-row]")].map((element) => ({
        id: element.getAttribute("data-row")!,
        text: (element.textContent ?? "").replace(/\s+/g, " ").trim(),
        swatches: [...element.querySelectorAll("[data-swatch]")].map((swatch) =>
          swatch.textContent ?? ""
        ),
      }));
      for (const element of root.querySelectorAll("*")) {
        if (element.shadowRoot) {
          for (const row of collect(element.shadowRoot)) rows.push(row);
        }
      }
      return rows;
    }
    return collect(document);
  });
}

describe("rendered vote rows across replicas", () => {
  const cases = ["nested", "mapped"].flatMap((variant) =>
    [false, true].map((crossSpace) => ({ variant, crossSpace }))
  );
  for (const { variant, crossSpace } of cases) {
    const profileLocation = crossSpace ? "cross-space" : "same-space";
    it(`materializes and updates ${variant} rows with ${profileLocation} profiles after remote writes`, async () => {
      const identity = await Identity.fromPassphrase(
        `reactive rows ${variant}`,
        { implementation: "noble" },
      );
      const spaceDid = await createTestSpace(identity);
      const cc = await initializePiecesController({
        space: spaceDid,
        apiUrl: new URL(env.API_URL),
        identity,
      });
      let browser: Awaited<ReturnType<typeof Browser.launch>> | undefined;
      try {
        browser = await Browser.launch({ headless: true });
        await cc.ensureDefaultPattern();
        let input: object | undefined;
        let externalProfiles: Cell<{ name: string }[]> | undefined;
        if (crossSpace) {
          const profiles = cc.runtime.getCell<{ name: string }[]>(
            await createTestSpace(identity),
            "remote-voter-profiles",
          );
          const initialized = await cc.runtime.editWithRetry((tx) => {
            const writableProfiles = profiles.withTx(tx);
            writableProfiles.set([]);
            for (const key of ["alice", "bob", "carol"]) {
              const profile = writableProfiles.elementById(key);
              profile.set({ name: key });
              writableProfiles.addUnique(profile);
            }
          });
          if (initialized.error) throw new Error(initialized.error.message);
          await cc.synced();
          input = { profiles };
          externalProfiles = profiles;
        }
        const program = await resolveLocalProgram(
          (resolver) => cc.runtime.harness.resolve(resolver),
          {
            main: join(fixtureRoot, `${variant}.tsx`),
            root,
            testPaths: [join(fixtureRoot, "main.test.tsx")],
          },
        );
        const piece = await cc.create<FixtureOutput>(program, {
          start: true,
          input,
        });
        const output = cc.getResult<FixtureOutput>(piece.getCell());
        const coldName = "Alice Before Mount";
        const seeded = await cc.runtime.editWithRetry((tx) =>
          output.key("cast").withTx(tx).send({
            key: "alice",
            optionId: "one",
            color: "red",
          })
        );
        if (seeded.error) throw new Error(seeded.error.message);
        await cc.runtime.settled(Infinity);
        const coldRename = await cc.runtime.editWithRetry((tx) => {
          if (externalProfiles) {
            externalProfiles.withTx(tx).elementById("alice").key("name")
              .set(coldName);
          } else {
            output.key("rename").withTx(tx).send({
              key: "alice",
              name: coldName,
            });
          }
        });
        if (coldRename.error) throw new Error(coldRename.error.message);
        await cc.runtime.settled(Infinity);
        await cc.synced();
        const page = await browser.newPage();
        const errors: string[] = [];
        page.addEventListener("pageerror", (event) => {
          errors.push(event.detail.message);
        });
        await page.goto(`${env.FRONTEND_URL}${spaceDid}/${piece.id}`);
        await waitForPieceView(page, spaceDid, piece.id);
        await login(page, identity);
        await settleView(page);
        await waitForSettledText(
          page,
          `[data-row="one"][title="${coldName}"]`,
          "one: red",
        );
        expect(await renderedRows(page)).toEqual([
          {
            id: "one",
            text: "one: red",
            swatches: variant === "mapped" ? ["red"] : [],
          },
          { id: "two", text: "two:", swatches: [] },
        ]);
        const artifactDir = Deno.env.get("CF_ROW_REPRO_ARTIFACT_DIR");
        if (artifactDir) {
          const artifactName = crossSpace ? `${variant}-cross-space` : variant;
          await Deno.mkdir(artifactDir, { recursive: true });
          await page.screenshot(join(artifactDir, `${artifactName}-cold.png`));
        }
        for (const color of ["green", "yellow"]) {
          await controlNetwork("pause");
          const sent = await cc.runtime.editWithRetry((tx) =>
            output.key("cast").withTx(tx).send({
              key: "alice",
              optionId: "one",
              color,
            })
          );
          if (sent.error) throw new Error(sent.error.message);
          await cc.runtime.settled(Infinity);
          await cc.synced();
          await controlNetwork("resume");
          await waitForSettledText(
            page,
            variant === "mapped"
              ? `[data-row="one"][title="${coldName}"][data-tally-colors="${color}"]`
              : `[data-row="one"][title="${coldName}"]`,
            variant === "mapped" ? "one:" : `one: ${color}`,
          );
          if (variant === "mapped") {
            await settleView(page);
            const swatches = await page.evaluate(() => {
              function collect(root: Document | ShadowRoot): string[] {
                const values = [
                  ...root.querySelectorAll('[data-row="one"] [data-swatch]'),
                ]
                  .map((element) => element.textContent ?? "");
                for (const element of root.querySelectorAll("*")) {
                  if (element.shadowRoot) {
                    for (const value of collect(element.shadowRoot)) {
                      values.push(value);
                    }
                  }
                }
                return values;
              }
              return collect(document);
            });
            expect(swatches).toEqual([color]);
          }
        }
        await controlNetwork("pause");
        const renamed = await cc.runtime.editWithRetry((tx) => {
          if (externalProfiles) {
            externalProfiles.withTx(tx).elementById("alice").key("name")
              .set("Alice Updated");
          } else {
            output.key("rename").withTx(tx).send({
              key: "alice",
              name: "Alice Updated",
            });
          }
        });
        if (renamed.error) throw new Error(renamed.error.message);
        await cc.runtime.settled(Infinity);
        await cc.synced();
        await controlNetwork("resume");
        await waitForSettledText(
          page,
          '[data-row="one"][title="Alice Updated"]',
          "one: yellow",
        );
        for (const key of ["bob", "carol"]) {
          const inserted = await cc.runtime.editWithRetry((tx) =>
            output.key("cast").withTx(tx).send({
              key,
              optionId: "two",
              color: "green",
            })
          );
          if (inserted.error) throw new Error(inserted.error.message);
          await cc.runtime.settled(Infinity);
          await cc.synced();
        }
        await waitForSettledText(
          page,
          '[data-row="two"][title="bob,carol"]',
          variant === "mapped" ? "two: greengreen" : "two: green,green",
        );
        if (variant === "mapped") {
          await waitForSettledText(
            page,
            '[data-row="two"] [data-swatch="carol"]',
            "green",
          );
          await waitForSettledText(
            page,
            '[data-row="one"] [data-swatch="Alice Updated"]',
            "yellow",
          );
          await settleView(page);
          const rowOrder = (await renderedRows(page)).map((row) => row.id);
          expect(rowOrder).toEqual(["two", "one"]);
        }
        if (errors.length) throw new Error(errors.join("; "));
        if (artifactDir) {
          const artifactName = crossSpace ? `${variant}-cross-space` : variant;
          await Deno.mkdir(artifactDir, { recursive: true });
          await page.screenshot(join(artifactDir, `${artifactName}.png`));
          await Deno.writeTextFile(
            join(artifactDir, `${artifactName}.json`),
            JSON.stringify(
              {
                variant,
                profileLocation,
                reconnect: Boolean(networkControlUrl),
                url: `${env.FRONTEND_URL}${spaceDid}/${piece.id}`,
                assertions: [
                  "linked values and profiles before first browser materialization",
                  "remote colors",
                  "profile-only edit",
                  "remote membership",
                ],
                rankedRows: variant === "mapped"
                  ? ["two", "one"]
                  : ["one", "two"],
              },
              null,
              2,
            ),
          );
        }
        for (const key of ["bob", "carol"]) {
          await controlNetwork("pause");
          const removed = await cc.runtime.editWithRetry((tx) =>
            output.key("retract").withTx(tx).send({ key })
          );
          if (removed.error) throw new Error(removed.error.message);
          await cc.runtime.settled(Infinity);
          await cc.synced();
          await controlNetwork("resume");
          await waitForSettledText(
            page,
            `[data-row="two"][title="${key === "bob" ? "carol" : ""}"]`,
            key === "bob" ? "two: green" : "two:",
          );
          await settleView(page);
          expect(
            (await renderedRows(page)).find((row) => row.id === "two")?.text,
          )
            .toBe(key === "bob" ? "two: green" : "two:");
        }
        await settleView(page);
        if (variant === "mapped") {
          expect(await renderedRows(page)).toEqual([
            { id: "one", text: "one: yellow", swatches: ["yellow"] },
            { id: "two", text: "two:", swatches: [] },
          ]);
        }
        if (artifactDir) {
          const artifactName = crossSpace ? `${variant}-cross-space` : variant;
          await page.screenshot(
            join(artifactDir, `${artifactName}-removed.png`),
          );
        }
        const restored = await cc.runtime.editWithRetry((tx) =>
          output.key("cast").withTx(tx).send({
            key: "bob",
            optionId: "two",
            color: "green",
          })
        );
        if (restored.error) throw new Error(restored.error.message);
        await cc.runtime.settled(Infinity);
        await cc.synced();
        await waitForSettledText(
          page,
          '[data-row="two"][title="bob"]',
          "two: green",
        );
        await settleView(page);
        if (variant === "mapped") {
          expect(await renderedRows(page)).toEqual([
            { id: "one", text: "one: yellow", swatches: ["yellow"] },
            { id: "two", text: "two: green", swatches: ["green"] },
          ]);
        }
        expect((await renderedRows(page)).find((row) => row.id === "two")?.text)
          .toBe("two: green");
        expect(errors).toEqual([]);
      } finally {
        try {
          await controlNetwork("resume");
        } finally {
          try {
            await browser?.close();
          } finally {
            await cc.dispose();
          }
        }
      }
    });
  }
});
