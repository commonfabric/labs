// Prints the environment `createClearedHostProcessEnv()` builds, as JSON, so
// a test can run it in a process whose env permission it chooses.
import { createClearedHostProcessEnv } from "../../src/tools/host-process-env.ts";

console.log(JSON.stringify(createClearedHostProcessEnv()));
