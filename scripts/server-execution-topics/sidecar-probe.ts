/**
 * Counts source resolution and compilation for distinct sidecar slots in real
 * runtimes. Each arm has fresh storage; cache counters are not wall-clock claims.
 */

import { expect } from "@std/expect";

import { Identity } from "@commonfabric/identity";
import {
  resolveEntryIdentity,
  Runtime,
  systemPatternSource,
} from "@commonfabric/runner";

import {
  openSidecarSurface,
  type SidecarSurfaceState,
} from "../../runtime/runner/src/builtins/wish.ts";
import { EmulatedStorageManager } from "../../runtime/runner/src/storage/v2-emulate.ts";

const signer = await Identity.fromPassphrase("sidecar campaign probe");
const second = await Identity.fromPassphrase("sidecar campaign second space");
const sourcePath = "/api/patterns/system/campaign-sidecar.tsx";
const contents = [
  "import { computed, pattern } from 'commonfabric';",
  "export default pattern<Record<string, never>, { marker: string }>(() => ({",
  "  marker: computed(() => 'sidecar campaign'),",
  "}));",
].join("\n");
const identity = await resolveEntryIdentity(
  sourcePath,
  (name) =>
    name === sourcePath
      ? Promise.resolve(contents)
      : Promise.reject(new Error(`Unexpected fixture file: ${name}`)),
);
const surface = {
  name: "campaign-sidecar.tsx",
  origin: systemPatternSource("system/campaign-sidecar.tsx"),
};

for (const enabled of [false, true]) {
  const manager = EmulatedStorageManager.emulate({ as: signer });
  const requests: { pathname: string; identity: boolean }[] = [];
  const runtime = new Runtime({
    apiUrl: new URL("http://toolshed.test"),
    storageManager: manager,
    experimental: { serverExecution: enabled },
    servingPosture: enabled,
    fetch: (input) => {
      const url = new URL(
        input instanceof Request ? input.url : String(input),
      );
      requests.push({
        pathname: url.pathname,
        identity: url.searchParams.has("identity"),
      });
      return Promise.resolve(
        url.pathname === sourcePath
          ? new Response(url.searchParams.has("identity") ? identity : contents)
          : new Response("not found", { status: 404 }),
      );
    },
  });
  const compile = runtime.patternManager.compilePattern.bind(
    runtime.patternManager,
  );
  let compilationCalls = 0;
  runtime.patternManager.compilePattern = (...args) => {
    compilationCalls += 1;
    return compile(...args);
  };
  const rows = [];
  try {
    for (
      const [index, space] of [
        signer.did(),
        signer.did(),
        signer.did(),
        second.did(),
      ].entries()
    ) {
      const slot: SidecarSurfaceState = {};
      const piece = runtime.getCell(space, `campaign-sidecar-${index}`);
      const before = { requests: requests.length, compilationCalls };
      const pattern = await openSidecarSurface(runtime, slot, piece, surface);
      expect(pattern).toBeDefined();
      expect(runtime.patternManager.getArtifactEntryRef(pattern!)?.identity)
        .toBe(identity);
      const after = { requests: requests.length, compilationCalls };
      expect(await openSidecarSurface(runtime, slot, piece, surface))
        .toBe(pattern);
      expect({ requests: requests.length, compilationCalls }).toEqual(after);
      await runtime.patternManager.flushCompileCacheWrites();
      expect(
        await runtime.patternManager.getPatternSourceProgramByIdentity(
          identity,
          space,
        ),
      ).toBeDefined();
      rows.push({
        index,
        space,
        requests: requests.slice(before.requests),
        compilationCalls: after.compilationCalls - before.compilationCalls,
        compileCache: runtime.patternManager.getCompileCacheStats(),
        repeatedSlotDidNoWork: true,
        durableSourceClosurePresent: true,
      });
    }
    console.log(JSON.stringify({ enabled, rows }));
  } finally {
    try {
      await runtime.sourceReconciler.idle();
      await runtime.patternManager.flushCompileCacheWrites();
    } finally {
      try {
        await runtime.dispose();
      } finally {
        await manager.close();
      }
    }
  }
}
