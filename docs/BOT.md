# How the bots play

Every bot plays the same strong, **GTO-inspired** strategy. On top of that, it **studies the table**: it learns how each player plays and adjusts to exploit them.

Like a person at the table, a bot only uses:

- its own two cards
- the community cards on the board
- the size of the pot
- how everyone has bet, in this hand and in earlier ones

It never looks at anyone else's cards.

The code is in five files:

| File | What it does |
| --- | --- |
| [`src/ai/Bot.ts`](../src/ai/Bot.ts) | Makes the decision: preflop charts, postflop play, exploits |
| [`src/ai/preflopCharts.ts`](../src/ai/preflopCharts.ts) | Which hands to raise, call or fold before the flop, by seat and situation |
| [`src/ai/OpponentTracker.ts`](../src/ai/OpponentTracker.ts) | Learns each player's habits from every finished hand |
| [`src/ai/equity.ts`](../src/ai/equity.ts) | Estimates how often the bot wins, by simulating the rest of the hand |
| [`src/ai/ranges.ts`](../src/ai/ranges.ts) | Ranks all starting hands, so the bot can picture "an opponent's top 20% of hands" |

## What GTO-inspired means

GTO ("game theory optimal") play is a strategy no opponent can profit against, however they adjust. True GTO needs huge offline computations (see the end of this guide), so these bots borrow its main habits instead:

- **Solver-style preflop charts.** Opening, re-raising and calling ranges for each seat, close to what solvers recommend, instead of a rule of thumb.
- **Mixed strategies.** Borderline hands are played different ways at set frequencies, for example "re-raise A5s half the time, otherwise fold". The same hand in the same spot doesn't always get the same action, so the bot is hard to read.
- **Defending properly.** Facing a bet, the bot calls whenever its equity beats the pot odds, against a realistic picture of how often the bettor is bluffing. Betting at it doesn't automatically work.
- **Balanced betting.** It value-bets several sizes, semi-bluffs with draws, bluffs rivers at a measured rate and sometimes slow-plays big hands. A big bet doesn't reveal whether it's strong.

## Key ideas

**Range:** the set of hands a player could plausibly have, often described as "the top X% of starting hands". Any two cards is 100%; someone who re-raised before the flop is usually in about the top 7%.

**Equity:** the bot's expected share of the pot if the hand were played to the end. 0.6 means it wins 60% of the time. A split pot counts as a partial win.

**Pot odds:** the share of the final pot the bot would be putting in by calling.

> The pot is 100 and it costs 50 to call. After calling, the pot is 150, and 50 of it came from us:
> pot odds = 50 / 150 = **33%**.
> Calling pays off in the long run if we win more than 33% of the time, that is, if equity > 33%.

**Exploiting:** deliberately leaving GTO play to take advantage of an opponent's mistakes, like bluffing more against someone who folds too often.

## Before the flop: the charts (`preflopCharts.ts`)

### Range notation

The charts use standard poker notation:

| Notation | Means |
| --- | --- |
| `TT+` | Pairs from tens up: TT, JJ, QQ, KK, AA |
| `22-55` | Pairs from deuces to fives |
| `A2s+` | Suited aces, A2s up to AKs (`s` = suited, `o` = offsuit) |
| `K9s-K6s` | Suited kings from K9s down to K6s |
| `ATo+` | Offsuit aces, ATo up to AKo |
| `A5s:0.5` | Play A5s only half the time (a mixed strategy) |

`parseRange()` turns a string like `"TT+, AQs+, A5s:0.5"` into a chart: a table of how often to play each hand.

### Seats

Seats are counted back from the dealer (the button):

| Seat | Who |
| --- | --- |
| BTN | The dealer, last to act after the flop |
| CO (cutoff) | One seat before the button |
| HJ (hijack) | Two before |
| UTG (under the gun) | Earlier still |
| SB / BB | The small and big blind |
| HU | The dealer when only two players are dealt in (heads-up) |

