/**
 * A worker that asks for its thread's heap profile without ever starting
 * sampling, and posts back the error it gets, or `null` if it gets none.
 */

import { writeThreadHeapProfile } from "../../src/heap-profile.ts";

const directory = new URL(import.meta.url).searchParams.get("directory")!;
writeThreadHeapProfile(directory, "unstarted").then(
  () => self.postMessage(null),
  (error) => self.postMessage(String(error)),
);
