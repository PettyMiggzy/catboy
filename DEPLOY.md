# Catboy backend — set up ONCE, then it auto-deploys forever

Goal: after this, Claude adds features by pushing code + uploading assets, and
they go live automatically. You don't repeat any manual steps.

## A. Spaces (storage/CDN) — 3 min
1. DO panel -> Spaces Object Storage -> Create bucket, region `nyc3`, name `catboy-assets`. Enable the CDN.
2. API -> Spaces Keys -> Generate New Key. Copy the Access Key + Secret.

## B. Backend on App Platform (auto-deploy) — 5 min
1. DO panel -> Apps -> Create App -> GitHub -> pick this repo, branch `main`.
   It reads `.do/app.yaml` automatically (service = `server/`).
2. When prompted, fill the SECRET env vars:
   - `VENICE_KEY` = your Venice API key
   - `ADMIN_TOKEN` = a long random string (I'll use this to upload assets)
   - `SPACES_KEY`, `SPACES_SECRET` = from step A2
   (the non-secret ones are pre-filled in the spec)
3. Create Resources -> Deploy. You get a URL like `https://catboy-backend-xxxx.ondigitalocean.app`.
4. Test: open `<that url>/health` -> should show `{"ok":true,...}`.

**From now on:** every `git push` to `main` auto-redeploys the backend. No more manual steps.

## C. Let Claude reach it (so I can add stuff for you)
In your Claude Code environment settings:
- Environment variables (.env format, no quotes):
  ```
  CATBOY_API=https://catboy-backend-xxxx.ondigitalocean.app
  CATBOY_ADMIN_TOKEN=the-same-ADMIN_TOKEN
  ```
- Network access -> Custom -> add:
  ```
  *.ondigitalocean.app
  *.digitaloceanspaces.com
  *.cdn.digitaloceanspaces.com
  ```
Then tell me "backend is live" + paste the app URL, and I'll wire the site's
on-site AI features, uploads, and leaderboards to it — and keep adding more
without you doing anything.

## What the backend already does
- `POST /api/venice/image` — on-site AI art (key stays server-side, rate-limited)
- `POST /api/upload` (admin) — I push generated assets to Spaces/CDN
- `GET|POST /api/leaderboard/:game` — real arcade/fighter leaderboards
- `GET /health`
More endpoints get added by pushing code — they deploy themselves.
