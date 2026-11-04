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

export const sendProducerCommand = handler<
  void,
  { commands: Writable<CommandValue[]>; draft: Writable<string> }
>((_, { commands, draft }) => {
  commands.push(draft.get());
});

type ProducerCommandQueue = RepresentsCurrentUser<
  Cfc<
    WriteAuthorizedBy<CommandValue[], typeof sendProducerCommand>,
    { ownerPrincipal: CurrentPrincipal }
  >
>;

export interface ProducerInput {
  commands: Writable<CommandValue[]>;
}

export interface ProducerOutput {
  [NAME]: string;
  [UI]: VNode;
  commandQueue: ProducerCommandQueue;
  // The host reads this field's schema to learn which handler may write the
  // queue it binds for this piece. The field has no stored value.
  commandAuthorization?: WriteAuthorizedBy<
    boolean,
    typeof sendProducerCommand
  >;
}

export default pattern<ProducerInput, ProducerOutput>(({ commands }) => {
  const draft = new Writable.perSession("");
  return {
    [NAME]: "Command producer fixture",
    [UI]: (
      <cf-screen>
        <cf-textarea $value={draft} />
        <cf-button onClick={sendProducerCommand({ commands, draft })}>
          Send
        </cf-button>
      </cf-screen>
    ),
    commandQueue: commands,
  };
});
