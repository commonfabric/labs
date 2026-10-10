import { isDID } from "@commonfabric/identity/did";

import { type Cell } from "../cell.ts";
import { type FabricUrlTarget, parseFabricUrl } from "../fabric-url.ts";
import { getMetaLink } from "../link-utils.ts";
import { type Runtime } from "../runtime.ts";
import { type Action } from "../scheduler.ts";
import type { URI } from "../sigil-types.ts";
import { slugIdForSpace } from "../slugs.ts";
import {
  enrollRuntimeOwnedStore,
  recordRuntimeOwnedStore,
} from "./runtime-owned-store.ts";
import type {
  IExtendedStorageTransaction,
  MemorySpace,
} from "../storage/interface.ts";

/**
 * cellFromUrl({ url, hosts, spaceHost }) — the cell a URL names, if it names
 * one. `spaceHost` supplies the toolshed origin for an explicitly named space.
 *
 * A URL that names no cell resolves with no `cell`. That is an answer, not a
 * failure: most URLs are web pages, and a caller asking this question expects
 * to be told no.
 *
 * **Why this is a builtin.** Every part of the question is on its way to being
 * asynchronous. Deciding whether an unfamiliar host is a fabric host will mean
 * probing it, and turning a space name into a DID is a cached derivation today
 * and a lookup later. Only reading the string apart and hashing a slug stay
 * synchronous. Callers get the `{ pending, … }` shape every other builtin has,
 * so none of them changes when the work behind it grows.
 *
 * A URL naming a space by a legacy name resolves through
 * `Runtime.resolveLegacySpaceName`. The first time this runtime meets a name,
 * the result stays pending until the derivation finishes, and the action runs
 * again then.
 */
export function cellFromUrl(
  inputsCell: Cell<{
    url: string;
    hosts?: string[];
    spaceHost?: string;
    writable?: boolean;
  }>,
  sendResult: (tx: IExtendedStorageTransaction, result: any) => void,
  _addCancel: (cancel: () => void) => void,
  cause: Cell<any>[],
  parentCell: Cell<any>,
  runtime: Runtime,
): Action {
  return (tx: IExtendedStorageTransaction) => {
    const pending = runtime.getCell<boolean>(
      parentCell.space,
      { cellFromUrl: { pending: cause } },
      undefined,
      tx,
    );
    const cell = runtime.getCell<unknown>(
      parentCell.space,
      { cellFromUrl: { cell: cause } },
      undefined,
      tx,
    );
    // Both stores are keyed on this node's cause and outlive the transaction
    // that mints them, so each is named and enrolled the way every other
    // builtin's state store is. The mint stays as it was: these two carry no
    // instance scope, and `ownedCell` would address them at one.
    for (const store of [pending, cell]) {
      recordRuntimeOwnedStore(tx, parentCell, store);
      enrollRuntimeOwnedStore(tx, parentCell, store);
    }
    sendResult(tx, { pending, cell });

    const inputs = inputsCell.withTx(tx);
    const spaceHost = inputs.key("spaceHost").get();
    const target = targetOf(inputsCell, tx);

    const space = resolveSpace(runtime, parentCell.space, target?.space);
    if (target?.space !== undefined && space === undefined) {
      // Pending until the name is derived; clearing the flag then is the
      // write that runs this action again. A derivation that finishes after
      // the input has stopped naming its name leaves the flag alone, since
      // whatever the input names now is still unanswered.
      const pendingWithTx = pending.withTx(tx);
      if (pendingWithTx.get() !== true) pendingWithTx.set(true);
      const name = target.space;
      runtime.trackAsyncWork(
        runtime.resolveLegacySpaceName(name).then(
          () =>
            runtime.editWithRetry((retryTx) => {
              if (targetOf(inputsCell, retryTx)?.space !== name) return;
              pending.withTx(retryTx).set(false);
            }),
          (error) =>
            console.error("cellFromUrl: deriving a space name:", error),
        ),
        parentCell,
      );
      return;
    }
    const routed = target?.space === undefined || typeof spaceHost !== "string"
      ? true
      : space !== undefined && routeSpace(runtime, space, spaceHost);
    if (routed === "unresolved") {
      // The host names another deployment whose memory host this runtime has
      // not read yet. Pending until the read is done; the action runs again
      // when the flag clears, and finds the host resolved. A read that
      // finishes after the input has stopped naming this host leaves the flag
      // alone, as the name derivation above does.
      const pendingWithTx = pending.withTx(tx);
      if (pendingWithTx.get() !== true) pendingWithTx.set(true);
      // `routeSpace` answers "unresolved" only for a named space and a string
      // host, which is what the assertions below restate.
      runtime.trackAsyncWork(
        runtime.resolveSpaceHost(space!, spaceHost as string).then(
          () =>
            runtime.editWithRetry((retryTx) => {
              if (
                inputsCell.withTx(retryTx).key("spaceHost").get() !== spaceHost
              ) return;
              pending.withTx(retryTx).set(false);
            }),
          (error) =>
            console.error("cellFromUrl: resolving a space host:", error),
        ),
        parentCell,
      );
      return;
    }
    const id = target && space && routed ? entityUri(space, target) : undefined;

    const cellWithTx = cell.withTx(tx);
    if (id === undefined) {
      // The SLOT, not what it points at: reading through a stored link to an
      // empty cell returns `undefined`, and a guard on that would leave the
      // previous URL's link in place after the input stopped naming anything.
      if (cellWithTx.getRaw() !== undefined) cellWithTx.set(undefined);
    } else {
      const root = runtime.getCellFromLink(
        {
          id,
          space,
          path: [],
          scope: target!.scope ?? "space",
        },
        undefined,
        tx,
      );
      const argument = target!.member === "argument"
        ? getMetaLink(root, "argument", {})
        : undefined;
      const selected = target!.member === "argument"
        ? argument && runtime.getCellFromLink(argument, undefined, tx)
        : root;
      const targetCell = selected?.key(...target!.path);
      if (targetCell) {
        cellWithTx.setRawUntyped(targetCell.getAsLink({ base: cell }));
      } else if (cellWithTx.getRaw() !== undefined) {
        cellWithTx.set(undefined);
      }
    }

    const pendingWithTx = pending.withTx(tx);
    if (pendingWithTx.get() !== false) pendingWithTx.set(false);
  };
}

