# scottfriedman.ooo

Personal site — a hand-drawn-feeling playground of interactive pages backed by
Firebase, two Cloudflare Workers, and a Home Assistant instance at home.

Live at **https://scottfriedman.ooo** (GitHub Pages, `main` branch, repo
`scott-friedman/ooo`).

## Pages

| Page | What it is | Backend |
|---|---|---|
| `index.html` | Home — bio, projects, writing, sounds; shared drawing canvas | RTDB `content`, `strokes` |
| `stickynotes.html` | Public sticky-note wall | RTDB `stickynotes` |
| `music.html` | Collaborative sequencer bars + song embeds (Tone.js) | RTDB `music` |
| `figurines.html` | Upload/interact with 3D figurines (three.js) | RTDB `figurines`, Firebase Storage |
| `benefits.html` | "Benefits of everything" — AI answers via Gemini | `benefits-api` worker, RTDB `benefits` |
| `commandcenter.html` | Visitors control whitelisted smart-home devices | `ha-command-center` worker → HA, RTDB `commandcenter` |
| `litterrobot.html` | Tot's litter robot dashboard (Chart.js) | RTDB `litterrobot`, written by HA |
| `eink.html` | E-ink display message sender | **Firestore, separate project `inky-179bb`** |
| `page.html` | Generic template for admin-created pages | RTDB `pages` |
| `admin.html` | Admin panel (Firebase Auth; admin UIDs in RTDB `admins`) | everything above |

## Architecture

```
GitHub Pages (static)         Cloudflare Workers                Home
scottfriedman.ooo ──fetch──▶  benefits-api ──▶ Gemini API
                              ha-command-center ──▶ Nabu Casa ──▶ Home Assistant
        │                            │                                │
        ▼                            ▼                                ▼ (rest_command
Firebase RTDB (scottfriedman-f400d)  ◀────────────────────────────────  + ?auth=secret)
Firebase Storage (figurine .glb files)
Firestore (inky-179bb — eink page only)
```

- **Two Firebase projects**: `scottfriedman-f400d` (RTDB + Storage + Auth,
  rules in `firebase.rules.json`) and `inky-179bb` (Firestore for the e-ink
  display; its rules currently live only in that project's console).
- **Write auth**: public paths are validated by rules; machine writers (HA
  rest_commands, both workers) authenticate with the RTDB **database secret**
  (`?auth=`), which bypasses rules. Get it from Firebase console → Project
  settings → Service accounts → Database secrets.
- **Home Assistant** pushes litter robot state via `rest_command` (see
  `homeassistant/litter_robot.yaml`) and is reached by the command-center
  worker through its Nabu Casa URL.

## Deploying (three separate channels — easy to forget one)

1. **Site**: `git push origin main` → GitHub Pages. Everything in the repo is
   public at scottfriedman.ooo, so never commit secrets or private info.
2. **Database rules**: `firebase deploy --only database --project scottfriedman-f400d`
   after editing `firebase.rules.json`. Run the rules tests first (see below).
3. **Workers** (from `worker/`):
   - `npx wrangler deploy` (ha-command-center)
   - `npx wrangler deploy --config wrangler-benefits.toml` (benefits-api)

   Secrets (one-time, via `npx wrangler secret put NAME [--config ...]`):
   `HA_URL`, `HA_TOKEN`, `FIREBASE_SECRET` for ha-command-center;
   `GEMINI_API_KEY`, `FIREBASE_SECRET` for benefits-api.

Rules and worker deploys have drifted before (Jan/Apr 2026: a rules deploy
silently locked out HA and the benefits cache for months). If you change
rules, redeploy any writer they affect in the same sitting.

## Local development

```sh
python3 -m http.server 8000    # from the repo root
```

Needed because `js/eink.js` is an ES module and won't run from `file://`.
The workers' CORS allowlists include `localhost:8000` only when their
`IS_PRODUCTION` flag is false.

## Repo map

- `js/` — one script per page plus shared `firebase-config.js`, `sanitize.js`,
  `main.js` (nav, drawing canvas), `tot-cat.js` (SVG mascot on litterrobot)
- `worker/` — both Cloudflare Workers and their wrangler configs
- `homeassistant/` — reference copy of the HA automations/rest_commands
  (the live config lives in HA itself; keep the database secret out of git)
- `scripts/` — maintenance one-offs for litter robot history data
- `firebase.rules.json` — RTDB security rules (deploy channel #2)
