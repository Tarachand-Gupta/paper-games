# Paper Games — feasibility and build plan

## Short answer

Yes, this is doable as a static, invite-only, peer-to-peer game platform — with a few honest caveats.

You do **not** need a server to run the games or store the game state. Each browser holds a complete copy, and Yjs merges changes when players reconnect. But “no server” is not literally true at the network layer: WebRTC still needs **signaling** to introduce peers, and sometimes a **TURN relay** when two networks cannot connect directly. We can use public infrastructure for both, or add a tiny Cloudflare Worker later if reliability matters.

The right mental model:

- **Yjs** = the shared notebook (CRDT state sync).
- **Trystero** = the mailroom that introduces players over WebRTC (public signaling, no server to run).
- **IndexedDB** = each player's local copy of the notebook.
- **The static site** = the paper, the games, and the UI.

That combination fits GitHub Pages or Cloudflare Pages.

---

## What is realistic without a server

### Works well

- Two to eight friends in the same room, playing a turn-based game.
- Invite-code rooms with no accounts.
- Live presence (“Maya is here”), turn indicators, rematches.
- Reconnection: a player who drops can rejoin the same room and sync from any player who is still online.
- Late joining: a new player receives the full action history from an existing player.
- Local persistence: each player's browser keeps the room in IndexedDB, so a refresh does not lose the game.
- Static hosting on GitHub Pages or Cloudflare Pages, with no backend to maintain.

### Has caveats

- **No global room registry.** We cannot mathematically guarantee a code is unique. With a long enough code the chance of a collision is negligible, but not zero.
- **No persistence when everyone is offline.** If all players close the tab, the room disappears from the network. Each player still has a local copy; when two of them come back online, Yjs merges their copies. A brand-new player cannot join while nobody with the game is online.
- **No server authority.** A determined player can tamper with the shared document. For friends and casual play this is fine. For ranked or competitive play, you need a server.
- **Some networks need TURN.** Public STUN handles most home networks. Symmetric NAT, corporate firewalls, and some mobile carriers need a relay. Cloudflare TURN has a generous free tier, but issuing temporary credentials needs a small server or Worker.
- **Hidden-information games are harder.** Battleship, card games, and anything with secret state cannot use a public action log, because every player would see the secrets. Start with perfect-information games.
- **Public signaling is best-effort.** Public Nostr relays can be slow or rate-limited. Use several relays and a retry UI; a self-hosted relay is the reliability upgrade.

### Not a good fit (yet)

- Ranked matchmaking, global leaderboards, accounts, anti-cheat.
- Hundreds of spectators per room.
- Games with secret state, unless we add private per-player channels or a server.
- Guaranteed room-code uniqueness.

---

## Recommended architecture

```
Player A (host)                              Player B (guest)
┌──────────────────────────┐                ┌──────────────────────────┐
│  Game UI (canvas/DOM)    │                │  Game UI (canvas/DOM)    │
│  Pure game reducer       │                │  Pure game reducer       │
│  Y.Doc                   │◀── WebRTC ────▶│  Y.Doc                   │
│  IndexedDB cache         │   encrypted    │  IndexedDB cache         │
└────────────┬─────────────┘                └────────────┬─────────────┘
             │                                           │
             └──── public signaling (Nostr relays) ──────┘
                          no app server
```

### The stack

- **Vite + TypeScript** for a static, fast site. No framework required; a small shared UI layer is enough.
- **Yjs** for shared state.
- **Trystero** for serverless WebRTC rooms and peer discovery.
- **y-webrtc-trystero** (community provider) for the first spike, or a small custom provider on top of Trystero if the package is not solid enough.
- **y-indexeddb** for local persistence.
- **y-protocols/awareness** for presence and player cursors.
- **Canvas** for the game boards, matching the existing paper-and-pencil look.

Why not y-websocket? It is excellent, but it needs a WebSocket server. y-webrtc is the standard WebRTC provider, but its default public signaling servers are a weak point. Trystero swaps that signaling layer for public Nostr relays and keeps the data peer-to-peer.

### Hosting

Both work because the output is just HTML, CSS, and JavaScript:

- **GitHub Pages** — simplest. Push a repo, enable Pages, done. HTTPS included. Good for a prototype.
- **Cloudflare Pages** — recommended for the public app. Free static hosting, global CDN, preview deployments, custom domains, and a path to Cloudflare Workers if we later add TURN credentials or a relay. Cloudflare now points new projects toward Workers with static assets, but Pages is still a fine fit for a static site.

No server code is needed for the core game. If we later add a TURN credential Worker, Cloudflare is the smoother host.

---

## Multiplayer and sync design

### The core decision: sync actions, not pixels

Each game exposes a **pure reducer**:

```
createState(seed) -> state
reduce(state, action, playerId) -> { state, error? }
isOver(state) -> boolean
```

The shared room stores an append-only **action log** in a Yjs array. Every client replays the log through the same reducer. This gives us:

- late join for free (send the log, replay it);
- reconnection for free (Yjs merges, replay again);
- a natural move history for the notation panel;
- deterministic state on every device.

For chess, the action is `{ type: "move", from, to, promotion }`. The existing chess engine already validates moves and has passed perft checks, so it becomes the reducer.

For Ludo, actions are rolls and piece moves. For dots and boxes, actions are line draws. For tic-tac-toe, actions are square picks.

### Yjs document shape

```
roomDoc
  meta: Y.Map       // gameId, status, createdAt, settings
  players: Y.Map    // playerId -> { name, color, seat, joinedAt }
  actions: Y.Array  // append-only game actions
  chat: Y.Array     // optional
  awareness         // online presence, cursor, selected piece
```

- `meta` and `players` are small maps.
- `actions` is the source of truth for the game.
- `awareness` is ephemeral and is not persisted.
- `y-indexeddb` stores the doc locally per room.

### Connection lifecycle

1. Host opens the game, chooses **Play with a friend**, and gets a code.
2. Host's browser joins the Trystero room and waits.
3. Guest opens the same game, enters the code, and joins the same Trystero room.
4. Peers connect over WebRTC; Yjs exchanges state vectors and missing updates.
5. Presence appears; the game starts.
6. If a player drops, the others keep the doc. On return, Yjs syncs the missing actions.
7. If the host leaves, nothing breaks: the doc is replicated. The “host” is only a label for room creation and settings.
8. If everyone leaves, each browser keeps a local copy. When two return, they merge. A new player needs at least one existing player online.

### Turn handling and conflicts

- The reducer rejects actions that are not from the player whose turn it is.
- If two actions arrive concurrently, Yjs gives them a deterministic order. The reducer applies the first legal one and flags the second as stale.
- The UI applies moves optimistically, then reconciles when the shared log catches up.
- For chess, undo in multiplayer should be a room action (“request undo”) rather than a local rewind. For the MVP, disable undo in multiplayer or make it host-only.
- Rematch: both players press **Rematch**; a shared flag resets the action log and starts a fresh game.

### Presence and identity

- Generate a random player ID and a friendly pencil name on first visit; store it in localStorage.
- Let players edit their name and pick a pencil color.
- No accounts, no email, no password.
- Show “Maya joined”, “Sam is thinking”, and a small colored pencil dot per player.

### Persistence and reconnection

- `y-indexeddb` loads the local doc instantly, then the network provider syncs.
- Show a clear connection pill: **connected / reconnecting / offline**.
- If the signaling relay is unreachable, retry with backoff and offer “copy invite again”.
- A new player joining a room with no online peers sees “Waiting for someone to come online” rather than an empty board.

---

## Invite codes

### Recommendation: 7 characters, not 4

Use a 32-character alphabet that avoids lookalikes:

```
23456789ABCDEFGHJKLMNPQRSTUVWXYZ
```

Seven characters gives **32^7 = 34.4 billion** combinations. Display it as `ABC-1234` for readability.

Why not 4:

| Code length | Combinations | Collision chance with 1,000 live rooms |
|---|---:|---:|
| 4 | 1.05 M | ~48% |
| 6 | 1.07 B | ~0.05% |
| 7 | 34.4 B | ~0.0015% |

At 10,000 live rooms, 6 characters is already ~4.7% likely to collide somewhere; 7 characters is ~0.15%. Four characters is fine only for a tiny demo.