/** The address the builtin's `url` input names, read within `tx`. */
function targetOf(
  inputsCell: Cell<{ url: string; hosts?: string[] }>,
  tx: IExtendedStorageTransaction,
): FabricUrlTarget | undefined {
  const inputs = inputsCell.withTx(tx);
  const url = inputs.key("url").get();
  const hosts = inputs.key("hosts").get();
  return typeof url === "string"
    ? parseFabricUrl(url, { hosts: Array.isArray(hosts) ? hosts : undefined })
    : undefined;
}

/**
 * Applies an explicit route without overriding a route the runtime already
 * fixed. A storage manager without remote routing can still confirm its own
 * default origin, which keeps local and emulated runtimes useful. Under a
 * memory URL, a host naming another deployment is `"unresolved"` until the
 * runtime has read where that deployment serves Memory
 * (`Runtime.resolveSpaceHost`); the action waits for that read.
 */
function routeSpace(
  runtime: Runtime,
  space: MemorySpace,
  host: string,
): boolean | "unresolved" {
  let requested: string;
  try {
    requested = new URL(host).origin;
    const registration = runtime.registerSpaceHostDetailed(space, host);
    if (registration.accepted) return true;
    if (registration.reason === "foreign-host-unresolved") return "unresolved";
  } catch {
    return false;
  }
  const effective = runtime.mappedHostFor(space) ?? runtime.apiUrl.toString();
  return new URL(effective).origin === requested;
}

/**
 * The space a target names, as a DID. A target naming none is in the space
 * doing the asking, which is what an unqualified URL means.
 */
function resolveSpace(
  runtime: Runtime,
  ownSpace: MemorySpace,
  named: string | undefined,
): MemorySpace | undefined {
  if (named === undefined) return ownSpace;
  return isDID(named) ? named : runtime.legacySpaceDidSync(named);
}

/**
 * The URI of the cell a target addresses. A slug addresses the redirect
 * document that names the piece rather than the piece itself, which is why
 * hashing it is enough: reads follow the redirect.
 */
function entityUri(
  space: MemorySpace,
  target: { id?: string; slug?: string },
): URI | undefined {
  if (target.id !== undefined) return target.id as URI;
  if (target.slug === undefined) return undefined;
  return `of:${slugIdForSpace(space, target.slug)}` as URI;
}
