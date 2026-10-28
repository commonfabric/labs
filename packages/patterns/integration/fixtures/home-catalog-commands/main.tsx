/** A social-space write that asks Home to register a supplied target. */
import { handler, pattern, Stream, wish, Writable } from "commonfabric";
import type { SharedSpaceRegistration } from "../../../system/shared-space-catalog.ts";
import type {
  SharedSpaceCollectionView,
  SharedSpaceCommands,
} from "../../../system/shared-space-interface.ts";

interface Input {
  commands: SharedSpaceCommands;
  messages: Writable<string[]>;
}

interface Event {
  message: string;
  registration: SharedSpaceRegistration;
}

export interface Output {
  messages: Writable<string[]>;
  send: Stream<Event>;
}

const send = handler<Event, Input>((event, { commands, messages }) => {
  messages.push(event.message);
  commands.register.send(event.registration);
});

export default pattern<Input, Output>((input) => ({
  messages: input.messages,
  send: send(input),
}));

/** A control whose bound state also materializes the private observation. */
interface ObservedInput extends Input {
  observation: SharedSpaceCollectionView;
}

const sendObserved = handler<Event, ObservedInput>(
  (event, { commands, messages, observation }) => {
    messages.push(`${event.message}: ${observation.status}`);
    commands.register.send(event.registration);
  },
);

export const ObservingConsumer = pattern<ObservedInput, Output>((input) => ({
  messages: input.messages,
  send: sendObserved(input),
}));

interface DiscoveredInput {
  messages: Writable<string[]>;
}

const sendDiscovered = handler<
  Event,
  { commands?: SharedSpaceCommands; messages: Writable<string[]> }
>((event, { commands, messages }) => {
  if (commands === undefined) {
    throw new Error("Home's collection commands are unavailable.");
  }
  messages.push(event.message);
  commands.register.send(event.registration);
});

/** Discovers the actor's Home command role through the ordinary Home root path. */
export const DiscoveredConsumer = pattern<DiscoveredInput, Output>((input) => {
  const found = wish<SharedSpaceCommands>({
    query: "#default/sharedSpaces/commands",
    scope: ["~"],
  });
  return {
    messages: input.messages,
    send: sendDiscovered({ messages: input.messages, commands: found.result }),
  };
});
