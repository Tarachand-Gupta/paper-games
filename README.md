# Paper Games — v0.2

A static notebook full of games. Chess and Ludo have invite-code rooms; Snake is solo.

**Play:** <https://tarachand-gupta.github.io/paper-games/>

## Run it locally

From this folder:

```bash
python3 -m http.server 8080 --bind 127.0.0.1
```

Then open <http://127.0.0.1:8080/>.

The pages are plain HTML/CSS/JS, so they also work on Cloudflare Pages or GitHub Pages with no build step.

## Multiplayer

- Open a game, press **invite**, then **create a room**.
- Share the seven-character code, the copied link, or the code through the hub's **join a room** form.
- The other player opens the game (the invite link joins automatically) and gets the next free seat.
- Rooms are **host-authoritative**: the host holds the game and relays snapshots. Every player keeps the latest snapshot too, so if the host leaves, the lowest online seat **takes over** and the game carries on. A host who reloads rejoins as a guest and gets their seat back.
- **Seats are remembered per browser.** Each browser keeps a secret resume token per room, so a reload, a closed tab, or a laptop waking up puts you back in your own seat instead of a new one. A different browser gets a new seat.
- Cross-device rooms use Trystero over public relays (peer-to-peer). Same-browser rooms work too; add `?local=1` to force the local path (BroadcastChannel across tabs).
- Ludo starts with **2 to 4 players**. Empty or disconnected seats are skipped automatically, so a two-player game is a two-horse race around the board.
- A player who closes the tab is marked **away** within a few seconds; the remaining players keep playing.

## Games

- **Chess** — 2 players, full rules, perft-tested engine.
- **Ludo** — 4 pencils, 52-cell track, four tokens each, safe squares, captures, home lanes, local pass-and-play and online rooms. The die sits in the middle of the board; the page takes the colour of your seat, and the turn banner names whose roll it is.
- **Snake** — solo, notebook-paper arcade.

## Known limits

- No accounts, rankings, or global room list.
- A room only lives while someone is in it: if everybody closes the tab, the game is gone. (Persisting rooms needs a server; that is the next step if this grows.)
- A seat belongs to the browser that claimed it. Rejoining from another device cannot take over a seat mid-game — it gets the next free one.
- Offline seats are skipped; if every rival leaves, the last player plays out the board alone.
- No hidden-information games yet.
- Public signalling relays are best-effort; strict NATs can still block a peer-to-peer room. The room panel says so when it falls back to same-browser play.

## Layout

```
index.html              hub
assets/room.js          invite rooms + room modal
assets/room.css
games/chess/            chess page
games/ludo/             ludo page
games/snake/            snake page
PLAN.md                 the longer platform plan
```
