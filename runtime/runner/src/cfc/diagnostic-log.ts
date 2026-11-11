/**
 * Measurement only. When `CFC_DIAGNOSTIC_LOG` names a directory, every CFC
 * diagnostic a transaction notes, and every runtime-owned-store marker the
 * runtime records, is appended to `<dir>/<pid>.log`, one line each, headed by
 * the process's arguments so a line can be attributed to the `cf test` file
 * that produced it. Off unless the variable is set; a no-op outside Deno or
 * without the permissions to read the environment and write the file. Nothing
 * reads the file at run time, and no enforcement decision depends on it.
 */

const logDir: string | undefined = (() => {
  try {
    return typeof Deno !== "undefined" && typeof Deno.env?.get === "function"
      ? Deno.env.get("CFC_DIAGNOSTIC_LOG") || undefined
      : undefined;
  } catch {
    return undefined;
  }
})();

let headerWritten = false;

export function appendCfcDiagnosticLog(line: string): void {
  if (logDir === undefined) return;
  try {
    const file = `${logDir}/${Deno.pid}.log`;
    if (!headerWritten) {
      headerWritten = true;
      Deno.writeTextFileSync(file, `# args: ${Deno.args.join(" ")}\n`, {
        append: true,
      });
    }
    Deno.writeTextFileSync(file, line.replaceAll("\n", " ") + "\n", {
      append: true,
    });
  } catch {
    // measurement only
  }
}
