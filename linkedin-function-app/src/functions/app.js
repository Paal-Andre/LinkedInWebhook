const crypto = require('crypto');
const { app } = require('@azure/functions');

const oauthStateStore = new Map();

app.http('adminPage', {
  methods: ['GET'],
  authLevel: 'anonymous',
  route: 'dashboard',
  handler: async () => {
    return htmlResponse(renderRegistrationPage());
  }
});

app.http('startPage', {
  methods: ['GET'],
  authLevel: 'anonymous',
  route: 'start',
  handler: async () => {
    return htmlResponse(renderRegistrationPage());
  }
});

app.http('startOAuth', {
  methods: ['POST'],
  authLevel: 'anonymous',
  route: 'auth/linkedin/start',
  handler: async (request) => {
    try {
      assertOAuthConfig();

      const form = await readForm(request);
      const customerWebhookUrl = String(form.customerWebhookUrl || '').trim();
      const ownerType = String(form.ownerType || '').trim();
      const ownerUrn = String(form.ownerUrn || '').trim();
      const leadType = String(form.leadType || 'SPONSORED').trim().toUpperCase();
      const apiVersion = String(form.apiVersion || process.env.LINKEDIN_API_VERSION || '202605').trim();
      const leadActionWebhookEnabled = String(form.leadActionWebhookEnabled || '').trim().toLowerCase();

      if (!customerWebhookUrl) {
        return jsonResponse(400, { error: 'customerWebhookUrl mangler' });
      }

      const webhookUrl = new URL(customerWebhookUrl);
      if (webhookUrl.protocol !== 'https:') {
        return jsonResponse(400, { error: 'customerWebhookUrl ma vaere HTTPS' });
      }

      if (!['sponsoredAccount', 'organization'].includes(ownerType)) {
        return jsonResponse(400, { error: 'ownerType ma vaere sponsoredAccount eller organization' });
      }

      if (!['SPONSORED', 'EVENT', 'COMPANY', 'ORGANIZATION_PRODUCT'].includes(leadType)) {
        return jsonResponse(400, { error: 'leadType ma vaere SPONSORED, EVENT, COMPANY eller ORGANIZATION_PRODUCT' });
      }

      if (leadType === 'SPONSORED' && ownerType !== 'sponsoredAccount') {
        return jsonResponse(400, { error: 'For leadType SPONSORED ma ownerType vaere sponsoredAccount' });
      }

      if (leadType !== 'SPONSORED' && ownerType !== 'organization') {
        return jsonResponse(400, { error: 'For EVENT/COMPANY/ORGANIZATION_PRODUCT ma ownerType vaere organization' });
      }

      if (!ownerUrn) {
        return jsonResponse(400, { error: 'ownerUrn mangler' });
      }

      if (leadActionWebhookEnabled !== 'on') {
        return jsonResponse(400, {
          error: 'Du ma bekrefte at LinkedIn event type "An action performed on a lead (created/deleted)" er aktivert.'
        });
      }

      const state = crypto.randomUUID();
      oauthStateStore.set(state, {
        customerWebhookUrl,
        ownerType,
        ownerUrn,
        leadType,
        apiVersion,
        oauthScopes: resolveLinkedInOAuthScopes(leadType)
      });

      const authUrl = new URL('https://www.linkedin.com/oauth/v2/authorization');
      authUrl.searchParams.set('response_type', 'code');
      authUrl.searchParams.set('client_id', process.env.LINKEDIN_CLIENT_ID || '');
      authUrl.searchParams.set('redirect_uri', getRedirectUri());
      authUrl.searchParams.set('scope', resolveLinkedInOAuthScopes(leadType));
      authUrl.searchParams.set('state', state);

      return redirectResponse(authUrl.toString());
    } catch (error) {
      return jsonResponse(500, { error: toMessage(error) });
    }
  }
});

