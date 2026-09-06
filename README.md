# Manual Services Ledger & P&L

Internal tool for AccessibilityChecker.org. Tracks one-time work (remediation, audit, VPAT, PDF) and monitoring, reads signed contracts, pulls invoice dates from Gmail, matches payments from Stripe and Mercury, and drafts the weekly team check-in.

## Deploy on DigitalOcean (about 15 minutes)

1. Push this folder to the GitHub repo `Mr-Vertigot/manual-services-ledger` (replace the old index.html and README).
2. DigitalOcean → Apps → Create App → GitHub → pick the repo → it detects the Dockerfile and `.do/app.yaml`.
3. Add the dev Postgres database when prompted (about $7/mo). The app is $5/mo.
4. Fill the secrets (Settings → App-level environment variables):
   - `APP_PASSWORD`: any password. This is what the sign-in page asks for.
   - `ANTHROPIC_API_KEY`: console.anthropic.com → API keys.
   - `STRIPE_SECRET_KEY`: dashboard.stripe.com → Developers → API keys → Secret key (live).
   - `MERCURY_API_TOKEN`: Mercury → Settings → API tokens → read-only token.
   - `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET`: see below.
   - `APP_URL`: the URL DigitalOcean gives the app, e.g. `https://manual-services-ledger-xxxxx.ondigitalocean.app`.
5. Deploy. Open the URL, sign in, click **Connect Gmail** once.

## Google OAuth (one-time, 5 minutes)

1. console.cloud.google.com → new project → APIs & Services → Enable **Gmail API**.
2. OAuth consent screen → External → add yourself as a test user.
3. Credentials → Create → OAuth client ID → Web application.
   - Authorised redirect URI: `https://YOUR-APP-URL/auth/google/callback`
4. Copy the client ID and secret into the app's env vars.

## What runs automatically

Every Monday 08:00 Bangkok time the server:
- creates Gmail drafts to Cas, Ritvik and the developer asking for hours and costs on open projects (you press send),
- emails you a summary: open reminders, unpaid invoices, payments that landed in the last 8 days.

There is also a **Run Monday now** endpoint (`POST /api/run-monday-now`) for testing.

## Local run

```
cp .env.example .env   # fill it in
npm install
npm start              # http://localhost:8080
```
