interface A {
  /** Name doc */
  name: string;
}

interface B {
  /** Name doc */
  name: string;

  /** Age */
  age: number;
}

type SchemaRoot = A & B;
