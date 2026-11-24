// Runs in a worker the test page starts, which loads it by URL from the server
// root. Its specifier for `add` names a TypeScript module, which a browser
// cannot resolve, so this file runs there only if the runner bundled it.

import { add } from "./add.ts";

self.postMessage(add(1, 1));
