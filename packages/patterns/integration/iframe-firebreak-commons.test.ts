/**
 * Browser-level multiplayer coverage for Firebreak Commons.
 *
 * The guest is an opaque-origin iframe, so the shell document cannot inspect
 * it directly. This test attaches a second CDP client, creates an isolated
 * world in the real guest frame, and clicks the ordinary accessible controls.
 * No command listener or test-only state surface is shipped in the pattern.
 */

import {
  createTestSpace,
  env,
  type Page,
  waitForCondition,
} from "@commonfabric/integration";
import { ShellIntegration } from "@commonfabric/integration/shell-utils";
import { type DID, Identity } from "@commonfabric/identity";
import { resolveLocalProgram } from "@commonfabric/runner/local-program.deno";
import { expect } from "@std/expect";
import { afterAll, beforeAll, describe, it } from "@std/testing/bdd";
import { join } from "@std/path";
import { waitForRuntimeIdle } from "./cfc-browser-helpers.ts";
import {
  initializePiecesController,
  PiecesController,
} from "./pieces-controller.ts";

const { API_URL, FRONTEND_URL } = env;
const GUEST_WAIT_BACKSTOP_MS = 5 * 60 * 1_000;

type CdpResult = Record<string, unknown>;

interface FrameTree {
  frame: { id: string };
  childFrames?: FrameTree[];
}

interface GuestSummary {
  ready: boolean;
  turn: string;
  status: string;
  crewName: string;
  crewColor: string;
  selectedTool: string;
  actionCount: number;
  actionText: string;
  hasCanvas: boolean;
}

function guestSummaryReader(condition = "true"): string {
  return `() => {
    const app = document.querySelector('#firebreak-app');
    const selected = document.querySelector('[data-tool][aria-pressed="true"]');
    const actions = [...document.querySelectorAll('#action-log li[data-action-id]')];
    const summary = {
      ready: app?.getAttribute('data-ready') === 'true',
      turn: app?.getAttribute('data-turn') ?? '',
      status: app?.getAttribute('data-status') ?? '',
      crewName: document.querySelector('#crew-name')?.value ?? '',
      crewColor: app?.getAttribute('data-crew-color') ?? '',
      selectedTool: selected?.getAttribute('data-tool') ?? '',
      actionCount: actions.length,
      actionText: actions.map((item) => item.textContent ?? '').join(' '),
      hasCanvas: document.querySelector('#game canvas') !== null,
    };
    return (${condition}) ? summary : false;
  }`;
}

class GuestDomDriver {
  readonly #socket: WebSocket;
  readonly #sessionId: string;
  readonly #contextId: number;
  #nextId = 1;
  #pending = new Map<
    number,
    {
      resolve: (value: CdpResult) => void;
      reject: (error: Error) => void;
    }
  >();

  private constructor(
    socket: WebSocket,
    sessionId: string,
    contextId: number,
  ) {
    this.#socket = socket;
    this.#sessionId = sessionId;
    this.#contextId = contextId;
  }

