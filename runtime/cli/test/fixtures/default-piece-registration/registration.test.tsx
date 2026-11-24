import {
  action,
  assert,
  pattern,
  type Stream,
  TESTS,
  wish,
  Writable,
} from "commonfabric";

interface RegisteredPiece {
  title: string;
}

export default pattern(() => {
  const pieceRegistry = wish<Writable<RegisteredPiece[]>>({
    query: "#pieceRegistry",
  }).result!;
  const addPiece = wish<Stream<{ piece?: Writable<RegisteredPiece> }>>({
    query: "#default",
    path: ["addPiece"],
  }).result!;
  const registrationCount = wish<Writable<number>>({
    query: "#default",
    path: ["testPieceRegistrationCount"],
  }).result!;
  const piece = new Writable<RegisteredPiece>({
    title: "Registered through addPiece",
  });

  const sendMissingPiece = action(() => {
    addPiece.send({});
  });
  const registerPiece = action(() => addPiece.send({ piece }));

  const startsEmpty = assert(() =>
    pieceRegistry.get().length === 0 && registrationCount.get() === 0
  );
  const missingPieceIsIgnored = assert(() =>
    pieceRegistry.get().length === 0 && registrationCount.get() === 0
  );
  const pieceIsRegistered = assert(() =>
    pieceRegistry.get().length === 1 &&
    pieceRegistry.get()[0].title === "Registered through addPiece" &&
    registrationCount.get() === 1
  );

  return {
    [TESTS]: [
      { assertion: startsEmpty },
      { action: sendMissingPiece },
      { assertion: missingPieceIsIgnored },
      { action: registerPiece },
      { assertion: pieceIsRegistered },
    ],
  };
});
