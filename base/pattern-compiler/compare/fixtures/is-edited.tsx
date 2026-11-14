/// <cts-enable />
import { type Cell, computed, type Confidential, pattern } from "commonfabric";

// The message record of FabriChat, cut down to three fields, each with a
// label of its own so that the comparison shows which of them a label
// includes.
interface Message {
  body: Confidential<string, ["body"]>;
  sentAt: Confidential<number, ["sent"]>;
  editedAt?: Confidential<number, ["edited"]>;
}

interface Input {
  message: Cell<Message>;
}

export default pattern<Input>(({ message }) => {
  // The source of `isEdited` in `patterns/system/fabrichat/message-row.tsx`.
  const isEdited = computed(() => {
    const record = message.get();
    return record?.editedAt !== undefined && typeof record.body === "string";
  });
  return { isEdited };
});
