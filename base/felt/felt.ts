import { blue, cyan, dim, green, red, yellow } from "@std/fmt/colors";
import { copy } from "@std/fs";

import { Builder } from "./builder.ts";
import { DevServer } from "./dev-server.ts";
import { FeltCommand, ResolvedConfig } from "./interface.ts";

export class Felt {
  constructor(
    public command: FeltCommand,
    public config: ResolvedConfig,
  ) {}

  async process() {
    const { port, redirectToIndex, hostname, watchDir, publicDir, outDir } =
      this.config;
    const isBuild = this.command === "build";
    const isServe = this.command === "serve";
    const isDev = this.command === "dev";

    if (isServe || isDev) {
      // Calculate the maximum width needed for the box
      const lines = [
        `  🌐 Server:   http://${hostname}:${port}`,
        `  📂 Project:  ${this.config.cwd}`,
        `  📁 Public:   ${this.config.publicDir}`,
      ];
      if (isDev) {
        lines.push(`  👀 Watch:    ${watchDir}`);
      }

      // Find the longest line to determine box width (minimum 50 for the header)
      const maxLineLength = lines.reduce(
        (longest, line) => Math.max(longest, line.length),
        50,
      );
      const boxWidth = maxLineLength + 4; // +4 for padding on both sides

      console.log();
      console.log(cyan("  ╔" + "═".repeat(boxWidth - 2) + "╗"));

      // Header with colored FELT letters
      const headerPrefix = " ".repeat(3);
      const headerSuffix = " ".repeat(3);
      const headerContent = headerPrefix +
        yellow("F") + dim("ront") + red("E") + dim("nd ") +
        green("L") + dim("ightweight ") +
        blue("T") + dim("ooling") + " 🚀 " + dim("(v0.0.1)") +
        headerSuffix;

      // Calculate padding for centered header
      const headerVisualLength = headerPrefix.length +
        "Frontend Lightweight Tooling 🚀 (v0.0.1)".length + headerSuffix.length;
      const headerPadding = Math.floor((boxWidth - 2 - headerVisualLength) / 2);
      const headerRightPad = boxWidth - 2 - headerPadding - headerVisualLength;

      console.log(
        cyan("  ║") + " ".repeat(headerPadding) + headerContent +
          " ".repeat(headerRightPad) + cyan("║"),
      );

      console.log(cyan("  ╠" + "═".repeat(boxWidth - 2) + "╣"));
      console.log(cyan("  ║" + " ".repeat(boxWidth - 2) + "║"));

      // Server line
      const serverLine = `  🌐 Server:   ${blue(`http://${hostname}:${port}`)}`;
      const serverVisualLength =
        `  🌐 Server:   http://${hostname}:${port}`.length;
      const serverPadding = boxWidth - 2 - serverVisualLength;
      console.log(
        cyan("  ║") + serverLine + " ".repeat(serverPadding) + cyan("║"),
      );

      // Project line
      const projectLine = `  📂 Project:  ${this.config.cwd}`;
      console.log(
        cyan("  ║") + projectLine +
          " ".repeat(boxWidth - 2 - projectLine.length) + cyan("║"),
      );

      // Public line
      const publicLine = `  📁 Public:   ${this.config.publicDir}`;
      console.log(
        cyan("  ║") + publicLine +
          " ".repeat(boxWidth - 2 - publicLine.length) + cyan("║"),
      );

      // Watch line (only in dev mode)
      if (isDev) {
        const watchLine = `  👀 Watch:    ${watchDir}`;
        console.log(
          cyan("  ║") + watchLine +
            " ".repeat(boxWidth - 2 - watchLine.length) + cyan("║"),
        );
      }

      console.log(cyan("  ║" + " ".repeat(boxWidth - 2) + "║"));
      console.log(cyan("  ╚" + "═".repeat(boxWidth - 2) + "╝"));
      console.log();
    }

    await copy(publicDir, outDir, { overwrite: true });

    const builder = new Builder(this.config);
    await builder.build();

    if (isBuild) {
      return;
    }

    let server: DevServer;
    try {
      server = new DevServer({
        useReloadSocket: isDev,
        hostname,
        redirectToIndex,
        port,
        outDir,
        staticDirs: this.config.staticDirs,
      });
    } catch (error) {
      if (error instanceof Deno.errors.AddrInUse) {
        // Reported only when the actual bind fails. Exit code 3 matches the
        // dev-server scripts so a port collision can be retried elsewhere.
        console.error(`Port ${port} is already in use`);
        Deno.exit(3);
      }
      throw error;
    }

    if (isDev) {
      builder.addEventListener("build", (_) => {
        server.reload();
      });
      await builder.watch(watchDir);
    }
  }
}