app.http('oauthCallback', {
  methods: ['GET'],
  authLevel: 'anonymous',
  route: 'auth/linkedin/callback',
  handler: async (request) => {
    try {
      assertOAuthConfig();

      const code = String(request.query.get('code') || '');
      const state = String(request.query.get('state') || '');

      if (!code || !state) {
        return jsonResponse(400, { error: 'Mangler code/state i callback' });
      }

      const config = oauthStateStore.get(state);
      if (!config) {
        return jsonResponse(400, { error: 'Ugyldig eller utlopet state' });
      }

      oauthStateStore.delete(state);

      const tokenResponse = await fetchLinkedInToken(code);
      const accessToken = tokenResponse.access_token;
      if (!accessToken) {
        return jsonResponse(500, { error: 'Fikk ikke access_token fra LinkedIn' });
      }

      const linkedInResult = await createLeadNotificationSubscription(accessToken, {
        ownerType: config.ownerType,
        ownerUrn: config.ownerUrn,
        leadType: config.leadType,
        webhook: config.customerWebhookUrl,
        apiVersion: config.apiVersion
      });

      return htmlResponse(renderSuccessPage(config, linkedInResult));
    } catch (error) {
      return jsonResponse(500, { error: toMessage(error) });
    }
  }
});

app.http('linkedinChallengeCalculator', {
  methods: ['POST'],
  authLevel: 'anonymous',
  route: 'linkedin/challenge',
  handler: async (request) => {
    try {
      const body = await tryReadJsonBody(request);
      const challengeCode = String(body.challengeCode || '').trim();
      const clientSecret = String(body.clientSecret || process.env.LINKEDIN_CLIENT_SECRET || '').trim();

      if (!challengeCode) {
        return jsonResponse(400, { error: 'challengeCode mangler i request body' });
      }

      if (!clientSecret) {
        return jsonResponse(400, { error: 'clientSecret mangler i request body eller LINKEDIN_CLIENT_SECRET i config' });
      }

      const challengeResponse = crypto
        .createHmac('sha256', clientSecret)
        .update(challengeCode, 'utf8')
        .digest('hex');

      return jsonResponse(200, { challengeCode, challengeResponse });
    } catch (error) {
      return jsonResponse(400, { error: `Ugyldig JSON body: ${toMessage(error)}` });
    }
  }
});

