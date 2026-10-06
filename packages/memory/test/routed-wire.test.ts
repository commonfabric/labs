import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { Identity } from "@commonfabric/identity";
import { sha256 } from "@commonfabric/content-hash";
import {
  routedStatementPayload,
  RoutedWriter,
  verifyRoutedProof,
} from "../v2/routed-wire.ts";
const router = await Identity.fromRaw(new Uint8Array(32).fill(71));
const other = await Identity.fromRaw(new Uint8Array(32).fill(72));
const principal = await Identity.fromRaw(new Uint8Array(32).fill(73));
const epoch = new Uint8Array(16).fill(21),
  context = new Uint8Array(16).fill(22),
  value = new Uint8Array(32).fill(23);
const now = 1_800_000_000, deployment = "auth-boundary-probe";
const options = { router: router.did(), deployment, epoch, context, now };
async function proof(
  {
    iat = now,
    exp = now + 600,
    issued = now,
    expires = now + 60,
    received = now,
    receiptPrincipal = principal.did(),
  } = {},
) {
  const statement = await routedStatementPayload({
    principal: principal.did(),
    router: router.did(),
    deployment,
    challenge: value,
    iat,
    exp,
  }).sign(principal);
  const challenge = await new RoutedWriter("mrc1").text(deployment).text(
    router.did(),
  ).fixed(epoch).fixed(context).fixed(value).time(issued).time(expires).sign(
    router,
  );
  const receipt = await new RoutedWriter("mrr1").fixed(sha256(challenge)).text(
    receiptPrincipal,
  ).fixed(sha256(statement)).time(received).sign(router);
  return { statement, challenge, receipt };
}
const good = await proof(), variant = await proof({ exp: now + 599 });
const cases = [
  ["valid", good, options, true],
  ["differentRouter", good, { ...options, router: other.did() }, false],
  [
    "differentEpoch",
    good,
    { ...options, epoch: new Uint8Array(16).fill(24) },
    false,
  ],
  ["differentContext", good, {
    ...options,
    context: new Uint8Array(16).fill(25),
  }, false],
  ["differentDeployment", good, { ...options, deployment: "another" }, false],
  ["expiredLease", good, { ...options, now: now + 600 }, false],
  ["leaseOverOneHour", await proof({ exp: now + 3601 }), options, false],
  ["receiptAtChallengeExpiry", await proof({ received: now + 60 }), {
    ...options,
    now: now + 60,
  }, false],
  [
    "challengeOverOneMinute",
    await proof({ expires: now + 61 }),
    options,
    false,
  ],
  [
    "validSignatureButDifferentExactStatement",
    { ...good, statement: variant.statement },
    options,
    false,
  ],
  [
    "receiptPrincipalMismatch",
    await proof({ receiptPrincipal: other.did() }),
    options,
    false,
  ],
  [
    "positiveSkewFullHourExceedsReceiptBound",
    await proof({ iat: now + 1, exp: now + 3601 }),
    options,
    false,
  ],
  [
    "positiveSkewCappedToReceiptHour",
    await proof({ iat: now + 1, exp: now + 3600 }),
    options,
    true,
  ],
];
describe("routed wire proof authority", () => {
  for (const [name, p, o, expected] of cases) {
    it(String(name), async () => {
      let accepted = false;
      try {
        await verifyRoutedProof(
          p as Awaited<ReturnType<typeof proof>>,
          o as typeof options,
        );
        accepted = true;
      } catch { /* Expected admission denial. */ }
      expect(accepted).toBe(expected);
    });
  }
});
