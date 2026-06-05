const crypto = require('crypto');
const express = require('express');
const dotenv = require('dotenv');

dotenv.config();

const app = express();
const port = Number(process.env.PORT || 3000);
const appBaseUrl = process.env.APP_BASE_URL || `http://localhost:${port}`;
const webhookPublicBaseUrl = (process.env.WEBHOOK_PUBLIC_BASE_URL || '').trim();
const linkedInClientId = process.env.LINKEDIN_CLIENT_ID || '';
const linkedInClientSecret = process.env.LINKEDIN_CLIENT_SECRET || '';
const linkedInRedirectPath = process.env.LINKEDIN_REDIRECT_PATH || '/auth/linkedin/callback';
const linkedInScopes = process.env.LINKEDIN_OAUTH_SCOPES || 'r_marketing_leadgen_automation';
const linkedInApiVersion = process.env.LINKEDIN_API_VERSION || '202605';

const oauthStateStore = new Map();
const subscriptionStore = new Map();
const dedupStore = new Set();

app.use(express.urlencoded({ extended: false }));
app.use(
  express.json({
    verify: (req, _res, buf) => {
      req.rawBody = buf;
    }
  })
);

app.get('/', (_req, res) => {
  res.type('html').send(`<!doctype html>
<html lang="no">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>LinkedIn LeadSync webhook-registrering</title>
    <style>
      :root {
        --bg: #f6f7fb;
        --card: #ffffff;
        --text: #1f2430;
        --muted: #5b657a;
        --accent: #0a66c2;
        --line: #d6deeb;
      }
      body {
        margin: 0;
        font-family: "Segoe UI", sans-serif;
        background: radial-gradient(circle at top left, #eef5ff 0%, var(--bg) 50%);
        color: var(--text);
      }
      .wrap {
        max-width: 900px;
        margin: 40px auto;
        padding: 0 16px;
      }
      .card {
        background: var(--card);
        border: 1px solid var(--line);
        border-radius: 14px;
        box-shadow: 0 8px 30px rgba(10, 102, 194, 0.08);
        padding: 24px;
      }
      h1 {
        margin: 0 0 8px;
      }
      p {
        color: var(--muted);
      }
      form {
        display: grid;
        grid-template-columns: 1fr 1fr;
        gap: 14px;
      }
      label {
        display: flex;
        flex-direction: column;
        gap: 6px;
        font-size: 14px;
      }
      input, select, textarea {
        padding: 10px 12px;
        border: 1px solid var(--line);
        border-radius: 10px;
        font-size: 14px;
      }
      textarea {
        min-height: 100px;
        resize: vertical;
      }
      .full {
        grid-column: span 2;
      }
      button {
        grid-column: span 2;
        border: 0;
        border-radius: 10px;
        padding: 12px 16px;
        background: var(--accent);
        color: white;
        font-weight: 600;
        cursor: pointer;
      }
      .small {
        margin-top: 14px;
        font-size: 13px;
      }
      code {
        background: #f0f4fa;
        border: 1px solid #dbe5f3;
        border-radius: 7px;
        padding: 2px 6px;
      }
      @media (max-width: 740px) {
        form {
          grid-template-columns: 1fr;
        }
        .full, button {
          grid-column: span 1;
        }
      }
    </style>
  </head>
  <body>
    <div class="wrap">
      <div class="card">
        <h1>LinkedIn LeadSync webhook-registrering</h1>
        <p>
          Denne siden brukes av deg (ingen kundelogin). Fyll inn kundedata,
          kjør OAuth mot kundens Campaign Manager-bruker, og appen registrerer
          leadNotifications automatisk mot denne tjenesten. Hendelser videresendes
          deretter til kundens endepunkt.
        </p>

        <form method="POST" action="/auth/linkedin/start">
          <label>
            Kunde-ID
            <input name="customerId" required placeholder="kunde-a" />
          </label>

          <label>
            Registreringsmodus
            <select name="registrationMode" required>
              <option value="relay" selected>Relay via denne tjenesten</option>
              <option value="direct">Direkte custom endpoint (Power Automate)</option>
            </select>
          </label>

          <label>
            Kundens mottaker-endepunkt (https, for videresending)
            <input name="customerWebhookUrl" placeholder="https://kunde.no/webhook/linkedin" />
          </label>

          <label class="full">
            Direkte webhook URL til LinkedIn (https, optional)
            <input name="directWebhookUrl" placeholder="https://prod-xx.westeurope.logic.azure.com/workflows/..." />
          </label>

          <label>
            Owner type
            <select name="ownerType" required>
              <option value="sponsoredAccount" selected>sponsoredAccount</option>
              <option value="organization">organization</option>
            </select>
          </label>

          <label>
            Owner URN
            <input name="ownerUrn" required placeholder="urn:li:sponsoredAccount:123456" />
          </label>

          <label>
            Lead type
            <select name="leadType" required>
              <option value="SPONSORED" selected>SPONSORED</option>
              <option value="EVENT">EVENT</option>
              <option value="COMPANY">COMPANY</option>
              <option value="ORGANIZATION_PRODUCT">ORGANIZATION_PRODUCT</option>
            </select>
          </label>

          <label>
            LinkedIn API version
            <input name="apiVersion" value="${escapeHtml(linkedInApiVersion)}" placeholder="202605" />
          </label>

          <label class="full">
            Optional associatedEntity (JSON)
            <textarea name="associatedEntityJson" placeholder='{"event":"urn:li:event:123"}'></textarea>
          </label>

          <label class="full">
            Optional versionedForm URN
            <input name="versionedForm" placeholder="urn:li:versionedLeadGenForm:(urn:li:leadGenForm:818,1)" />
          </label>

          <button type="submit">Start OAuth + register webhook</button>
        </form>

        <p class="small">
          Callback URL brukt i OAuth: <code>${escapeHtml(getRedirectUri())}</code>
        </p>
        <p class="small">
          Webhook base URL mot LinkedIn: <code>${escapeHtml(getWebhookBaseUrlHint())}</code>
        </p>
        <p class="small">
          Relay-modus registrerer: <code>&lt;webhook-base-url&gt;/webhooks/linkedin/&lt;id&gt;</code>
        </p>
        <p class="small">
          Direct-modus registrerer den eksakte URLen i feltet <code>Direkte webhook URL til LinkedIn</code>
        </p>
      </div>
    </div>
  </body>
</html>`);
});

