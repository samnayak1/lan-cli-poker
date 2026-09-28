import type { Card } from './Card.js';
import { Deck } from './Deck.js';
import { Player, type PlayerData } from './Player.js';
import type { HandSummary, SeatView, Street } from '../types.js';

export interface ActionRecord {
  playerId: string;
  street: Street;
  kind: 'fold' | 'check' | 'call' | 'bet' | 'raise';
  /** For bet/raise: the street total raised to. For call: chips added. */
  amount: number;
}

export interface GameConfig {
  smallBlind: number;
  bigBlind: number;
  startingChips: number;
  maxPlayers: number;
}

export const DEFAULT_CONFIG: GameConfig = {
  smallBlind: 10,
  bigBlind: 20,
  startingChips: 1000,
  maxPlayers: 8,
};

/** Between-hands snapshot: everything needed to resume a game later. */
export interface GameSnapshot {
  config: GameConfig;
  players: PlayerData[];
  dealerIndex: number;
  handNumber: number;
}

/**
 * All mutable table data for one game. Holds no rules — `Game` drives the transitions.
 */
export class GameState {
  players: Player[] = [];
  deck = new Deck();
  board: Card[] = [];
  street: Street = 'preflop';
  handInProgress = false;
  dealerIndex = -1;
  smallBlindIndex = -1;
  bigBlindIndex = -1;
  toActIndex = -1;
  /** Highest total street bet that others must match. */
  currentBet = 0;
  /** Size of the last full raise; the next raise must be at least this much more. */
  lastRaiseSize = 0;
  handNumber = 0;
  log: string[] = [];
  /** Every voluntary action this hand — what bots use to guess opponents' ranges. */
  handActions: ActionRecord[] = [];
  lastHand: HandSummary | null = null;
  /** Stacks as they were before the current hand — what a mid-hand save restores to. */
  private handStartSnapshot: GameSnapshot | null = null;

  constructor(public config: GameConfig = DEFAULT_CONFIG) {}

  get pot(): number {
    return this.players.reduce((sum, p) => sum + p.totalBet, 0);
  }

  get toAct(): Player | null {
    return this.handInProgress ? (this.players[this.toActIndex] ?? null) : null;
  }

  player(id: string): Player | undefined {
    return this.players.find((p) => p.id === id);
  }

  addLog(message: string): void {
    this.log.push(message);
    if (this.log.length > 100) this.log.splice(0, this.log.length - 100);
  }

  markHandStart(): void {
    this.handStartSnapshot = this.toSnapshot();
  }

  toSnapshot(): GameSnapshot {
    if (this.handInProgress && this.handStartSnapshot) return structuredClone(this.handStartSnapshot);
    return {
      config: { ...this.config },
      players: this.players.map((p) => p.toData()),
      dealerIndex: this.dealerIndex,
      handNumber: this.handNumber,
    };
  }

  static fromSnapshot(snapshot: GameSnapshot): GameState {
    const state = new GameState({ ...snapshot.config });
    state.players = snapshot.players.map((d) => new Player(d));
    state.dealerIndex = snapshot.dealerIndex;
    state.handNumber = snapshot.handNumber;
    return state;
  }

  /** Per-viewer projection: hides other players' hole cards until showdown. */
  seatViews(viewerId: string): SeatView[] {
    const shown = new Map(this.lastHand?.shown.map((s) => [s.id, s]) ?? []);
    const winners = new Set(this.lastHand?.pots.flatMap((p) => p.winners.map((w) => w.id)) ?? []);

    return this.players.map((p, i) => {
      let holeCards: (string | null)[] = [];
      if (p.holeCards.length) {
        if (p.id === viewerId) holeCards = p.holeCards.map((c) => c.code);
        else if (shown.has(p.id)) holeCards = shown.get(p.id)!.cards;
        else if (!p.folded) holeCards = p.holeCards.map(() => null);
      }
      return {
        id: p.id,
        name: p.name,
        chips: p.chips,
        streetBet: p.streetBet,
        folded: p.folded,
        allIn: p.allIn,
        isBot: p.isBot,
        botStyle: p.isBot ? p.personality : undefined,
        isYou: p.id === viewerId,
        connected: p.connected,
        eliminated: p.chips === 0 && !(this.handInProgress && p.inHand),
        reserved: p.reserved,
        isDealer: i === this.dealerIndex,
        isSmallBlind: this.handInProgress && i === this.smallBlindIndex,
        isBigBlind: this.handInProgress && i === this.bigBlindIndex,
        isTurn: this.handInProgress && i === this.toActIndex,
        holeCards,
        lastAction: p.lastAction,
        handName: shown.get(p.id)?.handName,
        isWinner: winners.has(p.id),
      };
    });
  }
}
