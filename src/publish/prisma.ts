// PUB-03 / protocol 6.7: small PRISMA reasons. Exclusion reasons (stage1:*,
// stage2:*) under the floor merge into "other"; if "other" is still under the
// floor it merges into the nearest larger reason (the smallest reason at or over
// the floor, ties by key order). not-collectable:* details merge the same way
// into "not-collectable:other". Totals (screened, included, ...) pass through.
// Every family keeps its sum.

function mergeFamily(entries: [string, number][], otherKey: string, floor: number): [string, number][] {
  // An existing "other" joins the pool, so it is never written twice.
  const small = entries.filter(([k, v]) => v < floor || k === otherKey);
  if (small.length === 0) return entries;
  const large = entries.filter(([k, v]) => v >= floor && k !== otherKey);
  const other = small.reduce((s, [, v]) => s + v, 0);
  if (other === 0) return large;
  if (other >= floor || large.length === 0) return [...large, [otherKey, other]];
  const target = large.slice().sort(([ka, a], [kb, b]) => a - b || (ka < kb ? -1 : 1))[0]![0];
  return large.map(([k, v]) => [k, k === target ? v + other : v]);
}

export function mergeSmallReasons(reasons: Record<string, number>, floor = 10): Record<string, number> {
  const all = Object.entries(reasons);
  const excl = all.filter(([k]) => /^stage\d+:/.test(k) || k === "other");
  const nc = all.filter(([k]) => k.startsWith("not-collectable:"));
  const rest = all.filter(([k]) => !excl.some(([e]) => e === k) && !nc.some(([e]) => e === k));
  return Object.fromEntries([...rest, ...mergeFamily(excl, "other", floor), ...mergeFamily(nc, "not-collectable:other", floor)]);
}
