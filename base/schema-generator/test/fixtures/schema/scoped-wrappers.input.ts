interface SchemaRoot {
  userName: PerUser<string>;
  anyValue: PerAny<string>;
  userCell: PerUser<Cell<string>>;
  cellOfSession: Cell<PerSession<string>>;
  userCellOfSession: PerUser<Cell<PerSession<string>>>;
}
