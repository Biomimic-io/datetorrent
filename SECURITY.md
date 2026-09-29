# Security

DateTorrent handles dating profiles, private photos and messages, so security
reports are a priority.

## Reporting a vulnerability

Please report privately through GitHub's **Report a vulnerability** button
(Security tab → Advisories) on the project repository. Don't open a public
issue. Include the steps to reproduce, the impact, and the affected version or
commit. We aim to reply within a week.

## What we promise, and what we don't

The promises are tested in `test/acceptance.test.js`. In scope:

- Anyone holding a replica can't read private photos, catalogs, likes,
  messages, grants, or backups.
- Profiles, vaults and events can't be forged or modified without the
  owner's key, and substituted encryption keys are rejected.
- Tampered photos are rejected.
- Photos carry no EXIF or GPS data after upload.
- The local UI can't be driven by other websites (Host check, custom header,
  CSP).

Not promised (documented limits; see docs/ARCHITECTURE.md):

- Keys already shared with a match can't be revoked.
- Public profiles and git history are permanent.
- Activity timing, file counts and sizes are visible to replicas.
- There's no forward secrecy for messages yet.
- A compromised device, or malicious code running as the user, can read
  everything that device can decrypt.
- Age and identity are self-declared.
