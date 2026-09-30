import { expect } from "@std/expect";
import { beforeEach, describe, it } from "@std/testing/bdd";

import { env, type Page, waitForCondition } from "@commonfabric/integration";
import { ShellIntegration } from "@commonfabric/integration/shell-utils";
import { nameSchema } from "@commonfabric/runner/schemas";
import { NAME } from "@commonfabric/runner/shared";

import type { XPieceList } from "../src/components/PieceList.ts";
import type { XHeaderView } from "../src/views/HeaderView.ts";

declare global {
  var pieceMenuFixture: {
    header: XHeaderView;
    reads: Array<{ space: string; schema: unknown }>;
    starts: unknown[];
    registryReads: number;
    fullReads: number;
    release(space: string): void;
  };
}

/** Mount a real header over a runtime whose name reads the test releases. */
async function mountHeader(page: Page) {
  await page.evaluate(async (nameKey: string) => {
    const gates = new Map<string, ReturnType<typeof Promise.withResolvers>>();
    const fixture: typeof pieceMenuFixture = {
      header: document.createElement("x-header-view") as XHeaderView,
      reads: [],
      starts: [],
      registryReads: 0,
      fullReads: 0,
      release(space) {
        gates.get(space)!.resolve(undefined);
      },
    };
    const runtime = {
      synced: () => Promise.resolve(),
      favorites: () => ({ subscribeFavorites: () => () => {} }),
      getPiecesListCell() {
        fixture.registryReads++;
        return Promise.resolve({
          sync: () => Promise.resolve(),
          get: () => [
            { id: () => "named" },
            { $ID: "untitled" },
            { $ID: "unavailable" },
          ],
        });
      },
      getPattern(space: string, id: string, options: unknown) {
        fixture.starts.push(options);
        if (id === "unavailable") {
          return Promise.reject(new Error("Piece unavailable"));
        }
        const value = id === "named" ? { [nameKey]: `${space} title` } : {};
        return Promise.resolve({
          id: () => id,
          name: () => "Unprojected name",
          cell: () => ({
            sync: () => {
              fixture.fullReads++;
              return Promise.resolve(value);
            },
            asSchema: (schema: unknown) => ({
              sync: async () => {
                fixture.reads.push({ space, schema });
                if (!gates.has(space)) {
                  gates.set(space, Promise.withResolvers());
                }
                await gates.get(space)!.promise;
                return value;
              },
            }),
          }),
        });
      },
    };
    Object.assign(fixture.header, {
      rt: runtime,
      space: "did:key:first",
      spaceName: "Menu test",
      pieceTitle: "Current piece",
      pieceId: "named",
    });
    globalThis.pieceMenuFixture = fixture;
    document.body.replaceChildren(fixture.header);
    await fixture.header.updateComplete;
  }, { args: [NAME] });
}

/** Click a rendered control in the isolated header. */
async function clickHeader(page: Page, selector: string) {
  const button = await page.waitForSelector(selector, { strategy: "pierce" });
  await button.click();
  await page.evaluate(async () => {
    await pieceMenuFixture.header.updateComplete;
  });
}

/** Wait for the piece list to display a loaded name or loading status. */
async function waitForListText(page: Page, text: string) {
  await waitForCondition(page, (probe, expected) => {
    return probe.collect("x-piece-list").some((list) =>
      probe.isRendered(list) && probe.deepText(list).includes(expected)
    );
  }, { args: [text] });
}

describe("header piece list", () => {
  const shell = new ShellIntegration();
  shell.bindLifecycle();

  beforeEach(async () => {
    await shell.page().goto(env.FRONTEND_URL);
    await shell.page().setViewportSize({ width: 1280, height: 800 });
    await mountHeader(shell.page());
  });

  for (const surface of ["desktop", "mobile"] as const) {
    it(`loads only names when the ${surface} switcher opens and reuses them`, async () => {
      const page = shell.page();
      const trigger = surface === "desktop"
        ? ".header-piece-trigger"
        : ".piece-title-row";
      expect(await page.evaluate(() => pieceMenuFixture.registryReads)).toBe(0);
      if (surface === "mobile") {
        await page.setViewportSize({ width: 390, height: 844 });
        await clickHeader(page, ".nav-picker");
        expect(await page.evaluate(() => pieceMenuFixture.registryReads)).toBe(
          0,
        );
      }

      await clickHeader(page, trigger);
      await waitForListText(page, "Loading pieces…");
      const pending = await page.evaluate(() => ({
        registryReads: pieceMenuFixture.registryReads,
        fullReads: pieceMenuFixture.fullReads,
        reads: pieceMenuFixture.reads,
        starts: pieceMenuFixture.starts,
      }));
      expect(pending.registryReads).toBe(1);
      expect(pending.fullReads).toBe(0);
      expect(pending.reads).toEqual([
        { space: "did:key:first", schema: nameSchema },
        { space: "did:key:first", schema: nameSchema },
      ]);
      expect(pending.starts).toEqual([
        { start: false },
        { start: false },
        { start: false },
      ]);
      await page.evaluate(() => pieceMenuFixture.release("did:key:first"));
      await waitForListText(page, "did:key:first title");
      await waitForListText(page, "Piece #untitl");

      await clickHeader(page, trigger);
      await clickHeader(page, trigger);
      await waitForListText(page, "did:key:first title");
      expect(await page.evaluate(() => pieceMenuFixture.registryReads)).toBe(1);
    });
  }

  it("keeps a late response from replacing the new space's cached names", async () => {
    const page = shell.page();
    await clickHeader(page, ".header-piece-trigger");
    await waitForListText(page, "Loading pieces…");
    await page.evaluate(async () => {
      pieceMenuFixture.header.space = "did:key:second";
      await pieceMenuFixture.header.updateComplete;
    });
    await page.evaluate(() => pieceMenuFixture.release("did:key:second"));
    await waitForListText(page, "did:key:second title");
    await page.evaluate(() => pieceMenuFixture.release("did:key:first"));

    await clickHeader(page, ".header-piece-trigger");
    await clickHeader(page, ".header-piece-trigger");
    const names = await page.evaluate(async () => {
      const list = pieceMenuFixture.header.shadowRoot!
        .querySelector("x-piece-list") as XPieceList;
      await list.updateComplete;
      return Array.from(list.shadowRoot!.querySelectorAll(".piece-item"))
        .map((item) => item.textContent!.trim());
    });
    expect(names).toEqual(["did:key:second title", "Piece #untitl"]);
    expect(await page.evaluate(() => pieceMenuFixture.registryReads)).toBe(2);
  });

  it("closes a disconnected switcher and loads again when reopened", async () => {
    const page = shell.page();
    await clickHeader(page, ".header-piece-trigger");
    await waitForListText(page, "Loading pieces…");
    await page.evaluate(async () => {
      const { header } = pieceMenuFixture;
      header.remove();
      pieceMenuFixture.release("did:key:first");
      await header.updateComplete;
    });
    await page.evaluate(async () => {
      const { header } = pieceMenuFixture;
      document.body.append(header);
      await header.updateComplete;
    });
    expect(
      await page.evaluate(() => {
        return pieceMenuFixture.header.shadowRoot!
          .querySelector(".header-piece-trigger")!.getAttribute(
            "aria-expanded",
          );
      }),
    ).toBe("false");
    await clickHeader(page, ".header-piece-trigger");
    await waitForListText(page, "did:key:first title");
    expect(await page.evaluate(() => pieceMenuFixture.registryReads)).toBe(2);
  });
});
