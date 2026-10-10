# How the bots play

The bots play no-limit Texas Hold'em using the same information a person at the table has:

- their own two cards
- the community cards on the board
- the size of the pot
- how each opponent has bet during this hand

They never look at anyone else's cards.

The code is in three files:

| File | What it does |
| --- | --- |
| [`src/ai/Bot.ts`](../src/ai/Bot.ts) | Makes the decision: guesses ranges, then applies the preflop and postflop rules |
| [`src/ai/equity.ts`](../src/ai/equity.ts) | Estimates how often the bot wins, by simulating the rest of the hand |
| [`src/ai/ranges.ts`](../src/ai/ranges.ts) | Ranks all starting hands so the bot can talk about the "top 20% of hands" |

## The decision in four steps

Each time it's a bot's turn, `Bot.decide()` runs these four steps:

```
1. Guess ranges   →  what could each opponent be holding?          (guessRange)
2. Equity         →  how often would I win against those hands?    (estimateEquity)
3. Pot odds       →  what share of the pot does calling cost me?   (potOdds)
4. Choose         →  preflop rules, or postflop equity vs pot odds (playPreflop / playPostflop)
```

A decision takes about 25 ms on average. Most of that time goes into the equity simulation.

## Key ideas

**Range:** the set of hands a player could plausibly have. The bots describe a range as "the top X% of starting hands". Any two cards is 100%. A player who re-raised before the flop is assumed to be in about the top 7%.

**Equity:** the bot's expected share of the pot if the hand were played to the end. 0.6 means it wins 60% of the time. A split pot counts as a partial win.

**Pot odds:** the share of the final pot the bot would be putting in by calling.

> The pot is 100 and it costs 50 to call. After calling, the pot is 150, and 50 of it came from us:
> pot odds = 50 / 150 = **33%**.
> Calling pays off in the long run if we win more than 33% of the time, that is, if equity > 33%.

The whole postflop strategy follows from that comparison.

## Personalities

Each bot has one of four personalities (`PERSONALITIES` in `Bot.ts`):

| Personality | Plays (`vpip`) | Opens with a raise (`pfr`) | Aggression | Bluffs | Call margin |
| --- | --- | --- | --- | --- | --- |
| Tight-Aggressive (`tag`) | 22% of hands | 16% | 0.75 | 0.10 | +0.03 |
| Loose-Aggressive (`lag`) | 38% | 26% | 0.85 | 0.20 | 0 |
| Tight-Passive (`rock`) | 15% | 7% | 0.35 | 0.03 | +0.06 |
| Calling Station (`station`) | 50% | 8% | 0.30 | 0.05 | −0.07 |

- **vpip:** the share of starting hands the bot is willing to play at all.
- **pfr:** the share it opens with a raise. This is always smaller than vpip.
- **aggression:** the chance it bets or raises a strong hand instead of just checking or calling.
- **bluff:** the chance it bets a weak hand when nobody else has bet.
- **call margin:** how much equity it wants on top of the pot odds before it calls. A negative margin means it calls too often, which is what makes a calling station.

The names and personalities of the seated bots come from `BOT_ROSTER`.

## Step 1: Guessing opponents' ranges

`guessRange()` goes through every action this hand. Each opponent starts on "any two cards", and their actions narrow that down:

| What they did | Their range becomes |
| --- | --- |
| Raised first before the flop | top 20% |
| Re-raised before the flop | top 7% |
| Called before the flop with no raise in front | top 50% |
| Called a raise before the flop | top 30% |
| Each bet or raise after the flop | 75% of what it was |
| Each call after the flop | 90% of what it was |

A range never gets narrower than 4% (`TIGHTEST_RANGE`). If an opponent has bet or raised after the flop, the bot also marks them as `aggressivePostflop`. Step 2 uses that flag to assume they usually hold a made hand or a draw.

The numbers are in `RANGE_IF_THEY`, `NARROWING_PER_POSTFLOP_BET` and `NARROWING_PER_POSTFLOP_CALL`.

## Step 2: Equity by simulation (`equity.ts`)

