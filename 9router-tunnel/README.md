# 9router on your machine + free Cloudflare Tunnel

The free alternative to `../9router-cloudflare` (which needs the Workers Paid plan).
9router runs in Docker on a machine you control; `cloudflared` makes an outbound-only
connection to Cloudflare and gives it a public HTTPS URL. No inbound ports, no port forwarding.

```
CLI tools / browser ──▶ Cloudflare edge ──▶ cloudflared ──▶ 9router :20128 ──▶ volume (SQLite)
```

The SQLite DB sits on a normal Docker volume, so none of the Litestream/R2 machinery is needed.
The trade-off: the URL only works while this machine and Docker are running.

## Prerequisites

- Docker with Compose v2
- About 2 GB of free RAM for the container (upstream reports 512 MB runs out of memory)
- For the stable-hostname option: a free Cloudflare account with a domain on it

## 1. Configure

```bash
cd 9router-tunnel
cp .env.example .env
```

Edit `.env`: set `INITIAL_PASSWORD` and generate the three secrets:

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

## 2. Start 9router

```bash
docker compose up -d
docker compose logs -f 9router
```

Open <http://localhost:20128>, sign in, add providers, create an API key.
The container is bound to `127.0.0.1` only.

## 3. Make it public (pick one)

### A. Quick tunnel: no account, no domain, random URL

```bash
docker compose --profile quick up -d
docker compose logs cloudflared-quick   # look for https://<random>.trycloudflare.com
```

The URL changes every time the tunnel container restarts, and Cloudflare offers no uptime
guarantee for quick tunnels. Good for trying it out. Set `BASE_URL` in `.env` to the URL and run
`docker compose up -d` again so 9router knows its public origin.

### B. Named tunnel: stable hostname on your domain (free)

1. Cloudflare dashboard → **Zero Trust → Networks → Tunnels → Create a tunnel** → type *Cloudflared*.
2. Copy the tunnel **token** into `.env` as `TUNNEL_TOKEN`.
3. Add a **public hostname**, for example `9router.example.com`, with service type **HTTP** and
   URL `9router:20128` (the compose service name, not `localhost`).
4. Set `BASE_URL=https://9router.example.com` in `.env`.
5. Start it:
   ```bash
   docker compose --profile tunnel up -d
   ```

## 4. Lock it down

Your provider OAuth tokens and keys live behind that URL.

- `REQUIRE_API_KEY=true` is already set, so `/v1/*` needs a Bearer key.
- Add a **Cloudflare Access** policy (Zero Trust → Access → Applications) on the hostname so the
  dashboard needs a login. If your CLI tools can't send Access service-token headers, scope the
  policy to everything except `/v1/*`.
- Keep `AUTH_COOKIE_SECURE=true` (the default) when using the tunnel, since it is HTTPS.
  If you open the dashboard over plain `http://` on a LAN IP, the browser will drop the cookie;
  use `localhost` or the tunnel URL.

## Everyday commands

```bash
docker compose ps
docker compose logs -f
docker compose down            # stop (keeps data)
docker compose down -v         # stop AND delete the data volume
```

Back up the data volume:

```bash
docker run --rm -v 9router-tunnel_9router-data:/data -v "$PWD":/backup alpine \
  tar czf /backup/9router-data.tgz -C /data .
```

(The volume name is `<folder>_9router-data`; check `docker volume ls` if you renamed the folder.)

## Upgrading

Set `NINE_ROUTER_VERSION` in `.env` (tags: <https://hub.docker.com/r/decolua/9router/tags>), then:

```bash
docker compose pull && docker compose up -d
```

## Keeping it always on

For a PC that sleeps or reboots, `restart: unless-stopped` brings the containers back when Docker
starts. For truly always-on, run the same folder on an always-free VM (for example Oracle Cloud
Always Free ARM; the 9router image is published for arm64). Nothing here changes.

## Not verified yet

Written without Docker available on the authoring machine, so nothing here has been run.
Worth confirming on first start:

- `docker compose config` parses cleanly and `docker compose up -d` brings 9router up on :20128.
- The named-tunnel flow with your account's current dashboard layout (menu names move around).
- 9router behaves correctly behind the tunnel, including streaming (SSE) responses from `/v1/chat/completions`.
- `cloudflare/cloudflared:latest` is unpinned; pin a version tag once you have one that works.
