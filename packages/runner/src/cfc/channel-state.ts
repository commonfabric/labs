import { SERVER_EXECUTION_EFFECTS_DOC_ID } from "@commonfabric/memory/v2";

/**
 * Whether `id` names a document the runtime keeps as a channel's own state,
 * which that channel reads raw and decides entry by entry: the session effects
 * document, whose entries are a server's intents for this session, each
 * decided by the effects channel on the labels it carries (`chosenFrom`).
 *
 * The entries are written by an intent's own commit and carry no labels of
 * their own, so a reader's measure of them would admit what the channel
 * withholds. A host's read or render of such a document is therefore answered
 * as unreadable: by the reader's consumed measure
 * (`collectReaderConsumedLabel()`) and by the display fit's view of a cell's
 * own labels.
 */
export const isChannelStateDocument = (id: string): boolean =>
  id === SERVER_EXECUTION_EFFECTS_DOC_ID;
