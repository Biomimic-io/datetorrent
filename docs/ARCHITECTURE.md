# Architecture

DateTorrent is a dating app with no required server. Each person owns a signed
record in a git database that peers replicate over GitTorrent or any other git
transport. Encryption happens on the user's device, and matching runs there
too.

**The central rule:** holding someone's data never grants access to their
private content. Only receiving keys does.

## Principles

1. **Peer-to-peer first.** Every feature must work with nothing but git remotes.
   Hosted helpers such as relays, discovery indexes, or a Cloudflare Worker are
   welcome as optional adapters, never as requirements.
2. **Everything from a peer is hostile until verified.** Signatures, schemas,
   sizes and content hashes are checked before any file enters a replica.
3. **Crypto only through libsodium's high-level APIs.** No home-made primitives.
4. **No false promises.** The UI and docs say plainly what cannot be revoked
   (shared keys, git history, public profiles).

## Components

| Component | Where | Job |
|---|---|---|
| Identity | `lib/crypto.js`, `~/.datetorrent/identity.json` | Ed25519 signing key (your id) and X25519 box key, created on the device |
| Database | `lib/store.js`, `~/.datetorrent/datetorrent-db/` | A git repo on `master`, replicated and merged by verification |
| Validation | `lib/schema.js` | The rules any file from a peer must pass |
| Media | `lib/image.js`, `lib/crypto.js` | Metadata stripping and per-photo encryption |
| Matching | `lib/match.js` | Local compatibility filter and score |
| Transport | `lib/gittorrent.js` | Runs `gittorrentd`, falls back to `git daemon`; any git URL works as a peer |
| UI | `lib/server.js`, `public/index.html` | Local-only web app on 127.0.0.1 |
| CLI | `bin/datetorrent.js` | Everything the UI does, plus `serve` and `restore` |

## Data model

```
datetorrent-db/
  profiles/<id>.json      signed public profile
  vault/<id>.json         signed private catalog, sealed to its owner
  media/<sha256>.bin      encrypted photo
  mail/<sha256>.json      sealed box: like | unlike | msg | grant
  backup/<locator>.json   signed identity backup, encrypted under a recovery code
```

Every writer only touches files named after their own key, or files named by
their own content hash. Replicas therefore never conflict, and `sync` never
runs `git merge`. It lists each peer's tree and copies across only files that
pass validation:

| File | Accepted when |
|---|---|
| profile | Signature by the id in the filename; schema valid (18+, field limits); newer `updated`; **box key unchanged** from the one already pinned |
| vault | Signature by the id in the filename; newer `updated` |
| media | SHA-256 matches the filename, and some verified profile lists it in `media` (so nobody can dump unvouched blobs); 2 MB max |
| mail | SHA-256 matches the filename; well-formed sealed box; 12 KB max |
| backup | Signature by the embedded id; locator matches the filename |

Commits use a fixed anonymous author (`datetorrent <peer@datetorrent.invalid>`).

## Cryptography

| Purpose | Construction |
|---|---|
| Signing profiles, vaults, mail contents | Ed25519 (`crypto_sign_detached`) over canonical JSON |
| Likes, messages, photo grants | `crypto_box_seal` to the recipient's X25519 key. The inner payload is signed by the sender, so the recipient knows who sent it and observers learn neither party |
| Photos | XChaCha20-Poly1305 IETF, a fresh 256-bit key and random 192-bit nonce per photo, with the owner's id as associated data |
| Private catalog | `crypto_box_seal` to your own key |
| Recovery backup | XChaCha20-Poly1305 under a 256-bit random recovery code, with the backup locator as associated data |

Mail is replicated to everyone, and each person finds theirs by trial
decryption. A copy of every outgoing event is also sealed to the sender, so
their history can be rebuilt from any replica.

## Flows

