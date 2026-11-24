import { Console as RuntimeConsole } from "@commonfabric/runner";
import { createRuntime, serializeMainExport } from "../../lib/dev.ts";

const runtime = await createRuntime({ consoleToStderr: true });
try {
  const sandboxConsole = new RuntimeConsole(runtime.harness);
  const serialized = serializeMainExport({
    default: {
      toJSON() {
        sandboxConsole.log("check JSON serialized");
        Promise.resolve().then(() =>
          sandboxConsole.log("check JSON serialization deferred")
        );
        return 1;
      },
    },
  });
  await Promise.resolve();

  console.log(serialized);
} finally {
  await runtime.dispose();
}