function renderRegistrationPage() {
  const apiVersion = process.env.LINKEDIN_API_VERSION || '202605';
  const redirectUri = getRedirectUriHint();
  const defaultWebhookUrl = String(process.env.POWER_AUTOMATE_WEBHOOK_URL || '').trim();

  return `<!doctype html>
<html lang="no">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>LinkedIn Lead Webhook Registry</title>
    <style>
      body { font-family: Segoe UI, sans-serif; margin: 0; background: #f4f7fb; color: #1f2430; }
      .wrap { max-width: 920px; margin: 40px auto; padding: 0 16px; }
      .card { background: #fff; border: 1px solid #d7e0ec; border-radius: 12px; padding: 22px; }
      form { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; }
      label { display: flex; flex-direction: column; gap: 6px; font-size: 14px; }
      input, select, textarea { padding: 10px 12px; border-radius: 8px; border: 1px solid #cfd9e6; }
      textarea { min-height: 90px; resize: vertical; }
      .full { grid-column: span 2; }
      .hint { color: #5a687f; font-size: 13px; margin-top: 0; }
      .note { margin: 0 0 16px 0; padding: 10px 12px; border-radius: 8px; background: #edf5ff; border: 1px solid #cfe2fb; color: #1f3f64; }
      button { grid-column: span 2; border: 0; border-radius: 8px; padding: 11px 14px; background: #0a66c2; color: #fff; font-weight: 600; cursor: pointer; }
      code { background: #eef3fa; border-radius: 6px; padding: 2px 6px; }
      @media (max-width: 740px) { form { grid-template-columns: 1fr; } .full, button { grid-column: span 1; } }
    </style>
  </head>
  <body>
    <div class="wrap">
      <div class="card">
        <h1>Registrer LinkedIn lead webhook</h1>
        <p class="note">Denne appen registrerer webhook direkte mot LinkedIn. LinkedIn sender deretter events direkte til Power Automate URL-en du oppgir.</p>

        <form method="POST" action="/auth/linkedin/start">
          <label>
            Power Automate webhook URL (https)
            <input name="customerWebhookUrl" required placeholder="https://prod-xx.logic.azure.com/workflows/..." value="${escapeHtml(defaultWebhookUrl)}" />
          </label>

          <label>
            Owner type
            <select name="ownerType" id="ownerTypeInput" required>
              <option value="sponsoredAccount" selected>sponsoredAccount</option>
              <option value="organization">organization</option>
            </select>
          </label>

          <label>
            Owner URN
            <input name="ownerUrn" id="ownerUrnInput" required placeholder="urn:li:sponsoredAccount:123456" />
          </label>

          <label>
            Lead type
            <select name="leadType" id="leadTypeInput" required>
              <option value="SPONSORED" selected>SPONSORED</option>
              <option value="EVENT">EVENT</option>
              <option value="COMPANY">COMPANY</option>
              <option value="ORGANIZATION_PRODUCT">ORGANIZATION_PRODUCT</option>
            </select>
          </label>

          <label>
            LinkedIn API version
            <input name="apiVersion" value="${escapeHtml(apiVersion)}" />
          </label>

          <label class="full" style="flex-direction: row; align-items: center; gap: 8px;">
            <input type="checkbox" name="leadActionWebhookEnabled" />
            Jeg har aktivert LinkedIn event type "An action performed on a lead (created/deleted)".
          </label>

          <button type="submit">Start OAuth og registrer webhook</button>
        </form>

        <p class="hint">Callback URI: <code>${escapeHtml(redirectUri)}</code></p>
        <p class="hint">Challenge endpoint for Power Automate: <code>/linkedin/challenge</code></p>
      </div>
    </div>

    <script>
      const ownerTypeInput = document.getElementById('ownerTypeInput');
      const ownerUrnInput = document.getElementById('ownerUrnInput');
      const leadTypeInput = document.getElementById('leadTypeInput');

      function syncOwnerTypeFromLeadType() {
        const leadType = String(leadTypeInput.value || '').toUpperCase();
        if (leadType === 'SPONSORED') {
          ownerTypeInput.value = 'sponsoredAccount';
          if (!String(ownerUrnInput.value || '').trim()) {
            ownerUrnInput.placeholder = 'urn:li:sponsoredAccount:123456';
          }
          return;
        }

        ownerTypeInput.value = 'organization';
        if (!String(ownerUrnInput.value || '').trim()) {
          ownerUrnInput.placeholder = 'urn:li:organization:123456';
        }
      }

      leadTypeInput.addEventListener('change', syncOwnerTypeFromLeadType);
      syncOwnerTypeFromLeadType();
    </script>
  </body>
</html>`;
}

function renderSuccessPage(config, linkedInResult) {
  return `<!doctype html>
<html lang="no">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Registrert hos LinkedIn</title>
    <style>
      body { font-family: Segoe UI, sans-serif; margin: 0; background: #f4f7fb; color: #1f2430; }
      .wrap { max-width: 920px; margin: 32px auto; padding: 0 16px; }
      .card { background: #fff; border: 1px solid #d7e0ec; border-radius: 12px; padding: 22px; }
      pre { background: #f6f8fa; border: 1px solid #d0d7de; border-radius: 8px; padding: 12px; overflow: auto; }
      a { color: #0a66c2; }
    </style>
  </head>
  <body>
    <div class="wrap">
      <div class="card">
        <h2>Webhook registrert hos LinkedIn</h2>
        <p><b>Webhook URL registrert hos LinkedIn:</b> ${escapeHtml(config.customerWebhookUrl)}</p>
        <p><b>LeadType:</b> ${escapeHtml(config.leadType || '-')}</p>
        <p><b>Owner:</b> ${escapeHtml(`${config.ownerType}:${config.ownerUrn}`)}</p>
        <p><b>OAuth scopes:</b> ${escapeHtml(config.oauthScopes || '')}</p>
        <p><b>LinkedIn subscription id:</b> ${escapeHtml((linkedInResult && linkedInResult.xRestLiId) || '-')}</p>
        <p><b>Payload sendt til LinkedIn:</b></p>
        <pre>${escapeHtml(JSON.stringify((linkedInResult && linkedInResult.sentPayload) || {}, null, 2))}</pre>
        <p><a href="/start">Tilbake</a></p>
      </div>
    </div>
  </body>
</html>`;
}