app.post('/auth/linkedin/start', (req, res) => {
  try {
    assertConfig();

    const customerId = (req.body.customerId || '').trim();
    const registrationMode = (req.body.registrationMode || 'relay').trim();
    const customerWebhookUrl = (req.body.customerWebhookUrl || '').trim();
    const directWebhookUrl = (req.body.directWebhookUrl || '').trim();
    const ownerType = (req.body.ownerType || '').trim();
    const ownerUrn = (req.body.ownerUrn || '').trim();
    const leadType = (req.body.leadType || 'SPONSORED').trim();
    const apiVersion = (req.body.apiVersion || linkedInApiVersion).trim();
    const versionedForm = (req.body.versionedForm || '').trim();
    const associatedEntityJson = (req.body.associatedEntityJson || '').trim();

    if (!customerId) {
      throw new Error('customerId mangler');
    }

    if (!['relay', 'direct'].includes(registrationMode)) {
      throw new Error('registrationMode må være relay eller direct');
    }

    let parsedCustomerUrl;
    if (customerWebhookUrl) {
      parsedCustomerUrl = new URL(customerWebhookUrl);
      if (parsedCustomerUrl.protocol !== 'https:') {
        throw new Error('Kundens webhook endpoint må være HTTPS');
      }
    }

    let parsedDirectUrl;
    if (directWebhookUrl) {
      parsedDirectUrl = new URL(directWebhookUrl);
      if (parsedDirectUrl.protocol !== 'https:') {
        throw new Error('Direct webhook URL må være HTTPS');
      }
    }

    if (registrationMode === 'relay' && !customerWebhookUrl) {
      throw new Error('I relay-modus må kundens mottaker-endepunkt fylles ut');
    }

    if (registrationMode === 'direct' && !directWebhookUrl) {
      throw new Error('I direct-modus må direkte webhook URL fylles ut');
    }

    if (!['sponsoredAccount', 'organization'].includes(ownerType)) {
      throw new Error('ownerType må være sponsoredAccount eller organization');
    }

    const associatedEntity = parseOptionalJson(associatedEntityJson, 'associatedEntityJson');

    const state = crypto.randomUUID();
    oauthStateStore.set(state, {
      customerId,
      registrationMode,
      customerWebhookUrl,
      directWebhookUrl,
      ownerType,
      ownerUrn,
      leadType,
      apiVersion,
      versionedForm,
      associatedEntity
    });

    const authUrl = new URL('https://www.linkedin.com/oauth/v2/authorization');
    authUrl.searchParams.set('response_type', 'code');
    authUrl.searchParams.set('client_id', linkedInClientId);
    authUrl.searchParams.set('redirect_uri', getRedirectUri());
    authUrl.searchParams.set('scope', linkedInScopes);
    authUrl.searchParams.set('state', state);

    return res.redirect(authUrl.toString());
  } catch (error) {
    return sendError(res, error, 400);
  }
});

