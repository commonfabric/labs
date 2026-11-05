import {
  Browser,
  installPresentationInteractions,
  type Page,
} from "@commonfabric/integration";
import {
  assert,
  assertEquals,
  assertRejects,
  assertStringIncludes,
} from "@std/assert";
import { expect } from "@std/expect";
import { afterAll, beforeAll, describe, it } from "@std/testing/bdd";
import {
  armSenderEcho,
  CLICK_TARGET_ATTR,
  clickCfButton,
  clickCfButtonsConcurrently,
  clickNthCfButton,
  clickTrustedAction,
  collectBrowserLoadSummary,
  fillCfInput,
  installSenderEchoProbe,
  readSenderEchoReport,
  submitViaEnter,
  waitForSettledText,
} from "./cfc-browser-helpers.ts";
import {
  clickButtonWithText,
  readNoteButtonCandidates,
} from "./note-button-helpers.ts";

/** One element's live click marks, in attribute order. */
type MarkProbe = { clicks: number; marksAtClick: string[]; marks: string[] };

/** Presentation config with every demo delay removed. */
const testPresentationConfig = {
  enabled: true,
  outputDir: ".",
  videoFileName: "unused.mp4",
  viewport: { width: 1280, height: 720 },
  typingDelayMs: 0,
  cursorTravelMs: 0,
  cursorSettleMs: 0,
  clickPulseMs: 0,
  postResultHoldMs: 0,
  jpegQuality: 85,
  keepFrames: false,
} as const;

