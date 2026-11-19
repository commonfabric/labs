/**
 * Exercises cell-link navigation over stand-in links whose destinations and
 * replacement timing are controlled by the test. A stand-in's button
 * dispatches `cf-navigate` for what it opens, as a `cf-cell-link`'s click
 * does, and the helper reports that.
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
          button.addEventListener("click", () => {
            clicks.push(identity);
            globalThis.dispatchEvent(
              new CustomEvent("cf-navigate", { detail: { pieceId } }),
            );
          });
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

    it("asks a labelled link that has resolved nothing to resolve, then clicks it", async () => {
      await page.evaluate(() => {
        document.body.replaceChildren();
        const clicks: string[] = [];
        let requests = 0;
        const pieceId = "of:fid1:on-demand";
        const link = Object.assign(document.createElement("cf-cell-link"), {
          label: "Open",
          _resolvedCell: undefined as unknown,
          resolveTarget() {
            requests++;
            return new Promise((resolve) =>
              setTimeout(() => {
                link._resolvedCell = {
                  space: () => "did:key:space",
                  id: () => pieceId,
                  ref: () => ({ scope: "space", path: [] }),
                };
                resolve(link._resolvedCell);
              }, 20)
            );
          },
        });
        const linkRoot = link.attachShadow({ mode: "open" });
        const chip = document.createElement("cf-chip");
        const chipRoot = chip.attachShadow({ mode: "open" });
        const button = document.createElement("button");
        button.textContent = "Open";
        button.addEventListener("click", () => {
          clicks.push(pieceId);
          globalThis.dispatchEvent(
            new CustomEvent("cf-navigate", { detail: { pieceId } }),
          );
        });
        chipRoot.append(button);
        linkRoot.append(chip);
        document.body.append(link);

        Object.assign(globalThis, {
          commonfabric: { viewSettled: () => Promise.resolve() },
          __topicsNavigationResult: () => ({ clicks, requests }),
        });
      });

      const returned = await clickCellLink(page, "Open");
      const result = await page.evaluate(() =>
        (globalThis as typeof globalThis & {
          __topicsNavigationResult: () => {
            clicks: string[];
            requests: number;
          };
        }).__topicsNavigationResult()
      );

      expect(returned).toBe("of:fid1:on-demand");
      expect(result.clicks).toEqual(["of:fid1:on-demand"]);
      expect(result.requests).toBeGreaterThanOrEqual(1);
    });

    it("asks no other labelled link to resolve, through the click and its revalidation", async () => {
      await page.evaluate(() => {
        document.body.replaceChildren();
        const clicks: string[] = [];
        const requests: Record<string, number> = {};
        const buildLink = (label: string, pieceId: string) => {
          requests[pieceId] = 0;
          const link = Object.assign(document.createElement("cf-cell-link"), {
            label,
            _resolvedCell: undefined as unknown,
            resolveTarget() {
              requests[pieceId]++;
              return new Promise((resolve) =>
                setTimeout(() => {
                  link._resolvedCell = {
                    space: () => "did:key:space",
                    id: () => pieceId,
                    ref: () => ({ scope: "space", path: [] }),
                  };
                  resolve(link._resolvedCell);
                }, 5)
              );
            },
          });
          const linkRoot = link.attachShadow({ mode: "open" });
          const chip = document.createElement("cf-chip");
          const chipRoot = chip.attachShadow({ mode: "open" });
          const button = document.createElement("button");
          button.textContent = label;
          button.addEventListener("click", () => {
            clicks.push(pieceId);
            globalThis.dispatchEvent(
              new CustomEvent("cf-navigate", { detail: { pieceId } }),
            );
          });
          chipRoot.append(button);
          linkRoot.append(chip);
          return link;
        };
        for (let index = 0; index < 10; index++) {
          document.body.append(buildLink("Other", `of:fid1:other-${index}`));
        }
        document.body.append(buildLink("Open", "of:fid1:selected"));

        Object.assign(globalThis, {
          commonfabric: { viewSettled: () => Promise.resolve() },
          __topicsNavigationResult: () => ({ clicks, requests }),
        });
      });

      const returned = await clickCellLink(page, "Open");
      const result = await page.evaluate(() =>
        (globalThis as typeof globalThis & {
          __topicsNavigationResult: () => {
            clicks: string[];
            requests: Record<string, number>;
          };
        }).__topicsNavigationResult()
      );

      expect(returned).toBe("of:fid1:selected");
      expect(result.clicks).toEqual(["of:fid1:selected"]);
      expect(
        Object.entries(result.requests)
          .filter(([id, count]) => id !== "of:fid1:selected" && count > 0),
      ).toEqual([]);
    });

    it("asks only the first of several links with the same label to resolve", async () => {
      await page.evaluate(() => {
        document.body.replaceChildren();
        const clicks: string[] = [];
        const requests: Record<string, number> = {};
        for (let index = 0; index < 10; index++) {
          const pieceId = `of:fid1:open-${index}`;
          requests[pieceId] = 0;
          const link = Object.assign(document.createElement("cf-cell-link"), {
            label: "Open",
            _resolvedCell: undefined as unknown,
            resolveTarget() {
              requests[pieceId]++;
              return new Promise((resolve) =>
                setTimeout(() => {
                  link._resolvedCell = {
                    space: () => "did:key:space",
                    id: () => pieceId,
                    ref: () => ({ scope: "space", path: [] }),
                  };
                  resolve(link._resolvedCell);
                }, 5)
              );
            },
          });
          const linkRoot = link.attachShadow({ mode: "open" });
          const chip = document.createElement("cf-chip");
          const chipRoot = chip.attachShadow({ mode: "open" });
          const button = document.createElement("button");
          button.textContent = "Open";
          button.addEventListener("click", () => {
            clicks.push(pieceId);
            globalThis.dispatchEvent(
              new CustomEvent("cf-navigate", { detail: { pieceId } }),
            );
          });
          chipRoot.append(button);
          linkRoot.append(chip);
          document.body.append(link);
        }

        Object.assign(globalThis, {
          commonfabric: { viewSettled: () => Promise.resolve() },
          __topicsNavigationResult: () => ({ clicks, requests }),
        });
      });

      const returned = await clickCellLink(page, "Open");
      const result = await page.evaluate(() =>
        (globalThis as typeof globalThis & {
          __topicsNavigationResult: () => {
            clicks: string[];
            requests: Record<string, number>;
          };
        }).__topicsNavigationResult()
      );

      expect(returned).toBe("of:fid1:open-0");
      expect(result.clicks).toEqual(["of:fid1:open-0"]);
      expect(
        Object.entries(result.requests)
          .filter(([id, count]) => id !== "of:fid1:open-0" && count > 0),
      ).toEqual([]);
    });

    it("returns the destination resolved for this click, not one an earlier interaction left", async () => {
      await page.evaluate(() => {
        document.body.replaceChildren();
        const clicks: string[] = [];
        const destination = (pieceId: string) => ({
          space: () => "did:key:space",
          id: () => pieceId,
          ref: () => ({ scope: "space", path: [] }),
        });
        const link = Object.assign(document.createElement("cf-cell-link"), {
          label: "Open",
          // Where an earlier press found the link, before its slot moved on.
          _resolvedCell: destination("of:fid1:earlier") as unknown,
          resolveTarget() {
            return new Promise((resolve) =>
              setTimeout(() => {
                link._resolvedCell = destination("of:fid1:current");
                resolve(link._resolvedCell);
              }, 5)
            );
          },
        });
        const linkRoot = link.attachShadow({ mode: "open" });
        const chip = document.createElement("cf-chip");
        const chipRoot = chip.attachShadow({ mode: "open" });
        const button = document.createElement("button");
        button.textContent = "Open";
        button.addEventListener("click", () => {
          const pieceId = (link._resolvedCell as { id(): string }).id();
          clicks.push(pieceId);
          globalThis.dispatchEvent(
            new CustomEvent("cf-navigate", { detail: { pieceId } }),
          );
        });
        chipRoot.append(button);
        linkRoot.append(chip);
        document.body.append(link);

        Object.assign(globalThis, {
          commonfabric: { viewSettled: () => Promise.resolve() },
          __topicsNavigationResult: () => ({ clicks }),
        });
      });

      const returned = await clickCellLink(page, "Open");
      const result = await page.evaluate(() =>
        (globalThis as typeof globalThis & {
          __topicsNavigationResult: () => { clicks: string[] };
        }).__topicsNavigationResult()
      );

      expect(returned).toBe("of:fid1:current");
      expect(result.clicks).toEqual(["of:fid1:current"]);
    });

    it("passes over a link whose resolution found nothing, to the next match", async () => {
      await page.evaluate(() => {
        document.body.replaceChildren();
        const clicks: string[] = [];
        const requests: Record<string, number> = {};
        const buildLink = (pieceId: string, resolves: boolean) => {
          requests[pieceId] = 0;
          const link = Object.assign(document.createElement("cf-cell-link"), {
            label: "Open",
            _resolvedCell: undefined as unknown,
            resolveTarget() {
              requests[pieceId]++;
              return new Promise((resolve) =>
                setTimeout(() => {
                  link._resolvedCell = resolves
                    ? {
                      space: () => "did:key:space",
                      id: () => pieceId,
                      ref: () => ({ scope: "space", path: [] }),
                    }
                    : undefined;
                  resolve(link._resolvedCell);
                }, 5)
              );
            },
          });
          const linkRoot = link.attachShadow({ mode: "open" });
          const chip = document.createElement("cf-chip");
          const chipRoot = chip.attachShadow({ mode: "open" });
          const button = document.createElement("button");
          button.textContent = "Open";
          button.addEventListener("click", () => {
            clicks.push(pieceId);
            globalThis.dispatchEvent(
              new CustomEvent("cf-navigate", { detail: { pieceId } }),
            );
          });
          chipRoot.append(button);
          linkRoot.append(chip);
          return link;
        };
        document.body.append(
          buildLink("of:fid1:empty", false),
          buildLink("of:fid1:healthy", true),
        );

        Object.assign(globalThis, {
          commonfabric: { viewSettled: () => Promise.resolve() },
          __topicsNavigationResult: () => ({ clicks, requests }),
        });
      });

      const returned = await clickCellLink(page, "Open");
      const result = await page.evaluate(() =>
        (globalThis as typeof globalThis & {
          __topicsNavigationResult: () => {
            clicks: string[];
            requests: Record<string, number>;
          };
        }).__topicsNavigationResult()
      );

      expect(returned).toBe("of:fid1:healthy");
      expect(result.clicks).toEqual(["of:fid1:healthy"]);
      expect(result.requests["of:fid1:empty"]).toBe(1);
    });

    it("reports what the click opened when the link moves after it was chosen", async () => {
      await page.evaluate(() => {
        document.body.replaceChildren();
        const clicks: string[] = [];
        const destination = (pieceId: string) => ({
          space: () => "did:key:space",
          id: () => pieceId,
          ref: () => ({ scope: "space", path: [] }),
        });
        let resolutions = 0;
        const link = Object.assign(document.createElement("cf-cell-link"), {
          label: "Open",
          _resolvedCell: undefined as unknown,
          // The first resolution, made when the helper chooses the link,
          // finds where the link points then; every later one finds where
          // its slot has moved to since.
          resolveTarget() {
            const pieceId = resolutions++ === 0
              ? "of:fid1:chosen"
              : "of:fid1:moved";
            return new Promise((resolve) =>
              setTimeout(() => {
                link._resolvedCell = destination(pieceId);
                resolve(link._resolvedCell);
              }, 5)
            );
          },
        });
        const linkRoot = link.attachShadow({ mode: "open" });
        const chip = document.createElement("cf-chip");
        const chipRoot = chip.attachShadow({ mode: "open" });
        const button = document.createElement("button");
        button.textContent = "Open";
        // As a cf-cell-link's click does: resolve again, then navigate there.
        button.addEventListener("click", () => {
          void link.resolveTarget().then((cell) => {
            const pieceId = (cell as { id(): string }).id();
            clicks.push(pieceId);
            globalThis.dispatchEvent(
              new CustomEvent("cf-navigate", { detail: { pieceId } }),
            );
          });
        });
        chipRoot.append(button);
        linkRoot.append(chip);
        document.body.append(link);

        Object.assign(globalThis, {
          commonfabric: { viewSettled: () => Promise.resolve() },
          __topicsNavigationResult: () => ({ clicks }),
        });
      });

      const returned = await clickCellLink(page, "Open");
      const result = await page.evaluate(() =>
        (globalThis as typeof globalThis & {
          __topicsNavigationResult: () => { clicks: string[] };
        }).__topicsNavigationResult()
      );

      expect(returned).toBe("of:fid1:moved");
      expect(result.clicks).toEqual(["of:fid1:moved"]);
    });

    it("resolves again a link whose first resolution was superseded by a new source", async () => {
      await page.evaluate(() => {
        document.body.replaceChildren();
        const clicks: string[] = [];
        let resolutions = 0;
        const link = Object.assign(document.createElement("cf-cell-link"), {
          label: "Open",
          cell: { source: "first" } as unknown,
          _resolvedCell: undefined as unknown,
          // The first resolution is overtaken by a new source and, as the
          // component does for a superseded one, finds nothing; the next
          // resolves the new source.
          resolveTarget() {
            const attempt = resolutions++;
            return new Promise((resolve) =>
              setTimeout(() => {
                if (attempt === 0) {
                  link.cell = { source: "second" };
                  resolve(undefined);
                  return;
                }
                link._resolvedCell = {
                  space: () => "did:key:space",
                  id: () => "of:fid1:retargeted",
                  ref: () => ({ scope: "space", path: [] }),
                };
                resolve(link._resolvedCell);
              }, 5)
            );
          },
        });
        const linkRoot = link.attachShadow({ mode: "open" });
        const chip = document.createElement("cf-chip");
        const chipRoot = chip.attachShadow({ mode: "open" });
        const button = document.createElement("button");
        button.textContent = "Open";
        button.addEventListener("click", () => {
          const pieceId = (link._resolvedCell as { id(): string }).id();
          clicks.push(pieceId);
          globalThis.dispatchEvent(
            new CustomEvent("cf-navigate", { detail: { pieceId } }),
          );
        });
        chipRoot.append(button);
        linkRoot.append(chip);
        document.body.append(link);

        Object.assign(globalThis, {
          commonfabric: { viewSettled: () => Promise.resolve() },
          __topicsNavigationResult: () => ({ clicks, resolutions }),
        });
      });

      const returned = await clickCellLink(page, "Open");
      const result = await page.evaluate(() =>
        (globalThis as typeof globalThis & {
          __topicsNavigationResult: () => { clicks: string[] };
        }).__topicsNavigationResult()
      );

      expect(returned).toBe("of:fid1:retargeted");
      expect(result.clicks).toEqual(["of:fid1:retargeted"]);
    });

    it("reports the navigation its click made, not one dispatched before it", async () => {
      await page.evaluate(() => {
        document.body.replaceChildren();
        const clicks: string[] = [];
        // Some other part of the page navigates while the helper is still
        // choosing and revalidating, until the click.
        const noise = setInterval(
          () =>
            globalThis.dispatchEvent(
              new CustomEvent("cf-navigate", {
                detail: { pieceId: "of:fid1:unrelated" },
              }),
            ),
          2,
        );
        const pieceId = "of:fid1:clicked";
        const link = Object.assign(document.createElement("cf-cell-link"), {
          label: "Open",
          _resolvedCell: undefined as unknown,
          resolveTarget() {
            return new Promise((resolve) =>
              setTimeout(() => {
                link._resolvedCell = {
                  space: () => "did:key:space",
                  id: () => pieceId,
                  ref: () => ({ scope: "space", path: [] }),
                };
                resolve(link._resolvedCell);
              }, 20)
            );
          },
        });
        const linkRoot = link.attachShadow({ mode: "open" });
        const chip = document.createElement("cf-chip");
        const chipRoot = chip.attachShadow({ mode: "open" });
        const button = document.createElement("button");
        button.textContent = "Open";
        button.addEventListener("click", () => {
          clearInterval(noise);
          clicks.push(pieceId);
          globalThis.dispatchEvent(
            new CustomEvent("cf-navigate", { detail: { pieceId } }),
          );
        });
        chipRoot.append(button);
        linkRoot.append(chip);
        document.body.append(link);

        Object.assign(globalThis, {
          commonfabric: { viewSettled: () => Promise.resolve() },
          __topicsNavigationResult: () => ({ clicks }),
        });
      });

      const returned = await clickCellLink(page, "Open");

      expect(returned).toBe("of:fid1:clicked");
    });

    it("reports the clicked link's navigation when another link's finishes after the click", async () => {
      await page.evaluate(() => {
        document.body.replaceChildren();
        const clicks: string[] = [];
        const destination = (pieceId: string) => ({
          space: () => "did:key:space",
          id: () => pieceId,
          ref: () => ({ scope: "space", path: [] }),
        });
        const buildLink = (label: string, pieceId: string) => {
          const link = Object.assign(document.createElement("cf-cell-link"), {
            label,
            _resolvedCell: undefined as unknown,
            resolveTarget() {
              return new Promise((resolve) =>
                setTimeout(() => {
                  link._resolvedCell = destination(pieceId);
                  resolve(link._resolvedCell);
                }, 30)
              );
            },
          });
          const linkRoot = link.attachShadow({ mode: "open" });
          const chip = document.createElement("cf-chip");
          const chipRoot = chip.attachShadow({ mode: "open" });
          const button = document.createElement("button");
          button.textContent = label;
          chipRoot.append(button);
          linkRoot.append(chip);
          return { link, button };
        };
        const other = buildLink("Elsewhere", "of:fid1:earlier");
        const clicked = buildLink("Open", "of:fid1:clicked");
        // As a cf-cell-link's click does: resolve where the link points now,
        // then navigate there. The other link, still finishing a lookup of
        // its own, navigates first.
        clicked.button.addEventListener("click", () => {
          setTimeout(
            () =>
              globalThis.dispatchEvent(
                new CustomEvent("cf-navigate", {
                  detail: { pieceId: "of:fid1:earlier" },
                }),
              ),
            10,
          );
          void clicked.link.resolveTarget().then((cell) => {
            const pieceId = (cell as { id(): string }).id();
            clicks.push(pieceId);
            globalThis.dispatchEvent(
              new CustomEvent("cf-navigate", { detail: { pieceId } }),
            );
          });
        });
        document.body.append(other.link, clicked.link);

        Object.assign(globalThis, {
          commonfabric: { viewSettled: () => Promise.resolve() },
          __topicsNavigationResult: () => ({ clicks }),
        });
      });

      const returned = await clickCellLink(page, "Open");
      const result = await page.evaluate(() =>
        (globalThis as typeof globalThis & {
          __topicsNavigationResult: () => { clicks: string[] };
        }).__topicsNavigationResult()
      );

      expect(returned).toBe("of:fid1:clicked");
      expect(result.clicks).toEqual(["of:fid1:clicked"]);
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
          button.addEventListener("click", () => {
            const pieceId = link._resolvedCell.id();
            clicks.push(pieceId);
            globalThis.dispatchEvent(
              new CustomEvent("cf-navigate", { detail: { pieceId } }),
            );
          });
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
