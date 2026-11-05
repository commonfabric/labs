/** Doc A */
type TypeA = {
  foo: string;
};

/** Doc B */
type TypeB = {
  bar: number;
};

type SchemaRoot = TypeA & TypeB;