“Never the same” is impossible without a central registry. Seven random characters makes a collision vanishingly unlikely, and scoping by game makes it even safer.

### Per-game namespace

The room ID is:

```
papergames:${gameId}:${code}
```

So `ABC-1234` on the chess page and `ABC-1234` on the Ludo page are different rooms. This matches the UX you described: the guest opens the specific game first, then enters the code. It also means a chess invite cannot accidentally join a Ludo room.

### Invite link

```
https://papergames.example/chess/#ABC-1234
```

- The game path selects the game.
- The code lives in the URL **hash**, so static hosts and CDNs do not see it in request logs.
- Opening the link auto-fills the code and shows “Join Maya's game?”
- Manual entry remains available on every game page, in the same panel position.

### Security notes

- The code is a **capability**, not authentication. Anyone with it can join.
- Seven characters is too short to be a strong encryption key. If privacy matters, add an optional room password and derive an encryption key with PBKDF2/Argon2; the password can travel in the link hash.
- WebRTC data channels are DTLS-encrypted in transit. Public signaling sees room metadata and IP addresses, not the game data.
- Without a server we cannot rate-limit code guessing at the app layer. Seven characters makes brute force impractical; public relays add their own limits.

---

## Platform structure

### The hub

A notebook-cover index page:

- **Paper Games** masthead.
- Filter chips: All, Multiplayer, 2-player, 3–4 players, Party, Solo, Quick, Classic.
- Search.
- Game cards with a hand-drawn cover, player count, and a “multiplayer” stamp.
- A “Join with code” shortcut that asks the player to open the game first (or routes by game if the link contains the game path).

### Shared game shell

Every game page uses the same shell:

- the paper background and typography;
- the same top bar: game name, connection state, players;
- the same **Play with a friend** panel in the same place;
- the same room code display, copy button, and join input;
- the same “waiting for players”, “reconnecting”, and “game over” states.

That consistency is the product. A player should never wonder where the invite code goes.

### Game module contract

Each game is a folder with an `index.html` and a module exporting:

```
id, title, blurb, tags, minPlayers, maxPlayers, mode
createState(seed)
reduce(state, action, playerId)
isOver(state)
render(ctx, state, view)
```

The shared room layer handles Yjs, presence, invites, reconnection, and the panel. The game only handles its rules and drawing.

### Suggested catalog order

Start with games that are easy to make correct and fun with two people:

1. Chess (already built; 2 players)
2. Tic-tac-toe (2 players)
3. Dots and boxes (2 players)
4. Connect four (2 players)
5. Checkers (2 players)
6. Ludo (2–4 players)
7. Snakes and ladders (2–4 players)
8. Reversi (2 players)
9. Nine men's morris (2 players)
10. Backgammon (2 players)

Keep Snake as a solo game for now. A real-time multiplayer Snake is a different synchronization problem (lockstep or host-authoritative ticks) and should come after the turn-based platform is solid.

Hidden-information games such as Battleship or card games need private state. They are a later phase, not part of the first multiplayer release.

---

## Hosting and deployment

### GitHub Pages

- Free, static, HTTPS.
- Push the built site to `main` or `gh-pages`.
- Good for a prototype and for a repo-first workflow.
- No server-side headers, no Workers. Fine for the pure P2P build.

### Cloudflare Pages

- Free static hosting on Cloudflare's edge.
- Connect the repo, set the build command (`npm run build`) and output directory (`dist`).
- Preview deployments for every branch.
- Custom domain and TLS.
- If we later need TURN credentials or a tiny relay, Cloudflare Workers are right there.

### Recommendation

Build the static site so it runs on both. Use **Cloudflare Pages** for the public deployment and keep GitHub Pages as a zero-config fallback.

### What “static” means here

The game logic, the board rendering, the invite panel, the Yjs document, and the IndexedDB cache all run in the browser. The only external services are public signaling relays, public STUN, and optionally a TURN relay. There is no application server to deploy or maintain.

---

## Security and fairness

