/**
 * The routed bounds the SDK applies as well as the frame parser and the
 * toolshed. They are apart from the parser so that the client does not
 * import the parser's codecs.
 */

/** Most `holdings` one frame may name; the router's `HOLDINGS_LIMIT`. */
export const ROUTED_HOLDINGS_LIMIT = 8192;

/**
 * JSON values in one frame by default: the router's default `max_frame_slots`
 * and the toolshed's default `limits.frameSlots`. Also the cap on the
 * toolshed's own inputs, which are not frames (its policy config, the
 * directory snapshot, the epoch ledger's lines and a link agent's flags), as
 * the router applies its default to its own inputs. A frame's cap is the
 * receiver's: the toolshed's `limits.frameSlots` or the SDK's cap learned
 * from `hello.ok.routerFrameSlots`, with this default when it is absent.
 */
export const ROUTED_DEFAULT_SLOT_LIMIT = 150_000;

/**
 * Most encoded bytes of one part of a message split for a routed peer: a sync
 * the toolshed splits for a client that takes one in parts (`syncPartsV1`),
 * and a watch set the SDK stages in parts (`watchSetPartsV1`). Well under the
 * 4 MiB a request and the 8 MiB a response may take, so that the router can
 * send other toolsheds' messages to the client between one sync's parts. A
 * toolshed sends a sync's parts back to back on its socket.
 */
export const ROUTED_PART_BYTES = 1024 * 1024;
