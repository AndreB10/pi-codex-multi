# @andre-barbosa/pi-codex-multi

Use **multiple ChatGPT (OpenAI Codex) subscriptions** side by side in [pi](https://github.com/earendil-works/pi-mono).

pi supports one login per provider id. This extension clones the built-in
`openai-codex` provider once per ChatGPT account under a distinct provider id
(`codex-<id>`), so each subscription gets:

- its own `/login` entry (browser or device-code flow, same as built-in),
- its own OAuth tokens in `~/.pi/agent/auth.json` (auto-refreshed),
- its own models in `/model`, named `<model> · <label>` to tell them apart,
- its own usage/rate limits — the Codex backend identifies the account from
  the access token itself, so nothing else is needed.

## Install

### From npm

```bash
pi install npm:@andre-barbosa/pi-codex-multi
```

Restart pi or run `/reload` to load the extension. Requires Pi 1.5.2 or newer
and Node.js 22.19 or newer.

If you previously loaded `codex-multi.ts` directly, remove that entry from
`~/.pi/agent/settings.json` (or the copy/symlink in `~/.pi/agent/extensions/`)
so the extension is not loaded twice. Existing accounts and logins are preserved.

### From git

```bash
pi install git:github.com/AndreB10/pi-codex-multi
```

### From a local checkout (development)

```bash
pi install /absolute/path/to/pi-codex-multi
# Or try it for one session:
pi -e ./codex-multi.ts
```

### Managing

```bash
pi update npm:@andre-barbosa/pi-codex-multi
pi remove npm:@andre-barbosa/pi-codex-multi
```

## Quick start

```
/codex add work Work            # registers provider "codex-work"
/login codex-work               # authenticate that ChatGPT account
/codex use work                 # switch the active model to codex-work
/model                          # or pick e.g. "GPT-5.6 Sol · Work" manually
```

Repeat `add` + `login` for each subscription. Your original `/login openai-codex`
account keeps working unchanged.

## Commands

| Command | Effect |
|---|---|
| `/codex` | List accounts, provider ids, login status (email/plan), active marker |
| `/codex add <id> [label]` | Register a new account (then `/login codex-<id>`) |
| `/codex remove <id>` | Unregister, delete stored credentials, forget account |
| `/codex use <id>` | Switch the active model to that account (picker if >1 model) |

`/codex` also reports config problems (invalid/duplicate entries) and any
account that failed to register.

Accounts persist in `~/.pi/agent/codex-accounts.json`:

```json
{
	"accounts": [
		{ "id": "work", "name": "Work" },
		{ "id": "personal", "name": "Personal" }
	]
}
```

`id` must be short alphanumeric (`-`/`_` allowed); it becomes the provider id
`codex-<id>`. `name` is the display label.

## How it works

- pi keys OAuth credentials by `Provider.id` in `~/.pi/agent/auth.json`, so a
  cloned provider with a new id gets a fully isolated credential slot, refresh
  lifecycle, and `/login` menu entry.
- The extension builds each clone from pi's own `builtinProviders()`
  (`@earendil-works/pi-ai/providers/all`) — same base URL, streaming API
  (`openai-codex-responses`), OAuth flow, and baseline model catalog as the
  built-in provider. Models are restamped with the clone's provider id and
  relabeled.
- Each clone implements Pi's native `Provider.refreshModels` contract. Pi's
  normal startup/model-picker refreshes overlay the public `openai-codex`
  catalog from pi.dev, with four-hour freshness checks, ETag revalidation,
  and generation-checked persistence in `~/.pi/agent/models-store.json`.
  Cached catalogs work offline; newer bundled metadata takes precedence over
  older cached catalogs. Failed requests leave last-known models available.
- Catalog requests are public and never send account credentials or rotate
  OAuth tokens. Pi still requires the account to be configured before doing
  network discovery. Cancellation and `PI_OFFLINE` follow Pi's normal refresh
  lifecycle; the extension runs no polling timers.
- `catalog.ts` mirrors Pi's catalog-overlay policy through the public provider
  API because Pi's own `withRemoteCatalog` helper is not publicly exported.
- Login runs the standard ChatGPT OAuth flow (browser on
  `localhost:1455/auth/callback`, or device code for headless machines).

## Caveats

- **One browser login at a time** — the OAuth callback server listens on a
  fixed port (1455). Log accounts in sequentially.
- Each account's refresh token rotates on refresh as usual.
- The config file is validated when loaded: ids must match
  `[a-z0-9][a-z0-9_-]{0,30}` (case-insensitive uniqueness), labels are
  cleaned and capped at 32 chars, and at most 20 accounts are registered.
  `add`/`remove` rewrite the file from the sanitized list, so hand-edits
  self-heal on the next change. Unknown top-level keys in the file are
  dropped on rewrite — keep only `accounts` in it.
- **Credential deletion races** (rare): `/codex remove` deletes the account's
  tokens from `auth.json` with a change-detecting retry so it cannot revert
  another pi session's freshly refreshed tokens. If a same-session token
  refresh completes around the same moment, the deleted entry can reappear
  as an unused orphan — `/logout codex-<id>` removes it (works even though
  the provider is unregistered). Prefer removing accounts while pi is idle.
- New catalog models appear in `/model` automatically after a normal refresh;
  your `/scoped-models` selection and default model do not change automatically.
- Multiple accounts are subject to each subscription's own limits; this is
  per-account parallelism, not unlimited usage. Use in line with OpenAI's
  terms.

## Development notes

- Run ad hoc: `pi -e ./codex-multi.ts`
- Extension imports (`@earendil-works/pi-ai/providers/all`, etc.) are resolved
  by pi's extension loader; no `npm install` is required to *run* it.
- `npm install` installs development dependencies for editor type hints and
  `npm run typecheck`. Pi supplies the runtime peer dependencies.
- Run `npm test` for catalog refresh, offline/cache, cancellation, ETag,
  account isolation, and native Pi Models lifecycle regression tests.
- Gotcha discovered while building this: models returned by a custom
  `Provider.getModels()` must carry the clone's `provider` id — the builtin
  catalog is stamped `openai-codex`, and unstamped models silently vanish from
  the registry's provider-keyed views.

## Publishing

```bash
npm ci
npm publish --dry-run  # runs the typecheck/tests and previews the published files
npm login             # sign in as a user with access to @andre-barbosa
npm publish
```

The package is published publicly as `@andre-barbosa/pi-codex-multi`; no build
step is required. Only `codex-multi.ts`, `catalog.ts`, `package.json`, `README.md`,
`CHANGELOG.md`, and `LICENSE` are shipped. For subsequent releases, bump the
version with `npm version patch` before publishing (npm versions cannot be reused).

## License

MIT
