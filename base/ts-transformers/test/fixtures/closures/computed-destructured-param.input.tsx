import { Writable, computed, pattern } from "commonfabric";

interface Point {
  x: number;
  y: number;
}

// FIXTURE: computed-destructured-param
// Verifies: a captured cell works alongside destructuring inside the computed body
//   computed(() => { const { x, y } = point.get(); ... }) → lift(...)({ point, multiplier })
// Context: `const { x, y } = point.get()` destructures inside the body, not a parameter
export default pattern(() => {
  const point = new Writable({ x: 10, y: 20 } as Point);
  const multiplier = new Writable(2);

  // Destructuring requires .get() first since the captured cell is not unwrapped
  const result = computed(() => {
    const { x, y } = point.get();
    return (x + y) * multiplier.get();
  });

  return result;
});
