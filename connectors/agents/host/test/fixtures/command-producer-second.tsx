import {
  Cfc,
  CurrentPrincipal,
  handler,
  NAME,
  pattern,
  RepresentsCurrentUser,
  UI,
  type VNode,
  Writable,
  WriteAuthorizedBy,
} from "commonfabric";

/** A JSON-encoded connector command. */
type CommandValue = string;

export const sendSecondCommand = handler<
  void,
  { commands: Writable<CommandValue[]>; draft: Writable<string> }
>((_, { commands, draft }) => {
  commands.push(draft.get());
});

type SecondCommandQueue = RepresentsCurrentUser<
  Cfc<
    WriteAuthorizedBy<CommandValue[], typeof sendSecondCommand>,
    { ownerPrincipal: CurrentPrincipal }
  >
>;

export interface SecondInput {
  commands: Writable<CommandValue[]>;
}

export interface SecondOutput {
  [NAME]: string;
  [UI]: VNode;
  commandQueue: SecondCommandQueue;
  commandAuthorization?: WriteAuthorizedBy<boolean, typeof sendSecondCommand>;
}

/** A second producer with a writer of its own, for isolation between queues. */
export default pattern<SecondInput, SecondOutput>(({ commands }) => {
  const draft = new Writable.perSession("");
  return {
    [NAME]: "Second command producer fixture",
    [UI]: (
      <cf-screen>
        <cf-textarea $value={draft} />
        <cf-button onClick={sendSecondCommand({ commands, draft })}>
          Send
        </cf-button>
      </cf-screen>
    ),
    commandQueue: commands,
  };
});
