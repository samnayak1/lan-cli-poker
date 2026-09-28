import { Card } from './Card.js';
import { Deck, cryptoRng, type Rng } from './Deck.js';
import { GameState, type ActionRecord } from './GameState.js';
import { evaluateHand } from './HandEvaluator.js';
import type { Player } from './Player.js';
import { buildPots } from './Pot.js';
import type { LegalActions, PlayerAction, PotResult } from '../types.js';

const fmtCards = (cards: Card[]) => cards.map((c) => c.toString()).join(' ');

/**
 * No-limit Texas Hold'em rules engine. Synchronous and timer-free: callers (TableSession)
 * decide when to start hands and whose input to wait for.
 */
export class Game {
  constructor(
    public readonly state: GameState,
    private readonly rng: Rng = cryptoRng,
  ) {}

  private get players(): Player[] {
    return this.state.players;
  }

  private seated(p: Player): boolean {
    return p.chips > 0 && !p.reserved;
  }

  canStartHand(): boolean {
    return !this.state.handInProgress && this.players.filter((p) => this.seated(p)).length >= 2;
  }

  /** Next seat index after `from` (wrapping) whose player satisfies `pred`, or -1. */
  private nextSeat(from: number, pred: (p: Player) => boolean): number {
    const n = this.players.length;
    for (let i = 1; i <= n; i++) {
      const idx = (((from + i) % n) + n) % n;
      if (pred(this.players[idx]!)) return idx;
    }
    return -1;
  }

  startHand(): void {
    const s = this.state;
    if (!this.canStartHand()) throw new Error('Need at least two players with chips');

    s.markHandStart();
    s.handNumber++;
    s.lastHand = null;
    s.handActions = [];
    s.board = [];
    s.street = 'preflop';
    for (const p of this.players) p.resetForHand();

    const seated = (p: Player) => this.seated(p);
    const headsUp = this.players.filter(seated).length === 2;
    s.dealerIndex = this.nextSeat(s.dealerIndex, seated);
    s.smallBlindIndex = headsUp ? s.dealerIndex : this.nextSeat(s.dealerIndex, seated);
    s.bigBlindIndex = this.nextSeat(s.smallBlindIndex, seated);

    s.deck = new Deck().shuffle(this.rng);
    for (let round = 0; round < 2; round++) {
      let idx = s.dealerIndex;
      do {
        idx = this.nextSeat(idx, seated);
        this.players[idx]!.holeCards.push(s.deck.draw());
      } while (idx !== s.dealerIndex);
    }

    s.handInProgress = true;
    s.addLog(`── Hand #${s.handNumber} · dealer ${this.players[s.dealerIndex]!.name} ──`);
    this.postBlind(this.players[s.smallBlindIndex]!, s.config.smallBlind, 'SB');
    this.postBlind(this.players[s.bigBlindIndex]!, s.config.bigBlind, 'BB');
    s.currentBet = s.config.bigBlind;
    s.lastRaiseSize = s.config.bigBlind;

    s.toActIndex = s.bigBlindIndex;
    this.advance();
  }

  private postBlind(p: Player, amount: number, label: string): void {
    const posted = p.commit(amount);
    p.lastAction = `${label} ${posted}`;
    this.state.addLog(`${p.name} posts ${label} ${posted}${p.allIn ? ' (all-in)' : ''}`);
  }

  legalActions(playerId: string): LegalActions | null {
    const s = this.state;
    const p = s.toAct;
    if (!p || p.id !== playerId) return null;

    const toCall = Math.max(0, s.currentBet - p.streetBet);
    const maxRaiseTo = p.streetBet + p.chips;
    const minRaiseTo = Math.min(s.currentBet + Math.max(s.lastRaiseSize, s.config.bigBlind), maxRaiseTo);
    const opponentsCanAct = this.players.some((o) => o !== p && o.canAct);

    return {
      canFold: true,
      canCheck: toCall === 0,
      canCall: toCall > 0,
      callAmount: Math.min(toCall, p.chips),
      canRaise: p.chips > toCall && !p.raiseLocked && opponentsCanAct,
      minRaiseTo,
      maxRaiseTo,
    };
  }

