# LinkedIn Azure Function App

Azure Function App for a clean LinkedIn lead webhook setup.

Current architecture:

- Register webhook directly at LinkedIn to your Power Automate trigger URL.
- Use this Function App for:
  - GUI-based OAuth + registration of leadNotifications at LinkedIn
  - Challenge response calculation endpoint for Power Automate (`/linkedin/challenge`)

## Endpoints

- `GET /start` registration UI
- `GET /dashboard` same UI (admin shortcut)
- `POST /auth/linkedin/start` starts OAuth flow
- `GET /auth/linkedin/callback` exchanges token and creates LinkedIn subscription
- `POST /linkedin/challenge` computes `challengeResponse` (HMAC SHA256 hex)

## LinkedIn setup

In LinkedIn Developer App, enable webhook event type:

- `An action performed on a lead (created/deleted)`

Then use this app UI (`/start`) to register:

- Power Automate webhook URL (the URL LinkedIn should call directly)
- Owner type + owner URN
- Lead type

## Challenge endpoint for Power Automate

Request body:

```json
{
  "challengeCode": "abc123",
  "clientSecret": "<linkedin-client-secret>"
}
```

Response:

```json
{
  "challengeCode": "abc123",
  "challengeResponse": "<hex-hmac-sha256>"
}
```

Notes:

- `clientSecret` is optional in body if `LINKEDIN_CLIENT_SECRET` is configured in app settings.
- The endpoint is intended to be called from Power Automate HTTP actions.

## Configuration

Copy `local.settings.json.example` to `local.settings.json` and set:

Required:

- `LINKEDIN_CLIENT_ID`
- `LINKEDIN_CLIENT_SECRET`
- `LINKEDIN_REDIRECT_URI` OR `WEBHOOK_PUBLIC_BASE_URL`

Optional:

- `LINKEDIN_OAUTH_SCOPES` (default used if empty)
- `LINKEDIN_EVENT_OAUTH_SCOPES` (used for EVENT lead type)
- `LINKEDIN_API_VERSION` (default `202605`)
- `POWER_AUTOMATE_WEBHOOK_URL` (used as default value in UI)

## Run locally

1. Install Azure Functions Core Tools.
2. Run:
   - `npm install`
   - `npm start`

## Deploy

Deploy folder `linkedin-function-app/` to an Azure Function App (Node.js).
