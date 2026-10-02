/** Private Mode A endpoint policy, enabled only by tracked deployment configuration. */
import { isCanonicalEd25519DID } from "@commonfabric/identity";
import { RoutedEpochStore } from "@commonfabric/memory/v2/routed-epochs";
import { RoutedMemoryHost } from "@commonfabric/memory/v2/routed-host";
import { listenRoutedMemory } from "@commonfabric/memory/v2/routed-listener";
import {
  parseRoutedJson,
  routedObject,
} from "@commonfabric/memory/v2/routed-parser";
import { requireRouted } from "@commonfabric/memory/v2/routed-wire";
import type { Server } from "@commonfabric/memory/v2/server";
import { identity } from "@/lib/identity.ts";

/** Exact private-listener inputs; key values live in the managed secret files. */
interface RouterConfig {
  deployment: string;
  hostname: string;
  port: number;
  certificate: string;
  key: string;
  directory: string;
  epochLedger: string;
  routers: Map<string, Set<string>>;
}

/** Canonical IPv4 private/loopback addresses, never a wildcard or DNS lookup. */
export function isPrivateMemoryAddress(value: unknown): value is string {
  if (typeof value !== "string" || !/^\d{1,3}(\.\d{1,3}){3}$/.test(value)) {
    return false;
  }
  const octets = value.split(".").map(Number);
  return octets.every((n) => n <= 255) && octets.join(".") === value &&
    (octets[0] === 10 || octets[0] === 127 ||
      (octets[0] === 172 && octets[1] >= 16 && octets[1] <= 31) ||
      (octets[0] === 192 && octets[1] === 168));
}

/** Denies malformed configuration before allocating a private listener. */
function load(path: string): RouterConfig {
  const value = routedObject(parseRoutedJson(Deno.readTextFileSync(path)));
  requireRouted(
    Object.keys(value).sort().join(",") ===
      "certificate,deployment,directory,epochLedger,hostname,key,port,routers,version",
  );
  requireRouted(
    value.version === 1 && Number.isSafeInteger(value.port) &&
      typeof value.port === "number" && value.port > 0 && value.port <= 65535,
  );
  for (
    const field of [
      "deployment",
      "hostname",
      "certificate",
      "key",
      "directory",
      "epochLedger",
    ]
  ) {
    requireRouted(
      typeof value[field] === "string" && value[field].length > 0 &&
        value[field].length <= 1024,
    );
  }
  requireRouted(
    typeof value.deployment === "string" &&
      /^[\x21-\x7e]{1,256}$/.test(value.deployment),
  );
  requireRouted(isPrivateMemoryAddress(value.hostname));
  const routers = new Map<string, Set<string>>();
  for (const [did, peers] of Object.entries(routedObject(value.routers))) {
    requireRouted(
      isCanonicalEd25519DID(did) && Array.isArray(peers) && peers.length > 0 &&
        peers.length <= 4 && peers.every(isPrivateMemoryAddress),
    );
    routers.set(did, new Set(peers as string[]));
  }
  requireRouted(routers.size > 0 && routers.size <= 16);
  return { ...value, routers } as unknown as RouterConfig;
}

/** Directory snapshot shared with the placement broker; no request supplies an address. */
export class MemoryRouterPolicy {
  readonly config: RouterConfig;
  #source: string | undefined;
  #available = true;
  #owners = new Map<string, number>();

  /** Loads the private endpoint's allowlist and validates the first directory snapshot. */
  constructor(path: string) {
    this.config = load(path);
    this.#refresh();
  }

  #refresh(): void {
    const source = Deno.readTextFileSync(this.config.directory);
    if (source === this.#source) return;
    const directory = routedObject(
      parseRoutedJson(source),
    );
    requireRouted(
      directory.version === 1 &&
        directory.deployment === this.config.deployment &&
        Array.isArray(directory.toolsheds) && directory.toolsheds.length > 0 &&
        directory.toolsheds.length <= 32,
    );
    const sheds = directory.toolsheds.map((entry) => {
      const shed = routedObject(entry);
      requireRouted(isCanonicalEd25519DID(shed.did));
      return shed.did;
    });
    requireRouted(sheds.filter((did) => did === identity.did()).length === 1);
    const spaces = Object.entries(routedObject(directory.spaces));
    requireRouted(spaces.length <= 10000);
    const owners = new Map<string, number>();
    for (const [did, value] of spaces) {
      const placement = routedObject(value);
      requireRouted(
        isCanonicalEd25519DID(did) &&
          Number.isSafeInteger(placement.toolshed) &&
          typeof placement.toolshed === "number" && placement.toolshed >= 0 &&
          placement.toolshed < sheds.length &&
          typeof placement.epoch === "number" &&
          Number.isSafeInteger(placement.epoch) && placement.epoch > 0,
      );
      if (sheds[placement.toolshed] === identity.did()) {
        owners.set(did, placement.epoch);
      }
    }
    this.#owners = owners;
    this.#source = source;
    if (!this.#available) {
      console.error(
        JSON.stringify({
          event: "memory-directory-available",
          deployment: this.config.deployment,
        }),
      );
    }
    this.#available = true;
  }

  /** Separates an unavailable authoritative snapshot from a known unowned DID. */
  get available(): boolean {
    return this.#available;
  }

  /** Synchronously fences an engine turn against the current owning epoch. */
  ownership(space: string): number | undefined {
    try {
      this.#refresh();
      return this.#owners.get(space);
    } catch {
      this.#owners.clear();
      this.#source = undefined;
      if (this.#available) {
        console.error(
          JSON.stringify({
            event: "memory-directory-unavailable",
            deployment: this.config.deployment,
          }),
        );
      }
      this.#available = false;
      return undefined;
    }
  }

  /** Starts only the private Memory link/data endpoints, with no HTTP routes. */
  async start(server: Server) {
    const c = this.config;
    const epochs = new RoutedEpochStore(c.epochLedger);
    const host = new RoutedMemoryHost({
      server,
      identity,
      deployment: c.deployment,
      epochs,
      routers: c.routers,
      ownership: (space) => this.ownership(space),
    });
    try {
      const listener = await listenRoutedMemory({
        host,
        hostname: c.hostname,
        port: c.port,
        certificate: Deno.readTextFileSync(c.certificate),
        key: Deno.readTextFileSync(c.key),
      });
      const fence = setInterval(() => host.fenceOwnership(), 500);
      return {
        close: async () => {
          clearInterval(fence);
          await listener.close();
          epochs.close();
        },
      };
    } catch (error) {
      host.close();
      epochs.close();
      throw error;
    }
  }
}
