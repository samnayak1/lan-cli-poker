import { randomInt } from 'node:crypto';
import { Card, RANK_CHARS, SUITS } from './Card.js';

export type Rng = (maxExclusive: number) => number;

export const cryptoRng: Rng = (max) => randomInt(max);
export const mathRng: Rng = (max) => Math.floor(Math.random() * max);

export class Deck {
  private cards: Card[];

  constructor(cards?: Card[]) {
    this.cards = cards ? [...cards] : Deck.fullSet();
  }

  static fullSet(): Card[] {
    const cards: Card[] = [];
    for (const suit of SUITS) {
      for (let i = 0; i < RANK_CHARS.length; i++) cards.push(new Card(i + 2, suit));
    }
    return cards;
  }

  /** Fisher–Yates shuffle. */
  shuffle(rng: Rng = cryptoRng): this {
    for (let i = this.cards.length - 1; i > 0; i--) {
      const j = rng(i + 1);
      [this.cards[i], this.cards[j]] = [this.cards[j]!, this.cards[i]!];
    }
    return this;
  }

  draw(): Card {
    const card = this.cards.pop();
    if (!card) throw new Error('Deck is empty');
    return card;
  }

  drawMany(n: number): Card[] {
    return Array.from({ length: n }, () => this.draw());
  }

  /** Remove specific cards (e.g. known hole cards when simulating). */
  remove(toRemove: Card[]): this {
    this.cards = this.cards.filter((c) => !toRemove.some((r) => r.equals(c)));
    return this;
  }

  get size(): number {
    return this.cards.length;
  }

  toArray(): Card[] {
    return [...this.cards];
  }
}
