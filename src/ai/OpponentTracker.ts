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

  //from https://pokercopilot.com/poker-statistics/vpip-pfr
  vpip: number;  //“voluntary put in pot
  /*Take a sample size of 50 hands. Let’s say player A puts money in the pot for a raise or a call in 10 of those hands. Ten divided by 50 is 0.2, which is 20%. Player A’s VPIP is 20%. Generally, these calculations include only pre-flop action. */
  /** Share of hands they raised before the flop.
   * 
   * 
   * A player with a high VPIP and low PFR (75/10, 52/5, 60/15) is one you want at your table. These opponents play far too many hands, and they usually play them very passively. Players who have a very high VPIP and low PFR call far too much preflop. When they do raise, they are weighted towards value. These are passive players, and are known as “whales.”
   * 
   * Low VPIP/PFR: 10/8, 14/12
Players with a low VPIP and PFR but with a tight gap between their stats are what poker players call “nits.” They play a very tight range of hands, and usually play their range advantage aggressively post-flop.

Reg (professional) VPIP and PFR: 15/14, 19/17, 22/18, 28/23
Regs are almost always winning or break-even players. These players have small gaps between their VPIP and PFR. Regs can range from very tight to very loose. At one end of the spectrum, a player with 15/14 statistics will be an overly tight regular. At 28/23, the player may be playing too loose and aggressively.
   */
  pfr: number;
//PFR tracks the percentage of hands in which a particular player makes a preflop raise when having the opportunity to fold or call instead. This includes reraises.
  threeBet: number;

  /**from https://www.pokernews.com/pokerterms/three-bet.htm or https://www.pokerskill.com/poker-glossary/three-bet-range/
   * 
   * Pre-Flop: After the blinds are put out, Play A opens the betting with a raise. Player B then re-raises Player A's bet. Player B's bet is the third bet, after the blinds, open and re-raise, making this a three-bet.

Post-Flop: The difference with a post-flop three-bet, is the big blind is no longer out. This means that after Player A bets the flop and Player B raises, any re-raise by Player A or even Player C would then be a three-bet

AA calls for a three bet
   */

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

/*
(hits + typical × 12) / (tries + 12)

• hits: The actual number of successful outcomes achieved.
• tries: The actual number of total opportunities or attempts.
• typical: A baseline, projected, or historical success rate (e.g., league-average batting average like .260).
• 12: The pseudo-counts or sample "weight."

Why Use It?

If a baseball player has only 1 try and gets 1 hit, their standard batting average is a perfect 1.000. If they miss, it's .000. Neither represents their true talent.
By adding 12 hypothetical "typical" attempts into the equation, the math anchors the player's stat closer to a realistic average until they build up enough real-world tries to override the baseline.



*/


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
