import { createCfHarnessHostFailure } from "./cli.ts";
import {
  createLoomLocalCfHarnessHost,
  runLoomLocalInteractiveFailureStdio,
} from "./loom-local-host.ts";
import { HarnessControlError } from "./control-errors.ts";

const writeStderr = (value: unknown): void => {
  Deno.stderr.writeSync(
    new TextEncoder().encode(`${JSON.stringify(value)}\n`),
  );
};

export const runLoomLocalCfHarnessHostMain = async (
  args: readonly string[] = Deno.args,
  env: Record<string, string | undefined> = Deno.env.toObject(),
): Promise<number> => {
  const mode = args[0];
  const forwarded = args[1] === "--" ? args.slice(2) : args.slice(1);
  if (mode !== "batch" && mode !== "interactive") {
    writeStderr(createCfHarnessHostFailure(
      new HarnessControlError(
        "invalid-request",
        "usage: loom-local-host-main.ts batch|interactive [--] [options]",
      ),
    ));
    return 1;
  }
  const harnessHome = env.CF_HARNESS_HOME;
  if (harnessHome === undefined) {
    const error = new HarnessControlError(
      "provider-configuration-required",
      "CF_HARNESS_HOME is required by the local Loom host",
    );
    if (mode === "interactive") {
      await runLoomLocalInteractiveFailureStdio(error);
    } else {
      writeStderr(createCfHarnessHostFailure(error));
    }
    return 1;
  }
  try {
    const host = await createLoomLocalCfHarnessHost({ harnessHome, env });
    if (mode === "batch") return await host.runBatch(forwarded);
    await host.runInteractive(forwarded);
    return 0;
  } catch (error) {
    if (mode === "interactive") {
      await runLoomLocalInteractiveFailureStdio(error);
    } else {
      writeStderr(createCfHarnessHostFailure(error));
    }
    return 1;
  }
};

if (import.meta.main) {
  Deno.exit(await runLoomLocalCfHarnessHostMain());
}