  static async connect(browserEndpoint: string): Promise<GuestDomDriver> {
    const socket = new WebSocket(browserEndpoint);
    await new Promise<void>((resolve, reject) => {
      socket.addEventListener("open", () => resolve(), { once: true });
      socket.addEventListener(
        "error",
        () => reject(new Error("Could not connect to browser CDP.")),
        { once: true },
      );
    });
    const bootstrap = new GuestDomDriver(socket, "", 0);
    socket.addEventListener("message", (event) => bootstrap.#onMessage(event));
    socket.addEventListener("close", () => {
      bootstrap.#rejectPending("Browser CDP connection closed.");
    });

    const { targetInfos } = await bootstrap.#send("Target.getTargets") as {
      targetInfos: Array<{ targetId: string; type: string; url: string }>;
    };
    const candidates = targetInfos.filter((target) =>
      target.type === "page" || target.type === "iframe"
    );
    const inspected: string[] = [];
    for (const target of candidates) {
      const { sessionId } = await bootstrap.#send(
        "Target.attachToTarget",
        { targetId: target.targetId, flatten: true },
      ) as { sessionId: string };
      const { frameTree } = await bootstrap.#send(
        "Page.getFrameTree",
        {},
        sessionId,
      ) as { frameTree: FrameTree };
      for (const frameId of GuestDomDriver.#frameIds(frameTree)) {
        try {
          const { executionContextId } = await bootstrap.#send(
            "Page.createIsolatedWorld",
            {
              frameId,
              worldName: `firebreak-browser-test-${crypto.randomUUID()}`,
            },
            sessionId,
          ) as { executionContextId: number };
          const value = await bootstrap.#evaluateIn(
            sessionId,
            executionContextId,
            "Boolean(document.querySelector('#firebreak-app'))",
          );
          if (value === true) {
            return new GuestDomDriver(socket, sessionId, executionContextId)
              .#adopt(bootstrap);
          }
        } catch (error) {
          inspected.push(
            `${target.type}:${target.url}:${frameId}:` +
              (error instanceof Error ? error.message : String(error)),
          );
        }
      }
      inspected.push(`${target.type}:${target.url}`);
    }
    socket.close();
    throw new Error(
      `Could not find the Firebreak Commons guest frame. Inspected ${
        inspected.join(" | ")
      }`,
    );
  }

  #adopt(bootstrap: GuestDomDriver): GuestDomDriver {
    this.#nextId = bootstrap.#nextId;
    this.#pending = bootstrap.#pending;
    return this;
  }

  static *#frameIds(tree: FrameTree): Generator<string> {
    yield tree.frame.id;
    for (const child of tree.childFrames ?? []) {
      yield* GuestDomDriver.#frameIds(child);
    }
  }

  #onMessage(event: MessageEvent): void {
    const message = JSON.parse(String(event.data)) as {
      id?: number;
      result?: CdpResult;
      error?: { message: string };
    };
    if (message.id === undefined) return;
    const pending = this.#pending.get(message.id);
    if (!pending) return;
    this.#pending.delete(message.id);
    if (message.error) pending.reject(new Error(message.error.message));
    else pending.resolve(message.result ?? {});
  }

  #rejectPending(message: string): void {
    for (const pending of this.#pending.values()) {
      pending.reject(new Error(message));
    }
    this.#pending.clear();
  }

  #send(
    method: string,
    params: Record<string, unknown> = {},
    sessionId?: string,
  ): Promise<CdpResult> {
    const id = this.#nextId++;
    return new Promise((resolve, reject) => {
      this.#pending.set(id, { resolve, reject });
      this.#socket.send(JSON.stringify({ id, method, params, sessionId }));
    });
  }

  async #evaluateIn(
    sessionId: string,
    contextId: number,
    expression: string,
  ): Promise<unknown> {
    const response = await this.#send(
      "Runtime.evaluate",
      {
        expression,
        contextId,
        awaitPromise: true,
        returnByValue: true,
      },
      sessionId,
    ) as {
      result?: { value?: unknown; description?: string };
      exceptionDetails?: {
        text?: string;
        exception?: { description?: string };
      };
    };
    if (response.exceptionDetails) {
      throw new Error(
        response.exceptionDetails.exception?.description ??
          response.exceptionDetails.text ?? "Guest evaluation failed.",
      );
    }
    return response.result?.value;
  }

  async evaluate<T>(expression: string): Promise<T> {
    return await this.#evaluateIn(
      this.#sessionId,
      this.#contextId,
      expression,
    ) as T;
  }

  async waitFor<T>(reader: string): Promise<T> {
    return await this.evaluate<T>(`new Promise((resolve, reject) => {
      const finish = (callback, value) => {
        observer.disconnect();
        clearTimeout(backstop);
        callback(value);
      };
      const check = () => {
        try {
          const value = (${reader})();
          if (value === false || value === null || value === undefined) return;
          finish(resolve, value);
        } catch (error) {
          finish(reject, error);
        }
      };
      const observer = new MutationObserver(() => check());
      const backstop = setTimeout(() => {
        finish(
          reject,
          new Error('Guest condition did not settle before the test backstop.'),
        );
      }, ${GUEST_WAIT_BACKSTOP_MS});
      observer.observe(document, {
        attributes: true,
        characterData: true,
        childList: true,
        subtree: true,
      });
      check();
    })`);
  }

  async click(selector: string): Promise<void> {
    await this.evaluate(`(() => {
      const control = document.querySelector(${JSON.stringify(selector)});
      if (!(control instanceof HTMLElement)) {
        throw new Error('Missing control: ' + ${JSON.stringify(selector)});
      }
      if ('disabled' in control && control.disabled) {
        throw new Error('Disabled control: ' + ${JSON.stringify(selector)});
      }
      control.click();
      return true;
    })()`);
  }

  async clickFirst(selector: string): Promise<string> {
    return await this.evaluate<string>(`(() => {
      const control = document.querySelector(${JSON.stringify(selector)});
      if (!(control instanceof HTMLButtonElement)) {
        throw new Error('Missing tile control: ' + ${JSON.stringify(selector)});
      }
      if (control.disabled) {
        throw new Error('Disabled tile control: ' + ${
      JSON.stringify(selector)
    });
      }
      control.click();
      return control.dataset.tileId ?? '';
    })()`);
  }

  async setValue(selector: string, value: string): Promise<void> {
    await this.evaluate(`(() => {
      const control = document.querySelector(${JSON.stringify(selector)});
      if (!(control instanceof HTMLInputElement ||
        control instanceof HTMLSelectElement)) {
        throw new Error('Missing editable control: ' + ${
      JSON.stringify(selector)
    });
      }
      control.value = ${JSON.stringify(value)};
      control.dispatchEvent(new Event('input', { bubbles: true }));
      control.dispatchEvent(new Event('change', { bubbles: true }));
      return true;
    })()`);
  }

  summary(): Promise<GuestSummary> {
    return this.evaluate<GuestSummary>(`(${guestSummaryReader()})()`);
  }

  close(): void {
    this.#rejectPending("Guest DOM driver closed.");
    this.#socket.close();
  }
}