  act(playerId: string, action: PlayerAction): void {
    const s = this.state;
    const p = s.toAct;
    const legal = this.legalActions(playerId);
    if (!p || !legal) throw new Error('Not your turn');

    switch (action.type) {
      case 'fold':
        p.folded = true;
        p.lastAction = 'Fold';
        this.record(p, 'fold', 0);
        break;
      case 'check':
        if (!legal.canCheck) throw new Error('Cannot check — there is a bet to call');
        p.lastAction = 'Check';
        this.record(p, 'check', 0);
        break;
      case 'call': {
        if (!legal.canCall) throw new Error('Nothing to call');
        const moved = p.commit(legal.callAmount);
        p.lastAction = p.allIn ? `All-in ${moved}` : `Call ${moved}`;
        this.record(p, 'call', moved);
        break;
      }
      case 'allin':
        if (legal.canRaise && legal.maxRaiseTo > s.currentBet) return this.act(playerId, { type: 'raise', amount: legal.maxRaiseTo });
        if (legal.canCall) return this.act(playerId, { type: 'call' });
        return this.act(playerId, { type: 'check' });
      case 'raise': {
        if (!legal.canRaise) throw new Error('Raising is not allowed');
        const raiseTo = Math.floor(action.amount);
        if (raiseTo > legal.maxRaiseTo) throw new Error(`Max raise is ${legal.maxRaiseTo}`);
        if (raiseTo < legal.minRaiseTo) throw new Error(`Min raise is to ${legal.minRaiseTo}`);

        const wasBet = s.currentBet === 0;
        const increment = raiseTo - s.currentBet;
        p.commit(raiseTo - p.streetBet);
        const fullRaise = increment >= s.lastRaiseSize;
        for (const o of this.players) {
          if (o === p) continue;
          // An all-in for less than a full raise doesn't reopen betting for those who already acted.
          if (fullRaise) o.raiseLocked = false;
          else if (o.hasActed) o.raiseLocked = true;
          o.hasActed = false;
        }
        if (fullRaise) s.lastRaiseSize = increment;
        s.currentBet = raiseTo;
        p.lastAction = p.allIn ? `All-in ${raiseTo}` : wasBet ? `Bet ${raiseTo}` : `Raise to ${raiseTo}`;
        this.record(p, wasBet ? 'bet' : 'raise', raiseTo);
        break;
      }
    }

    p.hasActed = true;
    s.addLog(`${p.name}: ${p.lastAction}`);
    this.advance();
  }

  private record(p: Player, kind: ActionRecord['kind'], amount: number): void {
    this.state.handActions.push({ playerId: p.id, street: this.state.street, kind, amount });
  }

  private roundComplete(): boolean {
    const s = this.state;
    const actors = this.players.filter((p) => p.canAct);
    if (actors.length === 0) return true;
    if (actors.length === 1 && actors[0]!.streetBet >= s.currentBet) return true;
    return actors.every((p) => p.hasActed && p.streetBet === s.currentBet);
  }

  private advance(): void {
    const s = this.state;
    const live = this.players.filter((p) => p.inHand);
    if (live.length === 1) return this.finishUncontested(live[0]!);
    if (this.roundComplete()) return this.endStreet();
    s.toActIndex = this.nextSeat(s.toActIndex, (p) => p.canAct && (!p.hasActed || p.streetBet < s.currentBet));
  }

  /** Returns the part of the biggest bet nobody could match. */
  private refundUncalled(): void {
    const bettors = this.players.filter((p) => p.totalBet > 0).sort((a, b) => b.totalBet - a.totalBet);
    const top = bettors[0];
    if (!top) return;
    const refund = top.totalBet - (bettors[1]?.totalBet ?? 0);
    if (refund <= 0) return;
    top.totalBet -= refund;
    top.streetBet = Math.max(0, top.streetBet - refund);
    top.chips += refund;
    top.allIn = top.chips === 0;
    this.state.addLog(`Uncalled ${refund} returned to ${top.name}`);
  }

