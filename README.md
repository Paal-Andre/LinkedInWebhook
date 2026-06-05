# LinkedIn LeadSync Webhook Registrar (lokal)

Denne tjenesten lar deg:

- autorisere mot en kundes LinkedIn Campaign Manager-konto (OAuth)
- registrere webhook-subscription mot `https://api.linkedin.com/rest/leadNotifications`
- svare på LinkedIn challenge med hex-encoded HMAC-SHA256
- videresende innkommende events til Power Automate webhook-endepunkt

Denne tjenesten er en minimal challenge-proxy. LinkedIn registreres alltid mot denne tjenesten.

## 1) Oppsett

1. Installer avhengigheter:
   - `npm install`
2. Opprett miljøfil:
   - kopier `.env.example` til `.env`
3. Sett `LINKEDIN_CLIENT_SECRET` i `.env`
4. Sett `WEBHOOK_PUBLIC_BASE_URL` til offentlig HTTPS-domene som peker til denne appen
5. Start appen:
   - `npm run dev`

## 2) Bruk

1. Åpne `http://localhost:3000`
2. Fyll inn:
   - kunde-ID (internt navn)
   - Power Automate webhook URL (må være HTTPS)
   - owner type (`sponsoredAccount` eller `organization`)
   - owner URN (f.eks. `urn:li:sponsoredAccount:123456`)
3. Trykk **Start OAuth + register webhook**
4. Logg inn i LinkedIn med kundens Campaign Manager-bruker
5. Etter callback registreres subscription automatisk

## 3) Viktige noter

- LinkedIn validerer webhook med GET `challengeCode`, og appen svarer med:
  - `challengeResponse = hex(HMACSHA256(challengeCode, clientSecret))`
- LinkedIn re-validerer periodisk (ca. hver 2. time)
- Kun HTTPS webhook-URL støttes av LinkedIn
- `localhost` kan ikke brukes som webhook URL mot LinkedIn (må være offentlig)
- LinkedIn-endepunktet som registreres er: `<WEBHOOK_PUBLIC_BASE_URL>/webhooks/linkedin/<subscriptionKey>`
- Denne tjenesten beregner challenge dynamisk per forespørsel (ingen statisk hex)

## 4) Endepunkter

- `GET /` enkel admin-side
- `POST /auth/linkedin/start` starter OAuth
- `GET /auth/linkedin/callback` håndterer OAuth callback + registrering
- `GET /webhooks/linkedin/:subscriptionKey` challenge-respons
- `POST /webhooks/linkedin/:subscriptionKey` tar imot events og videresender til Power Automate
- `GET /api/subscriptions` viser aktive registreringer i minne

## 5) Persistens

Denne første versjonen bruker minnelager (Map). Ved restart mister du registreringene i appen (ikke hos LinkedIn). For produksjon: legg på database.

## 6) GitHub + Azure Static Web App (automatisk)

Følgende er lagt til:

- Workflow for provisjonering: `.github/workflows/azure-provision-static-webapp.yml`
- Workflow for deploy av statisk innhold: `.github/workflows/azure-deploy-static-webapp.yml`
- Bicep-mal: `infra/main.bicep`

Azure resource group er satt til `rg-linkedin`.

### Nødvendige GitHub secrets

- `AZURE_CLIENT_ID`
- `AZURE_TENANT_ID`
- `AZURE_SUBSCRIPTION_ID`
- `AZURE_STATIC_WEB_APPS_API_TOKEN`

### Valgfri GitHub variable

- `AZURE_STATIC_WEBAPP_NAME` (hvis ikke satt brukes `<repo>-swa`)

### Viktig

Denne repoen inneholder en Express-backend for OAuth/webhook. Azure Static Web Apps hoster kun statisk frontend her (`web/`).
For webhook-backend i Azure må du bruke en server-hosting-tjeneste (for eksempel Azure App Service eller Container Apps), eller bygge om backend til Azure Functions.

## 7) Azure Web App backend (automatisk deploy via git)

Backend er satt opp i Azure Web App:

- Web App: `linkedinwebhook-api-pa`
- URL: `https://linkedinwebhook-api-pa.azurewebsites.net`
- Callback URI: `https://linkedinwebhook-api-pa.azurewebsites.net/auth/linkedin/callback`

Workflow for backend deploy ved push til `main`:

- `.github/workflows/azure-deploy-webapp-backend.yml`

## 8) Minimal Azure Function challenge-proxy (anbefalt arkitektur)

Hvis du vil kjøre en enda tynnere arkitektur enn Express-appen, ligger en minimal Azure Function i:

- `azure-function-challenge-proxy/`

Den gjør kun dette:

- `GET /webhooks/linkedin/{subscriptionKey}`: svarer LinkedIn challenge med hex HMAC SHA256
- `POST /webhooks/linkedin/{subscriptionKey}`: videresender payload til Power Automate

### Hurtig oppsett

1. Gå til mappen:
   - `cd azure-function-challenge-proxy`
2. Installer avhengigheter:
   - `npm install`
3. Kopier settings:
   - `copy local.settings.json.example local.settings.json`
4. Sett verdier:
   - `LINKEDIN_CLIENT_SECRET`
   - `POWER_AUTOMATE_WEBHOOK_URL`
   - `POWER_AUTOMATE_WEBHOOK_METHOD` (`POST` anbefalt, `GET` ved behov)
   - `VERIFY_LINKEDIN_SIGNATURE` (`true`/`false`)
5. Kjør lokalt:
   - `npm start`

Denne varianten er stateless og passer godt når Power Automate skal gjøre all businesslogikk.

### Feil: TriggerRequestMethodNotValid (expected 'GET', actual 'POST')

Dette betyr at HTTP-triggeren i Power Automate er satt til `GET`.

- Anbefalt: sett triggeren til `POST`.
- Alternativ: sett `POWER_AUTOMATE_WEBHOOK_METHOD=GET` i Function config.

Når `GET` brukes, sender proxy payload som query-parameteren `payloadBase64` (base64-kodet JSON) fordi GET ikke har request body.
