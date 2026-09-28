export interface Contribution {
  id: string;
  amount: number;
  folded: boolean;
}

export interface Pot {
  amount: number;
  /** Player ids that can win this pot. */
  eligible: string[];
}

/**
 * Splits total contributions into a main pot and side pots.
 * Folded players' chips go in the pots but they are never eligible.
 */
export function buildPots(contributions: Contribution[]): Pot[] {
  const levels = [...new Set(contributions.map((c) => c.amount).filter((a) => a > 0))].sort((a, b) => a - b);
  const pots: Pot[] = [];
  let prev = 0;

  for (const level of levels) {
    let amount = 0;
    for (const c of contributions) amount += Math.max(0, Math.min(c.amount, level) - prev);
    const eligible = contributions.filter((c) => !c.folded && c.amount >= level).map((c) => c.id);
    prev = level;
    if (amount === 0) continue;

    const last = pots[pots.length - 1];
    if (eligible.length === 0 && last) {
      // Only folded players reached this level — their dead money joins the pot below.
      last.amount += amount;
    } else if (last && sameSet(last.eligible, eligible)) {
      last.amount += amount;
    } else {
      pots.push({ amount, eligible });
    }
  }
  return pots;
}

function sameSet(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((x) => b.includes(x));
}
