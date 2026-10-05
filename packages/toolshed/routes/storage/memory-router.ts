/** Private Mode A endpoint policy, enabled only by tracked deployment configuration. */
import { isCanonicalEd25519DID } from "@commonfabric/identity";
import {
  parseUnlistedPlacement,
  type UnlistedPlacement,
  unlistedToolshed,
} from "@commonfabric/memory/v2/routed-directory";
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

/** An Ed25519 `did:key`: the multicodec prefix and 32 bytes, base58btc. */
const ED25519_DID_SHAPE = /^did:key:z6Mk[1-9A-HJ-NP-Za-km-z]{44}$/;

/** Directory snapshot shared with the placement broker; no request supplies an address. */
export class MemoryRouterPolicy {
  readonly config: RouterConfig;
  #source: string | undefined;
  /** The directory file's identity, size and times when last read. */
  #stamp: string | undefined;
  /** Changes whenever ownership or availability changes. */
  #generation = 0;
  #available = true;
  #owners = new Map<string, number>();
  /** Every DID the directory lists, whichever toolshed it names. */
  #listed = new Set<string>();
  /** This toolshed's index in the directory. */
  #here = -1;
  #unlisted: UnlistedPlacement | undefined;
  /**
   * The `unlisted` rule and this toolshed's index as first read. Changing
   * either would move spaces the rule placed without their stores, so a
   * snapshot that does is unavailable until a restart, as a changed rule or
   * toolshed list is to the router. Toolsheds added after this one change
   * nothing here.
   */
  #topology: string | undefined;

  /** Loads the private endpoint's allowlist and validates the first directory snapshot. */
  constructor(path: string) {
    this.config = load(path);
    this.#refresh();
  }

