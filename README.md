# AbuNashmi's Mafia

A browser Mafia game for real tables. No install, no accounts, no server — one
player's browser hosts the game and everyone else joins with a 6-character room
code.

## Playing

Open the site, create a room, and share the code. Everyone else picks **Join a
room**. That is the whole setup.

- **Automated mode** — the game runs itself. No one has to referee; the clock
  drives night, day, votes and the win check.
- **Moderated mode** — a human referee steers from a slide-over panel: they see
  every role, and can walk the table through the night step by step, override a
  player's action, arm or disarm the timer, and flip back to automated play
  mid-game. Both styles are switchable live.
- **English / Arabic** with full RTL. The toggle is in the header.

Four roles: Mafia, Doctor, Detective, Civilian.

## How it works

The host's browser is the authoritative server. It holds the only real copy of
the game state and sends each player a projection containing only what they are
allowed to see — secrets are never placed in the payload, rather than being
hidden in the UI. Communication is PeerJS (WebRTC data channels) with the public
PeerJS broker used for signalling only; after the handshake, players talk
directly to the host.

## Fairness

- Roles are dealt with two independent Fisher-Yates shuffles using
  `crypto.getRandomValues`.
- A SHA-256 commitment to the deal is published before play and revealed at the
  end, so the host cannot change roles after the fact.
- Messages carry a monotonic sequence number and a phase id, so a stale or
  replayed action is rejected rather than applied late.
- Seat identity is derived by the host; a client cannot claim to be the
  moderator or another player by saying so.

## Running locally

The game is static files, so any static server works:

```
node tools/serve.js
```

Opening `index.html` directly from the filesystem will not work — ES modules and
the PeerJS vendor script need an HTTP origin.

## Tests

```
node --test tests/*.test.mjs
```
