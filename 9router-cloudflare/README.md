# 9router on Cloudflare Containers

Runs the official [`decolua/9router`](https://github.com/decolua/9router) image as a
[Cloudflare Container](https://developers.cloudflare.com/containers/) behind a small Worker.
This is separate from the `agkbuilds` site; it has its own `package.json` and `wrangler.jsonc`.

```
CLI tools / browser ──▶ Worker (src/index.ts) ──▶ Durable Object (NineRouter) ──▶ Container :20128
                                                                                   │
                                                          Litestream ◀────────────┘
                                                              │  (SQLite WAL stream)
                                                              ▼
                                                        R2 bucket
```

## Why Litestream

Container disks are ephemeral: after the container sleeps, the next start gets a fresh disk.
9router keeps providers, API keys and usage history in `/app/data/db/data.sqlite`.
`start.sh` restores that file from R2 on boot and runs 9router under `litestream replicate`,
which streams changes to R2 and does a final sync on `SIGTERM` (Cloudflare allows up to 15 min to exit).

Only the SQLite DB is persisted. Other files under `/app/data` (logs, generated certs, runtime config)
are regenerated on boot. If you find 9router state that lives outside `db/data.sqlite`, add it to the backup.

## Prerequisites

- Cloudflare account on the **Workers Paid** plan (Containers requires it) and an R2 subscription
- **Docker** running locally. `wrangler deploy` builds and pushes the image. (Alternative: Workers Builds in CI.)
- Node 20+

## Deploy

```bash
cd 9router-cloudflare
npm install
```

1. **Create the R2 bucket** (name must match `R2_BUCKET` in `wrangler.jsonc`):
   ```bash
   npx wrangler r2 bucket create nine-router-data
   ```
2. **Create an R2 API token** (dashboard → R2 → Manage API tokens) with *Object Read & Write*, scoped to that bucket.
   You get an Access Key ID and Secret Access Key.
3. **Edit `wrangler.jsonc` vars**: `R2_ACCOUNT_ID` (your account ID) and `BASE_URL`
   (the public origin, e.g. your custom domain or `https://nine-router.<subdomain>.workers.dev`).
4. **Set secrets**:
   ```bash
   npx wrangler secret put INITIAL_PASSWORD      # dashboard login; do NOT use 123456
   npx wrangler secret put JWT_SECRET            # long random string
   npx wrangler secret put API_KEY_SECRET        # long random string
   npx wrangler secret put MACHINE_ID_SALT       # long random string
   npx wrangler secret put R2_ACCESS_KEY_ID
   npx wrangler secret put R2_SECRET_ACCESS_KEY
   ```
   Generate random values with `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`.
   Note: the first `wrangler secret put` on a Worker that doesn't exist yet may prompt you to create it; deploying once first also works.
5. **Deploy**:
   ```bash
   npx wrangler deploy
   npx wrangler containers list
   ```
6. Open `BASE_URL`, sign in with `INITIAL_PASSWORD`, connect providers, and create an API key.
   The first request after a deploy or idle sleep is a cold start (container boot, DB restore, Next.js start), typically tens of seconds.
7. Point your CLI at `https://<your-origin>/v1` with the dashboard API key.

Check that persistence works: add a provider, wait ~10 s, stop the container from the dashboard
(Workers & Pages → Containers), hit the URL again, and confirm the provider is still there.
`npx wrangler r2 object list nine-router-data` (or the dashboard) should show objects under `9router/db/`.

## Security

This holds your provider OAuth tokens and keys, and `BASE_URL` is public. The defaults here are
`REQUIRE_API_KEY=true` (Bearer key needed on `/v1/*`) and `AUTH_COOKIE_SECURE=true`.
Strongly consider putting **Cloudflare Access** in front of the dashboard paths (everything except `/v1/*`),
or in front of the whole hostname if your CLI tools can send Access service-token headers.

## Behavior and costs

- **Single instance** (`max_instances: 1`, one Durable Object named `main`). 9router's SQLite DB can't be shared.
- **`sleepAfter = "30m"`** in `src/index.ts`. Running time is billed; idle time past the timeout isn't.
  Raise it if cold starts bother you.
- **`standard-1`** (4 GiB RAM, 1/2 vCPU, 8 GB disk). 9router OOMs at 512 MB; drop to `basic` (1 GiB) only if you test it.
- Pricing and plan details change; check the [Containers pricing page](https://developers.cloudflare.com/containers/pricing/).

## Upgrading 9router

Change `NINE_ROUTER_VERSION` in `Dockerfile` (tags: <https://hub.docker.com/r/decolua/9router/tags>)
and run `npx wrangler deploy`. The DB is restored from R2 onto the new image. Use numbered tags, not `latest`.

## Local test

```bash
cp .dev.vars.example .dev.vars   # fill in values; needs Docker
npx wrangler dev
```

Without R2 credentials `start.sh` logs a warning and runs without persistence, which is fine for a smoke test.

## Not verified yet

Nothing here has been built or deployed from this machine (no Docker installed). Things to confirm on first run:

- `docker build` succeeds and `litestream restore` / `replicate` talk to R2 (check container logs for `[start]` lines).
- 9router actually uses `db/data.sqlite` via a native SQLite driver. The upstream Dockerfile mentions a `sql.js`
  last-resort driver, which doesn't use WAL; if logs show Litestream complaining about journal mode, tell me and
  we'll switch to periodic file backups instead.
- Streaming (SSE) responses from `/v1/chat/completions` pass through the Worker without buffering.
