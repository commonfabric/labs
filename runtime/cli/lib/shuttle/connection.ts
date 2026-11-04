/**
 * The one connection a shuttle process holds: a `PiecesController` opened
 * once and served to every read and write for the rest of the run. Who holds
 * the controller, for how long, and who closes it are all decisions a
 * long-lived process has to make, and this module is where they are made.
 *
 * The connect sequence belongs to `loadPieces` (`lib/piece.ts`),
 * which this module calls. What it adds is two memos, whose retry policies
 * are opposites. A construction is not held when it fails, so a later ask
 * opens again; that covers the connection that never opened, and a connection
 * that opens and then drops is outside it entirely, since nothing here
 * observes a drop, retries one, or reports one. A disposal is held whatever
 * it does, so a close that fails is terminal and the holder serves nothing
 * after it.
 */

import type { PiecesController } from "@commonfabric/piece/ops";

import { loadPieces, type SpaceConfig } from "../piece.ts";
import { escapeControlCharacters } from "./place.ts";
import type { RecordEntry } from "./record.ts";

/**
 * The connection half of the ambient record: what one shuttle process
 * connects as, fixed for its whole run.
 */
export interface ConnectionRecord {
  /** The deployment to connect to. */
  readonly apiUrl: string;

  /** The space to open, as a `did:key:` DID or as a space name. */
  readonly space: string;

  /** The identity to act as, as the path to its PKCS#8 key file. */
  readonly identity: string;
}

/**
 * The connection's dimensions of the ambient record, as `where` prints them
 * (`record.ts`).
 *
 * The space prints as the process was launched with it, which is a name where
 * a name was given. That is not what the position dimension prints: a place
 * holds the DID the session settled the name on, and both are worth seeing —
 * one is what a person typed and the other is what it denotes.
 *
 * All three are escaped, because all three arrive from a launch flag or the
 * environment behind it rather than through a door: no place reads them, so
 * nothing has refused a character a terminal acts on before they are printed.
 * The glyph is what a message gets, this being prose somebody reads — the
 * prompt's convention, for the one destination it has. What a rendering
 * carries to a second one is B4's to settle
 * (`docs/plans/shuttle/build-sequence.md`).
 */
export function connectionEntries(
  record: ConnectionRecord,
): readonly RecordEntry[] {
  return [
    { label: "api", value: escapeControlCharacters(record.apiUrl) },
    { label: "identity", value: escapeControlCharacters(record.identity) },
    { label: "space", value: escapeControlCharacters(record.space) },
  ];
}

/** Opens a connection over `config` and returns the controller on it. */
export type ConnectionOpener = (
  config: SpaceConfig,
) => Promise<PiecesController>;

/**
 * Where a {@link HeldConnection} gets its controller, and with it who closes
 * it: a connection opened here is closed here, and one opened elsewhere is
 * closed by whoever opened it. Ownership is a property of the source, so it
 * holds whatever opener sits under either arm.
 */
export type ConnectionSource =
  /** Opened here, from `record`, and closed here. */
  | {
    /** Names this arm of {@link ConnectionSource}. */
    readonly kind: "owned";

    /** What to connect as. */
    readonly record: ConnectionRecord;

    /** What opens it; `loadPieces` where the source names none. */
    readonly open?: ConnectionOpener;
  }
  /** Already open, and closed by whoever opened it. */
  | {
    /** Names this arm of {@link ConnectionSource}. */
    readonly kind: "borrowed";

    /** The controller to serve. */
    readonly pieces: PiecesController;
  };

/**
 * Helper for {@link HeldConnection}, which returns the {@link SpaceConfig}
 * `record` denotes: the record's three dimensions, and nothing else the
 * config admits.
 */
function spaceConfigFor(record: ConnectionRecord): SpaceConfig {
  return {
    apiUrl: record.apiUrl,
    space: record.space,
    identity: record.identity,
  };
}

/**
 * The holder of a shuttle process's connection. It opens one on the first
 * ask, hands that same one to every ask after, and on disposal closes
 * whatever it opened.
 *
 * Per instance rather than per process, because a module-global holder would
 * be module-global mutable state (`docs/development/DEVELOPMENT.md`, "Avoid
 * Singletons"). How many connections one process may hold at a time is a
 * different question, settled in `docs/plans/shuttle/runtime-integration.md`
 * rather than here.
 */
