# Cardex

Spot a car, identify it with AI, and collect it as a trading card. Cards have a rarity tier, specs, an estimated value and XP that moves you up the ranks.

- Scan or upload a car photo. The server sends it to the Claude API and returns make, model, specs, rarity and a rough value.
- Your garage is saved in the browser (localStorage). Export and import a JSON backup from the Profile tab.
- Node 18+ and Express. No database needed.

## Run locally

```bash
npm install
cp .env.example .env      # then paste your Anthropic API key into .env
export $(grep -v '^#' .env | xargs) && npm start
```

Open http://localhost:3000. On a phone, the Scan button opens the camera.

## Deploy: GitHub then Render

1. Create a new GitHub repo and push this folder:
   ```bash
   git init && git add . && git commit -m "Cardex"
   git branch -M main
   git remote add origin https://github.com/YOUR-USER/cardex.git
   git push -u origin main
   ```
2. In Render choose **New > Blueprint**, pick the repo, and it reads `render.yaml`. (Or **New > Web Service** with build `npm install` and start `npm start`.)
3. When prompted, set `ANTHROPIC_API_KEY`. Get a key at https://console.anthropic.com.
4. Deploy. Your app will be live at the `onrender.com` URL.

The free Render plan sleeps when idle, so the first scan after a quiet spell can be slow.

## Settings (environment variables)

| Name | Default | What it does |
| --- | --- | --- |
| `ANTHROPIC_API_KEY` | required | Used server-side only |
| `ANTHROPIC_MODEL` | `claude-sonnet-4-6` | Model used for identification |
| `SCANS_PER_IP_PER_DAY` | `10` | Caps API spend on a public deploy |

## Not included yet

Friends, leaderboards and a shared marketplace need accounts and a database. A good next step is Render Postgres plus sign-in, then moving the garage from localStorage to the server.
