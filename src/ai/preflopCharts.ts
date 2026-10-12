/*
 * Preflop charts: which starting hands to raise, call or fold, by seat and situation.
 *
 * They're written in standard range notation, approximating solver ("GTO") strategy for
 * 6-max no-limit Hold'em at ~100 big blinds:
 *
 *   "TT+"      pairs from tens up              "22-55"   pairs from deuces to fives
 *   "A2s+"     suited aces, A2s up to AKs      "K9s-K6s" suited kings from K9s down to K6s
 *   "ATo+"     offsuit aces, ATo up to AKo     "76s"     one hand
 *   ":0.5"     after a hand: play it only that share of the time (a mixed strategy)
 *
 * A chart maps each hand class ("AKs", "T9o", "77" — see handClass in ranges.ts) to how often
 * to take the action, from 0 to 1. Hands not listed are 0 (never).
 */

export type Chart = Map<string, number>;

const RANK_ORDER = '23456789TJQKA';
const rankValue = (c: string): number => {
  const value = RANK_ORDER.indexOf(c) + 2;
  if (value < 2) throw new Error(`Bad rank "${c}"`);
  return value;
};
const rankChar = (value: number): string => RANK_ORDER[value - 2]!;

/** Every hand class a single range token stands for. */
function expandToken(token: string): string[] {
  const pairPlus = /^([2-9TJQKA])\1\+$/.exec(token);
  if (pairPlus) {
    const from = rankValue(pairPlus[1]!);
    return Array.from({ length: 15 - from }, (_, i) => rankChar(from + i).repeat(2));
  }
  const pairSpan = /^([2-9TJQKA])\1-([2-9TJQKA])\2$/.exec(token);
  if (pairSpan) {
    const [a, b] = [rankValue(pairSpan[1]!), rankValue(pairSpan[2]!)];
    const [lo, hi] = [Math.min(a, b), Math.max(a, b)];
    return Array.from({ length: hi - lo + 1 }, (_, i) => rankChar(lo + i).repeat(2));
  }
  const pair = /^([2-9TJQKA])\1$/.exec(token);
  if (pair) return [token];

  const kickerPlus = /^([2-9TJQKA])([2-9TJQKA])([so])\+$/.exec(token);
  if (kickerPlus) {
    // "A2s+": keep the top card, raise the kicker up to one below it.
    const [top, kicker, kind] = [rankValue(kickerPlus[1]!), rankValue(kickerPlus[2]!), kickerPlus[3]!];
    return Array.from({ length: top - kicker }, (_, i) => rankChar(top) + rankChar(kicker + i) + kind);
  }
  const kickerSpan = /^([2-9TJQKA])([2-9TJQKA])([so])-([2-9TJQKA])([2-9TJQKA])\3$/.exec(token);
  if (kickerSpan) {
    if (kickerSpan[1] !== kickerSpan[4]) throw new Error(`Range "${token}" must keep the same top card`);
    const top = kickerSpan[1]!;
    const [a, b] = [rankValue(kickerSpan[2]!), rankValue(kickerSpan[5]!)];
    const [lo, hi] = [Math.min(a, b), Math.max(a, b)];
    return Array.from({ length: hi - lo + 1 }, (_, i) => top + rankChar(lo + i) + kickerSpan[3]);
  }
  if (/^([2-9TJQKA])([2-9TJQKA])[so]$/.test(token) && rankValue(token[0]!) > rankValue(token[1]!)) return [token];

  throw new Error(`Can't read range token "${token}"`);
}

/** Parses a range like "TT+, AQs+, A5s:0.5, KQo" into a chart. */
export function parseRange(spec: string): Chart {
  const chart: Chart = new Map();
  for (const raw of spec.split(',')) {
    const part = raw.trim();
    if (!part) continue;
    const [token, freqText] = part.split(':');
    const frequency = freqText === undefined ? 1 : Number(freqText);
    if (!(frequency > 0 && frequency <= 1)) throw new Error(`Bad frequency in "${part}"`);
    for (const hand of expandToken(token!.trim())) chart.set(hand, frequency);
  }
  return chart;
}

/** How often a chart plays a hand (0 if it isn't in the chart). */
export const frequencyOf = (chart: Chart, hand: string): number => chart.get(hand) ?? 0;

/** Share of all 1326 two-card combos a chart plays, e.g. 0.18 for an 18% opening range. */
export function rangeShare(chart: Chart): number {
  let combos = 0;
  for (const [hand, frequency] of chart) {
    const handCombos = hand.length === 2 ? 6 : hand.endsWith('s') ? 4 : 12;
    combos += handCombos * frequency;
  }
  return combos / 1326;
}

// ── Opening (first to raise) ─────────────────────────────────────────────

export type OpenSeat = 'UTG' | 'HJ' | 'CO' | 'BTN' | 'SB' | 'HU';

