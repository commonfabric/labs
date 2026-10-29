/**
 * The serving loop's worker entry (serving-loop-worker.md). Loading this
 * module in a Worker serves the worker's global scope as a port, with no
 * lifecycle verbs; `serving-worker-main.ts` has the rest. Nothing outside a
 * worker imports a value from here; `serving-worker-host.ts` starts one.
 */

import type { PortLike } from "./serving-port-protocol.ts";
import { serveFromPort } from "./serving-worker-main.ts";

serveFromPort(self as unknown as PortLike);
