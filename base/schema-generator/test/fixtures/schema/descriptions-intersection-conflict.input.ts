interface C {
  /** First name doc */
  name: string;
}

interface D {
  /** Second name doc */
  name: string;
}

type SchemaRoot = C & D;
