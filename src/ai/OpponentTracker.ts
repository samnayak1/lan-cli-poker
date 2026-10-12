import type { ActionRecord } from '../engine/GameState.js';

/*
 * Watches how each player plays, hand after hand, so the bots can adjust to them.
 *
 * Every number is a rate, smoothed toward a typical player ("prior") until there's enough
 * evidence: with few hands seen it stays close to typical; after dozens it reflects the
 * player. That stops one wild hand from swinging the bots' strategy.
 */

/** What a typical, solid player looks like. Everyone starts here. */
const TYPICAL = {
  vpip: 0.25, // plays a quarter of hands
  pfr: 0.18, // opens most of those with a raise
  threeBet: 0.08, // re-raises an open 8% of the time
  foldVsOpen: 0.65, // folds to a single raise most of the time
  aggression: 0.35, // after the flop, bets or raises on about a third of their actions
  foldToBet: 0.45, // folds a bit under half the time when bet into after the flop
};

/** How many observations it takes before a player's own record outweighs "typical". */
const PRIOR_WEIGHT = 12;

export interface Profile {
  handsSeen: number;
  /** Share of hands they put money in voluntarily before the flop. */
  vpip: number;
  /** Share of hands they raised before the flop. */
  pfr: number;
  /** When facing exactly one raise before the flop: how often they re-raise... */
  threeBet: number;
  /** ...and how often they fold. */
  foldVsOpen: number;
  /** After the flop: bets and raises as a share of all their checks, calls, bets and raises. */
  aggression: number;
  /** After the flop: how often they fold when someone bets into them. */
  foldToBet: number;
}

interface Counts {
  hands: number;
  vpip: number;
  pfr: number;
  facedOpen: number;
  threeBet: number;
  foldedToOpen: number;
  postflopActions: number;
  postflopAggressive: number;
  facedBet: number;
  foldedToBet: number;
}

const emptyCounts = (): Counts => ({
  hands: 0, vpip: 0, pfr: 0, facedOpen: 0, threeBet: 0, foldedToOpen: 0,
  postflopActions: 0, postflopAggressive: 0, facedBet: 0, foldedToBet: 0,
});

/** `hits` out of `tries`, pulled toward `typical` when `tries` is small. */
const smoothed = (hits: number, tries: number, typical: number) => (hits + typical * PRIOR_WEIGHT) / (tries + PRIOR_WEIGHT);

export class OpponentTracker {
  private readonly counts = new Map<string, Counts>();

  private countsFor(playerId: string): Counts {
    let c = this.counts.get(playerId);
    if (!c) this.counts.set(playerId, (c = emptyCounts()));
    return c;
  }

  /** What we know about a player (typical values if we've never seen them). */
  profile(playerId: string): Profile {
    const c = this.counts.get(playerId) ?? emptyCounts();
    return {
      handsSeen: c.hands,
      vpip: smoothed(c.vpip, c.hands, TYPICAL.vpip),
      pfr: smoothed(c.pfr, c.hands, TYPICAL.pfr),
      threeBet: smoothed(c.threeBet, c.facedOpen, TYPICAL.threeBet),
      foldVsOpen: smoothed(c.foldedToOpen, c.facedOpen, TYPICAL.foldVsOpen),
      aggression: smoothed(c.postflopAggressive, c.postflopActions, TYPICAL.aggression),
      foldToBet: smoothed(c.foldedToBet, c.facedBet, TYPICAL.foldToBet),
    };
  }

  /**
   * Learns from one finished hand.
   * @param dealtIn  everyone who was dealt cards this hand
   * @param actions  the hand's voluntary actions, in order (blinds aren't included)
   */
  recordHand(dealtIn: string[], actions: ActionRecord[]): void {
    for (const id of dealtIn) this.countsFor(id).hands++;

    const putMoneyIn = new Set<string>();
    const raisedPreflop = new Set<string>();
    let preflopRaises = 0;
    let street = '';
    let betThisStreet = false;

    for (const action of actions) {
      const c = this.countsFor(action.playerId);

      if (action.street === 'preflop') {
        const facingOneRaise = preflopRaises === 1;
        if (facingOneRaise && !raisedPreflop.has(action.playerId)) {
          c.facedOpen++;
          if (action.kind === 'raise') c.threeBet++;
          if (action.kind === 'fold') c.foldedToOpen++;
        }
        if (action.kind === 'call' || action.kind === 'raise') putMoneyIn.add(action.playerId);
        if (action.kind === 'raise') {
          raisedPreflop.add(action.playerId);
          preflopRaises++;
        }
        continue;
      }

      // After the flop. A new street resets whether anyone has bet yet.
      if (action.street !== street) {
        street = action.street;
        betThisStreet = false;
      }
      if (betThisStreet) {
        c.facedBet++;
        if (action.kind === 'fold') c.foldedToBet++;
      }
      if (action.kind !== 'fold') {
        c.postflopActions++;
        if (action.kind === 'bet' || action.kind === 'raise') c.postflopAggressive++;
      }
      if (action.kind === 'bet' || action.kind === 'raise') betThisStreet = true;
    }

    for (const id of putMoneyIn) this.countsFor(id).vpip++;
    for (const id of raisedPreflop) this.countsFor(id).pfr++;
  }
}
