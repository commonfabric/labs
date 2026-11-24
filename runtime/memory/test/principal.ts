import { Identity } from "@commonfabric/identity";

export const alice = await Identity.fromString(
  "MU+bzp2GaFQHso587iSFWPSeCzbSfn/CbNHEz7ilKRZ0=",
);

export const bob = await Identity.fromString(
  "MG4+QCX1b3a45IzQsQd4gFMMe0UB1UOx9bCsh8uOiKLE=",
);

export const mallory = await Identity.fromString(
  "MLR9AL2MYkMARuvmV3MJV8sKvbSOdBtpggFCW8K62oZA=",
);

export const space = await Identity.fromString(
  "MCl6B1cu1ZOP0I3BBovjAqo57VImrMVyfLiSmNKoddXs=",
);