async function waitForGuestFrame(page: Page): Promise<void> {
  await waitForCondition(
    page,
    (probe) =>
      probe.collect("common-iframe-sandbox").some((candidate) =>
        candidate.getAttribute("load-state") === "loaded"
      ),
  );
}

function readySummary(driver: GuestDomDriver): Promise<GuestSummary> {
  return driver.waitFor<GuestSummary>(guestSummaryReader("summary.ready"));
}

function waitForActionCount(
  driver: GuestDomDriver,
  count: number,
): Promise<GuestSummary> {
  return driver.waitFor<GuestSummary>(
    guestSummaryReader(`summary.ready && summary.actionCount >= ${count}`),
  );
}

function waitForTurn(
  driver: GuestDomDriver,
  turn: number,
): Promise<GuestSummary> {
  return driver.waitFor<GuestSummary>(
    guestSummaryReader(
      `summary.ready && summary.turn === ${JSON.stringify(String(turn))}`,
    ),
  );
}

function waitForEnabledButton(
  driver: GuestDomDriver,
  selector: string,
): Promise<boolean> {
  return driver.waitFor<boolean>(`() => {
    const control = document.querySelector(${JSON.stringify(selector)});
    return control instanceof HTMLButtonElement && !control.disabled;
  }`);
}

describe("iframe Firebreak Commons", () => {
  const aliceShell = new ShellIntegration();
  const bobShell = new ShellIntegration();
  const shells = [aliceShell, bobShell];
  shells.forEach((shell) => shell.bindLifecycle());

  let aliceIdentity: Identity;
  let bobIdentity: Identity;
  let spaceDid: DID;
  let cc: PiecesController;
  let pieceId: string;
  let resultSinkCancel: (() => void) | undefined;

  beforeAll(async () => {
    [aliceIdentity, bobIdentity] = await Promise.all([
      Identity.generate({ implementation: "noble" }),
      Identity.generate({ implementation: "noble" }),
    ]);
    spaceDid = await createTestSpace(aliceIdentity, {
      grants: { [bobIdentity.did()]: "WRITE" },
    });
    cc = await initializePiecesController({
      space: spaceDid,
      apiUrl: new URL(API_URL),
      identity: aliceIdentity,
    });
    await cc.ensureDefaultPattern();

    const sourcePath = join(
      import.meta.dirname!,
      "..",
      "iframe-firebreak-commons",
      "main.tsx",
    );
    const rootPath = join(import.meta.dirname!, "..");
    const program = await resolveLocalProgram(
      (resolver) => cc.runtime.harness.resolve(resolver),
      { main: sourcePath, root: rootPath },
    );
    const piece = await cc.create(program, { start: true });
    pieceId = piece.id;
    resultSinkCancel = cc.getResult(piece.getCell()).sink(() => {});
  });

  afterAll(async () => {
    resultSinkCancel?.();
    await cc?.dispose();
  });

  it("merges crew actions while isolating user preferences and local dispatch selections", async () => {
    const view = { spaceDid, pieceId };
    await Promise.all([
      aliceShell.goto({
        frontendUrl: FRONTEND_URL,
        view,
        identity: aliceIdentity,
      }),
      bobShell.goto({
        frontendUrl: FRONTEND_URL,
        view,
        identity: bobIdentity,
      }),
    ]);
    const pages = [aliceShell.page(), bobShell.page()];
    await Promise.all(pages.map((page) => waitForRuntimeIdle(page)));
    await Promise.all(pages.map((page) => waitForGuestFrame(page)));

    const [alice, bob] = await Promise.all([
      GuestDomDriver.connect(aliceShell.wsEndpoint()),
      GuestDomDriver.connect(bobShell.wsEndpoint()),
    ]);
    try {
      const initial = await Promise.all([
        readySummary(alice),
        readySummary(bob),
      ]);
      expect(initial.map((value) => value.turn)).toEqual(["1", "1"]);
      expect(initial.every((value) => value.hasCanvas)).toBe(true);

      await bob.click('[data-tool="firebreak"]');
      expect((await bob.summary()).selectedTool).toBe("firebreak");
      expect((await alice.summary()).selectedTool).toBe("water");

      await alice.setValue("#crew-name", "Cedar One");
      await alice.setValue("#crew-color", "blue");
      await alice.click("#save-profile");
      await alice.waitFor<string>(`() => {
        const status = document.querySelector('#sync-status')?.textContent ?? '';
        return status.includes('Ready · Cedar One') ? status : false;
      }`);
      expect((await alice.summary()).crewName).toBe("Cedar One");
      expect((await alice.summary()).crewColor).toBe("blue");
      expect((await bob.summary()).crewName).toBe("Commons crew");
      expect((await bob.summary()).crewColor).toBe("amber");

      const [waterTile, firebreakTile] = await Promise.all([
        alice.clickFirst('.mirror-tile[data-fire="true"]'),
        bob.clickFirst(
          '.mirror-tile[data-fire="false"][data-terrain="forest"], ' +
            '.mirror-tile[data-fire="false"][data-terrain="grass"]',
        ),
      ]);
      expect(waterTile).not.toBe("");
      expect(firebreakTile).not.toBe("");
      expect(firebreakTile).not.toBe(waterTile);

      await Promise.all([
        alice.click("#deploy"),
        bob.click("#deploy"),
      ]);
      const shared = await Promise.all([
        waitForActionCount(alice, 2),
        waitForActionCount(bob, 2),
      ]);
      for (const summary of shared) {
        expect(summary.actionText).toContain("sent water to");
        expect(summary.actionText).toContain("cut a firebreak at");
        expect(summary.actionText).not.toContain("Rejected");
      }

      await alice.setValue("#crew-name", "Unsaved lookout");
      await waitForEnabledButton(bob, "#advance");
      await bob.click("#advance");
      const advanced = await Promise.all([
        waitForTurn(alice, 2),
        waitForTurn(bob, 2),
      ]);
      expect(advanced.map((value) => value.turn)).toEqual(["2", "2"]);
      expect(advanced.every((value) => value.actionCount >= 3)).toBe(true);
      expect(advanced.every((value) => value.actionText.includes("advanced")))
        .toBe(true);
      expect(advanced[0].crewName).toBe("Unsaved lookout");
      expect(advanced[1].crewName).toBe("Commons crew");
    } finally {
      alice.close();
      bob.close();
    }
  });
});
