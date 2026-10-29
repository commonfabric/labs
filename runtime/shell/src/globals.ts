import { type RuntimeClient } from "@commonfabric/runtime-client";

import type { ShellApp } from "./lib/app-state.ts";

/** Publishes the bootstrapped shell and notifies readiness listeners. */
export function publishShellApp(app: ShellApp): void {
  globalThis.app = app;
  globalThis.dispatchEvent(new Event("cf-shell-ready"));
}

declare global {
  var app: ShellApp;
  var commonfabric: {
    rt?: RuntimeClient;
    detectNonIdempotent?: (durationMs?: number) => Promise<unknown>;

    /** Changes memory-message compression for live and later connections. */
    setMemoryMessageCompression?: (enabled: boolean) => Promise<void>;

    watchWrites?: (
      options?:
        | {
          space?: string;
          did?: string;
          id?: string;
          path?: string[];
          match?: "exact" | "prefix";
          label?: string;
        }
        | {
          space?: string;
          did?: string;
          id?: string;
          path?: string[];
          match?: "exact" | "prefix";
          label?: string;
        }[],
    ) => Promise<unknown>;
    getWriteStackTrace?: () => Promise<unknown>;
    explainTriggerTrace?: (options?: {
      limit?: number;
      rootOnly?: boolean;
      includeCurrentValue?: boolean;
    }) => Promise<unknown>;
    forwardWorkerConsole?: (enabled?: boolean) => void;
    [key: string]: unknown;
  };
}
