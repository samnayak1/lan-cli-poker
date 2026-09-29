import type { Card } from '../engine/Card.js';
import { Deck } from '../engine/Deck.js';

/*
 * Preflop hand strength.
 *
 * There are 1326 possible two-card starting hands, but only 169 that play differently:
 * a pair ("77"), or two ranks that are suited ("AKs") or offsuit ("AKo").
 * We score each of those with the Chen formula, sort them strongest first, and turn the
 * ranking into a percentile, so the bots can talk about ranges like "the top 20% of hands".
 */

const TOTAL_COMBOS = 1326;

/** Two cards ordered as [higher rank, lower rank]. */
function byRank(first: Card, second: Card): [Card, Card] {
  return first.rank >= second.rank ? [first, second] : [second, first];
}

/** The 169-way class of a starting hand, e.g. "AKs", "T9o", "77". */
export function handClass(first: Card, second: Card): string {
  const [high, low] = byRank(first, second);
  const ranks = high.rankChar + low.rankChar;
  if (high.rank === low.rank) return ranks;
  return ranks + (high.suit === low.suit ? 's' : 'o');
}

// ── The Chen formula ─────────────────────────────────────────────────────

/** Points for the higher card: A 10, K 8, Q 7, J 6, anything else half its rank. */
function highCardPoints(rank: number): number {
  const faceCardPoints: Record<number, number> = { 14: 10, 13: 8, 12: 7, 11: 6 };
  return faceCardPoints[rank] ?? rank / 2;
}

/** Points taken off for the ranks between the two cards (0 gap = connectors like 9-8). */
function gapPenalty(gap: number): number {
  const penalties = [0, 1, 2, 4];
  return penalties[gap] ?? 5;
}

/**
 * Bill Chen's quick preflop score (roughly -1 to 20). Higher is better:
 *   1. Start with points for the higher card.
 *   2. Pairs double that (at least 5).
 *   3. Suited cards get +2 (they can make flushes).
 *   4. Subtract for the gap between the ranks (they make fewer straights).
 *   5. Small connected cards get +1 (their straights are easier to hit).
 */
export function chenScore(first: Card, second: Card): number {
  const [high, low] = byRank(first, second);

  const isPair = high.rank === low.rank;
  if (isPair) return Math.max(5, highCardPoints(high.rank) * 2);

  let score = highCardPoints(high.rank);

  const suited = high.suit === low.suit;
  if (suited) score += 2;

  const gap = high.rank - low.rank - 1;
  score -= gapPenalty(gap);

  const smallAndConnected = gap <= 1 && high.rank < 12;
  if (smallAndConnected) score += 1;

  return Math.ceil(score);
}

// ── Percentiles ──────────────────────────────────────────────────────────

/**
 * The Chen score alone has lots of ties, so break them by the cards themselves:
 * higher top card first, then higher second card. This gives every class a unique place.
 */
function sortingStrength(first: Card, second: Card): number {
  const [high, low] = byRank(first, second);
  return chenScore(first, second) * 100 + high.rank * 2 + low.rank / 10;
}

/**
 * Percentile of every hand class: the share of all 1326 hands that are at least as strong.
 * AA ≈ 0.005 (top half a percent), 72o = 1.0 (the very worst).
 */
function buildPercentileTable(): Map<string, number> {
  // 1. Count how many of the 1326 combos fall into each class, and how strong the class is.
  const classes = new Map<string, { strength: number; combos: number }>();
  const deck = Deck.fullSet();
  for (let i = 0; i < deck.length; i++) {
    for (let j = i + 1; j < deck.length; j++) {
      const first = deck[i]!;
      const second = deck[j]!;
      const name = handClass(first, second);
      const entry = classes.get(name) ?? { strength: sortingStrength(first, second), combos: 0 };
      entry.combos += 1;
      classes.set(name, entry);
    }
  }

  // 2. Strongest class first.
  const strongestFirst = [...classes.entries()].sort((a, b) => b[1].strength - a[1].strength);

  // 3. Walk down the list, adding up combos as we go.
  const percentiles = new Map<string, number>();
  let combosSoFar = 0;
  for (const [name, { combos }] of strongestFirst) {
    combosSoFar += combos;
    percentiles.set(name, combosSoFar / TOTAL_COMBOS);
  }
  return percentiles;
}

const PERCENTILES = buildPercentileTable();

/** 0.01 means "a top 1% hand"; a hand is in the "top 20% range" when this is ≤ 0.2. */
export function preflopPercentile(first: Card, second: Card): number {
  return PERCENTILES.get(handClass(first, second))!;
}

/** The hand classes in the top `maxPercentile` of hands, strongest first (handy for tuning). */
export function describeRange(maxPercentile: number): string[] {
  return [...PERCENTILES.entries()].filter(([, percentile]) => percentile <= maxPercentile).map(([name]) => name);
}
