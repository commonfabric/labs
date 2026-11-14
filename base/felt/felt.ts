import {
  blue,
  cyan,
  dim,
  green,
  red,
  stripAnsiCode,
  yellow,
} from "@std/fmt/colors";
import { copy } from "@std/fs";

import { Builder } from "./builder.ts";
import { DevServer } from "./dev-server.ts";
import { FeltCommand, ResolvedConfig } from "./interface.ts";

/** A running `serve` or `dev` server. */
export interface Serving {
  server: DevServer;
  /**
   * Settles once serving has stopped. For `serve`, that is when the server
   * shuts down. For `dev`, it is when the changes being watched end, which
   * shuts the server down.
   */
  finished: Promise<void>;
}

/**
 * Copies the public directory into the output directory and builds the
 * project. For `serve` and `dev`, then starts serving the output. In `dev`, the
 * served page reloads after each rebuild, and a rebuild follows each change
 * that `watch` reports under the watch directory.
 */
export async function felt(
  command: FeltCommand,
  config: ResolvedConfig,
  watch: (dir: string) => AsyncIterable<unknown> = Deno.watchFs,
): Promise<Serving | undefined> {
  const isDev = command === "dev";
  if (command !== "build") {
    for (const line of banner(config, isDev)) console.log(line);
  }

  await copy(config.publicDir, config.outDir, { overwrite: true });
  const builder = new Builder(config);
  await builder.build();

  if (command === "build") return undefined;

  const server = new DevServer({
    useReloadSocket: isDev,
    hostname: config.hostname,
    redirectToIndex: config.redirectToIndex,
    port: config.port,
    outDir: config.outDir,
    staticDirs: config.staticDirs,
  });
  if (!isDev) return { server, finished: server.finished };

  builder.addEventListener("build", () => server.reload());
  const finished = (async () => {
    try {
      await builder.watch(watch(config.watchDir));
    } finally {
      await server.shutdown();
    }
  })();
  return { server, finished };
}

const STYLED_TITLE = yellow("F") + dim("ront") + red("E") + dim("nd ") +
  green("L") + dim("ightweight ") + blue("T") + dim("ooling") + " 🚀 " +
  dim("(v0.0.1)");
const TITLE = stripAnsiCode(STYLED_TITLE);

/**
 * The lines of the box `serve` and `dev` print on starting, naming the server
 * address and the project's directories, and the watch directory when `watch`
 * is set.
 */
export function banner(config: ResolvedConfig, watch: boolean): string[] {
  const server = "  🌐 Server:   ";
  const url = `http://${config.hostname}:${config.port}`;
  const rows = [
    server + url,
    `  📂 Project:  ${config.cwd}`,
    `  📁 Public:   ${config.publicDir}`,
    ...(watch ? [`  👀 Watch:    ${config.watchDir}`] : []),
  ];
  const width = rows.reduce((max, text) => Math.max(max, text.length), 50) + 2;
  // A row of the box, padded by the length of `text`, printed as `styled`.
  const row = (text: string, styled = text) =>
    cyan("  ║") + styled + " ".repeat(width - text.length) + cyan("║");
  const indent = " ".repeat(Math.floor((width - TITLE.length) / 2));
  return [
    "",
    cyan("  ╔" + "═".repeat(width) + "╗"),
    row(indent + TITLE, indent + STYLED_TITLE),
    cyan("  ╠" + "═".repeat(width) + "╣"),
    row(""),
    row(rows[0], server + blue(url)),
    ...rows.slice(1).map((text) => row(text)),
    row(""),
    cyan("  ╚" + "═".repeat(width) + "╝"),
    "",
  ];
}
