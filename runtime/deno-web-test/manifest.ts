import * as path from "@std/path";

import { removeDirectory } from "@commonfabric/utils/remove-directory";

import { Config, getConfig } from "./config.ts";

// The name a run's directory carries. A directory a killed run leaves behind
// has nothing but its name to say what made it.
export const RUN_DIRECTORY_PREFIX = "deno-web-test-";

export class Manifest {
  readonly #projectDir: string;
  readonly #tests: string[];
  readonly #runDir: string;
  readonly #config: Config;

  constructor(
    projectDir: string,
    tests: string[],
    runDir: string,
    config: Config,
  ) {
    this.#projectDir = projectDir;
    this.#tests = tests;
    this.#runDir = runDir;
    this.#config = config;
  }

  /** The root directory path of the project being tested. */
  get projectDir(): string {
    return this.#projectDir;
  }

  /** An array of relative paths to tests from `projectDir`. */
  get tests(): string[] {
    return this.#tests;
  }

  /** The root directory path of the static server. */
  get serverDir(): string {
    return path.join(this.#runDir, "server");
  }

  /** The directory the browser keeps its profile in. */
  get profileDir(): string {
    return path.join(this.#runDir, "profile");
  }

  /**
   * The requested port the static server is being served on. If `0` (the
   * default), the actual listening port will be different.
   */
  get requestedPort(): number {
    return 0;
  }

  /** Configuration defined via `deno-web-test.config.ts`. */
  get config(): Config {
    return this.#config;
  }

  /**
   * Removes everything the run wrote, both directories above included. The
   * browser has to be closed and the static server stopped first, so that
   * nothing the run started is writing to either directory as it goes.
   */
  async remove(): Promise<void> {
    await removeDirectory(this.#runDir);
  }

  static async create(projectDir: string, tests: string[]): Promise<Manifest> {
    const config = await getConfig(projectDir);
    const manifest = new Manifest(
      projectDir,
      tests,
      await Deno.makeTempDir({ prefix: RUN_DIRECTORY_PREFIX }),
      config,
    );
    try {
      await Deno.mkdir(manifest.serverDir);
      await Deno.mkdir(manifest.profileDir);
    } catch (error) {
      // The temporary directory is already there, and nobody holds the
      // manifest to remove it with.
      await manifest.remove();
      throw error;
    }
    return manifest;
  }
}