describe("CFC browser helpers", () => {
  let browser: Browser;
  let page: Page;

  beforeAll(async () => {
    browser = await Browser.launch({ headless: true });
    page = await browser.newPage();
    // These tests place controls at chosen coordinates and then check where a
    // trusted click landed, so the viewport they are placed in has to be a
    // known size. A browser's default viewport is not: the widest surface below
    // reaches x=920, which is off-screen in an 800-wide default, and a click
    // aimed at a control's middle then lands outside the page and reaches
    // nothing.
    await page.setViewportSize({ width: 1280, height: 800 });
  });

  afterAll(async () => {
    await browser.close();
  });

  it("reports the main-thread half when the worker never answers", async () => {
    await page.evaluate(() => {
      const row = {
        count: 1,
        average: 60_000,
        totalTime: 60_000,
        p50: 60_000,
        p95: 60_000,
        max: 60_000,
      };
      const global = globalThis as unknown as { commonfabric: unknown };
      global.commonfabric = {
        getTimingStatsBreakdown: () => ({
          "runtime-client": {
            "ipc/runtime:idle": row,
            "ipc-outcome/cancelled/runtime:idle": row,
          },
        }),
        rt: {
          // A worker that has stopped answering. Reading its statistics is
          // a request like any other, so this promise is the shape a stalled
          // worker presents: one that never settles.
          getLoggerCounts: () => new Promise(() => {}),
          getPendingRequests: () => [{ type: "runtime:idle", ageMs: 60_000 }],
          getRequestTimeline: () => [{
            type: "runtime:idle",
            sentAtMs: 0,
          }],
        },
      };
    });
    try {
      // A short budget, so the case pays milliseconds rather than the
      // production default. The elapsed span is asserted against that budget
      // below: the worker's answer never comes, so a collection that returned
      // sooner would be one that abandoned the request without waiting, and
      // the backstop would go unexercised while the status still read
      // `unavailable`.
      const budget = 250;
      const startedAt = performance.now();
      const summary = await collectBrowserLoadSummary(
        page,
        "worker not answering",
        { workerBudgetMs: budget },
      );
      const elapsed = performance.now() - startedAt;

      // The collection returns rather than waiting on the worker forever, and
      // says the worker half is missing rather than reporting it as empty.
      expect(summary.workerStatus).toBe("unavailable");
      expect(elapsed).toBeGreaterThanOrEqual(budget);
      expect(summary.ipcFailures).toMatchObject([{
        key: "ipc-outcome/cancelled/runtime:idle",
        count: 1,
        total: 60_000,
      }]);
      expect(summary.pendingIpc).toMatchObject([{ type: "runtime:idle" }]);
      expect(summary.ipc).toHaveLength(1);
    } finally {
      await page.evaluate(() => {
        delete (globalThis as unknown as { commonfabric?: unknown })
          .commonfabric;
      });
    }
  });

  it("settles the view before clicking a rendered control", async () => {
    await page.evaluate(() => {
      const host = document.createElement("div");
      const root = host.attachShadow({ mode: "open" });
      const button = document.createElement("button");
      button.id = "lp-guest-button";
      button.textContent = "Continue as guest";
      root.append(button);
      document.body.append(host);

      let settleCalls = 0;
      (globalThis as typeof globalThis & {
        commonfabric: { viewSettled: () => Promise<void> };
        __settleCalls: () => number;
      }).commonfabric = {
        viewSettled: () => {
          settleCalls++;
          button.addEventListener("click", () => {
            const input = document.createElement("input");
            input.id = "lp-join-name";
            document.body.append(input);
          }, { once: true });
          return Promise.resolve();
        },
      };
      (globalThis as typeof globalThis & {
        __settleCalls: () => number;
      }).__settleCalls = () => settleCalls;
    });

    await clickCfButton(page, "#lp-guest-button");

    const result = await page.evaluate(() => ({
      inputPresent: document.querySelector("#lp-join-name") !== null,
      settleCalls: (globalThis as typeof globalThis & {
        __settleCalls: () => number;
      }).__settleCalls(),
    }));
    assert(
      result.inputPresent,
      'clicking "Continue as guest" did not reveal #lp-join-name',
    );
    assertEquals(result.settleCalls, 2);
  });

  it("settles the view after clicking so local effects render", async () => {
    await page.evaluate(() => {
      const host = document.createElement("div");
      const root = host.attachShadow({ mode: "open" });
      const button = document.createElement("button");
      button.id = "post-settle-guest-button";
      button.textContent = "Continue as guest";
      root.append(button);
      document.body.append(host);

      let clicked = false;
      let settleCalls = 0;
      button.addEventListener("click", () => {
        clicked = true;
      }, { once: true });
      (globalThis as typeof globalThis & {
        commonfabric: { viewSettled: () => Promise<void> };
        __postSettleCalls: () => number;
      }).commonfabric = {
        viewSettled: () => {
          settleCalls++;
          if (clicked) {
            const input = document.createElement("input");
            input.id = "post-settle-join-name";
            document.body.append(input);
          }
          return Promise.resolve();
        },
      };
      (globalThis as typeof globalThis & {
        __postSettleCalls: () => number;
      }).__postSettleCalls = () => settleCalls;
    });

    await clickCfButton(page, "#post-settle-guest-button");

    const result = await page.evaluate(() => ({
      inputPresent: document.querySelector("#post-settle-join-name") !== null,
      settleCalls: (globalThis as typeof globalThis & {
        __postSettleCalls: () => number;
      }).__postSettleCalls(),
    }));
    assert(
      result.inputPresent,
      "the click effect was not applied by a post-click view settle",
    );
    assertEquals(result.settleCalls, 2);
  });

  it("settles the view after a late target appears, before clicking it", async () => {
    await page.evaluate(() => {
      const host = document.createElement("div");
      const root = host.attachShadow({ mode: "open" });
      document.body.append(host);

      let settleCalls = 0;
      let clickedAtSettle = 0;
      let bound = false;
      const bind = () => {
        const button = root.querySelector("#late-vote-button");
        if (!button || bound) return;
        bound = true;
        button.addEventListener("click", () => {
          clickedAtSettle = settleCalls;
        }, { once: true });
      };
      (globalThis as typeof globalThis & {
        commonfabric: { viewSettled: () => Promise<void> };
      }).commonfabric = {
        viewSettled: () => {
          settleCalls++;
          if (!root.querySelector("#late-vote-button")) {
            const button = document.createElement("button");
            button.id = "late-vote-button";
            button.textContent = "Veto";
            root.append(button);
            return Promise.resolve();
          }
          bind();
          return Promise.resolve();
        },
      };

      (globalThis as typeof globalThis & {
        __lateClickResult: () => {
          settleCalls: number;
          clickedAtSettle: number;
        };
      }).__lateClickResult = () => ({ settleCalls, clickedAtSettle });
    });

    await clickCfButton(page, "#late-vote-button");

    const result = await page.evaluate(() =>
      (globalThis as typeof globalThis & {
        __lateClickResult: () => {
          settleCalls: number;
          clickedAtSettle: number;
        };
      }).__lateClickResult()
    );
    assert(
      result.clickedAtSettle > 0,
      "the click reached no handler: the view never settled with the target " +
        "present before the click was dispatched",
    );
    // One settle renders the control, one binds it, and one follows the click.
    assertEquals(result.settleCalls, 3);
  });

  it("settles the same rendered control that it clicks", async () => {
    await page.evaluate(() => {
      const host = document.createElement("div");
      const root = host.attachShadow({ mode: "open" });
      const createButton = () => {
        const button = document.createElement("button");
        button.id = "replaced-join-button";
        button.textContent = "Join";
        return button;
      };
      root.append(createButton());
      document.body.append(host);

      let settleCalls = 0;
      let clicks = 0;
      let boundButton: HTMLButtonElement | undefined;
      (globalThis as typeof globalThis & {
        commonfabric: { viewSettled: () => Promise<void> };
        __replacedClickResult: () => {
          settleCalls: number;
          clicks: number;
        };
      }).commonfabric = {
        viewSettled: () => {
          settleCalls++;
          if (settleCalls === 1) {
            root.replaceChildren(createButton());
          } else {
            const button = root.querySelector<HTMLButtonElement>(
              "#replaced-join-button",
            );
            if (button && button !== boundButton) {
              boundButton = button;
              button.addEventListener("click", () => clicks++);
            }
          }
          return Promise.resolve();
        },
      };
      (globalThis as typeof globalThis & {
        __replacedClickResult: () => {
          settleCalls: number;
          clicks: number;
        };
      }).__replacedClickResult = () => ({ settleCalls, clicks });
    });

    await clickCfButton(page, "#replaced-join-button");

    const result = await page.evaluate(() =>
      (globalThis as typeof globalThis & {
        __replacedClickResult: () => {
          settleCalls: number;
          clicks: number;
        };
      }).__replacedClickResult()
    );
    assertEquals(
      result.clicks,
      1,
      "the click reached the replacement before its handler was bound",
    );
    assertEquals(result.settleCalls, 3);
  });

  it("delivers a click when the control moves after aiming", async () => {
    await page.evaluate(() => {
      const host = document.createElement("div");
      host.id = "moving-click-host";
      const root = host.attachShadow({ mode: "open" });
      const button = document.createElement("button");
      button.id = "moving-guest-button";
      button.textContent = "Continue as guest";
      Object.assign(button.style, {
        display: "block",
        width: "200px",
        height: "32px",
      });
      root.append(button);
      document.body.append(host);

      let clicks = 0;
      let ready = false;
      button.addEventListener("click", () => {
        if (!ready) return;
        clicks++;
        const input = document.createElement("input");
        input.id = "moving-join-name";
        document.body.append(input);
      });
      (globalThis as typeof globalThis & {
        commonfabric: { viewSettled: () => Promise<void> };
        __moveClickTarget: () => void;
        __movingClickResult: () => {
          clicks: number;
          inputPresent: boolean;
        };
      }).commonfabric = {
        viewSettled: () => {
          ready = true;
          return Promise.resolve();
        },
      };
      (globalThis as typeof globalThis & {
        __moveClickTarget: () => void;
      }).__moveClickTarget = () => {
        ready = false;
        button.style.transform = "translateX(400px)";
      };
      (globalThis as typeof globalThis & {
        __movingClickResult: () => {
          clicks: number;
          inputPresent: boolean;
        };
      }).__movingClickResult = () => ({
        clicks,
        inputPresent: document.querySelector("#moving-join-name") !== null,
      });
    });

    let moved = false;
    page.setInteractionObserver({
      beforeClick: async () => {
        if (moved) return;
        moved = true;
        // Move the target after the helper measures it and before the browser
        // dispatches the trusted click.
        await page.evaluate(() =>
          (globalThis as typeof globalThis & {
            __moveClickTarget: () => void;
          }).__moveClickTarget()
        );
      },
    });
    try {
      await clickCfButton(page, "#moving-guest-button");
    } finally {
      page.setInteractionObserver();
    }

    const result = await page.evaluate(() =>
      (globalThis as typeof globalThis & {
        __movingClickResult: () => {
          clicks: number;
          inputPresent: boolean;
        };
      }).__movingClickResult()
    );
    expect(result.clicks).toBe(1);
    expect(result.inputPresent).toBe(true);
  });

  it("preserves page state and coordinates for a moved control", async () => {
    await page.evaluate(() => {
      const host = document.createElement("div");
      host.id = "native-moved-click-host";
      const root = host.attachShadow({ mode: "open" });
      const style = document.createElement("style");
      style.textContent = `
        #native-moved-click-button::after { content: "AUTHOR"; }
      `;
      const button = document.createElement("button");
      button.id = "native-moved-click-button";
      button.textContent = "Continue";
      const sibling = document.createElement("button");
      sibling.id = "native-moved-click-sibling";
      sibling.textContent = "Other";
      Object.assign(button.style, {
        position: "fixed",
        left: "40px",
        top: "120px",
        width: "120px",
        height: "40px",
        margin: "0",
      });
      Object.assign(sibling.style, {
        position: "fixed",
        left: "40px",
        top: "220px",
        width: "120px",
        height: "40px",
        margin: "0",
      });
      root.append(style, button, sibling);
      document.body.append(host);

      let result: {
        clicks: number;
        trusted: boolean;
        pointInside: boolean;
        pseudoContent: string;
        siblingPointerEvents: string;
        siblingHit: boolean;
      } | undefined;
      button.addEventListener("click", (event) => {
        const rect = button.getBoundingClientRect();
        const siblingRect = sibling.getBoundingClientRect();
        result = {
          clicks: 1,
          trusted: event.isTrusted,
          pointInside: event.clientX >= rect.left &&
            event.clientX <= rect.right && event.clientY >= rect.top &&
            event.clientY <= rect.bottom,
          pseudoContent: getComputedStyle(button, "::after").content,
          siblingPointerEvents: getComputedStyle(sibling).pointerEvents,
          siblingHit: root.elementFromPoint(
            siblingRect.x + siblingRect.width / 2,
            siblingRect.y + siblingRect.height / 2,
          ) === sibling,
        };
      });
      (globalThis as typeof globalThis & {
        commonfabric: { viewSettled: () => Promise<void> };
        __nativeMovedClickResult: () => typeof result;
      }).commonfabric = { viewSettled: () => Promise.resolve() };
      (globalThis as typeof globalThis & {
        __nativeMovedClickResult: () => typeof result;
      }).__nativeMovedClickResult = () => result;
    });

    page.setInteractionObserver({
      beforeClick: () =>
        page.evaluate(() => {
          const button = document.querySelector("#native-moved-click-host")
            ?.shadowRoot?.querySelector<HTMLElement>(
              "#native-moved-click-button",
            );
          if (!button) throw new Error("Moved click target is missing");
          button.style.transform = "translateX(400px)";
        }),
    });
    try {
      await clickCfButton(page, "#native-moved-click-button");
    } finally {
      page.setInteractionObserver();
    }

    const result = await page.evaluate(() => {
      const result = (globalThis as typeof globalThis & {
        __nativeMovedClickResult: () => {
          clicks: number;
          trusted: boolean;
          pointInside: boolean;
          pseudoContent: string;
          siblingPointerEvents: string;
          siblingHit: boolean;
        } | undefined;
      }).__nativeMovedClickResult();
      document.querySelector("#native-moved-click-host")?.remove();
      return result;
    });
    expect(result).toEqual({
      clicks: 1,
      trusted: true,
      pointInside: true,
      pseudoContent: '"AUTHOR"',
      siblingPointerEvents: "auto",
      siblingHit: true,
    });
  });

  it("settles a same-position replacement before clicking it", async () => {
    await page.evaluate(() => {
      const host = document.createElement("div");
      host.id = "same-position-host";
      const root = host.attachShadow({ mode: "open" });
      const button = document.createElement("button");
      button.id = "same-position-button";
      button.textContent = "Continue";
      Object.assign(button.style, {
        position: "fixed",
        left: "40px",
        top: "40px",
        width: "120px",
        height: "40px",
        margin: "0",
      });
      root.append(button);
      document.body.append(host);

      let clicks = 0;
      let bound: HTMLButtonElement | undefined;
      const bind = () => {
        const current = root.querySelector<HTMLButtonElement>(
          "#same-position-button",
        );
        if (current && current !== bound) {
          bound = current;
          current.addEventListener("click", () => clicks++);
        }
      };
      (globalThis as typeof globalThis & {
        commonfabric: { viewSettled: () => Promise<void> };
        __samePositionClicks: () => number;
      }).commonfabric = {
        viewSettled: () => {
          bind();
          return Promise.resolve();
        },
      };
      (globalThis as typeof globalThis & {
        __samePositionClicks: () => number;
      }).__samePositionClicks = () => clicks;
    });

    page.setInteractionObserver({
      beforeClick: async () => {
        await page.evaluate(() => {
          const current = document.querySelector("#same-position-host")
            ?.shadowRoot?.querySelector<HTMLButtonElement>(
              "#same-position-button",
            );
          if (!current) throw new Error("Same-position target is missing");
          current.replaceWith(current.cloneNode(true));
        });
      },
    });
    try {
      await clickCfButton(page, "#same-position-button");
    } finally {
      page.setInteractionObserver();
    }

    const clicks = await page.evaluate(() => {
      const clicks = (globalThis as typeof globalThis & {
        __samePositionClicks: () => number;
      }).__samePositionClicks();
      document.querySelector("#same-position-host")?.remove();
      return clicks;
    });
    expect(clicks).toBe(1);
  });

  it("clicks the current selector match when the old control remains", async () => {
    await page.evaluate(() => {
      const host = document.createElement("div");
      host.id = "retargeted-click-host";
      const root = host.attachShadow({ mode: "open" });
      const oldButton = document.createElement("button");
      oldButton.id = "retargeted-old-button";
      oldButton.className = "retargeted-click-target";
      oldButton.textContent = "Old";
      const newButton = document.createElement("button");
      newButton.id = "retargeted-new-button";
      newButton.textContent = "New";
      Object.assign(oldButton.style, {
        position: "fixed",
        left: "40px",
        top: "320px",
        width: "120px",
        height: "40px",
        margin: "0",
      });
      Object.assign(newButton.style, {
        position: "fixed",
        left: "240px",
        top: "320px",
        width: "120px",
        height: "40px",
        margin: "0",
      });
      root.append(oldButton, newButton);
      document.body.append(host);

      let oldClicks = 0;
      let newClicks = 0;
      oldButton.addEventListener("click", () => oldClicks++);
      newButton.addEventListener("click", () => newClicks++);
      const pageState = globalThis as typeof globalThis & {
        commonfabric: { viewSettled: () => Promise<void> };
        __retargetClick: () => void;
        __retargetClickResult: () => {
          oldClicks: number;
          newClicks: number;
        };
      };
      pageState.commonfabric = { viewSettled: () => Promise.resolve() };
      pageState.__retargetClick = () => {
        oldButton.classList.remove("retargeted-click-target");
        oldButton.style.transform = "translateX(400px)";
        newButton.classList.add("retargeted-click-target");
      };
      pageState.__retargetClickResult = () => ({ oldClicks, newClicks });
    });

    page.setInteractionObserver({
      beforeClick: () =>
        page.evaluate(() =>
          (globalThis as typeof globalThis & {
            __retargetClick: () => void;
          }).__retargetClick()
        ),
    });
    try {
      await clickCfButton(page, ".retargeted-click-target");
    } finally {
      page.setInteractionObserver();
    }

    const result = await page.evaluate(() => {
      const result = (globalThis as typeof globalThis & {
        __retargetClickResult: () => {
          oldClicks: number;
          newClicks: number;
        };
      }).__retargetClickResult();
      document.querySelector("#retargeted-click-host")?.remove();
      return result;
    });
    expect(result).toEqual({ oldClicks: 0, newClicks: 1 });
  });

  it("preserves page-owned click identity globals", async () => {
    const identityPage = await browser.newPage();
    try {
      await identityPage.evaluate(() => {
        const button = document.createElement("button");
        button.id = "identity-global-button";
        button.textContent = "Continue";
        document.body.append(button);

        let clicks = 0;
        button.addEventListener("click", () => clicks++);
        const ownedIds = new WeakMap<Element, number>();
        const pageState = globalThis as typeof globalThis & {
          commonfabric: { viewSettled: () => Promise<void> };
          __cfClickTargetIds: WeakMap<Element, number>;
          __cfClickTargetIdNext: number;
          __identityGlobalResult: () => {
            clicks: number;
            idsPreserved: boolean;
            next: number;
          };
        };
        pageState.commonfabric = {
          viewSettled: () => Promise.resolve(),
        };
        pageState.__cfClickTargetIds = ownedIds;
        pageState.__cfClickTargetIdNext = 47;
        pageState.__identityGlobalResult = () => ({
          clicks,
          idsPreserved: pageState.__cfClickTargetIds === ownedIds,
          next: pageState.__cfClickTargetIdNext,
        });
      });

      await clickCfButton(identityPage, "#identity-global-button");

      const result = await identityPage.evaluate(() =>
        (globalThis as typeof globalThis & {
          __identityGlobalResult: () => {
            clicks: number;
            idsPreserved: boolean;
            next: number;
          };
        }).__identityGlobalResult()
      );
      expect(result).toEqual({
        clicks: 1,
        idsPreserved: true,
        next: 47,
      });
    } finally {
      await identityPage.close();
    }
  });

  it("drives the page while waiting for text", async () => {
    await page.evaluate(() => {
      const host = document.createElement("div");
      const root = host.attachShadow({ mode: "open" });
      const line = document.createElement("p");
      line.id = "settled-text-line";
      line.textContent = "no votes yet";
      root.append(line);
      document.body.append(host);

      // A rendering the page produces for itself, not one pushed to it. Nothing
      // outside a settle applies it, which is what makes a wait that only
      // watches the DOM sit here until the stuck-condition net fires.
      let settleCalls = 0;
      (globalThis as typeof globalThis & {
        commonfabric: { viewSettled: () => Promise<void> };
      }).commonfabric = {
        viewSettled: () => {
          settleCalls++;
          if (settleCalls >= 2) line.textContent = "3 votes";
          return Promise.resolve();
        },
      };
      (globalThis as typeof globalThis & {
        __settledTextCalls: () => number;
      }).__settledTextCalls = () => settleCalls;
    });

    await waitForSettledText(page, "#settled-text-line", "3 votes");

    const settleCalls = await page.evaluate(() =>
      (globalThis as typeof globalThis & {
        __settledTextCalls: () => number;
      }).__settledTextCalls()
    );
    assertEquals(settleCalls, 2);
  });

  it("marks grouped targets between settlement barriers", async () => {
    await page.evaluate((clickTargetAttr: string) => {
      const host = document.createElement("div");
      const root = host.attachShadow({ mode: "open" });
      let settleCalls = 0;
      const settleCallsAtClick: number[] = [];
      const createButton = (id: string) => {
        const button = document.createElement("button");
        button.id = id;
        button.textContent = id;
        return button;
      };
      const firstButton = createButton("grouped-button-a");
      const secondButton = createButton("grouped-button-b");
      let secondTargetMarkedAtFirstClick = false;
      firstButton.addEventListener("click", () => {
        if (settleCallsAtClick.length === 0) {
          secondTargetMarkedAtFirstClick = secondButton.hasAttribute(
            clickTargetAttr,
          );
        }
        settleCallsAtClick.push(settleCalls);
      });
      secondButton.addEventListener("click", () => {
        settleCallsAtClick.push(settleCalls);
      }, { once: true });
      root.append(firstButton, secondButton);
      document.body.append(host);

      (globalThis as typeof globalThis & {
        commonfabric: { viewSettled: () => Promise<void> };
        __groupedClickResult: () => {
          settleCalls: number;
          settleCallsAtClick: number[];
          secondTargetMarkedAtFirstClick: boolean;
        };
      }).commonfabric = {
        viewSettled: () => {
          settleCalls++;
          return Promise.resolve();
        },
      };
      (globalThis as typeof globalThis & {
        __groupedClickResult: () => {
          settleCalls: number;
          settleCallsAtClick: number[];
          secondTargetMarkedAtFirstClick: boolean;
        };
      }).__groupedClickResult = () => ({
        settleCalls,
        settleCallsAtClick,
        secondTargetMarkedAtFirstClick,
      });
    }, { args: [CLICK_TARGET_ATTR] });

    await clickCfButtonsConcurrently([
      { page, selector: "#grouped-button-a" },
      { page, selector: "#grouped-button-b" },
      { page, selector: "#grouped-button-a" },
    ]);

    const result = await page.evaluate(() =>
      (globalThis as typeof globalThis & {
        __groupedClickResult: () => {
          settleCalls: number;
          settleCallsAtClick: number[];
          secondTargetMarkedAtFirstClick: boolean;
        };
      }).__groupedClickResult()
    );
    assertEquals(result.settleCallsAtClick, [1, 1, 1]);
    assertEquals(result.settleCalls, 2);
    assert(
      result.secondTargetMarkedAtFirstClick,
      `the second target did not carry ${CLICK_TARGET_ATTR} before dispatch`,
    );
  });

  //
  // Co-resident marks
  //
  // Every mark predicate adds its token to the marks already on the element, so
  // a target another click has spoken for keeps that claim. The grouped test
  // above exercises that for the by-selector predicate; these two cover the
  // indexed and trusted-action ones.
  //

  it("keeps a co-resident mark when tagging an indexed target", async () => {
    await page.evaluate((clickTargetAttr: string) => {
      const host = document.createElement("div");
      const root = host.attachShadow({ mode: "open" });
      const first = document.createElement("button");
      first.className = "indexed-target";
      first.textContent = "first";
      const second = document.createElement("button");
      second.className = "indexed-target";
      second.textContent = "second";
      second.setAttribute(clickTargetAttr, "held-by-another-click");
      let clicks = 0;
      let marksAtClick: string[] = [];
      const marksOf = (element: Element): string[] =>
        (element.getAttribute(clickTargetAttr) ?? "").split(/\s+/).filter(
          Boolean,
        );
      second.addEventListener("click", () => {
        clicks++;
        marksAtClick = marksOf(second);
      });
      root.append(first, second);
      document.body.append(host);

      (globalThis as typeof globalThis & {
        commonfabric: { viewSettled: () => Promise<void> };
      }).commonfabric = { viewSettled: () => Promise.resolve() };
      (globalThis as typeof globalThis & {
        __indexedMarkProbe: () => unknown;
      }).__indexedMarkProbe = () => ({
        clicks,
        marksAtClick,
        marks: marksOf(second),
      });
    }, { args: [CLICK_TARGET_ATTR] });

    await clickNthCfButton(page, ".indexed-target", 1);

    const result = await page.evaluate(() =>
      (globalThis as typeof globalThis & {
        __indexedMarkProbe: () => MarkProbe;
      }).__indexedMarkProbe()
    ) as MarkProbe;
    assertEquals(result.clicks, 1);
    // Both marks are live when the click lands, and only this helper's own
    // mark is cleared afterwards.
    assert(
      result.marksAtClick.includes("held-by-another-click"),
      `the pre-existing mark was lost: ${result.marksAtClick.join(" ")}`,
    );
    assertEquals(result.marksAtClick.length, 2);
    assertEquals(result.marks, ["held-by-another-click"]);
  });

  it("keeps a co-resident mark when tagging a trusted action", async () => {
    await page.evaluate((clickTargetAttr: string) => {
      const host = document.createElement("div");
      const root = host.attachShadow({ mode: "open" });
      const button = document.createElement("button");
      button.setAttribute("data-ui-action", "save-note");
      button.textContent = "Save";
      button.setAttribute(clickTargetAttr, "held-by-another-click");
      let clicks = 0;
      let marksAtClick: string[] = [];
      const marksOf = (element: Element): string[] =>
        (element.getAttribute(clickTargetAttr) ?? "").split(/\s+/).filter(
          Boolean,
        );
      button.addEventListener("click", () => {
        clicks++;
        marksAtClick = marksOf(button);
      });
      root.append(button);
      document.body.append(host);

      (globalThis as typeof globalThis & {
        commonfabric: { viewSettled: () => Promise<void> };
      }).commonfabric = { viewSettled: () => Promise.resolve() };
      (globalThis as typeof globalThis & {
        __trustedMarkProbe: () => unknown;
      }).__trustedMarkProbe = () => ({
        clicks,
        marksAtClick,
        marks: marksOf(button),
      });
    }, { args: [CLICK_TARGET_ATTR] });

    await clickTrustedAction(page, "save-note");

    const result = await page.evaluate(() =>
      (globalThis as typeof globalThis & {
        __trustedMarkProbe: () => MarkProbe;
      }).__trustedMarkProbe()
    ) as MarkProbe;
    assertEquals(result.clicks, 1);
    assert(
      result.marksAtClick.includes("held-by-another-click"),
      `the pre-existing mark was lost: ${result.marksAtClick.join(" ")}`,
    );
    assertEquals(result.marksAtClick.length, 2);
    assertEquals(result.marks, ["held-by-another-click"]);
  });

  //
  // Click helpers that reach a control
  //
  // The three tests below cover the click helpers that reach their control by
  // index, by `data-ui-action`, and by button text. Each drives a control that
  // is in the DOM from the start but receives its click handler only when the
  // view settles — the ordinary case of a vdom batch that has not yet crossed
  // to the main thread. A helper that marks its control without settling around
  // it clicks an element with nothing bound, and `clickedAtSettle` stays zero.
  //

  it("settles the view before clicking an indexed control", async () => {
    await page.evaluate(() => {
      const host = document.createElement("div");
      const root = host.attachShadow({ mode: "open" });
      for (const label of ["first", "second"]) {
        const button = document.createElement("button");
        button.className = "late-indexed-target";
        button.textContent = label;
        root.append(button);
      }
      document.body.append(host);

      let settleCalls = 0;
      let clickedAtSettle = 0;
      let bound = false;
      (globalThis as typeof globalThis & {
        commonfabric: { viewSettled: () => Promise<void> };
      }).commonfabric = {
        viewSettled: () => {
          settleCalls++;
          if (!bound) {
            bound = true;
            root.querySelectorAll(".late-indexed-target")[1]
              .addEventListener("click", () => {
                clickedAtSettle = settleCalls;
              }, { once: true });
          }
          return Promise.resolve();
        },
      };
      (globalThis as typeof globalThis & {
        __lateIndexedResult: () => {
          settleCalls: number;
          clickedAtSettle: number;
        };
      }).__lateIndexedResult = () => ({ settleCalls, clickedAtSettle });
    });

    await clickNthCfButton(page, ".late-indexed-target", 1);

    const result = await page.evaluate(() =>
      (globalThis as typeof globalThis & {
        __lateIndexedResult: () => {
          settleCalls: number;
          clickedAtSettle: number;
        };
      }).__lateIndexedResult()
    );
    assertEquals(
      result.clickedAtSettle,
      1,
      "the click reached no handler: the indexed target was marked and " +
        "clicked without a settle to bind it",
    );
    // One settle binds the control, and one follows the click.
    assertEquals(result.settleCalls, 2);
  });

  it("waits for the indexed control to become enabled before clicking it", async () => {
    await page.evaluate(() => {
      const controls = ["first", "second"].map((label) => {
        const control = document.createElement("div");
        control.className = "waiting-indexed-control";
        control.textContent = label;
        control.style.cssText = "display:inline-block;padding:16px";
        document.body.append(control);
        return control;
      });
      const target = controls[1];
      target.setAttribute("aria-disabled", "true");
      const clicks: string[] = [];
      controls[0].addEventListener("click", () => clicks.push("first"));
      target.addEventListener("click", () => {
        clicks.push(
          target.hasAttribute("aria-disabled") ? "disabled" : "second",
        );
      });
      let settles = 0;
      const global = globalThis as typeof globalThis & {
        commonfabric: { viewSettled: () => Promise<void> };
        __indexedEnabledClicks: string[];
      };
      global.commonfabric = {
        viewSettled: () => {
          if (++settles === 2) target.removeAttribute("aria-disabled");
          return Promise.resolve();
        },
      };
      global.__indexedEnabledClicks = clicks;
    });

    await clickNthCfButton(page, ".waiting-indexed-control", 1);

    expect(
      await page.evaluate(() =>
        (globalThis as typeof globalThis & {
          __indexedEnabledClicks: string[];
        }).__indexedEnabledClicks
      ),
    ).toEqual(["second"]);
  });

  it("waits for an indexed inner control's shadow host to become enabled", async () => {
    await page.evaluate(() => {
      const host = document.createElement("div");
      host.id = "indexed-disabled-shadow-host";
      host.setAttribute("disabled", "");
      Object.assign(host.style, {
        position: "fixed",
        left: "950px",
        top: "400px",
        width: "220px",
      });
      const root = host.attachShadow({ mode: "open" });
      const style = document.createElement("style");
      style.textContent =
        ":host([disabled]) [data-cf-button] { pointer-events: none; }";
      const button = document.createElement("button");
      button.id = "indexed-disabled-shadow-inner";
      button.setAttribute("data-cf-button", "");
      button.textContent = "Select this item";
      Object.assign(button.style, { width: "200px", height: "40px" });
      root.append(style, button);
      document.body.append(host);
      let settles = 0;
      const clicks: string[] = [];
      host.addEventListener("click", () => {
        clicks.push(host.hasAttribute("disabled") ? "disabled" : "enabled");
      }, { capture: true });
      const global = globalThis as typeof globalThis & {
        commonfabric: { viewSettled: () => Promise<void> };
        __indexedShadowClicks: string[];
      };
      global.commonfabric = {
        viewSettled: () => {
          if (++settles === 2) host.removeAttribute("disabled");
          return Promise.resolve();
        },
      };
      global.__indexedShadowClicks = clicks;
    });
    try {
      await clickNthCfButton(page, "#indexed-disabled-shadow-inner", 0);
      expect(
        await page.evaluate(() =>
          (globalThis as typeof globalThis & {
            __indexedShadowClicks: string[];
          }).__indexedShadowClicks
        ),
      ).toEqual(["enabled"]);
    } finally {
      await page.evaluate(() =>
        document.getElementById("indexed-disabled-shadow-host")?.remove()
      );
    }
  });

  it("settles the view before clicking a trusted action", async () => {
    await page.evaluate(() => {
      const host = document.createElement("div");
      const root = host.attachShadow({ mode: "open" });
      const button = document.createElement("button");
      button.setAttribute("data-ui-action", "late-save");
      button.textContent = "Save";
      root.append(button);
      document.body.append(host);

      let settleCalls = 0;
      let clickedAtSettle = 0;
      let bound = false;
      (globalThis as typeof globalThis & {
        commonfabric: { viewSettled: () => Promise<void> };
      }).commonfabric = {
        viewSettled: () => {
          settleCalls++;
          if (!bound) {
            bound = true;
            button.addEventListener("click", () => {
              clickedAtSettle = settleCalls;
            }, { once: true });
          }
          return Promise.resolve();
        },
      };
      (globalThis as typeof globalThis & {
        __lateActionResult: () => {
          settleCalls: number;
          clickedAtSettle: number;
        };
      }).__lateActionResult = () => ({ settleCalls, clickedAtSettle });
    });

    await clickTrustedAction(page, "late-save");

    const result = await page.evaluate(() =>
      (globalThis as typeof globalThis & {
        __lateActionResult: () => {
          settleCalls: number;
          clickedAtSettle: number;
        };
      }).__lateActionResult()
    );
    assertEquals(
      result.clickedAtSettle,
      1,
      "the click reached no handler: the trusted action was marked and " +
        "clicked without a settle to bind it",
    );
    assertEquals(result.settleCalls, 2);
  });

  it("settles the view before clicking a button found by text", async () => {
    await page.evaluate(() => {
      const host = document.createElement("div");
      const root = host.attachShadow({ mode: "open" });
      const button = document.createElement("button");
      button.id = "late-note-button";
      button.textContent = "Publish the late note";
      root.append(button);
      document.body.append(host);

      let settleCalls = 0;
      let clickedAtSettle = 0;
      let bound = false;
      (globalThis as typeof globalThis & {
        commonfabric: { viewSettled: () => Promise<void> };
      }).commonfabric = {
        viewSettled: () => {
          settleCalls++;
          if (!bound) {
            bound = true;
            button.addEventListener("click", () => {
              clickedAtSettle = settleCalls;
            }, { once: true });
          }
          return Promise.resolve();
        },
      };
      (globalThis as typeof globalThis & {
        __lateNoteResult: () => {
          settleCalls: number;
          clickedAtSettle: number;
        };
      }).__lateNoteResult = () => ({ settleCalls, clickedAtSettle });
    });

    await clickButtonWithText(page, "Publish the late note");

    const result = await page.evaluate(() =>
      (globalThis as typeof globalThis & {
        __lateNoteResult: () => {
          settleCalls: number;
          clickedAtSettle: number;
        };
      }).__lateNoteResult()
    );
    assertEquals(
      result.clickedAtSettle,
      1,
      "the click reached no handler: the named button was marked and " +
        "clicked without a settle to bind it",
    );
    assertEquals(result.settleCalls, 2);
  });

  it("passes over a disabled button carrying the text it was given", async () => {
    // Text names a button, and a page can show the same words twice: a
    // disabled control and, beside it, the one that is ready for the click.
    // A disabled control is laid out and has a box, so rendered-ness alone
    // answers it, and the browser raises no click on it. This fixture leaves
    // the pointer events alone, so it covers that half; the case above, whose
    // control carries `cf-button`'s `pointer-events: none`, covers the other.
    await page.evaluate(() => {
      const surface = document.createElement("div");
      // Fixed and on screen, clear of the surfaces the cases above leave on
      // the shared page, so the aim's scroll cannot move it and nothing else
      // reaches the point this click is aimed at.
      Object.assign(surface.style, {
        position: "fixed",
        left: "950px",
        top: "120px",
        width: "220px",
      });
      document.body.append(surface);

      // Both carry the `cf-button` shape: a host whose shadow root holds the
      // control that takes the click.
      const make = (disabled: boolean): HTMLElement => {
        const host = document.createElement("cf-button");
        const root = host.attachShadow({ mode: "open" });
        const button = document.createElement("button");
        button.setAttribute("data-cf-button", "");
        button.disabled = disabled;
        button.textContent = "Publish the note";
        Object.assign(button.style, {
          display: "block",
          width: "200px",
          height: "40px",
          padding: "0",
          margin: "0",
        });
        host.toggleAttribute("disabled", disabled);
        host.textContent = "Publish the note";
        root.append(button);
        surface.append(host);
        return host;
      };

      const disabledHost = make(true);
      const enabledHost = make(false);

      let disabledHostClicks = 0;
      let enabledClicks = 0;
      disabledHost.addEventListener("click", () => void disabledHostClicks++);
      enabledHost.addEventListener("click", () => void enabledClicks++);

      (globalThis as typeof globalThis & {
        commonfabric: { viewSettled: () => Promise<void> };
      }).commonfabric = { viewSettled: () => Promise.resolve() };
      (globalThis as typeof globalThis & {
        __twinButtonClicks: () => { disabledHost: number; enabled: number };
        __twinButtonTeardown: () => void;
      }).__twinButtonClicks = () => ({
        disabledHost: disabledHostClicks,
        enabled: enabledClicks,
      });
      (globalThis as typeof globalThis & {
        __twinButtonTeardown: () => void;
      }).__twinButtonTeardown = () => surface.remove();
    });

    try {
      await clickButtonWithText(page, "Publish the note");
    } finally {
      // The surface is fixed and would otherwise stand over these coordinates
      // for every case below.
      await page.evaluate(() =>
        (globalThis as typeof globalThis & {
          __twinButtonTeardown: () => void;
        }).__twinButtonTeardown()
      );
    }

    const clicks = await page.evaluate(() =>
      (globalThis as typeof globalThis & {
        __twinButtonClicks: () => { disabledHost: number; enabled: number };
      }).__twinButtonClicks()
    );
    expect(clicks).toEqual({ disabledHost: 0, enabled: 1 });
  });

  it("reports why each candidate was passed over when none can be clicked", async () => {
    // Waiting for a control to be enabled is waiting on the page, and a page
    // that never enables it runs the wait out. What is on screen then is a
    // button whose words are the ones that were asked for, sitting there
    // disabled — which reads, to a report that says only that no button was
    // found, as a button that was never on the page at all. The probe behind
    // that report answers the finder's three decisions per candidate, so the
    // one that failed only the last of them is distinguishable from the rest.
    await page.evaluate(() => {
      const surface = document.createElement("div");
      Object.assign(surface.style, {
        position: "fixed",
        left: "950px",
        top: "240px",
        width: "220px",
      });
      document.body.append(surface);

      const add = (
        id: string,
        text: string,
        disabled: boolean,
        rendered: boolean,
      ) => {
        const host = document.createElement("cf-button");
        host.id = id;
        const root = host.attachShadow({ mode: "open" });
        const button = document.createElement("button");
        button.setAttribute("data-cf-button", "");
        button.disabled = disabled;
        Object.assign(button.style, { display: "block", height: "20px" });
        root.append(button);
        host.textContent = text;
        host.toggleAttribute("disabled", disabled);
        if (!rendered) host.style.display = "none";
        surface.append(host);
      };

      // One of each: named but disabled, named but not rendered, and one whose
      // words are simply different.
      add("probe-disabled", "Archive the ledger", true, true);
      add("probe-hidden", "Archive the ledger", false, false);
      add("probe-other", "Restore the ledger", false, true);
    });

    const report = await readNoteButtonCandidates(
      page,
      "cf-button",
      "includes",
      "Archive the ledger",
    );
    const byTag = report.candidates.filter((candidate) =>
      candidate.text.includes("the ledger")
    ).map(({ text, named, rendered, disabled }) => ({
      text,
      named,
      rendered,
      disabled,
    }));
    assertEquals(
      byTag,
      [
        {
          text: "Archive the ledger",
          named: true,
          rendered: true,
          disabled: true,
        },
        {
          text: "Archive the ledger",
          named: true,
          rendered: false,
          disabled: false,
        },
        {
          text: "Restore the ledger",
          named: false,
          rendered: true,
          disabled: false,
        },
      ],
      "the probe did not separate the three reasons a candidate was passed over",
    );
  });

  //
  // Filling, typing, and submitting
  //
  // The helpers that work a control without clicking it — filling a value,
  // typing into it, pressing Enter to submit: the same settle discipline as
  // the click helpers, and what happens when a commit replaces the control
  // they were typing into.
  //

  it("settles the view before pressing Enter in a submit input", async () => {
    await page.evaluate(() => {
      const host = document.createElement("div");
      const root = host.attachShadow({ mode: "open" });
      const form = document.createElement("form");
      const input = document.createElement("input");
      input.id = "late-submit-input";
      const submit = document.createElement("button");
      submit.type = "submit";
      form.append(input, submit);
      root.append(form);
      document.body.append(host);

      let settleCalls = 0;
      let submittedAtSettle = 0;
      let bound = false;
      (globalThis as typeof globalThis & {
        commonfabric: { viewSettled: () => Promise<void> };
      }).commonfabric = {
        viewSettled: () => {
          settleCalls++;
          if (!bound) {
            bound = true;
            form.addEventListener("submit", (event) => {
              event.preventDefault();
              submittedAtSettle = settleCalls;
            }, { once: true });
          }
          return Promise.resolve();
        },
      };
      (globalThis as typeof globalThis & {
        __lateSubmitResult: () => {
          settleCalls: number;
          submittedAtSettle: number;
        };
      }).__lateSubmitResult = () => ({ settleCalls, submittedAtSettle });
    });

    await submitViaEnter(page, "#late-submit-input");

    const result = await page.evaluate(() =>
      (globalThis as typeof globalThis & {
        __lateSubmitResult: () => {
          settleCalls: number;
          submittedAtSettle: number;
        };
      }).__lateSubmitResult()
    );
    assertEquals(
      result.submittedAtSettle,
      1,
      "the Enter reached no handler: the field was focused and pressed " +
        "without a settle to wire its form up",
    );
    // One settle wires the form up, and one follows the submission.
    assertEquals(result.settleCalls, 2);
  });

  it("drives the page to settle before filling a cf input", async () => {
    await page.evaluate(() => {
      const host = document.createElement("div");
      host.id = "settling-fill-input";
      Object.assign(host.style, {
        display: "block",
        height: "40px",
        width: "240px",
      });
      const root = host.attachShadow({ mode: "open" });
      const input = document.createElement("input");
      Object.assign(input.style, {
        display: "block",
        height: "32px",
        width: "200px",
      });
      root.append(input);
      document.body.append(host);

      let settleCalls = 0;
      (globalThis as typeof globalThis & {
        commonfabric: { viewSettled: () => Promise<void> };
      }).commonfabric = {
        viewSettled: () => {
          settleCalls++;
          return Promise.resolve();
        },
      };
      (globalThis as typeof globalThis & {
        __settlingFillResult: () => { settleCalls: number; value?: string };
      }).__settlingFillResult = () => ({
        settleCalls,
        value: host.shadowRoot?.querySelector("input")?.value,
      });
    });

    await fillCfInput(page, "#settling-fill-input", "Bob");

    const result = await page.evaluate(() =>
      (globalThis as typeof globalThis & {
        __settlingFillResult: () => { settleCalls: number; value?: string };
      }).__settlingFillResult()
    );
    assertEquals(result.value, "Bob");
    assert(
      result.settleCalls > 0,
      "the fill read the DOM without asking the view to settle, so it only " +
        "watches the page instead of driving it",
    );
  });

  it("fills a cf input that only pending page work renders", async () => {
    await page.evaluate(() => {
      (globalThis as typeof globalThis & {
        commonfabric: { viewSettled: () => Promise<void> };
      }).commonfabric = {
        viewSettled: () => {
          if (!document.querySelector("#pending-work-input")) {
            const host = document.createElement("div");
            host.id = "pending-work-input";
            Object.assign(host.style, {
              display: "block",
              height: "40px",
              width: "240px",
            });
            const root = host.attachShadow({ mode: "open" });
            const input = document.createElement("input");
            Object.assign(input.style, {
              display: "block",
              height: "32px",
              width: "200px",
            });
            root.append(input);
            document.body.append(host);
          }
          return Promise.resolve();
        },
      };
    });

    await fillCfInput(page, "#pending-work-input", "Bob");

    const value = await page.evaluate(() =>
      document.querySelector("#pending-work-input")?.shadowRoot
        ?.querySelector("input")?.value
    );
    assertEquals(value, "Bob");
  });

  it("fills the live input when a commit replaces the one it typed into", async () => {
    await page.evaluate(() => {
      const host = document.createElement("div") as HTMLDivElement & {
        commit: () => Promise<void>;
      };
      host.id = "replacing-commit-input";
      Object.assign(host.style, {
        display: "block",
        height: "40px",
        width: "240px",
      });
      const root = host.attachShadow({ mode: "open" });
      const makeInput = () => {
        const input = document.createElement("input");
        Object.assign(input.style, {
          display: "block",
          height: "32px",
          width: "200px",
        });
        return input;
      };
      root.append(makeInput());
      document.body.append(host);

      // The first commit re-renders the control, as a Lit host does when the
      // committed cell value flows back into its template. Later commits leave
      // it in place, so the fill converges on the replacement.
      let replaced = false;
      host.commit = () => {
        if (!replaced) {
          replaced = true;
          root.querySelector("input")?.remove();
          root.append(makeInput());
        }
        return Promise.resolve();
      };

      (globalThis as typeof globalThis & {
        commonfabric: { viewSettled: () => Promise<void> };
      }).commonfabric = { viewSettled: () => Promise.resolve() };
    });

    await fillCfInput(page, "#replacing-commit-input", "Bob");

    const value = await page.evaluate(() =>
      document.querySelector("#replacing-commit-input")?.shadowRoot
        ?.querySelector("input")?.value
    );
    assertEquals(value, "Bob");
  });

  it("settles pending page work before presentation typing resolves its input", async () => {
    const presentationPage = await browser.newPage();
    const presentation = installPresentationInteractions(
      presentationPage,
      testPresentationConfig,
      { label: "Bob", color: "#0891b2" },
    );
    try {
      await presentationPage.evaluate(() => {
        // The shell's own controls sit inside shadow roots, so the target hangs
        // off one.
        const view = document.createElement("div");
        view.id = "pending-presentation-view";
        const viewRoot = view.attachShadow({ mode: "open" });
        document.body.append(view);
        (globalThis as typeof globalThis & {
          commonfabric: { viewSettled: () => Promise<void> };
        }).commonfabric = {
          viewSettled: () => {
            if (!viewRoot.querySelector("#pending-presentation-input")) {
              const host = document.createElement("div");
              host.id = "pending-presentation-input";
              Object.assign(host.style, {
                display: "block",
                height: "40px",
                width: "240px",
              });
              const root = host.attachShadow({ mode: "open" });
              const input = document.createElement("input");
              Object.assign(input.style, {
                display: "block",
                height: "32px",
                width: "200px",
              });
              root.append(input);
              viewRoot.append(host);
            }
            return Promise.resolve();
          },
        };
      });

      await fillCfInput(presentationPage, "#pending-presentation-input", "Bob");

      const value = await presentationPage.evaluate(() =>
        document.querySelector("#pending-presentation-view")?.shadowRoot
          ?.querySelector("#pending-presentation-input")?.shadowRoot
          ?.querySelector("input")?.value
      );
      assertEquals(value, "Bob");
    } finally {
      presentation.uninstall();
      await presentationPage.close();
    }
  });

  it("drives the page to settle before presentation typing", async () => {
    const presentationPage = await browser.newPage();
    const presentation = installPresentationInteractions(
      presentationPage,
      testPresentationConfig,
      { label: "Bob", color: "#0891b2" },
    );
    try {
      await presentationPage.evaluate(() => {
        // The shell's own controls sit inside shadow roots, so the target hangs
        // off one.
        const view = document.createElement("div");
        view.id = "settling-presentation-view";
        const viewRoot = view.attachShadow({ mode: "open" });
        document.body.append(view);
        const host = document.createElement("div");
        host.id = "settling-presentation-input";
        Object.assign(host.style, {
          display: "block",
          height: "40px",
          width: "240px",
        });
        const root = host.attachShadow({ mode: "open" });
        const input = document.createElement("input");
        Object.assign(input.style, {
          display: "block",
          height: "32px",
          width: "200px",
        });
        root.append(input);
        viewRoot.append(host);

        let settleCalls = 0;
        (globalThis as typeof globalThis & {
          commonfabric: { viewSettled: () => Promise<void> };
        }).commonfabric = {
          viewSettled: () => {
            settleCalls++;
            return Promise.resolve();
          },
        };
        (globalThis as typeof globalThis & {
          __settlingPresentationResult: () => {
            settleCalls: number;
            value?: string;
          };
        }).__settlingPresentationResult = () => ({
          settleCalls,
          value: input.value,
        });
      });

      await fillCfInput(
        presentationPage,
        "#settling-presentation-input",
        "Bob",
      );

      const result = await presentationPage.evaluate(() =>
        (globalThis as typeof globalThis & {
          __settlingPresentationResult: () => {
            settleCalls: number;
            value?: string;
          };
        }).__settlingPresentationResult()
      );
      assertEquals(result.value, "Bob");
      assert(
        result.settleCalls > 0,
        "presentation typing resolved its control without asking the view to " +
          "settle, so it only watches the page instead of driving it",
      );
    } finally {
      presentation.uninstall();
      await presentationPage.close();
    }
  });

  it("reports a control a presentation commit replaced", async () => {
    const presentationPage = await browser.newPage();
    const presentation = installPresentationInteractions(
      presentationPage,
      testPresentationConfig,
      { label: "Bob", color: "#0891b2" },
    );
    try {
      await presentationPage.evaluate(() => {
        // The shell's own controls sit inside shadow roots, so the target hangs
        // off one.
        const view = document.createElement("div");
        const viewRoot = view.attachShadow({ mode: "open" });
        document.body.append(view);
        const host = document.createElement("div") as HTMLDivElement & {
          commit: () => Promise<void>;
        };
        host.id = "replaced-presentation-input";
        Object.assign(host.style, {
          display: "block",
          height: "40px",
          width: "240px",
        });
        const root = host.attachShadow({ mode: "open" });
        const makeInput = () => {
          const input = document.createElement("input");
          Object.assign(input.style, {
            display: "block",
            height: "32px",
            width: "200px",
          });
          return input;
        };
        root.append(makeInput());
        viewRoot.append(host);
        host.commit = () => {
          root.querySelector("input")?.remove();
          root.append(makeInput());
          return Promise.resolve();
        };

        (globalThis as typeof globalThis & {
          commonfabric: { viewSettled: () => Promise<void> };
        }).commonfabric = { viewSettled: () => Promise.resolve() };
      });

      // The typed value survives on the detached control, so a verification
      // that reads it reports a fill that never reached the live field.
      const error = await assertRejects(
        () =>
          fillCfInput(presentationPage, "#replaced-presentation-input", "Bob"),
        Error,
      );
      assertStringIncludes(
        (error.cause as Error).message,
        "was replaced while committing",
      );
    } finally {
      presentation.uninstall();
      await presentationPage.close();
    }
  });

  //
  // A target that moves under the aim
  //
  // The control is found, then its box or its surface changes before the click
  // lands.
  //

  it("waits for a marked target's shifting box to settle before clicking", async () => {
    await page.evaluate((clickTargetAttr: string) => {
      const host = document.createElement("div");
      const root = host.attachShadow({ mode: "open" });
      const button = document.createElement("button");
      button.id = "shifting-guest-button";
      button.textContent = "Continue as guest";
      root.append(button);
      document.body.append(host);

      let clicked = false;
      button.addEventListener("click", () => {
        clicked = true;
      }, { once: true });

      // The control is laid out when the helper marks it, but its surface then
      // goes display:none for a spell as the join card's entrance settles — the
      // way the real profile surface toggles display through its transition.
      // While the marked control has no layout box, DOM.getBoxModel returns
      // nothing, so a click that measures the box once throws "Unable to get
      // stable box model to click on"; a click that waits for the box to settle
      // clicks the control once its surface returns. The shift lands between the
      // mark and the click, a window with no view settle to sequence against, so
      // the fixture hides on the mark and restores on a timer that outlasts a
      // single mark->click round trip. The restore states when the surface
      // returns, not how long to wait for it: the helper's wait ends on the
      // return, bounded only by the stuck-condition net.
      const observer = new MutationObserver(() => {
        if (!button.hasAttribute(clickTargetAttr)) return;
        observer.disconnect();
        button.style.display = "none";
        setTimeout(() => {
          button.style.display = "";
        }, 1000);
      });
      observer.observe(button, {
        attributes: true,
        attributeFilter: [clickTargetAttr],
      });

      (globalThis as typeof globalThis & {
        commonfabric: { viewSettled: () => Promise<void> };
      }).commonfabric = { viewSettled: () => Promise.resolve() };
      (globalThis as typeof globalThis & {
        __shiftingClicked: () => boolean;
      }).__shiftingClicked = () => clicked;
    }, { args: [CLICK_TARGET_ATTR] });

    await clickCfButton(page, "#shifting-guest-button");

    const clicked = await page.evaluate(() =>
      (globalThis as typeof globalThis & {
        __shiftingClicked: () => boolean;
      }).__shiftingClicked()
    );
    assert(
      clicked,
      "the click never reached the target after its hidden surface returned",
    );
  });

  it("waits for a disabled control to be enabled before clicking it", async () => {
    // A control the page has rendered disabled takes no click. The inner
    // control carries `disabled`, and `cf-button`'s stylesheet gives it
    // `pointer-events: none`, so the browser delivers the press to the host
    // instead. The host does not carry the mark, so the click is stopped at the
    // window and aimed again at the same pixel, which is where the aim gives
    // up.
    //
    // A pattern renders a control disabled while the state that enables it is
    // still arriving. A parking coordinator's "This is me" is disabled until
    // the acting identity resolves, and the surface above it collapses as that
    // same state lands. Marking a control in that state aims the click both at
    // a point that takes it nowhere and at a position the page is about to
    // leave.
    //
    // The settle is what carries the page through those steps, so the fixture
    // advances one step per settle: the surface above the control shrinks, and
    // on the last step the control is enabled. Each step mutates the DOM, which
    // re-enters the wait, so the run is driven by the page's own progress
    // rather than by a timer.
    await page.evaluate(() => {
      const surface = document.createElement("div");
      // Fixed and on screen, clear of the surfaces the cases above leave on the
      // shared page, so the aim's scroll cannot move it and nothing else
      // reaches the point this click is aimed at.
      Object.assign(surface.style, {
        position: "fixed",
        left: "950px",
        top: "400px",
        width: "220px",
      });
      document.body.append(surface);

      // Stands in for the join surface a pattern drops once the identity it was
      // collecting has resolved. It shrinks a step at a time, carrying the
      // control up the page as it goes.
      const filler = document.createElement("div");
      Object.assign(filler.style, { width: "200px", height: "72px" });

      // The `cf-button` shape: a host whose shadow root holds the control that
      // takes the click, and a stylesheet that stops pointer events at the
      // control while the host is disabled.
      const host = document.createElement("div");
      host.id = "gated-claim-button";
      const root = host.attachShadow({ mode: "open" });
      const style = document.createElement("style");
      style.textContent =
        ":host([disabled]) [data-cf-button] { pointer-events: none; }";
      const button = document.createElement("button");
      button.setAttribute("data-cf-button", "");
      button.textContent = "This is me";
      Object.assign(button.style, {
        display: "block",
        width: "200px",
        height: "40px",
        padding: "0",
        margin: "0",
      });
      const setDisabled = (disabled: boolean) => {
        button.disabled = disabled;
        host.toggleAttribute("disabled", disabled);
      };
      setDisabled(true);
      root.append(style, button);
      surface.append(filler, host);

      let clicks = 0;
      button.addEventListener("click", () => void clicks++);

      let stepsLeft = 3;
      (globalThis as typeof globalThis & {
        commonfabric: { viewSettled: () => Promise<void> };
      }).commonfabric = {
        viewSettled: () => {
          if (stepsLeft > 0) {
            stepsLeft--;
            filler.style.height = `${stepsLeft * 24}px`;
            if (stepsLeft === 0) setDisabled(false);
          }
          return Promise.resolve();
        },
      };
      (globalThis as typeof globalThis & {
        __gatedClaimState: () => { clicks: number; disabled: boolean };
        __gatedClaimTeardown: () => void;
      }).__gatedClaimState = () => ({ clicks, disabled: button.disabled });
      (globalThis as typeof globalThis & {
        __gatedClaimTeardown: () => void;
      }).__gatedClaimTeardown = () => surface.remove();
    });

    const readState = () =>
      page.evaluate(() =>
        (globalThis as typeof globalThis & {
          __gatedClaimState: () => { clicks: number; disabled: boolean };
        }).__gatedClaimState()
      );

    // Without this the case says nothing: a fixture whose control starts
    // enabled passes whether or not the helper waits for one.
    assert(
      (await readState()).disabled,
      "the fixture should start with its control disabled",
    );

    try {
      await clickCfButton(page, "#gated-claim-button");
    } finally {
      // The surface is fixed and would otherwise stand over these coordinates
      // for every case below.
      await page.evaluate(() =>
        (globalThis as typeof globalThis & {
          __gatedClaimTeardown: () => void;
        }).__gatedClaimTeardown()
      );
    }

    expect((await readState()).clicks).toBe(1);
  });

  it("clicks a control its surface keeps rebuilding under the aim", async () => {
    await page.evaluate((clickTargetAttr: string) => {
      const host = document.createElement("div");
      const root = host.attachShadow({ mode: "open" });
      const surface = document.createElement("div");
      root.append(surface);
      document.body.append(host);

      let clicked = 0;
      // Listen on the surface, not the control: each rebuild is a different
      // element, and a listener on the control would only ever see the one
      // instance it was attached to.
      surface.addEventListener("click", (event) => {
        const target = event.target as HTMLElement | null;
        if (target?.id === "rebuilt-guest-button") clicked++;
      });

      const makeButton = () => {
        const button = document.createElement("button");
        button.id = "rebuilt-guest-button";
        button.textContent = "Continue as guest";
        Object.assign(button.style, {
          display: "block",
          width: "200px",
          height: "32px",
        });
        return button;
      };
      surface.append(makeButton());

      // Once the helper marks the control, the surface rebuilds it on every
      // animation frame, the way a piece re-render replaces the DOM it drew
      // while a test is already interacting with it. Each replacement is
      // geometrically identical, so what changes is which element is there,
      // not where a click has to land. The mark travels to the replacement,
      // which is what a helper addressing the control by name would find.
      //
      // A click that resolves the control to a handle up front and measures
      // that handle's box some protocol round trips later measures an element
      // the surface has since dropped, and reports "Unable to get stable box
      // model to click on". A click that decides and measures inside one page
      // turn measures whichever element is there at that instant, and lands.
      const observer = new MutationObserver(() => {
        if (!surface.querySelector(`[${clickTargetAttr}]`)) return;
        observer.disconnect();
        let framesLeft = 20;
        const rebuild = () => {
          const current = surface.querySelector("#rebuilt-guest-button");
          if (!current || framesLeft-- <= 0) return;
          const replacement = makeButton();
          for (const name of current.getAttributeNames()) {
            replacement.setAttribute(name, current.getAttribute(name)!);
          }
          current.replaceWith(replacement);
          requestAnimationFrame(rebuild);
        };
        requestAnimationFrame(rebuild);
      });
      observer.observe(surface, {
        attributes: true,
        subtree: true,
        attributeFilter: [clickTargetAttr],
      });

      (globalThis as typeof globalThis & {
        commonfabric: { viewSettled: () => Promise<void> };
      }).commonfabric = { viewSettled: () => Promise.resolve() };
      (globalThis as typeof globalThis & {
        __rebuiltClicks: () => number;
      }).__rebuiltClicks = () => clicked;
    }, { args: [CLICK_TARGET_ATTR] });

    await clickCfButton(page, "#rebuilt-guest-button");

    const clicks = await page.evaluate(() =>
      (globalThis as typeof globalThis & {
        __rebuiltClicks: () => number;
      }).__rebuiltClicks()
    );
    assertEquals(
      clicks,
      1,
      "the click never reached the control the surface rebuilt under it",
    );
  });

  it("clicks the control its surface relaid out under the aim", async () => {
    // The aim measures the control inside the page and hands the point back to
    // the test process, which then dispatches the trusted click over a separate
    // protocol round trip. The page runs freely across that gap. A re-render
    // arriving in it — a roster update crossing from another browser, say —
    // relays the surface out and carries the control away from the point the
    // click is already aimed at, so the click lands on whatever moved into that
    // space and the control is never clicked.
    //
    // The relayout is driven from the interaction observer's `beforeClick`,
    // which the dispatch awaits, so it lands strictly between the measurement
    // and the click with no timing to align. It fires once: the second aim
    // measures the control where it now sits, and the click that follows has
    // nothing left to move it.
    await page.evaluate(() => {
      const host = document.createElement("div");
      const root = host.attachShadow({ mode: "open" });
      const surface = document.createElement("div");
      // Fixed and on screen, so the aim's scroll cannot move it and the
      // content earlier cases leave on the shared page cannot reach it.
      Object.assign(surface.style, {
        position: "fixed",
        left: "400px",
        top: "300px",
        width: "220px",
      });
      root.append(surface);
      document.body.append(host);

      // The block that grows into the space the control vacates. A click that
      // went to the control's old point landed here, which is what tells the
      // two failures apart: a click that reached nothing at all, and a click
      // that reached the wrong control.
      const filler = document.createElement("button");
      filler.id = "relaid-out-filler";
      Object.assign(filler.style, {
        display: "block",
        width: "200px",
        height: "0px",
        padding: "0",
        margin: "0",
        border: "none",
      });
      const button = document.createElement("button");
      button.id = "relaid-out-guest-button";
      button.textContent = "Continue as guest";
      Object.assign(button.style, {
        display: "block",
        width: "200px",
        height: "40px",
        padding: "0",
        margin: "0",
      });
      surface.append(filler, button);

      let buttonClicks = 0;
      let fillerClicks = 0;
      button.addEventListener("click", () => void buttonClicks++);
      filler.addEventListener("click", () => void fillerClicks++);

      (globalThis as typeof globalThis & {
        commonfabric: { viewSettled: () => Promise<void> };
      }).commonfabric = { viewSettled: () => Promise.resolve() };
      (globalThis as typeof globalThis & {
        __relaidOutRelayout: () => void;
        __relaidOutClicks: () => { button: number; filler: number };
      }).__relaidOutRelayout = () => {
        // 100px of filler covers the whole 40px box the control has left.
        filler.style.height = "100px";
      };
      (globalThis as typeof globalThis & {
        __relaidOutClicks: () => { button: number; filler: number };
      }).__relaidOutClicks = () => ({
        button: buttonClicks,
        filler: fillerClicks,
      });
    });

    let relaidOut = false;
    page.setInteractionObserver({
      beforeClick: async () => {
        if (relaidOut) return;
        relaidOut = true;
        await page.evaluate(() =>
          (globalThis as typeof globalThis & {
            __relaidOutRelayout: () => void;
          }).__relaidOutRelayout()
        );
      },
    });
    try {
      await clickCfButton(page, "#relaid-out-guest-button");
    } finally {
      page.setInteractionObserver(undefined);
    }

    const clicks = await page.evaluate(() =>
      (globalThis as typeof globalThis & {
        __relaidOutClicks: () => { button: number; filler: number };
      }).__relaidOutClicks()
    );
    assertEquals(
      clicks,
      { button: 1, filler: 0 },
      "the click did not reach the control after its surface relaid out",
    );
  });

  it("clicks the control its surface moved between press and release", async () => {
    // A trusted click is a press and a release, dispatched over two protocol
    // round trips. A surface that relays out between them leaves the release
    // somewhere the press was not, and the browser raises the click on the
    // nearest ancestor the two have in common rather than on the control. The
    // control is never clicked.
    //
    // The relayout is driven from the control's own mousedown, so it lands
    // strictly between the two dispatches with no timing to align. It fires
    // once, so the click that follows has a control standing still to reach.
    await page.evaluate(() => {
      const host = document.createElement("div");
      const root = host.attachShadow({ mode: "open" });
      const surface = document.createElement("div");
      Object.assign(surface.style, {
        position: "fixed",
        left: "400px",
        top: "80px",
        width: "220px",
      });
      root.append(surface);
      document.body.append(host);

      const filler = document.createElement("div");
      Object.assign(filler.style, { display: "block", height: "0px" });
      const button = document.createElement("button");
      button.id = "split-guest-button";
      button.textContent = "Continue as guest";
      Object.assign(button.style, {
        display: "block",
        width: "200px",
        height: "40px",
        padding: "0",
        margin: "0",
      });
      surface.append(filler, button);

      let buttonClicks = 0;
      let strayClicks = 0;
      button.addEventListener("click", () => void buttonClicks++);
      // Clicks the browser raised somewhere other than the control. The one a
      // split press and release produces lands here, on the surface the two
      // targets have in common.
      surface.addEventListener("click", (event) => {
        if (event.target !== button) strayClicks++;
      });
      button.addEventListener("mousedown", () => {
        filler.style.height = "100px";
      }, { once: true });

      (globalThis as typeof globalThis & {
        commonfabric: { viewSettled: () => Promise<void> };
      }).commonfabric = { viewSettled: () => Promise.resolve() };
      (globalThis as typeof globalThis & {
        __splitClicks: () => { button: number; stray: number };
      }).__splitClicks = () => ({ button: buttonClicks, stray: strayClicks });
    });

    await clickCfButton(page, "#split-guest-button");

    const clicks = await page.evaluate(() =>
      (globalThis as typeof globalThis & {
        __splitClicks: () => { button: number; stray: number };
      }).__splitClicks()
    );
    assertEquals(
      clicks,
      { button: 1, stray: 0 },
      "the click did not reach the control after the press and release split",
    );
  });

  //
  // Where the click actually landed
  //
  // A click can reach the DOM and still not reach the control the caller
  // aimed at. These cover what the helper does about that — report it, re-mark
  // the control, or stand aside for an interaction that is not its own.
  //

  it("leaves the page's own clicks to the page while a click is in flight", async () => {
    // Components raise clicks of their own — a label forwarding to its control,
    // a component clicking itself from a key handler. One of those arriving
    // while a trusted click is crossing the protocol is not that click, and is
    // none of the helper's business: it must reach its own listeners, and it
    // must not answer for the interaction the helper is waiting on.
    //
    // The page's click is raised from the interaction observer's `beforeClick`,
    // which the dispatch awaits, so it lands in exactly that window.
    await page.evaluate(() => {
      const host = document.createElement("div");
      const root = host.attachShadow({ mode: "open" });
      const surface = document.createElement("div");
      Object.assign(surface.style, {
        position: "fixed",
        left: "700px",
        top: "300px",
        width: "220px",
      });
      root.append(surface);
      document.body.append(host);

      const elsewhere = document.createElement("button");
      elsewhere.id = "page-raised-elsewhere";
      const button = document.createElement("button");
      button.id = "page-raised-guest-button";
      button.textContent = "Continue as guest";
      Object.assign(button.style, {
        display: "block",
        width: "200px",
        height: "40px",
        padding: "0",
        margin: "0",
      });
      surface.append(elsewhere, button);

      let buttonClicks = 0;
      let elsewhereClicks = 0;
      button.addEventListener("click", () => void buttonClicks++);
      elsewhere.addEventListener("click", () => void elsewhereClicks++);

      (globalThis as typeof globalThis & {
        commonfabric: { viewSettled: () => Promise<void> };
      }).commonfabric = { viewSettled: () => Promise.resolve() };
      (globalThis as typeof globalThis & {
        __pageRaisedClick: () => void;
        __pageRaisedClicks: () => { button: number; elsewhere: number };
      }).__pageRaisedClick = () => elsewhere.click();
      (globalThis as typeof globalThis & {
        __pageRaisedClicks: () => { button: number; elsewhere: number };
      }).__pageRaisedClicks = () => ({
        button: buttonClicks,
        elsewhere: elsewhereClicks,
      });
    });

    let raised = false;
    page.setInteractionObserver({
      beforeClick: async () => {
        if (raised) return;
        raised = true;
        await page.evaluate(() =>
          (globalThis as typeof globalThis & {
            __pageRaisedClick: () => void;
          }).__pageRaisedClick()
        );
      },
    });
    try {
      await clickCfButton(page, "#page-raised-guest-button");
    } finally {
      page.setInteractionObserver(undefined);
    }

    const clicks = await page.evaluate(() =>
      (globalThis as typeof globalThis & {
        __pageRaisedClicks: () => { button: number; elsewhere: number };
      }).__pageRaisedClicks()
    );
    assertEquals(
      clicks,
      { button: 1, elsewhere: 1 },
      "the page's own click was swallowed, or answered for the trusted one",
    );
  });

  it("reports a control that keeps taking the click nowhere", async () => {
    // A control a click cannot reach — covered, or declining pointer events —
    // is aimed at, missed, and aimed at again in the same place. The second aim
    // repeats a pixel a dispatch already lost, which is where the helper stops
    // and says so, rather than dispatching at it forever.
    await page.evaluate(() => {
      const host = document.createElement("div");
      const root = host.attachShadow({ mode: "open" });
      const surface = document.createElement("div");
      Object.assign(surface.style, {
        position: "fixed",
        left: "700px",
        top: "80px",
        width: "220px",
        height: "40px",
      });
      root.append(surface);
      document.body.append(host);

      const button = document.createElement("button");
      button.id = "unreachable-guest-button";
      button.textContent = "Continue as guest";
      Object.assign(button.style, {
        display: "block",
        width: "200px",
        height: "40px",
        padding: "0",
        margin: "0",
      });
      const cover = document.createElement("div");
      Object.assign(cover.style, {
        position: "absolute",
        inset: "0",
      });
      surface.append(button, cover);

      let buttonClicks = 0;
      button.addEventListener("click", () => void buttonClicks++);

      (globalThis as typeof globalThis & {
        commonfabric: { viewSettled: () => Promise<void> };
      }).commonfabric = { viewSettled: () => Promise.resolve() };
      (globalThis as typeof globalThis & {
        __unreachableClicks: () => number;
      }).__unreachableClicks = () => buttonClicks;
    });

    const error = await assertRejects(
      () => clickCfButton(page, "#unreachable-guest-button"),
      Error,
    );
    assertStringIncludes(
      error.message,
      "again, where a trusted click already failed to reach it",
    );
    // The click has to have been stopped by the cover, not by landing outside
    // the page: a point off the viewport reaches nothing, which would satisfy
    // every other assertion here while testing none of what this test is for.
    assertStringIncludes(error.message, "the click reached div");

    const clicks = await page.evaluate(() =>
      (globalThis as typeof globalThis & {
        __unreachableClicks: () => number;
      }).__unreachableClicks()
    );
    assertEquals(clicks, 0, "the covered control should have taken no click");
  });

  it("re-marks a replacement that drops the original click mark", async () => {
    await page.evaluate((clickTargetAttr: string) => {
      const host = document.createElement("div");
      const root = host.attachShadow({ mode: "open" });
      const surface = document.createElement("div");
      root.append(surface);
      document.body.append(host);

      const makeButton = (generation: number) => {
        const button = document.createElement("button");
        button.id = "remarked-guest-button";
        button.dataset.generation = String(generation);
        button.textContent = "Continue as guest";
        Object.assign(button.style, {
          display: "block",
          width: "200px",
          height: "32px",
        });
        return button;
      };
      surface.append(makeButton(0));

      let replacements = 0;
      let clickedGeneration = -1;
      let markPresentAtClick = false;
      surface.addEventListener("click", (event) => {
        const target = event.target as HTMLElement | null;
        if (target?.id !== "remarked-guest-button") return;
        clickedGeneration = Number(target.dataset.generation);
        markPresentAtClick = target.hasAttribute(clickTargetAttr);
      });

      // Replace the control as soon as the first wait marks it. Unlike the
      // continuous-rebuild fixture above, this replacement deliberately does
      // not inherit the mark. The click can land only if clickMarked runs the
      // caller's mark predicate again against the live replacement.
      const observer = new MutationObserver(() => {
        const marked = surface.querySelector<HTMLElement>(
          `[${clickTargetAttr}]`,
        );
        if (!marked) return;
        observer.disconnect();
        marked.replaceWith(makeButton(1));
        replacements++;
      });
      observer.observe(surface, {
        attributes: true,
        subtree: true,
        attributeFilter: [clickTargetAttr],
      });

      (globalThis as typeof globalThis & {
        commonfabric: { viewSettled: () => Promise<void> };
      }).commonfabric = { viewSettled: () => Promise.resolve() };
      (globalThis as typeof globalThis & {
        __remarkedClickResult: () => {
          replacements: number;
          clickedGeneration: number;
          markPresentAtClick: boolean;
        };
      }).__remarkedClickResult = () => ({
        replacements,
        clickedGeneration,
        markPresentAtClick,
      });
    }, { args: [CLICK_TARGET_ATTR] });

    await clickCfButton(page, "#remarked-guest-button");

    const result = await page.evaluate(() =>
      (globalThis as typeof globalThis & {
        __remarkedClickResult: () => {
          replacements: number;
          clickedGeneration: number;
          markPresentAtClick: boolean;
        };
      }).__remarkedClickResult()
    );
    assertEquals(result, {
      replacements: 1,
      clickedGeneration: 1,
      markPresentAtClick: true,
    });
  });

  it("tells the interaction observer where a marked click landed", async () => {
    // A presentation recording animates its cursor from these callbacks. The
    // click is aimed at a point rather than resolved to a handle, so the
    // observer is told about a point with no element to name.
    const observed: { phase: string; x: number; y: number }[] = [];
    page.setInteractionObserver({
      beforeClick: (_element, point) =>
        void observed.push({ phase: "before", x: point.x, y: point.y }),
      afterClick: (_element, point) =>
        void observed.push({ phase: "after", x: point.x, y: point.y }),
    });
    try {
      await page.evaluate(() => {
        const host = document.createElement("div");
        const root = host.attachShadow({ mode: "open" });
        const button = document.createElement("button");
        button.id = "observed-guest-button";
        button.textContent = "Continue as guest";
        Object.assign(button.style, {
          position: "fixed",
          left: "40px",
          top: "40px",
          width: "120px",
          height: "40px",
          margin: "0",
        });
        root.append(button);
        document.body.append(host);
        (globalThis as typeof globalThis & {
          commonfabric: { viewSettled: () => Promise<void> };
        }).commonfabric = { viewSettled: () => Promise.resolve() };
      });

      await clickCfButton(page, "#observed-guest-button");

      assertEquals(
        observed.map((entry) => entry.phase),
        ["before", "after"],
        "the observer should bracket the click",
      );
      // The control sits at 40,40 and is 120x40, so its centre is 100,60.
      assertEquals({ x: observed[0].x, y: observed[0].y }, { x: 100, y: 60 });
      assertEquals({ x: observed[1].x, y: observed[1].y }, { x: 100, y: 60 });
    } finally {
      page.setInteractionObserver(undefined);
    }
  });

  it("places the presentation cursor where a refreshed click lands", async () => {
    const presentationPage = await browser.newPage();
    const presentation = installPresentationInteractions(
      presentationPage,
      testPresentationConfig,
      { label: "Guest", color: "#2563eb" },
    );
    try {
      await presentationPage.evaluate(() => {
        const button = document.createElement("button");
        button.id = "presentation-moving-button";
        button.textContent = "Continue";
        Object.assign(button.style, {
          position: "fixed",
          left: "40px",
          top: "40px",
          width: "120px",
          height: "40px",
          margin: "0",
        });
        document.body.append(button);

        let clicks = 0;
        let clickX = 0;
        button.addEventListener("click", (event) => {
          clicks++;
          clickX = event.clientX;
        });
        (globalThis as typeof globalThis & {
          commonfabric: { viewSettled: () => Promise<void> };
          __presentationClickResult: () => {
            clicks: number;
            clickX: number;
            cursorX: number;
            cursorY: number;
          };
        }).commonfabric = { viewSettled: () => Promise.resolve() };
        (globalThis as typeof globalThis & {
          __presentationClickResult: () => {
            clicks: number;
            clickX: number;
            cursorX: number;
            cursorY: number;
          };
        }).__presentationClickResult = () => {
          const cursor = document.getElementById(
            "__cf_demo_presentation_overlay",
          )?.shadowRoot?.getElementById("cursor");
          if (!cursor) throw new Error("Presentation cursor is missing");
          const transform = new DOMMatrix(getComputedStyle(cursor).transform);
          return {
            clicks,
            clickX,
            cursorX: transform.m41,
            cursorY: transform.m42,
          };
        };
      });
      await presentation.prepareDocument();
      await presentationPage.evaluate(() => {
        const button = document.querySelector<HTMLElement>(
          "#presentation-moving-button",
        );
        const cursor = document.getElementById(
          "__cf_demo_presentation_overlay",
        )?.shadowRoot?.getElementById("cursor");
        if (!button || !cursor) {
          throw new Error("Presentation click fixture is incomplete");
        }
        const observer = new MutationObserver(() => {
          observer.disconnect();
          button.style.transform = "translateX(400px)";
        });
        observer.observe(cursor, {
          attributes: true,
          attributeFilter: ["style"],
        });
      });

      await clickCfButton(presentationPage, "#presentation-moving-button");

      const result = await presentationPage.evaluate(() =>
        (globalThis as typeof globalThis & {
          __presentationClickResult: () => {
            clicks: number;
            clickX: number;
            cursorX: number;
            cursorY: number;
          };
        }).__presentationClickResult()
      );
      expect(result).toEqual({
        clicks: 1,
        clickX: 500,
        cursorX: 500,
        cursorY: 60,
      });
    } finally {
      presentation.uninstall();
      await presentationPage.close();
    }
  });

  //
  // A control the page does not fully render
  //
  // A page that is not rendering at all, a control only partly inside the
  // viewport, one the edge cuts off, and one with no part inside it.
  //

  it("clicks a control on a page that is not being rendered", async () => {
    // A page sharing a browser with a fronted page is hidden, and a hidden page
    // produces no animation frames. A settle that waits for a frame there waits
    // for one that never arrives, and a settle that yields only to the
    // microtask queue starves the timers and tasks that would bring a
    // momentarily hidden control back — so it spins against a control it is
    // itself preventing from returning. Both leave the click unable to land.
    const background = await browser.newPage();
    const fronted = await browser.newPage();
    try {
      assertEquals(
        await background.evaluate(() => document.visibilityState),
        "hidden",
        "the background page should not be rendering",
      );

      await background.evaluate((clickTargetAttr: string) => {
        const host = document.createElement("div");
        const root = host.attachShadow({ mode: "open" });
        const button = document.createElement("button");
        button.id = "background-guest-button";
        button.textContent = "Continue as guest";
        Object.assign(button.style, {
          display: "block",
          width: "200px",
          height: "32px",
        });
        root.append(button);
        document.body.append(host);

        let clicked = 0;
        button.addEventListener("click", () => {
          clicked++;
        });

        // The control goes away for a spell once marked and comes back on a
        // task. Only a settle that lets the event loop turn will ever see it
        // return.
        const observer = new MutationObserver(() => {
          if (!button.hasAttribute(clickTargetAttr)) return;
          observer.disconnect();
          button.style.display = "none";
          setTimeout(() => {
            button.style.display = "block";
          }, 250);
        });
        observer.observe(button, {
          attributes: true,
          attributeFilter: [clickTargetAttr],
        });

        (globalThis as typeof globalThis & {
          commonfabric: { viewSettled: () => Promise<void> };
        }).commonfabric = { viewSettled: () => Promise.resolve() };
        (globalThis as typeof globalThis & {
          __backgroundClicks: () => number;
        }).__backgroundClicks = () => clicked;
      }, { args: [CLICK_TARGET_ATTR] });

      await clickCfButton(background, "#background-guest-button");

      const clicks = await background.evaluate(() =>
        (globalThis as typeof globalThis & {
          __backgroundClicks: () => number;
        }).__backgroundClicks()
      );
      assertEquals(
        clicks,
        1,
        "the click never landed on the unrendered page's control",
      );
    } finally {
      await fronted.close();
      await background.close();
    }
  });

  it("clicks the part of a control that lies inside the page", async () => {
    // A control can reach past the edge of the page it is drawn on: a surface
    // positioned towards the right of a narrow viewport, a control wider than
    // the column it sits in. The middle of such a control's box is a point the
    // page does not have, and a trusted click dispatched there is delivered to
    // the browser, lands outside the page, and reaches nothing at all.
    //
    // The control the mark is placed on is counted as well as clicked. The aim
    // and the measurement taken just before dispatch answer the point
    // separately, and a click whose two answers disagree clears its mark and
    // places it again on a control that never moved.
    const observed: { x: number; y: number }[] = [];
    const narrow = await browser.newPage();
    narrow.setInteractionObserver({
      afterClick: (_element, point) =>
        void observed.push({ x: point.x, y: point.y }),
    });
    try {
      await narrow.setViewportSize({ width: 800, height: 600 });
      await narrow.evaluate((clickTargetAttr: string) => {
        const host = document.createElement("div");
        const root = host.attachShadow({ mode: "open" });
        // Fixed, so the control cannot be brought into the page by scrolling
        // to it: the part of it inside the page is the whole of what a click
        // has to work with.
        const surface = document.createElement("div");
        Object.assign(surface.style, {
          position: "fixed",
          left: "700px",
          top: "300px",
          width: "420px",
        });
        // Spans 700 to 1100 in a page 800 wide. The middle of the whole box is
        // at 900, a hundred columns past the last column the page has; the
        // middle of the part inside the page is at 750.
        const button = document.createElement("button");
        button.id = "clipped-guest-button";
        button.textContent = "Continue as guest";
        Object.assign(button.style, {
          display: "block",
          width: "400px",
          height: "40px",
        });
        let clicked = 0;
        button.addEventListener("click", () => {
          clicked++;
        });
        surface.append(button);
        root.append(surface);
        document.body.append(host);

        let marks = 0;
        const observer = new MutationObserver(() => {
          if (button.hasAttribute(clickTargetAttr)) marks++;
        });
        observer.observe(button, {
          attributes: true,
          attributeFilter: [clickTargetAttr],
        });

        (globalThis as typeof globalThis & {
          commonfabric: { viewSettled: () => Promise<void> };
        }).commonfabric = { viewSettled: () => Promise.resolve() };
        (globalThis as typeof globalThis & {
          __clippedClicks: () => { clicks: number; marks: number };
        }).__clippedClicks = () => ({ clicks: clicked, marks });
      }, { args: [CLICK_TARGET_ATTR] });

      await clickCfButton(narrow, "#clipped-guest-button");

      const result = await narrow.evaluate(() =>
        (globalThis as typeof globalThis & {
          __clippedClicks: () => { clicks: number; marks: number };
        }).__clippedClicks()
      );
      assertEquals(
        result.clicks,
        1,
        "the click never landed on the part of the control inside the page",
      );
      assertEquals(
        result.marks,
        1,
        "the control was marked again for a click that had not moved",
      );
      // The part of the box inside the page spans 700 to 800 across and 300 to
      // 340 down, so the point to click is 750,320.
      assertEquals(observed, [{ x: 750, y: 320 }]);
    } finally {
      narrow.setInteractionObserver(undefined);
      await narrow.close();
    }
  });

  it("clicks a control the left-hand edge of the page cuts off", async () => {
    // The edge a control reaches past can be any of the four. A control that
    // starts to the left of the page has a negative middle, which is as
    // unreachable as one past the right-hand edge.
    const observed: { x: number; y: number }[] = [];
    const narrow = await browser.newPage();
    narrow.setInteractionObserver({
      afterClick: (_element, point) =>
        void observed.push({ x: point.x, y: point.y }),
    });
    try {
      await narrow.setViewportSize({ width: 800, height: 600 });
      await narrow.evaluate(() => {
        const host = document.createElement("div");
        const root = host.attachShadow({ mode: "open" });
        // Spans -300 to 100 across and -20 to 20 down, so the middle of the
        // whole box is at -100,0 and the middle of the part inside the page is
        // at 50,10.
        const button = document.createElement("button");
        button.id = "left-clipped-button";
        button.textContent = "Continue as guest";
        Object.assign(button.style, {
          position: "fixed",
          left: "-300px",
          top: "-20px",
          width: "400px",
          height: "40px",
          margin: "0",
        });
        let clicked = 0;
        button.addEventListener("click", () => {
          clicked++;
        });
        root.append(button);
        document.body.append(host);

        (globalThis as typeof globalThis & {
          commonfabric: { viewSettled: () => Promise<void> };
        }).commonfabric = { viewSettled: () => Promise.resolve() };
        (globalThis as typeof globalThis & {
          __leftClippedClicks: () => number;
        }).__leftClippedClicks = () => clicked;
      });

      await clickCfButton(narrow, "#left-clipped-button");

      assertEquals(
        await narrow.evaluate(() =>
          (globalThis as typeof globalThis & {
            __leftClippedClicks: () => number;
          }).__leftClippedClicks()
        ),
        1,
        "the click never landed on the part of the control inside the page",
      );
      assertEquals(observed, [{ x: 50, y: 10 }]);
    } finally {
      narrow.setInteractionObserver(undefined);
      await narrow.close();
    }
  });

  it("reports a control with no part of it inside the page", async () => {
    // Every point on the control is outside the page, so there is nowhere to
    // aim that a click can reach. Saying so is the only honest answer: a click
    // dispatched past the edge of the page reaches nothing, and a helper that
    // returns from that has told its caller the control was pressed.
    const narrow = await browser.newPage();
    try {
      await narrow.setViewportSize({ width: 800, height: 600 });
      await narrow.evaluate(() => {
        const host = document.createElement("div");
        const root = host.attachShadow({ mode: "open" });
        const surface = document.createElement("div");
        Object.assign(surface.style, {
          position: "fixed",
          left: "900px",
          top: "300px",
          width: "220px",
        });
        const button = document.createElement("button");
        button.id = "offscreen-guest-button";
        button.textContent = "Continue as guest";
        Object.assign(button.style, {
          display: "block",
          width: "200px",
          height: "40px",
        });
        let clicked = 0;
        button.addEventListener("click", () => {
          clicked++;
        });
        surface.append(button);
        root.append(surface);
        document.body.append(host);

        (globalThis as typeof globalThis & {
          commonfabric: { viewSettled: () => Promise<void> };
        }).commonfabric = { viewSettled: () => Promise.resolve() };
        (globalThis as typeof globalThis & {
          __offscreenClicks: () => number;
        }).__offscreenClicks = () => clicked;
      });

      const error = await assertRejects(
        () => clickCfButton(narrow, "#offscreen-guest-button"),
        Error,
      );
      assertStringIncludes(error.message, "outside the page");
      // The size of the page, so a message that names some other 800 cannot
      // satisfy this.
      assertStringIncludes(error.message, "width:800");
      assertStringIncludes(error.message, "height:600");

      const clicks = await narrow.evaluate(() =>
        (globalThis as typeof globalThis & {
          __offscreenClicks: () => number;
        }).__offscreenClicks()
      );
      assertEquals(clicks, 0, "a click reached a control the page cannot show");
    } finally {
      await narrow.close();
    }
  });

  //
  // The click-to-own-render echo
  //
  // Not about where a control sits, but about what the sender observes coming
  // back from its own click — including through a shadow root.
  //

  it("samples the sender's click-to-own-render echo, shadow roots included", async () => {
    const echoPage = await browser.newPage();
    try {
      await echoPage.evaluate(() => {
        // The render target lives inside a shadow root created AFTER the
        // probe installs (the attachShadow chain-wrap's case), and the
        // rendered text lands one macrotask after the click — a stand-in
        // for handler -> speculative write -> re-render.
        const button = document.createElement("button");
        button.id = "echo-send-button";
        button.textContent = "Send";
        document.body.append(button);
        (globalThis as typeof globalThis & {
          commonfabric: { viewSettled: () => Promise<void> };
        }).commonfabric = { viewSettled: () => Promise.resolve() };
        (globalThis as typeof globalThis & {
          __echoMount: () => void;
        }).__echoMount = () => {
          const host = document.createElement("div");
          const root = host.attachShadow({ mode: "open" });
          const preview = document.createElement("div");
          preview.id = "echo-preview";
          preview.textContent = "no messages yet";
          root.append(preview);
          document.body.append(host);
          button.addEventListener("click", () => {
            setTimeout(() => {
              preview.textContent = "echo landed";
            }, 40);
          });
        };
      });

      await installSenderEchoProbe(echoPage);
      // Mount AFTER install so the shadow root is one the attachShadow wrap
      // caught, not the initial scan.
      await echoPage.evaluate(() =>
        (globalThis as typeof globalThis & {
          __echoMount: () => void;
        }).__echoMount()
      );

      // A pre-rendered expectation is refused and recorded, not sampled.
      await armSenderEcho(echoPage, "pre", "#echo-preview", "no messages yet");
      // The real expectation: armed before the click, rendered ~40 ms after.
      await armSenderEcho(echoPage, "post-0", "#echo-preview", "echo landed");
      await clickCfButton(echoPage, "#echo-send-button");
      await waitForSettledText(echoPage, "#echo-preview", "echo landed");

      // An expectation that never renders is flushed as abandoned by the
      // read, with the click recorded.
      await armSenderEcho(echoPage, "post-1", "#echo-preview", "never shown");
      await clickCfButton(echoPage, "#echo-send-button");

      const report = await readSenderEchoReport(echoPage);
      assertEquals(report.samples.length, 1);
      const sample = report.samples[0];
      assertEquals(sample.label, "post-0");
      assertEquals(sample.clicks, 1);
      assert(
        sample.echoMs >= 30 && sample.echoMs < 2_000,
        `echoMs ${sample.echoMs} is outside the 40 ms render's sane band`,
      );
      assertEquals(
        report.abandoned.map((row) => [row.label, row.reason]),
        [["pre", "pre-armed"], ["post-1", "unrendered"]],
      );
    } finally {
      await echoPage.close();
    }
  });
});
