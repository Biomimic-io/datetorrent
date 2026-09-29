# DateTorrent

Open-source dating with no required server. Profiles are commits in a git
database that people replicate peer-to-peer over
[GitTorrent](https://github.com/cjb/GitTorrent). Matching runs on your own
machine. Photos, likes and messages are encrypted on your device, and each
photo only opens for the people you give its key.

**Holding someone's data never grants access to their private content. Only
receiving keys does.**

```
npm install --global gittorrent          # the transport (git-remote-gittorrent + gittorrentd)
git clone gittorrent://<hash>/datetorrent && cd datetorrent   # or clone it any other way
npm install
node bin/datetorrent.js init
node bin/datetorrent.js ui               # http://127.0.0.1:4242
```

Needs Node 20+ and git. Runtime dependencies: [libsodium](https://doc.libsodium.org/)
for all cryptography, and [three.js](https://threejs.org/) for the swipeable
card stack (served locally, never from a CDN).

## What it does

- **Signed profiles** in a shared git database. Nobody can edit yours, and
  sync rejects anything forged or tampered with.
- **Local matching:** a mutual gender and age-range filter, then a score based
  on interests (55%), region (30%) and age fit (15%).
- **Anonymous likes and messages:** sealed boxes that every peer stores but
  only the recipient can open. Observers can't see who liked whom.
- **Encrypted photos with per-match sharing.** Each photo gets its own key,
  and location/camera metadata is stripped before encryption. Public photos
  publish their key; private ones go only to matches you pick.
- **Chat with inline photo sharing.** Shared private photos appear in the
  conversation, iMessage-style, and open in a full-screen viewer.
- **A native-feeling UI** that follows Apple and Material conventions: a 3D
  swipe deck, sheets, Undo snackbars, light and dark themes, and a bottom tab
  bar on phones. It's keyboard-accessible and respects reduced motion.
- **Private blocking**, stored in your sealed catalog.
- **Recovery codes** that restore your identity, photos, matches and blocks
  from any peer.
- **Gossip discovery:** add one peer, and profiles lead you to others.

## How it works

```
~/.datetorrent/                    (DATETORRENT_HOME)
  identity.json                    your keys (0600, never shared)
  .gittorrentrc, ed25519.key       gittorrentd config and its DHT key
  datetorrent-db/                  the database, branch master
    profiles/<id>.json             signed public profile
    vault/<id>.json                your private catalog, sealed to you
    media/<sha256>.bin             encrypted photos
    mail/<sha256>.json             sealed likes, messages, photo grants
    backup/<locator>.json          identity encrypted under a recovery code
  datetorrent -> this repo         served too, so peers can clone the app itself
```

Each person only writes files named after their own key or named by their
content hash, so replicas never conflict. `sync` never runs `git merge`: it
verifies every file from a peer and copies across only what passes. The full
design, crypto and acceptance criteria are in
[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

## CLI

```
datetorrent init [--from <url>]
datetorrent profile --name Sam --age 32 --gender man --seeking woman,nonbinary \
  --ages 25-40 --region "Portland, OR" --interests jazz,climbing --bio "..."
datetorrent discover | like <id> | pass <id> | unlike <id> | block <id> | unblock <id>
datetorrent matches | msg <id> "text" | chat <id>
datetorrent photo add <file.jpg> [--public] | photo ls | photo share <id> <obj>...
datetorrent photo public|private|rm <obj> | photo get <owner> <obj> <out.jpg>
datetorrent backup | restore <code> --from <url>
datetorrent peer add <url> [name] | peer ls | peer rm <name>
datetorrent sync
datetorrent serve [--git-daemon] [--sync-minutes 10] [--no-app]
datetorrent ui [--port 4242]
```

Ids and photo ids can be shortened to any unique prefix. The web UI does all of
the above except `serve` and `restore`.

## Try it without other people

```
export DATETORRENT_HOME=/tmp/dt-me
node bin/datetorrent.js init
node bin/datetorrent.js profile --name You --age 30 --gender woman --seeking man,woman
node scripts/demo.js /tmp/dt-demo "$(node bin/datetorrent.js whoami | awk '/^id/{print $2}')"
node bin/datetorrent.js peer add /tmp/dt-demo/hub/datetorrent-db demo
node bin/datetorrent.js sync && node bin/datetorrent.js ui
```

That creates eight people on separate replicas, each with generated
placeholder photos, and four of them already like you. Sample photos you can
upload as yourself are written to `/tmp/dt-demo/samples/`.

In Discover, drag a card right to like or left to pass (or use the buttons, or
the ← → keys). Tap the sides of a card to flip through photos, and tap the
middle (or press space) to turn it over for a full-profile preview.

## Hosting and GitTorrent status (tested September 2026)

`datetorrent serve` runs `gittorrentd` to announce your database and this app
repo on the BitTorrent DHT. It records your `gittorrent://<hash>/…` URL in
your profile, re-announces on change, and pulls from peers every 10 minutes.

GitTorrent 0.1.9 still installs on Node 22, but:

- Its bootstrap hosts (`*.gittorrent.org`) no longer resolve. `serve` writes a
  `.gittorrentrc` that uses the public mainline DHT routers instead, and with
  that gittorrentd joins the DHT and announces commits.
- Mainline nodes reject its pre-standard BEP 44 mutable-key `put`
  (`203 invalid token`, `204 Unknown query type`). Your URL is recorded, but
  strangers can't resolve it until that's fixed (see the roadmap).

The database doesn't depend on the DHT: it syncs over any git remote. Until
then, run `serve --git-daemon` and share `gittorrent://<your-host>/datetorrent-db`
or `git://<your-host>/datetorrent-db`. HTTPS remotes, ssh, or a folder on a USB
stick also work. Hosted relays (including Cloudflare) are planned only as
optional adapters. The app must always work without them.

## Privacy and safety

- **Profiles and public photos are public and permanent.** Git history keeps
  old versions, and removing publishes a tombstone but can't recall copies.
- **Sharing a photo gives a permanent key.** Unmatching or blocking stops
  future sharing, but it can't take back what was shared. The app says so
  where it matters.
- Replicas can see when you publish and how many files you have, but not with
  whom you interact.
- Messages don't have forward secrecy yet (see the roadmap).
- A recovery code is as powerful as your keys. Keep it offline.
- Age is self-declared (18+ is enforced by the schema, not verified).
- The web UI listens only on 127.0.0.1 and rejects foreign Host headers,
  cross-site writes and framing.

## Contributing

Contributions are welcome. See [CONTRIBUTING.md](CONTRIBUTING.md) for setup
and ground rules, [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md#roadmap) for the
roadmap, and [SECURITY.md](SECURITY.md) for reporting vulnerabilities.

`npm test` covers the crypto, replication, matching, forged-data rejection,
and every row of the architecture's acceptance table.

## License

[MIT](LICENSE)
