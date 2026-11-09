# AGKBUILDS

Source for Dylan Borgen's AGKBUILDS work (San Antonio, TX). This repo holds two projects:

| Path | What it is |
|---|---|
| `client/`, `server/`, `shared/`, `drizzle/` | The AGKBUILDS portfolio site, built from a React 19 + Vite + Tailwind starter with an Express / tRPC / Drizzle backend. The portfolio itself only needs the static build (see [plan.md](plan.md)); the published site is maintained in [kannon-stack/kannon.github.io](https://github.com/kannon-stack/kannon.github.io). |
| [`hermes-desktop/`](hermes-desktop/README.md) | **Talaria**, an Electron AI chat desktop app (working title): streaming chat, any OpenAI-compatible provider, tools with approvals, MCP servers, memory, skills and themes. It has its own README, tests and release workflow. |

## Site: develop and build

The project uses `pnpm` (see `packageManager` in `package.json`).

```bash
pnpm install
pnpm dev            # full server (Express + tRPC) with hot reload; honors PORT
pnpm dev:static     # Vite only, no backend (PORT defaults to 3000)
pnpm build:static   # static production build (vite build)
pnpm build          # static build plus bundled server in dist/
pnpm start          # run the production server from dist/index.js
pnpm check          # type check (tsc --noEmit)
pnpm test           # vitest
pnpm db:migrate     # apply checked-in Drizzle migrations
pnpm db:push        # generate and apply new schema changes
pnpm format         # prettier --write .
```

Server-side code lives in `server/` (`routers.ts`, `db.ts`, `storage.ts`, `_core/`). Keep private keys server-side; `server/_core/publicConfig.ts` exposes only the named public runtime values.

## Talaria: develop and release

See [`hermes-desktop/README.md`](hermes-desktop/README.md) for install, build, test and release instructions, and [`hermes-desktop/DESIGN.md`](hermes-desktop/DESIGN.md) for architecture decisions.

## More docs

- [plan.md](plan.md): design direction and implementation plan for the portfolio.
- [TODO.md](TODO.md): implementation outcomes and status.

## License

`package.json` declares MIT.
