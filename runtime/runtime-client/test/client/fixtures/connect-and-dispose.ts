/**
 * Connects a real runtime worker, disposes of it, and exits. The process ends
 * as soon as `dispose()` settles, so any coverage profile the worker has not
 * yet written by then is lost or truncated.
 */

import { WebWorkerRuntimeTransport } from "../../../src/client/transports/web-worker/transport-web-worker.ts";

const transport = await WebWorkerRuntimeTransport.connect();
await transport.dispose();
