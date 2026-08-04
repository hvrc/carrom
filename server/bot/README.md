# The computer player

Three files, one idea: **the bot plays by actually playing.** Every shot it
considers is run through the game's own simulation and the game's own rules, on
a copy of the board, and it keeps the one it liked best. There is no second
model of carrom in here that could drift from the real one — the queen, colour
claiming, fouls, debts and the finishing-coin rule all just happen.

| file | job |
|---|---|
| `aim.js` | proposes shots worth simulating — pure geometry, no physics |
| `score.js` | says how much it liked a played-out shot |
| `index.js` | runs the simulations, applies difficulty, picks |

## Why it is not just a search

A simulated shot costs about 4ms and the physics ticks every 16ms. Trying every
placement against every angle — a few hundred candidates — would block the
server for a third of a second, which one player's opponent would inflict on
every other game running at the time.

So `aim.js` thinks geometrically first. To sink a coin the striker has to arrive
where its edge meets the coin's edge along the coin-to-pocket line (the "ghost"
point), so only shots with a reason to exist get simulated — dozens, not
thousands. And `index.js` slices the work: a few milliseconds, then the event
loop back, then resume.

**An opening rack offers no clean pot at all.** Every coin in the cluster is
blocked by its neighbours, so `potShots` correctly returns nothing — and a bot
with only pot attempts tapped the striker up the board for ever, 0 coins in 120
turns. `explorationShots` is the fix: hit that coin, and see. It is deliberately
dumb, because the simulation is what judges it. A break that scatters the rack
and leaves three coins near pockets scores well without anyone having to
describe what a good break looks like.

## Difficulty

One number, 0 to 1, moving three things: how many shots it looks at, how far
down its own ranking it will reach, and how accurately it hits what it aimed at.
It misses the way people miss — playing a good shot slightly wrong, rather than
choosing a bad shot on purpose — so `intended` and `shot` are both returned and
the difference between them *is* the difficulty.

The error curve is **squared**, and measured rather than guessed. Aim error is
brutally non-linear: 2° off scores on a third of turns, 0° on four fifths. A
linear dial spent its whole bottom half between "bad" and "slightly less bad",
because a hard break pots coins by luck whatever the aim — which puts a floor of
about a fifth of turns under even the worst bot.

Measured over whole games, bot against itself:

| difficulty | turns that scored | fouls | turns per game |
|---|---|---|---|
| 0.00 | 24% | 7% | 63 |
| 0.25 | 27% | 7% | 56 |
| **0.50 (shipped)** | **32%** | **5%** | **44** |
| 0.75 | 42% | 8% | 32 |
| 1.00 | 83% | 0% | 18 |

Head to head, 1.0 beats 0.5 ten times out of ten and 0.5 beats 0.0 nine.

**The game ships at medium and there is no dial in the interface.** The setting
lives in `socketHandlers.js` (`BOT_DIFFICULTY`). The parameter exists because a
difficulty you cannot change is a difficulty you cannot test: the tests drive
both ends of the range to prove it means something.

## What the tests are actually for

Mostly not "does it play well" — that is what the table above is for. They pin
the things that would break the game:

- every shot it proposes is a **legal placement** (the server refuses a striker
  that overlaps a coin or sits half on an end circle, so an illegal proposal
  would silently throw away its turn)
- it **never mutates the board** it is thinking about
- there is **always something to play**, on every rack and from either seat
- two of them can **finish a game** — the regression for the 0-pots-for-ever bug
