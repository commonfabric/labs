import {
  assert,
  handler,
  pattern,
  Stream,
  TESTS,
  Writable,
} from "commonfabric";
import RenderPolicyDemo, { TrustedHealthDisclosureSurface } from "./main.tsx";

const trigger = handler<void, { stream: Stream<unknown> }>((_, { stream }) => {
  stream.send(undefined);
});

export default pattern(() => {
  const demo = RenderPolicyDemo({});
  const demoRevealSensitive: boolean = demo.revealSensitive;
  const revealSensitive = new Writable(false);
  const trustedDisclosure = TrustedHealthDisclosureSurface({
    content: new Writable("Sensitive health data") as never,
    revealSensitive,
  });

  const action_reveal = trigger({ stream: trustedDisclosure.reveal });
  const action_conceal = trigger({ stream: trustedDisclosure.conceal });
  const action_reveal_demo = trigger({ stream: demo.reveal });
  const action_conceal_demo = trigger({ stream: demo.conceal });

  const assert_initially_hidden = assert(() => revealSensitive.get() === false);
  const assert_revealed = assert(() => revealSensitive.get() === true);
  const assert_concealed = assert(() => revealSensitive.get() === false);
  const assert_demo_initially_hidden = assert(() =>
    demoRevealSensitive === false
  );
  const assert_demo_revealed = assert(() => demoRevealSensitive === true);
  const assert_demo_concealed = assert(() => demoRevealSensitive === false);

  return {
    [TESTS]: [
      { assertion: assert_initially_hidden },
      { action: action_reveal },
      { assertion: assert_revealed },
      { action: action_conceal },
      { assertion: assert_concealed },
      { assertion: assert_demo_initially_hidden },
      { action: action_reveal_demo },
      { assertion: assert_demo_revealed },
      { action: action_conceal_demo },
      { assertion: assert_demo_concealed },
    ],
    demo,
    trustedDisclosure,
  };
});
