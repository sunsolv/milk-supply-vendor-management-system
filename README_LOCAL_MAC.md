# Local macOS setup

This project runs as one Node.js process. Express provides the API and mounts the
Vite-powered React frontend in development. By default it is available at
`http://127.0.0.1:5173/`.

## Detected environment

- macOS 26.4 on Intel (`x86_64`)
- Node.js 20.19+, 22.12+, or 24+ (required by Vite 7)
- Node.js 24.14.0 is available in the Codex bundled runtime on this Mac
- pnpm 11.7.0 with `pnpm-lock.yaml`
- Git 2.37.0 and Xcode Command Line Tools are installed
- MongoDB is optional; the current configuration uses the existing local JSON store

The system `/usr/local/bin/node` is version 16.16.0 and is not compatible with
Vite 7. Do not use it for this project. `run-mac.sh` automatically locates the
compatible bundled Node runtime, or you can set `NODE_BIN` to another compatible
Node executable.

## One-time dependency installation

From the project root, put a compatible Node executable first on `PATH`, then use
the existing lockfile:

```sh
export PATH="$HOME/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin:$HOME/.cache/codex-runtimes/codex-primary-runtime/dependencies/bin/fallback:$PATH"
CI=true pnpm install --frozen-lockfile
```

This installs packages only into the project and its pnpm store. Do not run the
install command on every launch. The lockfile must remain unchanged.

## Environment configuration

The existing `.env` is loaded automatically and is excluded by `.gitignore`. If a
new local checkout has no `.env`, create it once without overwriting an existing
file:

```sh
cp .env.example .env
```

Review these settings in `.env` without committing or sharing their values:

- `PORT`: local HTTP port; defaults to 5173
- `JWT_SECRET`: required for authenticated sessions
- `SUPER_ADMIN_NAME`, `SUPER_ADMIN_EMAIL`, and either the password or password-hash setting
- `MONGODB_URI`: optional; leave empty to use the local JSON store
- `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASS`, and `EMAIL_FROM`: required for real OTP and password-reset email

Use actual SMTP credentials only when email workflows need to be tested. Never
commit `.env`.

## Database

With `MONGODB_URI` empty, data is stored in the existing
`server/data/app-data.json`. The file is ignored by Git. The launcher never
deletes, resets, seeds, migrates, or overwrites it.

There are no database migration or seed commands in this project. If
`MONGODB_URI` is configured, the server connects to that existing MongoDB
database; ensure it is reachable before starting.

## Start and stop

```sh
./run-mac.sh
```

Open `http://127.0.0.1:5173/`, or the port configured in `.env`. The backend and
frontend run together, so no second terminal is required. Press Ctrl-C in the
terminal to stop the server safely.

To use another compatible Node installation:

```sh
NODE_BIN=/absolute/path/to/node ./run-mac.sh
```

The launcher checks the Node version, `.env`, installed dependencies, and port
availability. It will not stop an unrelated process if the port is occupied.

## Build and validation

Use the compatible runtime on `PATH` shown above:

```sh
CI=true pnpm run build
```

The repository currently declares no automated test, lint, type-check, or
migration scripts. A protected API can be checked without changing data:

```sh
curl -i http://127.0.0.1:5173/api/vendor/dashboard
```

An unauthenticated request should return HTTP 401. Do not test registration,
OTP, login, approval, or record-editing workflows unless valid local credentials
are available and changing the configured data is intended.

## Production-style local run

Build first, then run the already-built frontend through Express:

```sh
CI=true pnpm run build
NODE_ENV=production ./run-mac.sh
```

## Troubleshooting

- **Unsupported Node version:** use `./run-mac.sh`, or set `NODE_BIN` to Node
  20.19+, 22.12+, or 24+.
- **Dependencies missing:** run the frozen-lockfile installation once. Do not
  delete or regenerate `pnpm-lock.yaml`.
- **Port already in use:** stop the service you recognize or choose another
  unused `PORT` in `.env`; the launcher does not terminate processes.
- **MongoDB connection failure:** verify the existing `MONGODB_URI`, or leave it
  empty to retain the project's local-store development mode.
- **Email/OTP failure:** verify the SMTP settings and provider access. OTP values
  are deliberately not shown in the UI or logs.
- **Blank production page:** run the build command before starting with
  `NODE_ENV=production`.
