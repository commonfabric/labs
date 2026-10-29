import {
  SandboxOptions,
  UserAgentOptions,
  WaitForOptions,
} from "@astral/astral";

import { removeDirectory } from "@commonfabric/utils/remove-directory";

import { astralBinaryPath } from "./astral-adapter.ts";
import { BrowserProcess } from "./browser-process.ts";
import { Page } from "./page.ts";
import { collectPatternCoverage } from "./pattern-coverage.ts";

const DEFAULT_ASTRAL_TIMEOUT = 60_000;

/**
 * The name a browser's profile directory carries. A directory left behind by a
 * process that was killed has nothing but its name to say what made it.
 */
export const PROFILE_DIRECTORY_PREFIX = "integration-browser-";

// Wrapper around `@astral/astral`'s `Browser`.
//
// Each browser keeps its profile in a temporary directory of its own, which
// `close()` removes after the browser exits and its output streams end. A
// browser nothing closes leaves that directory behind, so a caller holds one
// for as long as it holds the browser.
export class Browser {
  #process: BrowserProcess | null;
  #profileDir: string;
  #timeout: number;

  private constructor(
    process: BrowserProcess,
    profileDir: string,
    options: { timeout: number },
  ) {
    this.#process = process;
    this.#profileDir = profileDir;
    this.#timeout = options.timeout;
  }

  /**
   * Passes through to `@astral/astral`'s `Browser#newPage`, applying the
   * browser timeout.
   */
  async newPage(
    url?: string,
    options?: WaitForOptions & SandboxOptions & UserAgentOptions,
  ): Promise<Page> {
    this.#checkIsOk();
    const page = new Page(
      await this.#process!.newPage(url, options),
      { timeout: this.#timeout },
    );
    // The worker's pattern-coverage hits live in the page's realm and go with
    // the document. A page that booted no runtime hands over nothing here.
    page.addBeforeUnloadHook(() => collectPatternCoverage(page));
    return page;
  }

  /**
   * Returns the browser-level CDP websocket endpoint. Chrome supports multiple
   * concurrent CDP clients, so a second connection (e.g. for CPU profiling via
   * `cdp-profiler.ts`) can attach alongside Astral's.
   */
  wsEndpoint(): string {
    this.#checkIsOk();
    return this.#process!.wsEndpoint();
  }

  /**
   * Closes the browser and removes its profile directory.
   *
   * The removal follows the close rather than running beside it. Chrome
   * recreates the directory `--user-data-dir` names, every missing parent
   * included, whenever it writes into it, so a removal that overlapped one of
   * the processes the browser started would put the directory back.
   *
   * The browser is given up before the wait rather than after it, so that a
   * page opened while this is running is refused rather than opened on a
   * browser that is going away. A close that fails hands it back, so a caller
   * whose browser stopped but whose directory stayed can close again.
   */
  async close(): Promise<void> {
    this.#checkIsOk();
    const process = this.#process!;
    this.#process = null;
    try {
      await process.close();
      await removeDirectory(this.#profileDir);
    } catch (error) {
      this.#process = process;
      throw error;
    }
  }

  #checkIsOk() {
    if (!this.#process) {
      throw new Error("Browser is already closed.");
    }
  }

  static async launch(
    config?: { timeout?: number; headless?: boolean },
  ): Promise<Browser> {
    const headless = config?.headless ?? true;
    const timeout = config?.timeout ?? DEFAULT_ASTRAL_TIMEOUT;

    // The profile directory belongs to this browser and goes when it closes.
    // A launch naming none would reach the profile of the browser the
    // developer uses, and write into the directory that profile lives in.
    const profileDir = await Deno.makeTempDir({
      prefix: PROFILE_DIRECTORY_PREFIX,
    });
    try {
      const process = await BrowserProcess.start({
        args: [`--user-data-dir=${profileDir}`],
        headless,
        // `undefined` leaves the choice to astral, which is the answer when no
        // system browser is installed.
        path: astralBinaryPath(),
      });
      return new Browser(process, profileDir, { timeout });
    } catch (error) {
      // A failed launch completes its process and output cleanup, and hands
      // back no browser for anyone to close the directory with. The failure is
      // the diagnosis, so a removal that fails as well is carried alongside it
      // rather than in its place.
      try {
        await removeDirectory(profileDir);
      } catch (removalFailure) {
        throw new AggregateError(
          [error, removalFailure],
          `The browser did not launch, and ${profileDir} is still there.`,
        );
      }
      throw error;
    }
  }
}