Later seats see more before they act, so they can play more hands.

### Opening (nobody has raised yet)

| Seat | Opens with |
| --- | --- |
| UTG | ~19% of hands |
| HJ | ~23% |
| CO | ~30% |
| BTN | ~46% |
| SB | ~40% |
| HU (heads-up dealer) | ~62% |

Opens are 2.5 big blinds (3 from the small blind), plus one big blind for every player who has already called. If everyone just calls to the big blind, it raises with its best hands (`BB_ISO`) and checks the rest.

### Facing a raise

Each situation has two charts: hands to **re-raise** with and hands to **call** with. Anything else folds.

| Situation | Chart |
| --- | --- |
| Facing one raise from an early seat | `VS_OPEN.early`: tight, because early openers are strong |
| Facing one raise from a late seat | `VS_OPEN.late`: re-raises and defends more |
| Small blind facing a raise | `VS_OPEN.sb`: mostly re-raise or fold (it plays out of position after the flop) |
| Big blind facing a raise | `VS_OPEN.bbEarly` / `bbLate`: defends widest, since it already has a blind in |
| We opened and got re-raised (3-bet) | `VS_3BET`: 4-bet the top, plus a few suited-ace bluffs; call the next tier |
| Someone else's raise got re-raised before us | `COLD_VS_3BET`: only the best hands |
| Facing a 4-bet | `VS_4BET` |
| Facing a 5-bet or more | `VS_5BET` |

For a hand that's in both charts, the bot rolls once for the raise frequency, then once more for the call frequency.

Re-raises are 3× the bet in position and 4× out of position (from the blinds). 4-bets are 2.3×.

**Against loose raisers:** the charts assume a typical opponent. Against someone who raises more often than that, folding most hands just hands them the blinds, so the bot keeps playing in proportion to how wide they raise. It also calls with its top share of hands (by preflop strength) and re-raises with the very top:

| Facing | Also calls with its top… | Also re-raises with its top… |
| --- | --- | --- |
| A loose raise, from the big blind | 85% of the raiser's raising rate (up to 75% of hands) | 20% of their rate (up to 18%) |
| A loose raise, from the small blind | 50% of their rate | 20% of their rate (up to 18%) |
| A loose raise, from any other seat | 45% of their rate | 20% of their rate (up to 18%) |
| A frequent re-raiser, after we opened | 50% of their re-raise rate (up to 35%) | 12% of their rate (up to 8%) |
| A player who keeps 4-betting light | Up to 15% more hands | — |

Against someone who raises every hand, the big blind keeps playing about 75% of the time instead of folding most hands.

**Huge bets:** if calling would cost more than 25 big blinds before the flop (usually someone moving all in), the charts don't apply. The bot works out its equity against the raiser's likely range and calls only if that beats the pot odds.

## After the flop (`playPostflop`)

The bot works out its **equity** against what each opponent likely holds (see "Equity by simulation" below), then compares it with an **even share** of the pot: 1/2 heads-up, 1/3 with two opponents, and so on.

- **Good enough to bet:** equity ≥ even share + 0.10 (`VALUE_BET_EDGE`)
- **Good enough to raise:** equity ≥ even share + 0.30 (`RAISE_EDGE`)
- **Monster:** equity ≥ 0.85

### Nobody has bet yet

