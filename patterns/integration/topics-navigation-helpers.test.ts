/**
 * Exercises cell-link navigation over stand-in links whose destinations and
 * replacement timing are controlled by the test.
 */

import { Browser, type Page } from "@commonfabric/integration";
import { expect } from "@std/expect";
import { afterAll, beforeAll, describe, it } from "@std/testing/bdd";

import { clickCellLink } from "./topics-navigation-helpers.ts";

describe("topics-navigation-helpers", () => {
  let browser: Browser;
  let page: Page;

  beforeAll(async () => {
    browser = await Browser.launch({ headless: true });
    page = await browser.newPage();
  });

  afterAll(async () => {
    await browser.close();
  });

  describe("clickCellLink()", () => {
    it("keeps a replacement in the resolved space and scope", async () => {
      await page.evaluate(() => {
        document.body.replaceChildren();
        const clicks: string[] = [];
        let replacements = 0;
        const links = document.createElement("div");
        const buildLink = (
          space: string,
          scope: string,
          pieceId: string,
          path: readonly string[] = [],
          label = "Open",
          onResolve?: () => void,
        ) => {
          let resolved = false;
          const link = Object.assign(document.createElement("cf-cell-link"), {
            label,
            _resolvedCell: {
              space: () => space,
              id: () => {
                if (!resolved) {
                  resolved = true;
                  onResolve?.();
                }
                return pieceId;
              },
              ref: () => ({ scope, path }),
            },
          });
          const linkRoot = link.attachShadow({ mode: "open" });
          const chip = document.createElement("cf-chip");
          const chipRoot = chip.attachShadow({ mode: "open" });
          const button = document.createElement("button");
          const identity = `${space}/${scope}/${pieceId}/${
            JSON.stringify(path)
          }`;
          button.textContent = `${label} ${identity}`;
          button.addEventListener("click", () => clicks.push(identity));
          chipRoot.append(button);
          linkRoot.append(chip);
          return link;
        };

        const firstSpace = "did:key:first";
        const firstScope = "user";
        const firstId = "of:fid1:shared";
        const first = buildLink(
          firstSpace,
          firstScope,
          firstId,
          [],
          "Open",
          () => {
            replacements++;
            first.remove();
            links.append(buildLink(firstSpace, firstScope, firstId));
          },
        );
        links.append(
          first,
          buildLink("did:key:second", firstScope, firstId),
          buildLink(firstSpace, "session", firstId),
          buildLink(firstSpace, firstScope, firstId, ["child"]),
        );
        document.body.append(links);

        Object.assign(globalThis, {
          commonfabric: { viewSettled: () => Promise.resolve() },
          __topicsNavigationResult: () => ({ clicks, replacements }),
        });
      });

      const returned = await clickCellLink(page, "Open");
      const result = await page.evaluate(() =>
        (globalThis as typeof globalThis & {
          __topicsNavigationResult: () => {
            clicks: string[];
            replacements: number;
          };
        }).__topicsNavigationResult()
      );

      expect(result.replacements).toBe(1);
      expect(returned).toBe("of:fid1:shared");
      expect(result.clicks).toEqual([
        `did:key:first/user/${returned}/[]`,
      ]);
    });

    it("revalidates after a surviving link's box settles", async () => {
      await page.evaluate(() => {
        document.body.replaceChildren();
        const clicks: string[] = [];
        const links = document.createElement("div");
        const makeCell = (pieceId: string) => ({
          space: () => "did:key:space",
          id: () => pieceId,
          ref: () => ({ scope: "space", path: [] }),
        });
        const buildLink = (pieceId: string, label: string) => {
          const link = Object.assign(document.createElement("cf-cell-link"), {
            label,
            _resolvedCell: makeCell(pieceId),
          });
          const linkRoot = link.attachShadow({ mode: "open" });
          const chip = document.createElement("cf-chip");
          const chipRoot = chip.attachShadow({ mode: "open" });
          const button = document.createElement("button");
          button.textContent = `${label} ${pieceId}`;
          button.addEventListener(
            "click",
            () => clicks.push(link._resolvedCell.id()),
          );
          chipRoot.append(button);
          linkRoot.append(chip);
          return link;
        };

        const firstId = "of:fid1:first";
        const first = buildLink(firstId, "Open");
        const originalId = first._resolvedCell.id;
        let identityReads = 0;
        let retargets = 0;
        first._resolvedCell.id = () => {
          identityReads++;
          if (identityReads === 2) {
            requestAnimationFrame(() => {
              first._resolvedCell = makeCell("of:fid1:second");
              retargets++;
            });
            first._resolvedCell.id = originalId;
          }
          return firstId;
        };
        links.append(first, buildLink(firstId, "Backup"));
        document.body.append(links);

        Object.assign(globalThis, {
          commonfabric: { viewSettled: () => Promise.resolve() },
          __topicsNavigationResult: () => ({ clicks, retargets }),
        });
      });

      const returned = await clickCellLink(page, "Open");
      const result = await page.evaluate(() =>
        (globalThis as typeof globalThis & {
          __topicsNavigationResult: () => {
            clicks: string[];
            retargets: number;
          };
        }).__topicsNavigationResult()
      );

      expect(result.retargets).toBe(1);
      expect(returned).toBe("of:fid1:first");
      expect(result.clicks).toEqual([returned]);
    });
  });
});
