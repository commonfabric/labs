import { assertEquals } from "@std/assert";
import { Identity } from "@commonfabric/identity";
import { StorageManager } from "../src/storage/cache.deno.ts";
import { Runtime } from "../src/runtime.ts";
import { compileAndRun } from "../src/builtins/compile-and-run.ts";
import type { IExtendedStorageTransaction } from "../src/storage/interface.ts";

Deno.test("compileAndRun initializes outputs and handles invalid programs", async () => {
  const identity = await Identity.fromPassphrase("compile and run coverage");
  const storageManager = StorageManager.emulate({ as: identity });
  const runtime = new Runtime({
    apiUrl: new URL(import.meta.url),
    storageManager,
  });
  const space = identity.did();
  const tx: IExtendedStorageTransaction = runtime.edit();

  try {
    const inputs = runtime.getCell<any>(
      space,
      "compile-and-run-inputs",
      undefined,
      tx,
    );
    const parent = runtime.getCell(
      space,
      "compile-and-run-parent",
      undefined,
      tx,
    );
    const cancels: Array<() => void> = [];
    let outputs: any;
    let sendResultCount = 0;
    const action = compileAndRun(
      inputs,
      (_tx, result) => {
        sendResultCount++;
        outputs = result;
      },
      (cancel) => cancels.push(cancel),
      { test: "compile-and-run" },
      parent,
      runtime,
    );

    inputs.set({ files: [], main: "" });
    action(tx);

    assertEquals(cancels.length, 1);
    assertEquals(sendResultCount, 1);
    assertEquals(outputs.pending.withTx(tx).get(), false);
    assertEquals(outputs.result.withTx(tx).get(), undefined);
    assertEquals(outputs.error.withTx(tx).get(), undefined);
    assertEquals(outputs.errors.withTx(tx).get(), undefined);

    action(tx);
    assertEquals(sendResultCount, 1);

    inputs.set({
      main: "/missing.tsx",
      files: [{ name: "/other.tsx", contents: "export default 1;" }],
    });
    action(tx);

    assertEquals(outputs.pending.withTx(tx).get(), false);
    assertEquals(
      outputs.error.withTx(tx).get(),
      '"/missing.tsx" not found in files',
    );

    await tx.commit().settled;
  } finally {
    await runtime.dispose();
    await storageManager.close();
  }
});

Deno.test("compileAndRun runs a program that reads an attached data file", async () => {
  const identity = await Identity.fromPassphrase("compile and run data file");
  const storageManager = StorageManager.emulate({ as: identity });
  const runtime = new Runtime({
    apiUrl: new URL(import.meta.url),
    storageManager,
  });
  const space = identity.did();
  const tx: IExtendedStorageTransaction = runtime.edit();

  try {
    const inputs = runtime.getCell<any>(
      space,
      "data-file-inputs",
      undefined,
      tx,
    );
    const parent = runtime.getCell(space, "data-file-parent", undefined, tx);
    const cancels: Array<() => void> = [];
    let outputs: any;
    const action = compileAndRun(
      inputs,
      (_tx, result) => {
        outputs = result;
      },
      (cancel) => cancels.push(cancel),
      { test: "compile-and-run-data-file" },
      parent,
      runtime,
    );

    // `dataFiles` names which of `files` carries data. Dropped anywhere between
    // here and the compile, the entry is still present with nothing saying it
    // is data, and the pattern is told at the read that it is not attached.
    inputs.set({
      main: "/main.tsx",
      files: [
        {
          name: "/main.tsx",
          contents: 'import { dataFile, pattern } from "commonfabric";\n' +
            "export default pattern(() => ({\n" +
            '  cities: JSON.parse(dataFile("/data/cities.json")).cities,\n' +
            "}));\n",
        },
        {
          name: "/data/cities.json",
          contents: '{ "cities": ["Oslo", "Lima"] }\n',
        },
      ],
      dataFiles: ["/data/cities.json"],
    });
    action(tx);
    await tx.commit().settled;

    // The compile runs outside the scheduler and writes what it produced when
    // it finishes, so wait on that write. Waiting on `pending` going false
    // instead would be satisfied by the value it already holds before the
    // compile starts.
    // The result cell is written before the pattern's own reactivity has filled
    // it in, so wait for the field the pattern derives from the data file
    // rather than for the object that will hold it.
    const written = Promise.withResolvers<void>();
    const waits = [
      outputs.result.sink((value: { cities?: unknown } | undefined) => {
        if (value?.cities !== undefined) written.resolve();
      }),
      outputs.error.sink((value: unknown) => {
        if (value !== undefined) written.resolve();
      }),
    ];
    await written.promise;
    for (const cancel of waits) cancel();
    await runtime.idle();

    assertEquals(outputs.error.get(), undefined);
    assertEquals(outputs.result.get(), { cities: ["Oslo", "Lima"] });
  } finally {
    await runtime.dispose();
    await storageManager.close();
  }
});