The bot can't see the other hands, so it estimates its equity by playing the hand out many times at random. This is a *Monte Carlo* simulation, and it runs 700 times per decision:

1. **Deal each opponent a hand that fits their range** (see below).
2. **Deal the rest of the board at random.**
3. **Compare hands.** A win counts 1, a loss 0, and a split between *n* players counts 1/*n*.

The equity is the average over all the run-outs.

### Dealing a hand that fits a range

The bot uses the simplest method that works, called *rejection sampling*: deal random cards, throw back anything that doesn't fit, and try again (`dealHandFromRange`).

> An opponent re-raised before the flop, so the bot guesses they hold a top-7% hand (AA, KK, QQ, AK…). In one run-out:
>
> 1. Draw two random cards from the ones we can't see: **7♣ 2♦**. Not in the top 7%, so put them back.
> 2. Draw again: **K♠ Q♠**. Still not in the top 7%, so put them back.
> 3. Draw again: **A♥ K♦**. That fits, so the opponent "holds" AK for this run-out.
>
> The next run-out starts over and might give them QQ, or AA, and so on.

**Why put the cards back?**

- **No cards go missing.** If rejected cards were thrown away, every rejection would strip weak cards like 7s and 2s out of the deck, and the board would come out stronger than it should.
- **Fair sampling.** Repeating until a hand fits makes every hand in the range as likely as it is in real dealing. AK, which can be dealt 16 ways, comes up more often than AA, which can be dealt only 6 ways.

**The 40-try limit.** With a very narrow range, such as the 4% minimum, finding a matching hand can take many tries. To keep each decision fast, after 40 tries the bot accepts whatever it drew. This makes the estimate slightly less accurate in rare cases.

**What counts as "fits"** (`handFitsRange`):

- **Preflop strength:** the hand is strong enough, meaning its percentile is within the opponent's range.
- **Postflop betting:** if they've been betting since the flop, it must also have **a pair or better**, a **flush draw** (four cards of one suit) or a **straight draw** (four of the five ranks of a straight).
  - One time in three, a hand with none of those is allowed anyway, because that opponent might be bluffing.

## Step 3: Pot odds

```
potOdds = toCall / (pot + toCall)        // 0 when there's nothing to call
```

## Step 4a: Before the flop (`playPreflop`)

Before the flop the bot mostly plays by **hand rankings**, adjusted for **position**.

### Ranking starting hands (`ranges.ts`)

There are 1326 possible two-card hands. They fall into 169 kinds that play differently: a pair (`77`), suited cards (`AKs`) and offsuit cards (`AKo`). The bot scores each kind with **Bill Chen's formula**:

1. Points for the higher card: A = 10, K = 8, Q = 7, J = 6, and anything else is half its rank (so 9 = 4.5).
2. A pair scores double those points, with a minimum of 5.
3. Suited cards get +2, because they can make flushes.
4. Points come off for the gap between the ranks: no gap −0, one −1, two −2, three −4, four or more −5.
5. Connected or one-gap cards below a Queen get +1, because their straights are easier to make.
6. Round up.

| Hand | Working | Score |
| --- | --- | --- |
| AKs | 10 (A) + 2 (suited) | 12 |
| 77 | 3.5 × 2 | 7 |
| T9s | 5 (T) + 2 (suited) + 1 (small connector) | 8 |
| 72o | 3.5 (7) − 5 (big gap) | −1 |

The 169 kinds are sorted by score. Ties are broken by the higher card, then the lower one. Each kind then gets a **percentile**: the share of all 1326 hands that are at least as strong. AA is about 0.005, the top half-percent, and 72o is 1.0. "Top 20%" means a percentile of 0.2 or lower. You can list what's in a range with `describeRange(0.2)`.

### Position

Players who act later have seen more before they decide, so they can play more hands. `positionLooseness()` scales the bot's ranges:

| Seat | Multiplier |
| --- | --- |
| Cutoff or button (last two to act), or 3 or fewer players | × 1.3 (looser) |
| Small or big blind | × 1.0 |
| Early seats (first two after the blinds) | × 0.8 (tighter) |
| Everything else | × 1.0 |

### The rules

**Nobody has raised yet:**

- If the hand is within `pfr × position`, the bot raises to 2.5–3.5 big blinds, plus 1 big blind for each player who has already called.
- If it's within `vpip × position`, the bot calls, or checks if it's already the big blind.
- Otherwise it folds, or checks if that's free.

**Someone has raised:**

- **Re-raise** with the very top of the range. That's `pfr × 0.3` against one raise and `pfr × 0.1` against two or more. The bot raises to 3 × the current bet.
- **Call** when both of these are true:
  - the hand is worth continuing with: within `vpip × 0.7` (one raise) or `vpip × 0.35` (more), or a premium top-3% hand, **and**
  - the price is right: equity ≥ pot odds + call margin.
- Otherwise **fold**.

## Step 4b: After the flop (`playPostflop`)

After the flop, equity does the work. The bot compares its equity with an **even share** of the pot. With 2 opponents, for example, an even share is 1/3.

- **Good enough to bet:** equity ≥ even share + 0.12 (`VALUE_BET_EDGE`)
- **Good enough to raise:** equity ≥ even share + 0.28 (`RAISE_EDGE`)

> With 2 opponents: bet at 45% equity or more, raise at 61% or more.

**Nobody has bet:**

- **Good enough to bet:** the bot bets 50–80% of the pot, with probability `aggression`.
- **Otherwise, maybe bluff:** it bets 55% of the pot with probability `bluff`.
  - That chance is cut to 40% of normal when there's more than one opponent, and to 60% of normal on the river.
- **Otherwise:** check.

**Someone has bet:**

- **Good enough to raise:** with probability `aggression`, the bot raises by 75% of the pot on top of the current bet.
- **Call** when equity ≥ pot odds + call margin.
- **Otherwise:** fold.

## Bet sizing (`raiseTo`)

Every raise size the bot wants is pushed into the legal range, between the minimum raise and all-in. If the raise would put 60% or more of its stack in anyway (`COMMIT_THRESHOLD`), the bot goes all in instead of keeping a few chips back.

## Tuning

All the numbers are named constants at the top of `Bot.ts`:

| Constant | Effect |
| --- | --- |
| `PERSONALITIES` | Each personality's style |
| `OPEN_RAISE_BIG_BLINDS`, `RERAISE_MULTIPLIER` | Preflop raise sizes |
| `PREMIUM_HAND` | Hands always good enough to continue with before the flop |
| `VALUE_BET_EDGE`, `RAISE_EDGE` | How far ahead the bot must be to bet or raise after the flop |
| `COMMIT_THRESHOLD` | When a big raise becomes all-in |
| `LATE_POSITION_LOOSENESS`, `EARLY_POSITION_LOOSENESS` | How much position matters |
| `RANGE_IF_THEY`, `NARROWING_PER_*`, `TIGHTEST_RANGE` | How strongly opponents' bets narrow their ranges |

In `equity.ts`:

| Constant | Effect |
| --- | --- |
| `MAX_DEAL_ATTEMPTS` | How hard the bot tries to deal a hand that fits a range |
| `BLUFF_ODDS` | How often it assumes a postflop bettor is bluffing |

The simulation count is the third argument to the `Bot` constructor, and defaults to 700. More simulations give steadier decisions but take longer.

The bot tests are in [`src/ai/ai.test.ts`](../src/ai/ai.test.ts):

- AA wins about 85% against a random hand.
- A tight range lowers the equity of a medium hand.
- Every personality plays full games using only legal actions.

Run them with `npm test`.

## Limits

These bots are meant to be decent opponents, not solvers:

- **No memory between hands.** They don't learn that one player bluffs a lot.
- **Stack sizes and future streets are ignored.** They don't plan several streets ahead.
- **Ranges are "top X%" by preflop strength.** After the flop they're only nudged toward made hands and draws, so a real player's range can differ a lot from the guess.
- **Chen is an approximation.** It ranks some hands differently from simulation-based charts.
- **Bluffs are random.** They follow set frequencies, not reads on opponents or the board.
