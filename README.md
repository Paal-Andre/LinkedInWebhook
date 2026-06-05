# LinkedIn LeadSync Webhook Registrar (lokal)

Denne tjenesten lar deg:

- autorisere mot en kundes LinkedIn Campaign Manager-konto (OAuth)
- registrere webhook-subscription mot `https://api.linkedin.com/rest/leadNotifications`
- svare på LinkedIn challenge med hex-encoded HMAC-SHA256
- verifisere `X-LI-Signature` på innkommende events
- videresende events til kundens webhook-endepunkt

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
   - kundens webhook URL (må være HTTPS og offentlig tilgjengelig)
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
- `ngrok` er ikke støttet av LinkedIn ifølge siste docs

## 4) Endepunkter

- `GET /` enkel admin-side
- `POST /auth/linkedin/start` starter OAuth
- `GET /auth/linkedin/callback` håndterer OAuth callback + registrering
- `GET /webhooks/linkedin/:subscriptionKey` challenge-respons
- `POST /webhooks/linkedin/:subscriptionKey` tar imot events, verifiserer signatur, videresender
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
