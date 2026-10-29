import { REALM_FORMAT_VERSION, type RealmFormatMarker } from "./interface.ts";

/**
 * The marker at slot zero of an outer envelope, or `undefined` if what is
 * there is not one this build implements.
 *
 * The one place the envelope's shape is decided, and its own function so that
 * shape can be tested apart from the act that consults it.
 */
export function markerOf(data: unknown): RealmFormatMarker | undefined {
  if (!Array.isArray(data) || (data.length !== 2)) {
    return undefined;
  }

  const marker = data[0];

  return (Array.isArray(marker) && (marker.length === 1) &&
      (marker[0] === REALM_FORMAT_VERSION))
    ? marker as unknown as RealmFormatMarker
    : undefined;
}