app.get('/auth/linkedin/callback', async (req, res) => {
  try {
    assertConfig();

    const code = (req.query.code || '').toString();
    const state = (req.query.state || '').toString();

    if (!code || !state) {
      throw new Error('Mangler code/state i callback');
    }

    const config = oauthStateStore.get(state);
    if (!config) {
      throw new Error('Ugyldig eller utløpt state');
    }

    oauthStateStore.delete(state);

    const tokenResponse = await fetchLinkedInToken(code);
    const token = tokenResponse.access_token;
    if (!token) {
      throw new Error('Fikk ikke access_token fra LinkedIn');
    }

    let relaySubscriptionKey;
    let webhookUrlForLinkedIn;

    if (config.registrationMode === 'direct') {
      webhookUrlForLinkedIn = config.directWebhookUrl;
    } else {
      relaySubscriptionKey = crypto.randomUUID();
      const webhookBaseUrl = getWebhookBaseUrl();
      webhookUrlForLinkedIn = `${webhookBaseUrl}/webhooks/linkedin/${relaySubscriptionKey}`;
    }

    const linkedInResult = await createLeadNotificationSubscription(token, {
      ownerType: config.ownerType,
      ownerUrn: config.ownerUrn,
      leadType: config.leadType,
      webhook: webhookUrlForLinkedIn,
      versionedForm: config.versionedForm,
      associatedEntity: config.associatedEntity,
      apiVersion: config.apiVersion
    });

    const trackingId = relaySubscriptionKey || crypto.randomUUID();

    subscriptionStore.set(trackingId, {
      createdAt: new Date().toISOString(),
      customerId: config.customerId,
      registrationMode: config.registrationMode,
      customerWebhookUrl: config.customerWebhookUrl,
      directWebhookUrl: config.directWebhookUrl,
      ownerType: config.ownerType,
      ownerUrn: config.ownerUrn,
      leadType: config.leadType,
      versionedForm: config.versionedForm,
      associatedEntity: config.associatedEntity,
      apiVersion: config.apiVersion,
      linkedInSubscription: linkedInResult,
      webhookUrlForLinkedIn
    });

    res.type('html').send(`<!doctype html>
<html lang="no">
  <head><meta charset="utf-8" /><title>Registrert</title></head>
  <body style="font-family:Segoe UI,sans-serif;padding:24px">
    <h2>Webhook registrert</h2>
    <p><b>Kunde:</b> ${escapeHtml(config.customerId)}</p>
    <p><b>Modus:</b> ${escapeHtml(config.registrationMode)}</p>
    <p><b>Webhook URL sendt til LinkedIn:</b> ${escapeHtml(webhookUrlForLinkedIn)}</p>
    <p><b>LinkedIn status:</b> OK</p>
    <p><a href="/">Tilbake</a></p>
  </body>
</html>`);
  } catch (error) {
    return sendError(res, error, 500);
  }
});

app.get('/webhooks/linkedin/:subscriptionKey', (req, res) => {
  try {
    assertConfig();

    const { challengeCode } = req.query;
    const challenge = (challengeCode || '').toString();

    if (!challenge) {
      return res.status(200).json({ status: 'ok' });
    }

    const challengeResponse = createChallengeResponse(challenge, linkedInClientSecret);

    return res.status(200).json({
      challengeCode: challenge,
      challengeResponse
    });
  } catch (error) {
    return sendError(res, error, 500);
  }
});

app.post('/webhooks/linkedin/:subscriptionKey', async (req, res) => {
  try {
    assertConfig();

    const subscriptionKey = req.params.subscriptionKey;
    const config = subscriptionStore.get(subscriptionKey);

    if (!config) {
      return res.status(404).json({ error: 'Ukjent subscriptionKey' });
    }

    if (!verifyLinkedInSignature(req.rawBody || Buffer.from(JSON.stringify(req.body || {}), 'utf8'), req.headers['x-li-signature'], linkedInClientSecret)) {
      return res.status(401).json({ error: 'Ugyldig X-LI-Signature' });
    }

    const payload = req.body;
    if (isDuplicate(payload)) {
      return res.status(200).json({ status: 'duplicate_ignored' });
    }

    if (!config.customerWebhookUrl) {
      return res.status(200).json({ status: 'accepted_no_forward_target' });
    }

    const forwardResponse = await fetch(config.customerWebhookUrl, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-forwarded-by': 'linkedin-webhook-service'
      },
      body: JSON.stringify(payload)
    });

    if (!forwardResponse.ok) {
      const bodyText = await forwardResponse.text();
      throw new Error(`Videresending feilet (${forwardResponse.status}): ${bodyText}`);
    }

    return res.status(202).json({ status: 'forwarded' });
  } catch (error) {
    return sendError(res, error, 500);
  }
});

app.get('/api/subscriptions', (_req, res) => {
  const items = Array.from(subscriptionStore.entries()).map(([key, value]) => ({
    subscriptionKey: key,
    ...value
  }));

  res.json({ count: items.length, items });
});