**Photo upload.** The browser resizes the image and re-encodes it through a
canvas, which drops EXIF and GPS. The server strips JPEG metadata again (the
only step for CLI uploads). It then generates a fresh key, encrypts the photo,
writes `media/<sha256>.bin`, adds `{obj, key}` to the sealed catalog, and adds
`obj` to the profile's `media` list. A public photo also publishes its key in
the profile.

**Matching.** A like is a signed, sealed event with a per-sender sequence
number `n`. For each direction, the event with the highest `n` wins, so a
replayed old like can't override a later unlike, even if the sender's clock
went backwards. A match is a current like in both directions, with neither
side blocked.

**Sharing photos.** Only with a current match. A `grant` event carries
`{obj, key}` for the selected photos, sealed to the match. The same ciphertext
serves every recipient, with nothing re-uploaded. Recipients show granted
photos only while the match holds.

**Unmatch and block.** Future sharing stops on the sender's device
immediately, and that's where it's enforced. Keys already delivered can't be
recalled, and the UI says so. Blocking is private: it unlikes, and the block
list lives in the sealed catalog.

**Recovery.** `backup` generates a recovery code and stores the identity,
encrypted under it, in `backup/`. Anyone replicating the database stores the
ciphertext. `restore <code> --from <peer>` fetches it, decrypts the identity,
and syncs. The sealed catalog then brings back photo keys, grants and blocks.

## Acceptance criteria

From the original architecture proposal. Each row is a test in
`test/acceptance.test.js`.

| Scenario | Required result | Status |
|---|---|---|
| A stranger copies Alice's repository | Private photos and keys remain unreadable | ✅ |
| Bob receives access to three photos | Only those three become readable | ✅ |
| Charlie receives a different selection | Bob's and Charlie's permissions stay independent | ✅ |
| A host alters an encrypted object | The client rejects it | ✅ |
| A service substitutes an unexpected identity key | The client does not silently release private content | ✅ (key pinning) |
| Alice unmatches Bob | New content remains inaccessible to Bob | ✅ |
| Bob retains an old photo key | The app makes no false promise of retroactive deletion | ✅ |
| Alice moves hosting providers | Her identity and authorized access continue working | ✅ |
| Alice restores a backup | Recovery succeeds without exposing keys to the host | ✅ |

## Known limits

- **Metadata is visible:** when someone publishes, how many files they have,
  and approximate photo sizes. It is not visible who liked or messaged whom.
- **Everyone replicates everything.** Fine for a small network, not for a
  large one. See the roadmap.
- **Messages have no forward secrecy yet.** They are sealed to long-lived keys
  and kept in git history, so a stolen box key exposes past messages to anyone
  who kept a replica.
- **No key rotation.** Box keys are pinned on first sight, so a legitimate
  rotation is currently rejected like an attack.
- **Anyone can add mail.** Junk is capped at 12 KB per file and costs
  recipients a failed decryption each.
- **GitTorrent's DHT layer is dated.** Its bootstrap hosts are gone, and
  mainline nodes reject its pre-standard BEP 44 `put`. See the README.

## Roadmap

Roughly in priority order. Each item is a good place to contribute.

1. **Forward-secret messaging.** A Double Ratchet over sealed-box bootstrap,
   with live ratchet state kept out of git and history as an opt-in encrypted
   archive. Needs an audited, permissively licensed implementation, or a
   decision to adopt libsignal (AGPL).
2. **Device linking.** Authorise a second device's keys from the first through
   a verified (QR) flow.
3. **Key rotation.** A signed rotation record from the old key, plus
   fingerprint/QR verification for matches.
4. **Partial replication.** Opt-in regional indexes and fetching only the
   media and mail you need, instead of every file.
5. **Sharing modes.** Ongoing album access, and auto-share-on-match presets.
6. **Transports.** Fix GitTorrent's BEP 44 compatibility (upstream or fork),
   add an optional relay adapter (a Cloudflare Worker + R2 is one candidate),
   and a WebTorrent/browser path.
7. **Moderation hooks.** Report flows where a user deliberately submits content.
