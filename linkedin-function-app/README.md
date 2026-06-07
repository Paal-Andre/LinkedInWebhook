# LinkedIn Azure Function App

Selvstendig Azure Function App for LinkedIn Lead Notifications.

Den dekker hele flyten:

- OAuth-start og callback mot LinkedIn
- Registrering av leadNotifications subscription
- Challenge-respons (hex HMAC SHA256)
- Videresending av events til Power Automate
- Persistens av subscriptions i Azure Table Storage (stabilt ved restart/skalering)

## Endepunkter

- `GET /start` startside med registreringsskjema
- `GET /dashboard` alternativ admin-side
- `POST /auth/linkedin/start` starter OAuth
- `GET /auth/linkedin/callback` fullforer OAuth + registrering
- `GET|POST /webhooks/linkedin/{subscriptionKey}` challenge + events
- `GET /api/subscriptions` viser aktive subscriptions i minne
- `GET /api/endpoint-stats` viser teller for mottak og videresending til Power Automate

## Konfigurasjon

For at leads skal pushes til webhooken, ma du aktivere i LinkedIn Developer App:

- Webhooks -> Event type: `An action performed on a lead (created/deleted)`

Kopier `local.settings.json.example` til `local.settings.json` og sett:

- `LINKEDIN_CLIENT_ID`
- `LINKEDIN_CLIENT_SECRET`
- `WEBHOOK_PUBLIC_BASE_URL`
- `POWER_AUTOMATE_WEBHOOK_URL`

Valgfritt:

- `LINKEDIN_REDIRECT_URI` (default: `<WEBHOOK_PUBLIC_BASE_URL>/auth/linkedin/callback`)
- `POWER_AUTOMATE_WEBHOOK_METHOD` (`POST` eller `GET`)
- `VERIFY_LINKEDIN_SIGNATURE` (`true` eller `false`)
- `ALLOW_POWER_AUTOMATE_GET_FALLBACK` (`true` eller `false`, default `false`)
- `SUBSCRIPTIONS_TABLE_NAME` (default: `LinkedInSubscriptions`)
- `ENDPOINT_STATS_TABLE_NAME` (default: `LinkedInEndpointStats`)

Anbefalt i produksjon:

- Sett `VERIFY_LINKEDIN_SIGNATURE=true`
- Hold `ALLOW_POWER_AUTOMATE_GET_FALLBACK=false` og konfigurer Power Automate-trigger til å akseptere `POST`

## Kjoring lokalt

1. Installer Azure Functions Core Tools.
2. Kjor:
   - `npm install`
   - `npm start`

## Deploy

Publiser mappen `linkedin-function-app/` til en Azure Function App (Node.js).
