import { join } from "@std/path/posix/join";
// Use `posix` path utils specifically so that the path lib
// does not check `Deno?.build.os` for Windows, which will
// be true in the `deno-web-test` environment as `Deno.test`
// is shimmed, causing a fail to access `os` from `undefined`.
import { toFileUrl } from "@std/path/posix/to-file-url";

import { isDeno } from "@commonfabric/utils/env";

import { assets } from "./assets.ts";
import { generateETag } from "./etag.ts";

const FS_URL = (import.meta.dirname && isDeno())
  ? toFileUrl(join(import.meta.dirname, "assets"))
  : undefined;

/**
 * Represents a cached static asset with its content and ETag.
 */
export interface CachedAsset {
  /**
   * The asset's content. A `Blob` is immutable, so what a consumer reads from
   * it is always what the ETag was computed over, however long the asset
   * stays cached and however many consumers share it.
   */
  readonly blob: Blob;

  /** Strong ETag over the content. */
  readonly etag: string;
}

/**
 * The cache of static assets served from one base location, holding each
 * asset's content together with a strong ETag over that content. An asset is
 * read at most once per instance: under Deno it is read off the file system,
 * and elsewhere it is fetched over the network.
 */
export class StaticCache {
  #cache: Map<string, Promise<CachedAsset>> = new Map();
  #baseUrl: URL;

  /**
   * Constructs an instance which resolves asset names against `baseUrl`.
   */
  constructor(baseUrl: URL) {
    this.#baseUrl = baseUrl;
  }

  /**
   * Constructs an instance reading the assets bundled alongside this module,
   * which requires the file system and so is available only under Deno.
   */
  static fromFileSystem(): StaticCache {
    if (!FS_URL) {
      throw new Error(
        "`StaticCache.fromFileSystem()` is only available in Deno.",
      );
    }
    return new StaticCache(new URL(FS_URL));
  }

  /**
   * Gets the content of a static asset, without its ETag.
   */
  async get(assetName: string): Promise<Blob> {
    const cached = await this.getWithETag(assetName);
    return cached.blob;
  }

  /**
   * Gets a static asset's content together with the ETag a caller validates
   * it against.
   */
  getWithETag(assetName: string): Promise<CachedAsset> {
    const currentValue = this.#cache.get(assetName);
    if (currentValue) {
      return currentValue;
    }
    const promise = this.#requestWithETag(assetName);
    this.#cache.set(assetName, promise);
    return promise;
  }

  /**
   * Gets the content of a static asset, decoded as text.
   */
  async getText(assetName: string): Promise<string> {
    const blob = await this.get(assetName);
    return blob.text();
  }

  /**
   * Gets the location of a static asset, and throws when `assetName` is not
   * one this package ships.
   */
  getUrl(assetName: string): URL {
    if (!assets.includes(assetName)) {
      throw new Error(`No static asset "${assetName}" found.`);
    }

    const url = new URL(this.#baseUrl);
    url.pathname = join(url.pathname, assetName);
    return url;
  }

  /**
   * Helper for `getWithETag()`, which reads an asset and generates its ETag,
   * off the file system under Deno and over the network elsewhere.
   */
  async #requestWithETag(assetName: string): Promise<CachedAsset> {
    const url = this.getUrl(assetName);
    let bytes: Uint8Array<ArrayBuffer>;

    if (isDeno()) {
      // In Deno, use readFile rather than `fetch`, as
      // `fetch` doesn't seem to play well with included assets
      // in "compiled" builds
      bytes = await Deno.readFile(url);
    } else {
      const res = await fetch(url);
      if (!res.ok) {
        throw new Error(
          `Could not retrieve "${assetName}" at "${url.toString()}".`,
        );
      }
      bytes = new Uint8Array(await res.arrayBuffer());
    }

    const etag = await generateETag(bytes);

    // The `Blob` constructor copies, so the cached content is reachable only
    // through the `Blob`, which cannot be written to.
    return { blob: new Blob([bytes]), etag };
  }
}
