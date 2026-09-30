/**
 * Writes the CLI's version and help output as JSON with renderer colors both
 * disabled and enabled. The parent test supplies the process's color environment.
 */

import { setColorEnabled } from "@std/fmt/colors";

import { main } from "../../commands/main.ts";

/** The rendered text inspected by the parent color tests. */
export interface ColorOutput {
  plainVersion: string;
  coloredVersion: string;
  plainHelp: string;
  coloredHelp: string;
  plainCellHelp: string;
}

setColorEnabled(false);
const plainVersion = main.getLongVersion();
setColorEnabled(true);
const coloredVersion = main.getLongVersion();

main.reset().help({ colors: false });
const plainHelp = main.getHelp();
const cell = main.getCommand("cell");
if (cell === undefined) throw new Error("The cf cell command is missing");
const plainCellHelp = cell.getHelp();
main.reset().help({ colors: true });
const coloredHelp = main.getHelp();

const output: ColorOutput = {
  plainVersion,
  coloredVersion,
  plainHelp,
  coloredHelp,
  plainCellHelp,
};
console.log(JSON.stringify(output));