/** Raise-first-in ranges by seat. Later seats open wider: fewer players left to wake up with a hand. */
export const OPEN: Record<OpenSeat, Chart> = {
  UTG: parseRange('22+, A2s+, K9s+, Q9s+, J9s+, T8s+, 98s, 87s:0.5, 76s:0.5, 65s:0.5, ATo+, KJo+, QJo:0.5'),
  HJ: parseRange('22+, A2s+, K7s+, Q9s+, J9s+, T8s+, 97s+, 87s, 76s, 65s, 54s:0.5, ATo+, KTo+, QJo, QTo:0.5, JTo:0.5'),
  CO: parseRange('22+, A2s+, K5s+, Q8s+, J8s+, T7s+, 96s+, 86s+, 75s+, 65s, 54s, A8o+, A5o:0.5, KTo+, K9o:0.5, QTo+, JTo, T9o:0.5'),
  BTN: parseRange(
    '22+, A2s+, K2s+, Q4s+, J6s+, T6s+, 95s+, 85s+, 74s+, 64s+, 53s+, 43s, A2o+, K8o+, K7o:0.5, Q9o+, J9o+, T8o+, 98o, 87o:0.5',
  ),
  SB: parseRange('22+, A2s+, K2s+, Q5s+, J7s+, T7s+, 96s+, 86s+, 75s+, 64s+, 54s, A2o+, K9o+, Q9o+, J9o+, T9o'),
  // Heads-up the dealer is the small blind and plays most hands.
  HU: parseRange(
    '22+, A2s+, K2s+, Q2s+, J2s+, T4s+, 94s+, 84s+, 74s+, 63s+, 53s+, 43s, A2o+, K2o+, Q5o+, J7o+, T7o+, 97o+, 87o, 76o:0.5',
  ),
};

/** One step wider / tighter than each seat's chart, for exploiting blinds that fold too much / too little. */
export const WIDER: Record<OpenSeat, OpenSeat> = { UTG: 'HJ', HJ: 'CO', CO: 'BTN', BTN: 'HU', SB: 'HU', HU: 'HU' };
export const TIGHTER: Record<OpenSeat, OpenSeat> = { UTG: 'UTG', HJ: 'UTG', CO: 'HJ', BTN: 'CO', SB: 'CO', HU: 'BTN' };

/** Big blind raising after everyone just called (limped). */
export const BB_ISO = parseRange('77+, A9s+, KTs+, QJs, ATo+, KQo');

// ── Facing one raise ─────────────────────────────────────────────────────

export interface Response {
  /** Re-raise with these. */
  raise: Chart;
  /** Otherwise call with these. */
  call: Chart;
}

/**
 * Responses to an open raise. Early-position opens are strong, so continue tighter; late opens
 * are wide, so re-raise and defend more. The big blind already has a blind in, so it defends widest.
 */
export const VS_OPEN: Record<'early' | 'late' | 'sb' | 'bbEarly' | 'bbLate', Response> = {
  early: {
    raise: parseRange('QQ+, AKs, AKo, AQs:0.5, A5s:0.5, A4s:0.5, KQs:0.3'),
    call: parseRange('JJ-55, AQs, AJs, ATs:0.5, KQs, KJs:0.5, QJs, JTs, T9s:0.5, AQo:0.5'),
  },
  late: {
    raise: parseRange('TT+, AQs+, AJs:0.5, ATs:0.5, A5s, A4s, A3s:0.5, KQs, KJs:0.5, QJs:0.3, AKo, AQo, AJo:0.3, K9s:0.2, 76s:0.2, 65s:0.2'),
    call: parseRange('99-22, AJs, ATs, A9s:0.5, KJs, KTs, QJs, QTs, JTs, T9s, 98s, 87s, 76s:0.5, AJo, KQo'),
  },
  // The small blind plays out of position after the flop, so it mostly re-raises or folds.
  sb: {
    raise: parseRange('TT+, AJs+, ATs:0.5, A5s, A4s, KQs, KJs:0.5, QJs:0.3, AKo, AQo, AJo:0.3, 76s:0.2, 65s:0.2'),
    call: parseRange('99-66:0.5, AJs:0.5, KQs:0.5, QJs:0.3, JTs:0.3'),
  },
  bbEarly: {
    raise: parseRange('QQ+, AKs, AKo, A5s:0.5, KQs:0.2'),
    call: parseRange('JJ-22, A2s+, K9s+, Q9s+, J9s+, T8s+, 97s+, 86s+, 75s+, 65s, 54s, AJo, ATo:0.5, KQo, KJo:0.5, QJo:0.5'),
  },
  bbLate: {
    raise: parseRange('TT+, AQs+, AJs, A5s, A4s, KQs, AKo, AQo, K9s:0.3, Q9s:0.2, 65s:0.3'),
    call: parseRange('99-22, A2s+, K2s+, Q5s+, J7s+, T7s+, 96s+, 85s+, 74s+, 63s+, 53s+, 43s, A2o+, K8o+, Q9o+, J9o+, T8o+, 98o, 87o'),
  },
};

// ── Facing a re-raise and beyond ─────────────────────────────────────────

/** We opened and got 3-bet: 4-bet the top (plus a few suited-ace bluffs), call the next tier. */
export const VS_3BET: Response = {
  raise: parseRange('QQ+, AKs, AKo, AQs:0.3, A5s:0.4, A4s:0.3'),
  call: parseRange('JJ-77, AQs, AJs, ATs:0.5, KQs, KJs:0.5, QJs:0.5, JTs:0.5, T9s:0.3, AQo:0.5'),
};

/** Someone opened and someone else 3-bet before it got to us: only the best hands continue. */
export const COLD_VS_3BET: Response = {
  raise: parseRange('QQ+, AKs, AKo'),
  call: parseRange('JJ:0.5, AQs:0.3'),
};

/** Facing a 4-bet: shove the very best, sometimes call with the next tier. */
export const VS_4BET: Response = {
  raise: parseRange('KK+, AKs, QQ:0.5, AKo:0.5'),
  call: parseRange('QQ, AKo, JJ:0.3'),
};

/** Facing a 5-bet or more (usually all in). */
export const VS_5BET: Response = {
  raise: parseRange('AA, KK'),
  call: parseRange('QQ+, AKs, AKo'),
};
