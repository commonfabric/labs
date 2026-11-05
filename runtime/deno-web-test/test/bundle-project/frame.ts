// Runs in a sandboxed iframe the test page creates. Such a frame has an opaque
// origin, so its module script is fetched cross-origin, which is what makes
// this the case that needs the server to answer with CORS headers.

import { add } from "./add.ts";

parent.postMessage(add(2, 2), "*");
