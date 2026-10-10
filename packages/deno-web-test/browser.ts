import { ConsoleEvent, LaunchOptions, Page } from "@astral/astral";
import {
  BOOT_FAILURE_MESSAGE,
  BrowserProcess,
} from "@commonfabric/integration/browser-process";
import { sleep } from "@commonfabric/utils/sleep";

import {
  DRIVER_BINDING,
  parseCommand,
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
   * through `commands.ts`. The binding holds for every document the page
   * loads, so it is installed once, with the page.
   */
  async #serveCommands(page: Page) {
    const celestial = page.unsafelyGetCelestialBindings();
    celestial.addEventListener("Runtime.bindingCalled", (event) => {
      if (event.detail.name !== DRIVER_BINDING) {
        return;
      }
      void this.#runCommand(page, event.detail.payload);
    });
    await celestial.Runtime.addBinding({ name: DRIVER_BINDING });
  }

  /**
   * Helper for `#serveCommands`, which runs one command and settles it in the
   * page. A command that cannot be parsed or carried out fails the test that
   * sent it; one that cannot be settled, because its page is gone, is
   * reported on the console.
   */
  async #runCommand(page: Page, payload: string) {
    let id: number | undefined;
    let error: string | null = null;
    try {
      const command = parseCommand(payload);
      id = command.id;
      await page.keyboard.press(command.press);
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
    }
    if (id === undefined) {
      this.#reportCommandFailure(`A test sent a malformed command: ${error}`);
      return;
    }
    try {
      await page.evaluate(
        (name: string, settled: number, failure: string | null) =>
          Reflect.get(globalThis, name)(settled, failure),
        { args: [SETTLE_GLOBAL, id, error] },
      );
    } catch (e) {
      this.#reportCommandFailure(`Command ${id} could not be settled: ${e}`);
    }
  }

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