1. **Good hand:** bet. Ordinary value hands bet 33%, 50% or 66% of the pot, chosen at random. Monsters bet 66–75%, or 75–110% on the river.
   - **Slow-play:** heads-up before the river, a monster sometimes checks instead (12%, plus up to 25% more against aggressive players who'll bet for it).
2. **Weak hand:** sometimes bluff.

   | Holding | Bluff chance (heads-up) |
   | --- | --- |
   | A flush or straight draw (semi-bluff, before the river) | 45% |
   | Nothing, on the flop or turn | 12% |
   | Nothing, on the river | 22% |

   Into two or more players these drop to about a third. Bluffs use the same big sizes as strong value bets, so the size of a bet doesn't give the hand away.
3. **Otherwise:** check.

### Someone has bet

1. **Good enough to raise:** raise 70% of the time, by about 80% of the pot.
2. **Strong draw** (at least 30% equity): sometimes raise as a semi-bluff (about 20%). If it gets called, the draw can still win.
3. **Otherwise:** call if equity ≥ pot odds, else fold.

That last rule is what makes bluffing the bot unprofitable. It defends whenever the price is right, and the bettor's range includes bluffs at the rate that player has shown (see below).

## Learning the table (`OpponentTracker.ts`)

One tracker per table watches every player, humans and bots, and is shared by all the bots. After each hand it reads the actions and updates each player's record:

| Stat | Means | Typical player |
| --- | --- | --- |
| `vpip` | Share of hands they put money in before the flop | 25% |
| `pfr` | Share of hands they raised before the flop | 18% |
| `threeBet` | When facing one raise: how often they re-raise | 8% |
| `foldVsOpen` | When facing one raise: how often they fold | 65% |
| `aggression` | After the flop: bets and raises as a share of all their actions | 35% |
| `foldToBet` | After the flop: how often they fold when bet into | 45% |

**Smoothing:** with few hands seen, a player is assumed to be typical. Their own record takes over gradually: each stat is `(times it happened + typical × 12) / (chances + 12)`. So one wild hand barely moves it, while after dozens of hands the stat reflects the player.

### How the bots use it

| If a player… | The bots… |
| --- | --- |
| Folds to bets a lot | Bluff them more (up to 1.8× as often) |
| Calls bets a lot | Nearly stop bluffing them (down to 0.25×) and bet thinner hands for value |
| Bets and raises a lot after the flop | Assume more of their bets are bluffs, so call them down lighter |
| Raises a lot before the flop | Treat their raises as wide, and stretch the charts to defend and re-raise against them (see "Against loose raisers") |
| Rarely raises before the flop | Treat their raises as strong, and continue against them only with good hands |
| Re-raises a lot | Call and 4-bet them wider when they re-raise the bot |
| Still to act, and folds to raises a lot | Open wider to steal the blinds (the next wider seat's chart) |
| Still to act, and rarely folds to raises | Open tighter (the next tighter seat's chart) |

A bluff only works if *everyone* folds, so with several opponents the bot plans its bluffs around the one least likely to fold.

## Guessing what opponents hold (`guessRange`)

Each opponent starts on "any two cards". Their actions this hand narrow it, sized by their own record:

| What they did | Their range becomes |
| --- | --- |
| Raised first before the flop | Their own raising rate (`pfr`), e.g. top 18% for a typical player, any two cards for someone who raises every hand |
| Re-raised | Their own re-raise rate (`threeBet`) |
| Called with no raise in front | Their own `vpip` |
| Called a raise | About 60% of their `vpip` |
| Each bet or raise after the flop | 75% of what it was for a typical player; barely narrower (up to 97%) for someone who bets constantly, since their bets tell us little |
| Each call after the flop | 90% of what it was |

If they've bet or raised after the flop, the bot also assumes they usually have something: a pair or better, or a draw. The exception is the share of the time they've shown they bluff (their `aggression` rate, between 10% and 95%), when a hand with nothing still counts as possible.

## Equity by simulation (`equity.ts`)

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

- **Preflop strength:** the hand is within the opponent's range.
- **Postflop betting:** if they've been betting since the flop, it must also have **a pair or better**, a **flush draw** (four cards of one suit) or a **straight draw** (four of the five ranks of a straight). The exception is a hand with none of those, which still counts at that player's bluff rate.

### Ranking hands for "top X%" (`ranges.ts`)

To picture "an opponent's top 20% of hands", the simulation needs every starting hand ranked. There are 1326 possible two-card hands, in 169 kinds that play differently: pairs (`77`), suited (`AKs`) and offsuit (`AKo`). They're scored with **Bill Chen's formula**:

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

Each kind then gets a **percentile**: the share of all 1326 hands at least as strong. AA is about 0.005, the top half-percent, and 72o is 1.0. (The bot's *own* preflop play uses the charts, not this ranking.)

## Bet sizing (`raiseTo`)

Every raise size the bot wants is pushed into the legal range, between the minimum raise and all-in. If the raise would put 60% or more of its stack in anyway (`COMMIT_THRESHOLD`), the bot goes all in instead of keeping a few chips back.

## How much stronger is it?

Simulated heads-up games, with stacks reset to 100 big blinds every hand, scored in big blinds won per 100 hands:

| New bot against | Result |
| --- | --- |
| The previous bot, tight-aggressive style | +17.8 bb/100 over 10,000 hands |
| The previous bot, loose-aggressive style | about +7 bb/100 (two 10,000-hand runs: +17.9 and −3.3) |
| A player who always calls | +323 bb/100 over 10,000 hands (the previous bot managed +137) |
| A player who folds whenever bet into | +60 bb/100 (the previous bot managed +14) |

The last two rows show the exploiting at work: the new bot wins 2–4× as much from those leaks as the old one. Heads-up results swing by about ±15 bb/100 even over 10,000 hands, so treat single numbers as rough.

Against over-aggressive players, the bot defends rather than folding:

| Human who… | Bot folds to their bets (before the flop / on the river) | Human's result |
| --- | --- | --- |
| Raises every hand before the flop | 35% / — | −685 bb/100 |
| Raises every hand and bets every street | 36% / 29% | −517 bb/100 heads-up |

## Tuning

The numbers are named constants:

| Where | Constant | Effect |
| --- | --- | --- |
| `preflopCharts.ts` | `OPEN`, `VS_OPEN`, `VS_3BET`, … | Every preflop range, in range notation |
| `Bot.ts` | `OPEN_SIZE_BB`, `THREE_BET_*`, `FOUR_BET` | Preflop raise sizes |
| `Bot.ts` | `DEEP_COMMITMENT_BB` | When huge preflop bets switch from charts to equity |
| `Bot.ts` | `VALUE_BET_EDGE`, `RAISE_EDGE`, `MONSTER` | How far ahead the bot must be to bet, raise or slow-play |
| `Bot.ts` | `SEMI_BLUFF`, `AIR_BLUFF`, `RIVER_BLUFF`, `MULTIWAY_BLUFF_FACTOR` | How often it bluffs |
| `Bot.ts` | `COMMIT_THRESHOLD` | When a big raise becomes all-in |
| `OpponentTracker.ts` | `TYPICAL`, `PRIOR_WEIGHT` | What "typical" means, and how fast a player's own record takes over |
| `equity.ts` | `MAX_DEAL_ATTEMPTS`, `DEFAULT_BLUFF_SHARE` | Range dealing and the default bluff rate |

The simulation count is the third argument to the `Bot` constructor, and defaults to 700.

The tests in [`src/ai/ai.test.ts`](../src/ai/ai.test.ts) cover:

- range notation and chart sizes
- the tracker learning from scripted hands
- bots playing full games with only legal actions
- the bot bluffing a player who folds too much far more than one who calls everything

Run them with `npm test`.

## Limits

These bots are strong for a casual game, but they aren't solvers:

- **Not true GTO.** The charts approximate solver output; postflop play uses equity thresholds and fixed mixing frequencies rather than a solved strategy. True GTO would mean training with counterfactual regret minimization (CFR) offline and shipping a large strategy table.
- **Memory lasts one table session.** What the tracker learns isn't saved, so a resumed game starts fresh.
- **Stack depth is mostly ignored.** The charts assume about 100 big blinds; very short stacks are handled only by the all-in commitment rules.
- **Simple reads.** The tracker learns overall tendencies, not board-specific habits like "only bluffs on wet boards".
