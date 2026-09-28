import type { Card } from '../engine/Card.js';
import { Deck } from '../engine/Deck.js';

/** Canonical starting-hand class, e.g. "AKs", "T9o", "77". */
export function handClass(a: Card, b: Card): string {
  const [hi, lo] = a.rank >= b.rank ? [a, b] : [b, a];
  if (hi.rank === lo.rank) return hi.rankChar + lo.rankChar;
  return hi.rankChar + lo.rankChar + (hi.suit === lo.suit ? 's' : 'o');
}

/** Bill Chen's formula — a quick, well-known preflop strength score (-1..20). */
export function chenScore(a: Card, b: Card): number {
  const [hi, lo] = a.rank >= b.rank ? [a, b] : [b, a];
  const base = (r: number) => (r === 14 ? 10 : r === 13 ? 8 : r === 12 ? 7 : r === 11 ? 6 : r / 2);

  if (hi.rank === lo.rank) return Math.max(5, base(hi.rank) * 2);

  let score = base(hi.rank);
  if (hi.suit === lo.suit) score += 2;
  const gap = hi.rank - lo.rank - 1;
  score -= gap === 0 ? 0 : gap === 1 ? 1 : gap === 2 ? 2 : gap === 3 ? 4 : 5;
  if (gap <= 1 && hi.rank < 12) score += 1;
  return Math.ceil(score);
}

/**
 * Percentile of every starting-hand class among all 1326 combos: 0.005 ≈ AA (top 0.5%),
 * 1.0 = the worst hand. "Top 20% range" = every class with percentile <= 0.2.
 */
const PERCENTILES: Map<string, number> = (() => {
  const classes = new Map<string, { score: number; combos: number }>();
  const all = Deck.fullSet();
  for (let i = 0; i < all.length; i++) {
    for (let j = i + 1; j < all.length; j++) {
      const a = all[i]!;
      const b = all[j]!;
      const key = handClass(a, b);
      // Chen score, tie-broken by high-card strength so the ordering is total.
      const score = chenScore(a, b) * 100 + Math.max(a.rank, b.rank) * 2 + Math.min(a.rank, b.rank) / 10;
      const entry = classes.get(key) ?? { score, combos: 0 };
      entry.combos++;
      classes.set(key, entry);
    }
  }
  const sorted = [...classes.entries()].sort((x, y) => y[1].score - x[1].score);
  const out = new Map<string, number>();
  let cumulative = 0;
  for (const [key, { combos }] of sorted) {
    cumulative += combos;
    out.set(key, cumulative / 1326);
  }
  return out;
})();

export function preflopPercentile(a: Card, b: Card): number {
  return PERCENTILES.get(handClass(a, b))!;
}

/** Compact grid-style listing of a range, strongest first (handy for debugging/tuning). */
export function describeRange(maxPercentile: number): string[] {
  return [...PERCENTILES.entries()].filter(([, p]) => p <= maxPercentile).map(([k]) => k);
}