- **Casual by design.** Friends-only rooms, no accounts, no public matchmaking.
- **Client-side validation.** Each client validates moves. A modified client can cheat; accept that for v1.
- **No secrets in public logs.** Only perfect-information games in the first release.
- **Optional room password.** Derive an encryption key and encrypt Yjs updates. The password travels in the link hash, not the server.
- **No PII.** Names are local and disposable. Room codes are in the hash. Analytics, if any, should be privacy-friendly and aggregate.
- **Abuse.** No global chat or public room list, so there is little surface area. Add reporting/moderation only if the platform becomes public and persistent.

---

## Roadmap

### Phase 0 — static foundation

- Put the existing Snake and Chess pages in the repo.
- Build the hub, the game catalog, tags, filters, and shared theme.
- Make every game page a folder with a clean URL.

### Phase 1 — multiplayer vertical slice

- Add the shared room panel: create, join, copy link, connection state, players.
- Add Yjs + Trystero + IndexedDB.
- Make Chess multiplayer with the action-log model.
- Test two browsers, two devices, refresh, disconnect, reconnect, and late join.
- Deploy to Cloudflare Pages.

### Phase 2 — prove the game contract

- Add Tic-tac-toe and Dots and boxes using the same reducer and room layer.
- Add the multiplayer tag/filter in the hub.
- Add rematch, leave, and “waiting for opponent”.
- Add a small “how to play with a friend” card on each game page.

### Phase 3 — reliability

- Use multiple Nostr relays; add retry and error states.
- Add a Cloudflare Worker to mint Cloudflare TURN credentials if testing shows connection failures.
- Optionally add a tiny WebSocket relay for signaling.
- Add Playwright tests with two browser contexts.

### Phase 4 — more games

- Checkers, Connect four, Ludo, Snakes and ladders, Reversi, Nine men's morris, Backgammon.
- Add real-time Snake only if the turn-based platform is stable.
- Consider a small backend only for accounts, leaderboards, or hidden-information games.

---

## Decisions I would take

1. **Transport:** WebRTC peer-to-peer via Trystero, public Nostr relays, no server to run.
2. **Sync:** Yjs CRDT + action log + IndexedDB.
3. **Room code:** 7 characters from a 32-character unambiguous alphabet, scoped by game, in the URL hash.
4. **State model:** pure reducers; the log is the source of truth.
5. **UI:** one shared multiplayer panel in the same place on every game page.
6. **Hosting:** static Vite build, Cloudflare Pages first, GitHub Pages compatible.
7. **Identity:** local random name and pencil color; no accounts in v1.
8. **Scope:** 2–8 players, turn-based, perfect-information games first.
9. **Reliability:** design the transport as a swappable layer; add a tiny Cloudflare Worker for TURN only if real-world testing shows it is needed.
10. **Security:** friends-only capability codes; no ranked play, no hidden information, no global room list.

---

## The honest bottom line

The idea is sound. A static, invite-only, peer-to-peer Paper Games platform is a good fit for Yjs, and it can live on GitHub Pages or Cloudflare Pages.

The part to plan around is not the game logic — it is the network. Public signaling and NAT traversal are the two places where “no server” becomes “no server that we operate, but we depend on someone else's.” That is acceptable for a friends-and-family launch. If Paper Games becomes popular, the first paid or serverless addition should be a tiny TURN/signaling Worker, not a full game server.

---

## Sources

- Trystero — serverless WebRTC rooms and public signaling: https://trystero.dev/
- Trystero repository: https://github.com/dmotz/trystero
- y-webrtc-trystero — Yjs provider over Trystero: https://github.com/WinstonFassett/y-webrtc-trystero
- y-trystero — minimal alternative: https://github.com/kahnpoint/y-trystero
- Yjs documentation: https://docs.yjs.dev/
- y-webrtc — WebRTC provider and public signaling: https://github.com/yjs/y-webrtc
- Cloudflare Realtime TURN (free tier, pricing, STUN): https://developers.cloudflare.com/realtime/turn/
- Cloudflare Pages — static hosting: https://developers.cloudflare.com/pages/
- GitHub Pages: https://docs.github.com/en/pages
- MDN WebRTC API (STUN/TURN, data channels): https://developer.mozilla.org/en-US/docs/Web/API/WebRTC_API
