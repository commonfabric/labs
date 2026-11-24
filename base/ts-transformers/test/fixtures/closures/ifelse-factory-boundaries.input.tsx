import { handler, ifElse, lift, pattern, UI, Writable } from "commonfabric";

const moduleHasSettings = lift(({ piece }: { piece: { settingsUI?: string } }) =>
  !!piece?.settingsUI
);

const selectMessage = handler<
  unknown,
  { selectedId: Writable<string>; msgId: string }
>((_event, { selectedId, msgId }) => {
  selectedId.set(msgId);
});

interface Entry {
  piece: { settingsUI?: string };
}

interface Message {
  id: string;
  type: "chat" | "system";
}

// FIXTURE: ifelse-factory-boundaries
// Verifies: authored ifElse keeps captured property access inside factory boundaries
//   moduleHasSettings({ piece: entry.piece }) → piece capture stays structural inside lift() call
//   selectMessage({ selectedId, msgId: msg.id }) → msg.id stays structural inside handler call branch
export default pattern<{ entries: Entry[]; messages: Message[] }>(
  ({ entries, messages }) => {
    const selectedId = new Writable("");

    return {
      [UI]: (
        <div>
          {entries.map((entry) =>
            ifElse(
              moduleHasSettings({ piece: entry.piece }),
              <span>settings</span>,
              null,
            )
          )}
          {messages.map((msg) =>
            ifElse(
              msg.type === "system",
              <span>{msg.id}</span>,
              <button
                type="button"
                onClick={selectMessage({ selectedId, msgId: msg.id })}
              >
                open
              </button>,
            )
          )}
        </div>
      ),
    };
  },
);