  private endStreet(): void {
    const s = this.state;
    this.refundUncalled();
    for (const p of this.players) {
      p.streetBet = 0;
      p.hasActed = false;
      p.raiseLocked = false;
      if (p.canAct) p.lastAction = null;
    }
    s.currentBet = 0;
    s.lastRaiseSize = s.config.bigBlind;

    // Deal streets until two players can bet again, or run it out to showdown.
    for (;;) {
      if (s.street === 'river') return this.showdown();
      this.dealNextStreet();
      if (this.players.filter((p) => p.canAct).length >= 2) {
        s.toActIndex = this.nextSeat(s.dealerIndex, (p) => p.canAct);
        return;
      }
    }
  }

  private dealNextStreet(): void {
    const s = this.state;
    s.deck.draw(); // burn
    if (s.street === 'preflop') {
      s.board.push(...s.deck.drawMany(3));
      s.street = 'flop';
    } else if (s.street === 'flop') {
      s.board.push(s.deck.draw());
      s.street = 'turn';
    } else {
      s.board.push(s.deck.draw());
      s.street = 'river';
    }
    s.addLog(`${s.street[0]!.toUpperCase()}${s.street.slice(1)}: ${fmtCards(s.board)}`);
  }

  private finishUncontested(winner: Player): void {
    const s = this.state;
    this.refundUncalled();
    const amount = s.pot;
    winner.chips += amount;
    s.lastHand = {
      handNumber: s.handNumber,
      board: s.board.map((c) => c.code),
      pots: [{ amount, winners: [{ id: winner.id, name: winner.name, amount }] }],
      shown: [],
      uncontested: true,
    };
    s.addLog(`${winner.name} wins ${amount}`);
    this.endHand();
  }

  private showdown(): void {
    const s = this.state;
    s.street = 'showdown';
    const live = this.players.filter((p) => p.inHand);
    const results = new Map(live.map((p) => [p.id, evaluateHand([...p.holeCards, ...s.board])]));
    const pots = buildPots(this.players.map((p) => ({ id: p.id, amount: p.totalBet, folded: !p.inHand })));

    // Odd chips go to the first winner left of the dealer.
    const seatOrder = (id: string) => {
      const idx = this.players.findIndex((p) => p.id === id);
      return (idx - s.dealerIndex - 1 + this.players.length) % this.players.length;
    };

    const potResults: PotResult[] = pots.map((pot) => {
      const best = Math.max(...pot.eligible.map((id) => results.get(id)!.score));
      const winnerIds = pot.eligible.filter((id) => results.get(id)!.score === best).sort((a, b) => seatOrder(a) - seatOrder(b));
      const share = Math.floor(pot.amount / winnerIds.length);
      let remainder = pot.amount - share * winnerIds.length;
      const winners = winnerIds.map((id) => {
        const p = s.player(id)!;
        const amount = share + (remainder-- > 0 ? 1 : 0);
        p.chips += amount;
        return { id, name: p.name, amount };
      });
      return { amount: pot.amount, winners, handName: results.get(winnerIds[0]!)!.name };
    });

    s.lastHand = {
      handNumber: s.handNumber,
      board: s.board.map((c) => c.code),
      pots: potResults,
      shown: live.map((p) => ({
        id: p.id,
        name: p.name,
        cards: p.holeCards.map((c) => c.code),
        handName: results.get(p.id)!.name,
      })),
      uncontested: false,
    };
    for (const p of live) s.addLog(`${p.name} shows ${fmtCards(p.holeCards)} — ${results.get(p.id)!.name}`);
    potResults.forEach((pot, i) => {
      const label = potResults.length > 1 ? (i === 0 ? 'main pot' : `side pot ${i}`) : 'the pot';
      const names = pot.winners.map((w) => `${w.name} (${w.amount})`).join(', ');
      s.addLog(`${names} ${pot.winners.length > 1 ? 'split' : 'wins'} ${label} of ${pot.amount}`);
    });
    this.endHand();
  }

  private endHand(): void {
    const s = this.state;
    for (const p of this.players) {
      p.streetBet = 0;
      p.totalBet = 0;
      p.allIn = false;
    }
    s.currentBet = 0;
    s.handInProgress = false;
    s.toActIndex = -1;
  }
}
