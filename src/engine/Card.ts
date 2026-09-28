export type Suit = 'c' | 'd' | 'h' | 's';

/** Two-character card code, e.g. "As", "Td", "7c". Used on the wire and in saves. */
export type CardCode = string;

export const SUITS: readonly Suit[] = ['c', 'd', 'h', 's'];
export const RANK_CHARS = '23456789TJQKA';
export const SUIT_SYMBOLS: Record<Suit, string> = { c: '♣', d: '♦', h: '♥', s: '♠' };

export class Card {
  /** rank: 2..14 (14 = Ace) */
  constructor(
    public readonly rank: number,
    public readonly suit: Suit,
  ) {
    if (rank < 2 || rank > 14) throw new Error(`Invalid rank ${rank}`);
  }

  get rankChar(): string {
    return RANK_CHARS[this.rank - 2]!;
  }

  get code(): CardCode {
    return this.rankChar + this.suit;
  }

  get isRed(): boolean {
    return this.suit === 'h' || this.suit === 'd';
  }

  /** Pretty form, e.g. "A♠". */
  toString(): string {
    return Card.pretty(this.code);
  }

  toJSON(): CardCode {
    return this.code;
  }

  equals(other: Card): boolean {
    return this.rank === other.rank && this.suit === other.suit;
  }

  static fromCode(code: CardCode): Card {
    const rank = RANK_CHARS.indexOf(code[0]!.toUpperCase()) + 2;
    const suit = code[1]!.toLowerCase() as Suit;
    if (rank < 2 || !SUITS.includes(suit)) throw new Error(`Invalid card code "${code}"`);
    return new Card(rank, suit);
  }

  static pretty(code: CardCode): string {
    const r = code[0] === 'T' ? '10' : code[0]!;
    return r + SUIT_SYMBOLS[code[1] as Suit];
  }
}
