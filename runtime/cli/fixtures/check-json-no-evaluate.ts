function evaluated(): number {
  console.log("check JSON evaluated");
  Promise.resolve().then(() => console.log("check JSON deferred"));
  return 1;
}

export default evaluated();
