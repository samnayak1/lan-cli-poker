import type { Card } from './Card.js';

export type PlayerKind = 'human' | 'bot';

/** What survives between hands and goes into a save file. */
export interface PlayerData {
  id: string;
  name: string;
  chips: number;
  kind: PlayerKind;
  personality?: string;
}

export class Player {
  readonly id: string;
  name: string;
  chips: number;
  kind: PlayerKind;
  personality?: string;
  connected = true;
  /** Seat carried over from a save, waiting for its human to reconnect. */
  reserved = false;

  // Per-hand state
  holeCards: Card[] = [];
  streetBet = 0;
  totalBet = 0;
  folded = false;
  allIn = false;
  hasActed = false;
  /** Set when an incomplete all-in raise doesn't reopen betting for this player. */
  raiseLocked = false;
  lastAction: string | null = null;

  constructor(data: PlayerData) {
    this.id = data.id;
    this.name = data.name;
    this.chips = data.chips;
    this.kind = data.kind;
    this.personality = data.personality;
  }

  get isBot(): boolean {
    return this.kind === 'bot';
  }

  /** Was dealt into the current hand and hasn't folded. */
  get inHand(): boolean {
    return this.holeCards.length > 0 && !this.folded;
  }

  /** Still able to make betting decisions this hand. */
  get canAct(): boolean {
    return this.inHand && !this.allIn;
  }

  resetForHand(): void {
    this.holeCards = [];
    this.streetBet = 0;
    this.totalBet = 0;
    this.folded = false;
    this.allIn = false;
    this.hasActed = false;
    this.raiseLocked = false;
    this.lastAction = null;
  }

  /** Moves up to `amount` chips from stack into the pot. Returns chips actually moved. */
  commit(amount: number): number {
    const moved = Math.min(amount, this.chips);
    this.chips -= moved;
    this.streetBet += moved;
    this.totalBet += moved;
    if (this.chips === 0 && this.holeCards.length > 0) this.allIn = true;
    return moved;
  }

  toData(): PlayerData {
    return { id: this.id, name: this.name, chips: this.chips, kind: this.kind, personality: this.personality };
  }
}
