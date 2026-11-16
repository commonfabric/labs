import { ConsoleEvent, LaunchOptions, Page } from "@astral/astral";
import {
  BOOT_FAILURE_MESSAGE,
  BrowserProcess,
} from "@commonfabric/integration/browser-process";
import { sleep } from "@commonfabric/async/sleep";

import { DRIVER_BINDING, SETTLE_GLOBAL } from "./commands-protocol.ts";
import { DEFAULT_TEST_TIMEOUT_MS, extractAstralConfig } from "./config.ts";
import { runCommand } from "./driver-commands.ts";
import { TestResult } from "./interface.ts";
import { Manifest } from "./manifest.ts";
import { tsToJs } from "./utils.ts";

const LAUNCH_RETRY_ATTEMPTS = 5;
const LAUNCH_RETRYABLE_ETXTBSY = "Text file busy (os error 26)";

type LaunchFn = (options: LaunchOptions) => Promise<BrowserProcess>;
type SleepFn = (ms: number) => Promise<unknown>;

export function isRetryableAstralLaunchError(error: unknown): boolean {
  return String(error).includes(LAUNCH_RETRYABLE_ETXTBSY) ||
    error instanceof Error && error.message === BOOT_FAILURE_MESSAGE;
}

export async function launchWithRetry(
  options: LaunchOptions,
  launchImpl: LaunchFn = BrowserProcess.start,
  sleepImpl: SleepFn = sleep,
): Promise<BrowserProcess> {
  for (let attempt = 1;; attempt++) {
    try {
      return await launchImpl(options);
    } catch (error) {
      if (
        attempt === LAUNCH_RETRY_ATTEMPTS ||
        !isRetryableAstralLaunchError(error)
      ) {
        throw error;
      }
      await sleepImpl(250 * 2 ** (attempt - 1));
    }
  }
}

export class BrowserController extends EventTarget {
  #manifest: Manifest;
  #page: Page | null;
  #process: BrowserProcess | null;
  #serverPort: number;

  constructor(manifest: Manifest, serverPort: number) {
    super();
    this.#manifest = manifest;
    this.#process = null;
    this.#page = null;
    this.#serverPort = serverPort;
  }

  async load(filePath: string) {
    const rootUrl = `http://localhost:${this.#serverPort}`;
    const jsTestPath = tsToJs(filePath);
    const config = this.#manifest.config;
    const testTimeout = config.testTimeout ?? DEFAULT_TEST_TIMEOUT_MS;
    const testUrl =
      `${rootUrl}/?test=/${jsTestPath}&testTimeout=${testTimeout}`;

    if (this.#page) {
      await this.#page.goto(testUrl);
    } else {
      this.#process = await launchWithRetry(
        extractAstralConfig(config, this.#manifest.profileDir),
      );
      this.#page = await this.#process.newPage(testUrl);
      await this.#serveCommands(this.#page);
      this.#page.addEventListener("console", (e) => {
        // Not sure why this event needs reconstructed in order
        // to re-fire, rather than just passing it into `dispatchEvent`.
        this.dispatchEvent(
          new ConsoleEvent({
            type: e.detail.type,
            text: e.detail.text,
          }),
        );
      });
    }
    await this.#waitUntilReady(this.#page);
  }

  async getTestCount(): Promise<number> {
    if (!this.#page) {
      throw new Error("No page loaded.");
    }
    return (await this.#page.evaluate<{ ok: number }, []>(
      "globalThis.__denoWebTest.getTestCount()",
    )).ok;
  }

  /** Runs the loaded file's test at `index`, numbered as it registered. */
  async runTest(index: number): Promise<TestResult | null> {
    if (!this.#page) {
      throw new Error("No page loaded.");
    }

    return (await this.#page.evaluate<{ ok: TestResult | null }, []>(
      `globalThis.__denoWebTest.runAt(${index})`,
    )).ok;
  }

  /**
   * Helper for `load`, which carries out the commands tests in `page` send
   * through `commands.ts`, one at a time in the order they arrive. The binding
   * holds for every document the page loads, so it is installed once, with
   * the page.
   */
  async #serveCommands(page: Page) {
    const celestial = page.unsafelyGetCelestialBindings();
    let queue = Promise.resolve();
    celestial.addEventListener("Runtime.bindingCalled", (event) => {
      const { name, payload, executionContextId } = event.detail;
      if (name !== DRIVER_BINDING) {
        return;
      }
      queue = queue.then(() =>
        this.#runCommand(page, payload, executionContextId)
      );
    });
    await celestial.Runtime.addBinding({ name: DRIVER_BINDING });
  }

  /**
   * Helper for `#serveCommands`, which runs one command and settles it in the
   * document that sent it, `contextId`: a command that is refused or fails
   * rejects there, and so fails the test that sent it. A command with no id
   * cannot be settled, and one whose document is gone has no test left to
   * fail; either is reported on the console. It never rejects, so the
   * command queued after it always runs. A test that leaves its file
   * without awaiting a press can have that key land in the next file's
   * document.
   */
  async #runCommand(page: Page, payload: string, contextId: number) {
    const report = await runCommand(
      payload,
      page.keyboard,
      // Celestial resolves a CDP error response, here a document that is
      // gone, as `undefined` rather than rejecting, and its send throws once
      // the connection to the browser is closed.
      (id, error) =>
        page.unsafelyGetCelestialBindings().Runtime.callFunctionOn({
          functionDeclaration: `function (name, id, error) {
            globalThis[name](id, error);
          }`,
          executionContextId: contextId,
          arguments: [{ value: SETTLE_GLOBAL }, { value: id }, {
            value: error,
          }],
        }),
    );
    if (report !== undefined) {
      this.dispatchEvent(new ConsoleEvent({ type: "error", text: report }));
    }
  }

  /** Helper for `load`, which waits for `page` to load its test file. */
  async #waitUntilReady(page: Page) {
    const response = await page.evaluate<
      { ok: true; error?: undefined } | { error: string },
      []
    >("globalThis.__denoWebTest.whenReady()");
    if (response.error !== undefined) {
      throw new Error(response.error);
    }
  }

  async close() {
    this.#page = null;
    if (this.#process) {
      await this.#process.close();
    }
    this.#process = null;
  }
}
