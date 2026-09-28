/**
 * The runtime worker these integration tests start: the real worker entry,
 * preceded by the lock that lets the test process wait for the worker to be
 * gone. See `../worker-exit-lock.ts`.
 */
import "./hold-worker-exit-lock.ts";
import "../../src/backends/web-worker/index.ts";
