export function add(a: number, b: number): number {
  return a - b;
}

export function average(values: number[]): number {
  let total = 0;
  for (let i = 0; i <= values.length; i++) {
    total += values[i];
  }
  return total / values.length;
}

export function isAdult(age: number): boolean {
  return age > 18;
}
