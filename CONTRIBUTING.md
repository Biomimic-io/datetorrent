# Contributing to DateTorrent

Thanks for helping build dating software that people own. Start with
[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md): it explains the data model, the
cryptography, and the roadmap, where most open work lives.

## Setup

```
git clone <any DateTorrent remote> && cd datetorrent
npm install
npm test
```

You need Node 20+ and git 2.28+. To try the app with a fake network:

```
export DATETORRENT_HOME=/tmp/dt-me
node bin/datetorrent.js init
node bin/datetorrent.js profile --name You --age 30 --gender woman --seeking man,woman
node scripts/demo.js /tmp/dt-demo "$(node bin/datetorrent.js whoami | awk '/^id/{print $2}')"
node bin/datetorrent.js peer add /tmp/dt-demo/hub/datetorrent-db demo && node bin/datetorrent.js sync
node bin/datetorrent.js ui
```

## Ground rules

These keep the security story true. Pull requests that break them will be
asked to change.

- **Peer data is hostile.** Anything read from another replica goes through
  validation in `lib/schema.js` or `Store.ingest` before it's written or
  trusted. Add a test showing that bad input is rejected.
- **Crypto goes through libsodium.** Use its high-level APIs via `lib/crypto.js`.
  Don't hand-roll constructions or add a second crypto library without an
  issue discussing it first.
- **Never write private material to git in plaintext:** keys, catalogs,
  message state, or anything identifying. If it must be replicated, seal it.
  Live messaging ratchet state should not go into git at all.
- **Don't let the user's git identity leak.** Database commits go through
  `Store.commit`, which uses the anonymous author.
- **Peer-to-peer must keep working.** Hosted services (relays, indexes,
  Cloudflare, anything else) are optional adapters behind an interface; the
  app must work with plain git remotes.
- **The UI never uses `innerHTML` with data.** Build DOM with `h()`, which
  inserts text nodes. Peers control profile text.
- **Say what can't be undone.** If a feature shares a key or publishes
  something, the UI copy says it can't be recalled.
- **Dependencies:** runtime dependencies are libsodium (crypto) and three.js
  (the Discover card stack, served from `node_modules`). Adding another needs
  a reason in the PR description. The UI must never load code from a CDN.

## Tests

`npm test` runs `node --test`. `test/acceptance.test.js` covers the product's
security promises, one test per row of the acceptance table in the
architecture doc. New features that make a privacy or security claim should
add a row and a test.

## Pull requests

- Keep each PR to one concern, and say what it does and how you verified it.
- Match the surrounding style: two-space indent, no semicolons, and
  `'use strict'` CommonJS.
- Don't break the on-disk formats (`profiles/`, `vault/`, `media/`, `mail/`,
  `backup/`) without a version bump and a migration note. Other people's
  replicas depend on them.

## Security issues

Please don't open public issues for vulnerabilities. See [SECURITY.md](SECURITY.md).

## License

By contributing you agree that your contributions are licensed under the
[MIT License](LICENSE).
