# LinkedIn Function App Repository

Dette repoet inneholder en ren Azure Function-løsning for LinkedIn Lead Notifications.

Hovedprosjektet ligger i:

- `linkedin-function-app/`

## Hva løsningen gjør

- Starter OAuth mot LinkedIn
- Registrerer `leadNotifications` webhook
- Svarer på LinkedIn challenge med hex HMAC SHA256
- Videresender events til Power Automate

## Lokal kjøring

1. Gå til prosjektmappen:
   - `cd linkedin-function-app`
2. Kopier `local.settings.json.example` til `local.settings.json`
3. Sett nødvendige verdier
4. Kjør:
   - `npm install`
   - `npm start`

## Deploy

Deploy skjer via GitHub Actions workflow:

- `.github/workflows/azure-deploy-functionapp.yml`

Workflow trigges på endringer i `linkedin-function-app/**`.