app.listen(port, () => {
  // Keep startup log concise for local development.
  console.log(`LinkedIn webhook service kjorer pa ${appBaseUrl}`);
});

function getRedirectUri() {
  return `${appBaseUrl}${linkedInRedirectPath}`;
}

function getWebhookBaseUrl() {
  const raw = webhookPublicBaseUrl || appBaseUrl;
  let parsed;

  try {
    parsed = new URL(raw);
  } catch (_err) {
    throw new Error('WEBHOOK_PUBLIC_BASE_URL må være en gyldig URL');
  }

  if (parsed.protocol !== 'https:') {
    throw new Error('WEBHOOK_PUBLIC_BASE_URL må bruke https:// for at LinkedIn webhook-validering skal passere');
  }

  if (['localhost', '127.0.0.1', '0.0.0.0'].includes(parsed.hostname)) {
    throw new Error('WEBHOOK_PUBLIC_BASE_URL kan ikke peke til localhost. Bruk offentlig HTTPS-domene.');
  }

  return raw.replace(/\/+$/, '');
}

function getWebhookBaseUrlHint() {
  if (!webhookPublicBaseUrl) {
    return 'IKKE SATT - sett WEBHOOK_PUBLIC_BASE_URL til offentlig https-domene';
  }

  return webhookPublicBaseUrl;
}

function assertConfig() {
  if (!linkedInClientId || !linkedInClientSecret) {
    throw new Error('LINKEDIN_CLIENT_ID og LINKEDIN_CLIENT_SECRET må settes i .env');
  }
}

function parseOptionalJson(value, fieldName) {
  if (!value) {
    return undefined;
  }

  try {
    return JSON.parse(value);
  } catch (_err) {
    throw new Error(`${fieldName} må være gyldig JSON`);
  }
}

function createChallengeResponse(challengeCode, clientSecret) {
  return crypto.createHmac('sha256', clientSecret).update(challengeCode, 'utf8').digest('hex');
}

function verifyLinkedInSignature(rawBody, signatureHeader, clientSecret) {
  if (!signatureHeader || typeof signatureHeader !== 'string') {
    return false;
  }

  const expected = `hmacsha256=${crypto.createHmac('sha256', clientSecret).update(rawBody).digest('hex')}`;
  const headerValue = signatureHeader.trim();

  // timingSafeEqual requires same-length inputs.
  if (expected.length !== headerValue.length) {
    return false;
  }

  return crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(headerValue));
}

function isDuplicate(payload) {
  const lead = payload && payload.leadGenFormResponse;
  const occurredAt = payload && payload.occurredAt;

  if (!lead || !occurredAt) {
    return false;
  }

  const key = `${lead}_${occurredAt}`;
  if (dedupStore.has(key)) {
    return true;
  }

  dedupStore.add(key);
  if (dedupStore.size > 10_000) {
    const first = dedupStore.values().next().value;
    dedupStore.delete(first);
  }

  return false;
}

async function fetchLinkedInToken(code) {
  const response = await fetch('https://www.linkedin.com/oauth/v2/accessToken', {
    method: 'POST',
    headers: {
      'content-type': 'application/x-www-form-urlencoded'
    },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      client_id: linkedInClientId,
      client_secret: linkedInClientSecret,
      redirect_uri: getRedirectUri()
    })
  });

  const text = await response.text();
  let body;

  try {
    body = JSON.parse(text);
  } catch (_err) {
    body = { raw: text };
  }

  if (!response.ok) {
    throw new Error(`OAuth token call feilet (${response.status}): ${JSON.stringify(body)}`);
  }

  return body;
}

async function createLeadNotificationSubscription(token, config) {
  const payload = {
    webhook: config.webhook,
    owner: {
      [config.ownerType]: config.ownerUrn
    },
    leadType: config.leadType
  };

  if (config.versionedForm) {
    payload.versionedForm = config.versionedForm;
  }

  if (config.associatedEntity) {
    payload.associatedEntity = config.associatedEntity;
  }

  const response = await fetch('https://api.linkedin.com/rest/leadNotifications', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'LinkedIn-Version': config.apiVersion,
      'X-RestLi-Protocol-Version': '2.0.0',
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(payload)
  });

  const text = await response.text();
  let body;

  try {
    body = text ? JSON.parse(text) : {};
  } catch (_err) {
    body = { raw: text };
  }

  if (!response.ok) {
    throw new Error(`leadNotifications create feilet (${response.status}): ${JSON.stringify(body)}`);
  }

  return {
    status: response.status,
    xRestLiId: response.headers.get('x-restli-id'),
    body
  };
}

function sendError(res, error, statusCode) {
  const message = error instanceof Error ? error.message : String(error);
  return res.status(statusCode).json({ error: message });
}

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}
