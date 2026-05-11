# sqlui-portal

A self-contained, single-binary **web portal for SQL/NoSQL databases** — think
phpMyAdmin or sqlite-web, but for [every dialect sqlui-native
supports](https://github.com/synle/sqlui-native): MySQL, MariaDB, MSSQL,
PostgreSQL, SQLite, Cassandra, MongoDB, Redis, Azure CosmosDB, Azure Table
Storage, Salesforce, and REST API.

---

## 🚀 Quick start — pick one

### curl + tar (no Node manager needed beyond `node` on PATH)

```sh
curl -fsSL https://github.com/synle/sqlui-portal/releases/latest/download/sqlui-portal.tar.gz \
  | tar -xz \
  && ./portal/sqlui-portal ./mydata.sqlite
```

### npx (zero install, runs and exits)

```sh
npx https://github.com/synle/sqlui-portal/releases/latest/download/sqlui-portal.tar.gz \
  ./mydata.sqlite
```

Either flow accepts:

- A path to a **SQLite file** — `./mydata.sqlite`
- One or more **dialect-prefixed connection strings** — `mysql://user:pass@host/db`, `postgres://…`, `mongodb://…`, `redis://…`, etc.
- Multiple positional args at once — they all get added to the portal session.
- **No args at all** — boots empty, add connections in the UI.

The portal binds to `0.0.0.0:19378` by default and auto-opens your browser. Use
`--host 127.0.0.1` to restrict to loopback or `--port <n>` to pick a different
port.

---

## Examples

```sh
# Browse a local SQLite file
./portal/sqlui-portal ./test.sqlite

# Connect to a Postgres database, loopback only, custom port
./portal/sqlui-portal --host 127.0.0.1 --port 8080 "postgres://app:secret@db.local:5432/orders"

# Mix multiple connections in one session
npx https://github.com/synle/sqlui-portal/releases/latest/download/sqlui-portal.tar.gz \
  ./mydata.sqlite \
  "mysql://root:pw@127.0.0.1/wiki" \
  "mongodb://localhost:27017/logs"

# Don't auto-open the browser (for remote / headless boxes)
./portal/sqlui-portal --no-open --host 0.0.0.0 ./data.sqlite
```

## All flags

```
  -p, --port <n>     Listen port. Default 19378. Falls back to random if busy.
      --host <host>  Bind host. Default 0.0.0.0 (exposed on the LAN).
                     Use 127.0.0.1 to restrict to loopback.
      --no-open      Don't auto-open the browser.
      --version      Print version and exit.
      --help         Print full usage.
```

## Pinning to a specific version

The latest-download URL above always serves the newest release. The URLs below
are auto-refreshed by the release script each time we cut a release — copy &
paste directly. See [Releases](https://github.com/synle/sqlui-portal/releases)
for older versions.

<!-- release-version-block:start -->
_No release has been cut yet — this block is auto-populated by `scripts/release.js`._
<!-- release-version-block:end -->

Every release attaches both names: `sqlui-portal.tar.gz` (stable, always points
at the latest) and `sqlui-portal-<version>.tar.gz` (versioned).

## Storage

Portal mode stores its configuration at `~/.sqlui-portal/` — entirely separate
from the desktop app's `~/.sqlui-native/`. You can run both side-by-side without
any interference.

## Requirements

Node.js 22 or newer must be on `$PATH` (or pointed to via `$NODE`). The portal
launcher script probes common locations (fnm, nvm, volta, mise, Homebrew,
`/usr/local/bin`) so version-manager setups generally Just Work.

---

## How releases work

This repo holds a git submodule pin to a specific
[`sqlui-native`](https://github.com/synle/sqlui-native) commit. A weekly
scheduled workflow (Mondays 13:00 UTC) pulls upstream `main`, runs the upstream
test suite, builds the portal bundle, smoke-tests it, and publishes a release.

**The release tag always matches the upstream `sqlui-native` version.** If
upstream hasn't bumped its version, the workflow skips silently — there is no
"force re-release" knob. To re-release with fixes, `sqlui-native` must bump its
`package.json` version first.

Manual trigger:

```sh
# Release latest upstream main
gh workflow run release.yml --repo synle/sqlui-portal

# Release a specific upstream tag / SHA
gh workflow run release.yml --repo synle/sqlui-portal -f sha=v3.1.4
gh workflow run release.yml --repo synle/sqlui-portal -f sha=abc1234
```

## Reporting issues

- **Bug in the portal / a database adapter / the UI**: file at
  [`synle/sqlui-native/issues`](https://github.com/synle/sqlui-native/issues).
- **Bug in the release pipeline of *this* repo**: file at
  [`synle/sqlui-portal/issues`](https://github.com/synle/sqlui-portal/issues).

## License

[MIT](LICENSE)
