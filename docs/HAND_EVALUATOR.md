# How hands are evaluated

[`src/engine/HandEvaluator.ts`](../src/engine/HandEvaluator.ts) takes 5–7 cards and returns the best 5-card hand: its category, a name like "Straight, Nine high", and a single number `score` for comparing hands.

It's fast because it records which ranks are present in a single number, one bit per rank, a **bitmask**. Checking for a straight then takes a handful of bit operations instead of trying every 5-card combination.

## 1. One bit per rank

Ranks are numbered 2–14 (J = 11, Q = 12, K = 13, A = 14). For each card, the evaluator switches on the bit at that rank's position:

```ts
mask |= 1 << c.rank;     // 1 << 9 = 0b1000000000: sets bit 9 for a nine
```

For the 7 cards **9♠ 8♥ 7♦ 6♣ 5♠ K♦ 2♣**:

```
bit:   14 13 12 11 10  9  8  7  6  5  4  3  2  1  0
rank:   A  K  Q  J  T  9  8  7  6  5  4  3  2  ·  ·
mask:   0  1  0  0  0  1  1  1  1  1  0  0  1  0  0
```

- **Only presence is stored.** With two nines, `|=` sets bit 9 again and it stays 1. The mask only says *whether* a rank is there. A separate `counts` array says *how many*, which is what finds pairs, three of a kind and four of a kind.
- **Bits 0 and 1 are unused,** apart from the ace-low trick in section 3.

## 2. Finding a straight: `straightHigh`

A straight is five consecutive ranks, which means five consecutive 1-bits:

```ts
for (let high = 14; high >= 5; high--) {
  const run = 0b11111 << (high - 4);        // five 1-bits ending at bit `high`
  if ((mask & run) === run) return high;
}
```

- **The template:** `0b11111 << (high - 4)` builds five 1s ending at bit `high`. For `high = 9` that's bits 5–9, the ranks 5-6-7-8-9.
- **The check:** `mask & run` keeps only the bits in both. If the result equals `run`, all five ranks are present.
- **Highest first:** the loop starts at the Ace and counts down, so the first match is the best straight. With 4-5-6-7-8-9 it finds 9-high, not 8-high.

On the example cards:

```
high = 14 (T–A)   mask & 0b111110000000000 ≠ run   ✗
high = 13 (9–K)   ✗   (no T, J or Q)
 …
high = 9  (5–9)   mask & 0b000001111100000 = run   ✓  → Straight, Nine high
```

That's at most 10 checks, however many cards there are.

## 3. The ace-low straight (the "wheel")

An Ace can also play as a 1 in A-2-3-4-5. Before checking for straights, the evaluator copies the Ace bit down to bit 1:

```ts
const withLowAce = (m) => (m & (1 << 14) ? m | 0b10 : m);
```

Now A-2-3-4-5 is bits 1–5, which is just the `high = 5` template. Its ranks are stored as `[5, 4, 3, 2, 1]`, so the wheel correctly loses to a 6-high straight.

## 4. Flushes and straight flushes: one mask per suit

The same idea runs separately for each suit:

```ts
suitMask[c.suit] |= 1 << c.rank;
```

- **Flush:** any suit with 5 or more cards (`suitCount`). Its best five cards come from walking that suit's mask from bit 14 downward and taking the first five 1s.
- **Straight flush:** `straightHigh` on that *suit's* mask instead of the combined one. Five consecutive bits within one suit is a straight flush. If it runs up to the Ace, it's a royal flush.

This also handles a case that's easy to get wrong. With 7 cards you might have a flush *and* a straight using different cards. That isn't a straight flush, and because the straight-flush check only looks at one suit's mask, it can't be fooled.

## 5. Checking in order of strength

After the straight-flush check, the evaluator works down the categories and returns the first that matches: four of a kind, full house, flush, straight, three of a kind, two pair, pair, high card. Pairs and sets come from the `counts` array. Kickers (the leftover high cards that break ties) are taken from the highest ranks not already used.

## 6. The score: packed into one number

The category (0 = high card … 8 = straight flush) and the five deciding ranks are packed into one number, 4 bits each:

```ts
let score = category;
for (const rank of ranks) score = score * 16 + rank;   // × 16 is a 4-bit shift left
```

For **two pair, Kings and Sevens, Ace kicker** (category 2):

```
category  rank rank rank rank rank
   2       13   13   7    7    14     →  0x2DD77E
```

Ranks top out at 14, so each fits in 4 bits (0–15). Comparing two scores as plain numbers compares the category first, then the top rank, then the next, and so on, exactly like poker's tie-break rules. Equal scores mean a split pot.

## Why bother?

Without masks, finding the best hand from 7 cards means checking all 21 five-card combinations. With them, the evaluator makes one pass over the cards and then does a handful of bit operations.

Speed matters because the bot evaluates hands a few thousand times per decision: about 700 simulated run-outs, with every player's hand checked in each one (see [BOT.md](BOT.md)).

The tests in [`src/engine/engine.test.ts`](../src/engine/engine.test.ts) cover each category, the wheel, kickers, and the case where a third pair is the kicker.