export class HeldConnection implements AsyncDisposable {
  #open: () => Promise<PiecesController>;
  #owned: boolean;
  #pieces: Promise<PiecesController> | undefined;
  #disposal: Promise<void> | undefined;

  /**
   * Constructs an instance serving the connection `source` names. An owned
   * source is opened on the first ask; a borrowed one is open already.
   */
  constructor(source: ConnectionSource) {
    if (source.kind === "borrowed") {
      this.#open = () => Promise.resolve(source.pieces);
      this.#owned = false;
    } else {
      const open = source.open ?? loadPieces;
      const config = spaceConfigFor(source.record);
      this.#open = () => open(config);
      this.#owned = true;
    }
  }

  /**
   * The connection, opened on the first ask and shared by every ask after.
   * An ask made while a construction is in flight joins that construction
   * rather than starting a second one.
   *
   * A rejected construction is not held: the rejection reaches every caller
   * awaiting that attempt, and the next ask opens again rather than replaying
   * a terminal failure for the rest of the run. That covers the connection
   * that never opened, which is the whole of what it covers.
   *
   * Throws once a disposal has begun — which refuses a call made from
   * inside the connection's own close, and not only one made after that
   * close finished — and throws where every other failure here rejects:
   * asking a disposed holder is a mistake in the caller rather than a
   * connection that would not open, and the two are worth telling apart at
   * the call. A caller that wants them together catches around the call and
   * not only on the promise.
   */
  pieces(): Promise<PiecesController> {
    if (this.#disposal !== undefined) {
      throw new Error("This connection is disposed.");
    }
    if (this.#pieces === undefined) {
      const attempt: Promise<PiecesController> = Promise.resolve()
        .then(this.#open)
        .catch((error) => {
          // Only while this attempt is still the held one, so unholding a
          // failure can never take a later, live connection with it. Nothing
          // reaches the other branch as things stand: an ask starts an
          // attempt only where nothing is held, and only a failure unholds.
          if (this.#pieces === attempt) this.#pieces = undefined;
          throw error;
        });
      this.#pieces = attempt;
    }
    return this.#pieces;
  }

  /**
   * Closes the connection this instance opened, and refuses to serve one
   * afterwards. Every call returns the one disposal, so a second neither
   * closes twice nor reports done while the first is still closing, and a
   * close that failed reports the same failure to each of them.
   *
   * A close that fails is terminal. The disposal stays rejected, so every
   * later call reports that same failure, nothing retries the close, and
   * this instance serves nothing again — over a connection that may be
   * part-way torn down. That is the bound on it: what suits a disposal which
   * is process shutdown does not suit one a run carries on past.
   *
   * A construction still in flight is awaited and its connection closed, so
   * that a disposal crossing a connect strands nothing; the ask that started
   * it still resolves with that connection. `loadPieces` takes no signal to
   * stop on, so what it opens exists whether or not anyone is still waiting
   * for it, and closing it is the only thing that can be done about it.
   *
   * A connection this instance was handed is left open: it is the caller's to
   * close, and closing it would take down a socket still in use. Where no ask
   * opened one there is nothing to close, and a construction that rejected
   * handed this instance no controller either, so its rejection is neither
   * closed nor re-raised here.
   */
  dispose(): Promise<void> {
    this.#disposal ??= this.#disposeOnce();
    return this.#disposal;
  }

  /** @inheritDoc */
  async [Symbol.asyncDispose](): Promise<void> {
    await this.dispose();
  }

  /**
   * Helper for {@link HeldConnection.dispose}, which does the closing that
   * every call to it shares. Nothing before its first `await` runs code a
   * caller supplied: two `#private` field reads, which no getter can
   * intercept, and `catch` on a native promise. So the window before
   * `dispose()` holds what this returns cannot be re-entered, rather than
   * merely happening not to be — and an `async` function never throws
   * synchronously, so that hold always happens, which is what lets
   * `dispose()` memoize the result rather than set a flag ahead of the
   * call.
   */
  async #disposeOnce(): Promise<void> {
    const held = this.#pieces;
    if (!this.#owned || held === undefined) return;
    const pieces = await held.catch(() => undefined);
    await pieces?.dispose();
  }
}
