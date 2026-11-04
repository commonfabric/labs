// PATTERN TIER: fixture — scaffolding that pins a bug or drives the
// runtime. Do not copy from this file. Tiers: patterns/index.md
import {
  Cell,
  Default,
  handler,
  pattern,
  Stream,
  Writable,
} from "commonfabric";

export interface InboxItem {
  id: string;
  text: string;
}

interface InboxListInput {
  inboxItems: InboxItem[] | Default<[]>;
}

export interface InboxListOutput {
  inboxItems: InboxItem[];
  deleteHandlers: Stream<void>[];
}

const deleteWithWritableItem = handler<
  void,
  { inboxItems: Writable<InboxItem[]>; inboxItem: Writable<InboxItem> }
>((_event, { inboxItems, inboxItem }) => {
  const currentItems = inboxItems.get();
  const index = currentItems.findIndex((_item, itemIndex) =>
    inboxItems.key(itemIndex).equals(inboxItem)
  );

  if (index >= 0) {
    inboxItems.set(currentItems.toSpliced(index, 1));
  }
});

const deleteWithCellItem = handler<
  void,
  { inboxItems: Writable<InboxItem[]>; inboxItem: Cell<InboxItem> }
>((_event, { inboxItems, inboxItem }) => {
  const currentItems = inboxItems.get();
  const index = currentItems.findIndex((_item, itemIndex) =>
    inboxItems.key(itemIndex).equals(inboxItem)
  );

  if (index >= 0) {
    inboxItems.set(currentItems.toSpliced(index, 1));
  }
});

export const WritableInboxItemCapturePattern = pattern<
  InboxListInput,
  InboxListOutput
>(({ inboxItems }) => {
  return {
    inboxItems,
    deleteHandlers: inboxItems.map((inboxItem) =>
      deleteWithWritableItem({ inboxItems, inboxItem })
    ),
  };
});

export const CellInboxItemCapturePattern = pattern<
  InboxListInput,
  InboxListOutput
>(({ inboxItems }) => {
  return {
    inboxItems,
    deleteHandlers: inboxItems.map((inboxItem) =>
      deleteWithCellItem({ inboxItems, inboxItem })
    ),
  };
});
