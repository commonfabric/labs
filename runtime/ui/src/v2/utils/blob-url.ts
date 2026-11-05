import { isDID } from "@commonfabric/identity/did";
import type { RuntimeClient } from "@commonfabric/runtime-client";

/** A blob, by its space's DID and its id there, as a FabriFile entry names one. */
export interface BlobReference {
  space?: unknown;
  id?: unknown;
}

/**
 * Resolves a blob reference to the URL its space's host serves the blob at,
 * for one element, asking the runtime each time the reference changes and
 * keeping only the answer for the latest. The element shows `url` once it has
 * a value, and `requestUpdate()` is called on it when it gets one. A resolver
 * made for downloads resolves to the URL to save the blob from.
 */
export class BlobUrlResolver {
  #host: { requestUpdate(): void };
  #download: boolean;
  #request = 0;
  #url: string | null = null;

  /**
   * Constructs an instance which updates `host` as its URL arrives, resolving
   * to URLs to save blobs from when `options.download` is set.
   */
  constructor(
    host: { requestUpdate(): void },
    options: { download?: boolean } = {},
  ) {
    this.#host = host;
    this.#download = options.download === true;
  }

  /** The URL the latest reference resolved to, or `null` until it has. */
  get url(): string | null {
    return this.#url;
  }

  /**
   * Asks `runtime` for the URL `blob` is served at, forgetting the URL of the
   * reference before it. A reference that names no blob, or a runtime not
   * there yet, resolves to nothing, as does a URL the runtime cannot give.
   */
  resolve(runtime: RuntimeClient | undefined, blob: BlobReference | undefined) {
    const request = ++this.#request;
    this.#url = null;
    const space = blob?.space;
    const id = blob?.id;
    if (runtime === undefined || !isDID(space) || typeof id !== "string") {
      return;
    }
    runtime.blobUrl({
      space,
      id,
      ...(this.#download ? { download: true } : {}),
    }).then(
      (url) => {
        if (request !== this.#request) return;
        this.#url = url;
        this.#host.requestUpdate();
      },
      () => {
        // A blob whose URL can't be resolved is shown as none.
      },
    );
  }
}
