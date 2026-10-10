import { ConsoleEvent, LaunchOptions, Page } from "@astral/astral";
import {
  BOOT_FAILURE_MESSAGE,
  BrowserProcess,
} from "@commonfabric/integration/browser-process";
import { backtickQuote } from "@commonfabric/utils/markdown";
import { sleep } from "@commonfabric/utils/sleep";

import {
  commandId,
  DRIVER_BINDING,
  pressOn,
  readKeyPress,
  SETTLE_GLOBAL,
} from "./commands-protocol.ts";
import { DEFAULT_TEST_TIMEOUT_MS, extractAstralConfig } from "./config.ts";
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
  for (let attempt = 1; attempt <= LAUNCH_RETRY_ATTEMPTS; attempt++) {
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
  throw new Error("unreachable");
}

export class BrowserController extends EventTarget {
  static readonly #HARNESS_READY_TIMEOUT_MS = 10_000;
  static readonly #HARNESS_READY_POLL_MS = 200;
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
    await this.#waitUntilReady();
  }

  async getTestCount(): Promise<number> {
    if (!this.#page) {
      throw new Error("No page loaded.");
    }
    return (await this.#page.evaluate(() =>
      // @ts-ignore This is defined in the JS harness
      globalThis.__denoWebTest.getTestCount()
    ))
      .ok;
  }

  /** Runs the loaded file's test at `index`, numbered as it registered. */
  async runTest(index: number): Promise<TestResult | void> {
    if (!this.#page) {
      throw new Error("No page loaded.");
    }

    return (await this.#page.evaluate((at: number) =>
      // @ts-ignore This is defined in the JS harness
      globalThis.__denoWebTest.runAt(at), { args: [index] })).ok;
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
   * fail; either is reported on the console. A test that leaves its file
   * without awaiting a press can have that key land in the next file's
   * document.
   */
  async #runCommand(page: Page, payload: string, contextId: number) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(payload);
    } catch {
      // `commandId` reports the payload below.
    }
    const id = commandId(parsed);
    if (id === undefined || typeof parsed !== "object" || parsed === null) {
      this.#reportCommandFailure(
        `A test sent a command with no id: ${backtickQuote(payload)}`,
      );
      return;
    }
    let error: string | null = null;
    try {
      await pressOn(page.keyboard, readKeyPress(parsed));
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
    }
    const settled = await page.unsafelyGetCelestialBindings().Runtime
      .callFunctionOn({
        functionDeclaration: `function (name, id, error) {
          globalThis[name](id, error);
        }`,
        executionContextId: contextId,
        arguments: [{ value: SETTLE_GLOBAL }, { value: id }, { value: error }],
      });
    // Celestial resolves a CDP error response, here a document that is gone,
    // as `undefined` rather than rejecting.
    if (settled === undefined) {
      this.#reportCommandFailure(
        `Command ${id} could not be settled: the document that sent it is gone`,
      );
    } else if (settled.exceptionDetails) {
      const { exception, text } = settled.exceptionDetails;
      this.#reportCommandFailure(
        `Command ${id} could not be settled: ${exception?.description ?? text}`,
      );
    }
  }

  /** Helper for `#runCommand`, which reports `text` on the console. */
  #reportCommandFailure(text: string) {
    this.dispatchEvent(new ConsoleEvent({ type: "error", text }));
  }

  async #waitUntilReady() {
    if (!this.#page) {
      throw new Error("No page loaded.");
    }
    const attempts = Math.ceil(
      BrowserController.#HARNESS_READY_TIMEOUT_MS /
        BrowserController.#HARNESS_READY_POLL_MS,
    );
    for (let i = 0; i < attempts; i++) {
      const response = await this.#page.evaluate(() =>
        // @ts-ignore This is defined in the JS harness
        globalThis.__denoWebTest && globalThis.__denoWebTest.isReady()
      );
      if (response.ok) {
        return;
      }
      if (response.error) {
        throw new Error(response.error?.message ?? response.error);
      }
      await sleep(BrowserController.#HARNESS_READY_POLL_MS);
    }
    throw new Error(
      `Test harness not ready in ${BrowserController.#HARNESS_READY_TIMEOUT_MS}ms.`,
    );
  }

  async close() {
    this.#page = null;
    if (this.#process) {
      await this.#process.close();
    }
    this.#process = null;
  }
}
