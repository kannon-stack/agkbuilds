# AGKBUILDS personal website plan

## Product scope

A single-page personal portfolio for Dylan Borgen, sole proprietor of AGKBUILDS in Texas. The page is a résumé-shaped narrative: an interactive hero, bento-grid about section, six selected project write-ups, an experience timeline, talks and awards, and a contact block.

## Design exploration

- **Neo-terminal editorial** — 0.07 probability. Black terminal surfaces, green signal accents, and editorial typography make the portfolio feel like a live system log.
- **Desert utility** — 0.05 probability. Warm paper, safety orange, and workshop labels create a rugged maker portfolio.
- **Soft systems** — 0.03 probability. Pale grey, blue-violet controls, and rounded cards create a calm product-studio feel.

### Chosen direction: neo-terminal editorial

- **Design movement:** A modern terminal / cybernetic editorial interface with an analog workshop edge.
- **Core principles:** high contrast without harshness; playful motion held inside a strict grid; copy that sounds human and specific; every section should feel useful, not decorative.
- **Color philosophy:** near-black is the canvas; acid green is the ownable signal color; bone-white provides readable editorial contrast; muted mint and olive describe secondary system states.
- **Layout paradigm:** a vertical one-page dossier with a fixed utility rail, asymmetrical bento modules, and wide timeline bands rather than one centered marketing stack.
- **Signature elements:** cursor-reactive radial signal field; bracketed system labels; animated matrix glyph columns and terminal-style microcopy.
- **Interaction philosophy:** movement should reveal structure, not distract. The hero follows the pointer, cards lift slightly on hover, and anchor links make the page feel like a navigable interface.
- **Animation:** slow background glyph drift, a 900ms hero entrance, 160–220ms card hover transitions, and reduced-motion fallbacks for accessibility.
- **Typography system:** a compact sans-serif for readable body copy, a monospace family for labels, metrics, metadata, and brand mark. Large headlines use tight tracking and short line lengths.
- **Brand essence:** one-person build practice for messy, multi-disciplinary problems — resourceful, exacting, unflashy.
- **Brand voice:** direct, observant, lightly wry. Example lines: “I make the complicated part legible.” / “Good work should survive contact with the real world.”
- **Wordmark & logo:** `AGKBUILDS` in a monospaced wordmark with a lime terminal cursor block and a small `TX // 01` system stamp.
- **Signature brand color:** `#B8F23A`, the “signal green” used only for active states, key actions, and important proof points.

## Implementation

- Keep the starter's React/Vite static build; no server or database is needed for a public portfolio.
- Implement the page in `client/src/pages/Home.tsx`, with all project, timeline, and recognition content represented as typed arrays so exact résumé facts can be swapped in without restructuring the UI.
- Use client-side pointer tracking to update CSS variables for the hero glow and subtle card tilt. Keep the effect pointer-only and disable it under reduced-motion or coarse-pointer conditions.
- Build the matrix effect from lightweight inline glyph columns and CSS animation rather than adding an image dependency.
- Keep the route surface to `/` and `/404`, and publish `public/manus-routes.json` with those routes.
- Use static semantic HTML and anchor links for the requested sections; there is no form submission backend. The contact CTA uses a mailto link.

## Project structure

- `client/src/pages/Home.tsx` — page composition, content arrays, pointer interaction, and accessible section markup.
- `client/src/index.css` — theme tokens, matrix visual system, responsive layout, motion, and component styling.
- `client/index.html` — title, metadata, and font loading.
- `client/public/manus-routes.json` — declared page routes for the managed website.
- `app.config.ts` — project logo metadata.
- `TODO.md` — request-derived implementation outcomes and status.
