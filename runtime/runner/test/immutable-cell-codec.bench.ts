/**
 * Measures immutable value addressing at the codec boundary. Fresh graphs keep
 * creation costs visible; repeated reads measure reuse of a single address.
 * Fixture construction is outside the timed region.
 */

import { deepFreeze } from "@commonfabric/data-model";
import {
  dataUriFromValue,
  valueFromDataUri,
} from "@commonfabric/data-model/codec-data-uri";

import { ImmutableCellStore } from "../src/immutable-cell.ts";

for (const size of [1, 100, 1000]) {
  const makeValue = () =>
    deepFreeze(Array.from({ length: size }, (_, index) => ({
      index,
      title: `Immutable cell ${index}: café 🌍`,
      values: [index, undefined, -0, Infinity],
    })));
  const value = makeValue();
  const uri = dataUriFromValue(value);
  const store = new ImmutableCellStore();
  const snapshot = store.create(value);

  Deno.bench({
    name: `fresh create and read / ${size} rows`,
    fn(b) {
      const fresh = makeValue();
      b.start();
      valueFromDataUri(dataUriFromValue(fresh));
      b.end();
    },
  });
  Deno.bench({
    name: `native fresh create and read / ${size} rows`,
    fn(b) {
      const fresh = makeValue();
      const freshStore = new ImmutableCellStore();
      b.start();
      const created = freshStore.create(fresh);
      freshStore.get(created.id);
      b.end();
      freshStore.dispose();
    },
  });
  Deno.bench(`native repeated create / ${size} rows`, () => {
    store.create(value);
  });
  Deno.bench(`native repeated read / ${size} rows`, () => {
    store.get(snapshot.id);
  });
  Deno.bench(`repeated create / ${size} rows`, () => {
    dataUriFromValue(value);
  });
  Deno.bench(`repeated read / ${size} rows`, () => {
    valueFromDataUri(uri);
  });
}