async function fetchLinkedInToken(code) {
  const response = await fetch('https://www.linkedin.com/oauth/v2/accessToken', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      client_id: process.env.LINKEDIN_CLIENT_ID || '',
      client_secret: process.env.LINKEDIN_CLIENT_SECRET || '',
      redirect_uri: getRedirectUri()
    })
  });

  const text = await response.text();
  const body = tryJson(text);

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
  const body = tryJson(text);

  if (!response.ok) {
    throw new Error(`leadNotifications create feilet (${response.status}): ${JSON.stringify(body)}`);
  }

  return {
    status: response.status,
    xRestLiId: response.headers.get('x-restli-id'),
    body,
    sentPayload: payload
  };
}

async function readForm(request) {
  const text = await request.text();
  const params = new URLSearchParams(text);
  return Object.fromEntries(params.entries());
}

async function tryReadJsonBody(request) {
  const text = await request.text();
  if (!text) {
    return {};
  }

  return JSON.parse(text);
}

function assertOAuthConfig() {
  const clientId = String(process.env.LINKEDIN_CLIENT_ID || '').trim();
  const clientSecret = String(process.env.LINKEDIN_CLIENT_SECRET || '').trim();

  if (!clientId || !clientSecret) {
    throw new Error('LINKEDIN_CLIENT_ID og LINKEDIN_CLIENT_SECRET ma settes');
  }
}

function resolveLinkedInOAuthScopes(leadType) {
  const configuredScopes = String(process.env.LINKEDIN_OAUTH_SCOPES || '').trim();
  if (configuredScopes) {
    return configuredScopes;
  }

  const configuredEventScopes = String(process.env.LINKEDIN_EVENT_OAUTH_SCOPES || '').trim();
  const normalizedLeadType = String(leadType || '').trim().toUpperCase();

  if (normalizedLeadType === 'EVENT') {
    return configuredEventScopes || 'r_marketing_leadgen_automation r_events';
  }

  return 'r_marketing_leadgen_automation';
}

function getRedirectUri() {
  const configured = String(process.env.LINKEDIN_REDIRECT_URI || '').trim();
  if (configured) {
    return configured;
  }

  const base = String(process.env.WEBHOOK_PUBLIC_BASE_URL || '').trim();
  if (!base) {
    throw new Error('Sett LINKEDIN_REDIRECT_URI eller WEBHOOK_PUBLIC_BASE_URL');
  }

  const url = new URL(base);
  if (url.protocol !== 'https:') {
    throw new Error('WEBHOOK_PUBLIC_BASE_URL ma vaere HTTPS');
  }

  return `${base.replace(/\/+$/, '')}/auth/linkedin/callback`;
}

function getRedirectUriHint() {
  try {
    return getRedirectUri();
  } catch (_error) {
    return 'IKKE SATT - sett LINKEDIN_REDIRECT_URI eller WEBHOOK_PUBLIC_BASE_URL';
  }
}

function tryJson(text) {
  try {
    return text ? JSON.parse(text) : {};
  } catch (_error) {
    return { raw: text };
  }
}

function jsonResponse(status, jsonBody) {
  return { status, jsonBody };
}

function htmlResponse(body) {
  return {
    status: 200,
    headers: { 'content-type': 'text/html; charset=utf-8' },
    body
  };
}

function redirectResponse(location) {
  return {
    status: 302,
    headers: { location },
    body: ''
  };
}

function toMessage(error) {
  if (!error) {
    return 'Unknown error';
  }

  if (typeof error === 'string') {
    return error;
  }

  return error.message || JSON.stringify(error);
}

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}