  /**
   * Rereads the directory only when it may have changed. Ownership is checked
   * on every protected engine turn, so reading the whole file each time costs
   * the event loop O(spaces) per message. File timestamps advance in coarse
   * ticks, so two same-size writes within one tick share a stamp. A stamp is
   * therefore recorded only from a read made after the file had been unchanged
   * for a second; until then every call compares bytes, so a later write in
   * the same tick cannot hide behind a recorded stamp.
   */
  #refresh(): void {
    const info = Deno.statSync(this.config.directory);
    const stamp = [
      info.dev,
      info.ino,
      info.size,
      info.mtime?.getTime(),
      info.ctime?.getTime(),
    ].join(":");
    const settled = info.ctime !== null &&
      Date.now() - info.ctime.getTime() > 1000;
    if (stamp === this.#stamp) return;
    const source = Deno.readTextFileSync(this.config.directory);
    const recorded = settled ? stamp : undefined;
    if (source === this.#source) {
      this.#stamp = recorded;
      return;
    }
    const directory = routedObject(
      parseRoutedJson(source),
    );
    requireRouted(
      Object.keys(directory).every((key) =>
        ["version", "deployment", "toolsheds", "spaces", "unlisted"].includes(
          key,
        )
      ),
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
    const here = sheds.indexOf(identity.did());
    const unlisted = parseUnlistedPlacement(directory.unlisted, sheds.length);
    const topology = unlisted === undefined
      ? ""
      : `${here}|${unlisted.epoch}:${
        [...unlisted.lastCharacter.values()].join(",")
      }`;
    this.#topology ??= topology;
    requireRouted(topology === this.#topology);
    const spaces = Object.entries(routedObject(directory.spaces));
    requireRouted(spaces.length <= 10000);
    const owners = new Map<string, number>();
    const listed = new Set<string>();
    for (const [did, value] of spaces) {
      const placement = routedObject(value);
      // A DID validated in an earlier snapshot is still canonical, and
      // validating 10,000 again would empty the identity cache.
      requireRouted(
        (this.#listed.has(did) || isCanonicalEd25519DID(did)) &&
          Number.isSafeInteger(placement.toolshed) &&
          typeof placement.toolshed === "number" && placement.toolshed >= 0 &&
          placement.toolshed < sheds.length &&
          typeof placement.epoch === "number" &&
          Number.isSafeInteger(placement.epoch) && placement.epoch > 0,
      );
      listed.add(did);
      if (placement.toolshed === here) owners.set(did, placement.epoch);
    }
    // Placement changes for other toolsheds leave this one's contexts valid,
    // so only a change in its own ownership triggers the fence: a listed
    // placement here, or a DID the rule assigns here being listed or
    // unlisted. The rule and this index are fixed, so they assign the same.
    const claimed = (did: string) =>
      unlisted !== undefined && unlistedToolshed(unlisted, did) === here;
    const changed = owners.size !== this.#owners.size ||
      [...owners].some(([did, epoch]) => this.#owners.get(did) !== epoch) ||
      [...listed].some((did) => !this.#listed.has(did) && claimed(did)) ||
      [...this.#listed].some((did) => !listed.has(did) && claimed(did));
    this.#owners = owners;
    this.#listed = listed;
    this.#here = here;
    this.#unlisted = unlisted;
    this.#source = source;
    this.#stamp = recorded;
    if (changed || !this.#available) this.#generation++;
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

  /**
   * Changes whenever this toolshed's ownership or the snapshot's availability
   * changes; the private endpoint fences its contexts when it does.
   */
  get generation(): number {
    this.#current();
    return this.#generation;
  }

  /**
   * Synchronously fences an engine turn against the current owning epoch: a
   * listed space's own, or the `unlisted` rule's for a DID the directory does
   * not list. `space` must be a canonical DID, as the routed host validates
   * before asking; a caller that has not validated it uses `owns`.
   */
  ownership(space: string): number | undefined {
    this.#current();
    if (this.#listed.has(space) || this.#unlisted === undefined) {
      return this.#owners.get(space);
    }
    return unlistedToolshed(this.#unlisted, space) === this.#here
      ? this.#unlisted.epoch
      : undefined;
  }

  /**
   * Whether this toolshed owns `space`, which may be any string. A string
   * the rule places must have an Ed25519 `did:key`'s shape, so no other name,
   * such as an internal cell database's, opens as a space. That check needs
   * no point decompression, so it costs nothing per turn; `creates` checks
   * the point before a store is made.
   */
  owns(space: string): boolean {
    return this.ownership(space) !== undefined &&
      (this.#listed.has(space) || ED25519_DID_SHAPE.test(space));
  }

  /**
   * Whether a space with no store may be created here: only a canonical DID
   * the `unlisted` rule places here, since a listed space's store must
   * already be in place.
   */
  creates(space: string): boolean {
    return !this.#listed.has(space) && this.owns(space) &&
      isCanonicalEd25519DID(space);
  }

  /** Refreshes ownership; an unreadable or invalid snapshot owns nothing. */
  #current(): void {
    try {
      this.#refresh();
    } catch {
      this.#owners.clear();
      this.#listed.clear();
      this.#unlisted = undefined;
      this.#source = undefined;
      this.#stamp = undefined;
      if (this.#available) {
        this.#generation++;
        console.error(
          JSON.stringify({
            event: "memory-directory-unavailable",
            deployment: this.config.deployment,
          }),
        );
      }
      this.#available = false;
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
      // Contexts record the epoch they were admitted under, so they can only
      // fall out of date when the directory changes or becomes unavailable.
      let fenced = this.#generation;
      const fence = setInterval(() => {
        this.#current();
        if (this.#generation === fenced) return;
        fenced = this.#generation;
        host.fenceOwnership();
      }, 500);
      return {
        close: async () => {
          clearInterval(fence);
          try {
            await listener.close();
          } finally {
            epochs.close();
          }
        },
      };
    } catch (error) {
      host.close();
      epochs.close();
      throw error;
    }
  }
}
