# LinkedIn Azure Function App

Selvstendig Azure Function App for LinkedIn Lead Notifications.

Den dekker hele flyten:

- OAuth-start og callback mot LinkedIn
- Registrering av leadNotifications subscription
- Challenge-respons (hex HMAC SHA256)
- Videresending av events til Power Automate

## Endepunkter

- `GET /` admin-side med registreringsskjema
- `POST /auth/linkedin/start` starter OAuth
- `GET /auth/linkedin/callback` fullforer OAuth + registrering
- `GET|POST /webhooks/linkedin/{subscriptionKey}` challenge + events
- `GET /api/subscriptions` viser aktive subscriptions i minne

## Konfigurasjon

Kopier `local.settings.json.example` til `local.settings.json` og sett:

- `LINKEDIN_CLIENT_ID`
- `LINKEDIN_CLIENT_SECRET`
- `WEBHOOK_PUBLIC_BASE_URL`
- `POWER_AUTOMATE_WEBHOOK_URL`

Valgfritt:

- `LINKEDIN_REDIRECT_URI` (default: `<WEBHOOK_PUBLIC_BASE_URL>/auth/linkedin/callback`)
- `POWER_AUTOMATE_WEBHOOK_METHOD` (`POST` eller `GET`)
- `VERIFY_LINKEDIN_SIGNATURE` (`true` eller `false`)

## Kjoring lokalt

1. Installer Azure Functions Core Tools.
2. Kjor:
   - `npm install`
   - `npm start`

## Deploy

Publiser mappen `linkedin-function-app/` til en Azure Function App (Node.js).
