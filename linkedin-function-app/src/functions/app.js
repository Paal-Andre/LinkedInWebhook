const crypto = require('crypto');
const { app } = require('@azure/functions');
const { TableClient } = require('@azure/data-tables');

const oauthStateStore = new Map();
const subscriptionStore = new Map();
const subscriptionsTableName = process.env.SUBSCRIPTIONS_TABLE_NAME || 'LinkedInSubscriptions';
const subscriptionsPartitionKey = 'subscriptions';
const endpointStatsTableName = process.env.ENDPOINT_STATS_TABLE_NAME || 'LinkedInEndpointStats';
const endpointStatsPartitionKey = 'webhooks';
let subscriptionsTableClient;
let endpointStatsTableClient;

app.http('adminPage', {
  methods: ['GET'],
  authLevel: 'anonymous',
  route: 'dashboard',
  handler: async () => {
    const apiVersion = process.env.LINKEDIN_API_VERSION || '202605';
    const redirectUri = getRedirectUri();
    const webhookBase = getWebhookBaseUrlHint();

    return htmlResponse(`<!doctype html>
<html lang="no">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>LinkedIn Function App</title>
    <style>
      body { font-family: Segoe UI, sans-serif; margin: 0; background: #f4f7fb; color: #1f2430; }
      .wrap { max-width: 900px; margin: 40px auto; padding: 0 16px; }
      .card { background: #fff; border: 1px solid #d7e0ec; border-radius: 12px; padding: 22px; }
      form { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; }
      label { display: flex; flex-direction: column; gap: 6px; font-size: 14px; }
      input, select, textarea { padding: 10px 12px; border-radius: 8px; border: 1px solid #cfd9e6; }
      textarea { min-height: 90px; resize: vertical; }
      .full { grid-column: span 2; }
      button { grid-column: span 2; border: 0; border-radius: 8px; padding: 11px 14px; background: #0a66c2; color: #fff; font-weight: 600; cursor: pointer; }
      code { background: #eef3fa; border-radius: 6px; padding: 2px 6px; }
      .lookup { margin-top: 22px; padding-top: 14px; border-top: 1px solid #e7edf6; }
      .lookup-row { display: grid; grid-template-columns: 1fr auto; gap: 10px; align-items: end; }
      .lookup-row button { grid-column: auto; }
      .results { margin-top: 12px; display: grid; gap: 10px; }
      .result-card { border: 1px solid #d7e0ec; border-radius: 10px; padding: 10px 12px; background: #fbfdff; }
      .muted { color: #5a687f; font-size: 13px; }
      @media (max-width: 740px) { form { grid-template-columns: 1fr; } .full, button { grid-column: span 1; } }
    </style>
  </head>
  <body>
    <div class="wrap">
      <div class="card">
        <h1>LinkedIn Webhook Function App</h1>
        <p>Ren Azure Function-løsning for OAuth-registrering, challenge-svar og forwarding til Power Automate.</p>

        <form method="POST" action="/auth/linkedin/start">
          <label>
            Kunde-ID
            <input name="customerId" required placeholder="kunde-a" />
          </label>

          <label>
            Power Automate webhook URL (https)
            <input name="customerWebhookUrl" required placeholder="https://prod-xx.westeurope.logic.azure.com/workflows/..." />
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
            <input name="apiVersion" value="${escapeHtml(apiVersion)}" />
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

        <p>Callback URI: <code>${escapeHtml(redirectUri)}</code></p>
        <p>Webhook base: <code>${escapeHtml(webhookBase)}</code></p>

        <div class="lookup">
          <h2>Finn registrerte webhooks per LinkedIn ID</h2>
          <div class="lookup-row">
            <label>
              LinkedIn owner URN eller ID
              <input id="ownerLookup" placeholder="urn:li:sponsoredAccount:123456 eller 123456" />
            </label>
            <button id="lookupButton" type="button">Sok</button>
          </div>
          <p class="muted">Tips: Du kan bruke full URN eller bare numerisk ID.</p>
          <div id="lookupResults" class="results"></div>
        </div>
      </div>
    </div>

    <script>
      const ownerInput = document.getElementById('ownerLookup');
      const lookupButton = document.getElementById('lookupButton');
      const lookupResults = document.getElementById('lookupResults');

      async function lookupSubscriptions() {
        const ownerValue = (ownerInput.value || '').trim();
        lookupResults.innerHTML = '';

        if (!ownerValue) {
          lookupResults.textContent = 'Skriv inn LinkedIn owner URN eller ID.';
          return;
        }

        lookupButton.disabled = true;
        lookupButton.textContent = 'Soker...';

        try {
          const response = await fetch('/api/subscriptions?owner=' + encodeURIComponent(ownerValue));
          const data = await response.json();

          if (!response.ok) {
            lookupResults.textContent = data.error || 'Klarte ikke hente subscriptions.';
            return;
          }

          if (!data.items || data.items.length === 0) {
            lookupResults.textContent = 'Ingen registrerte webhooks funnet for angitt LinkedIn ID.';
            return;
          }

          lookupResults.innerHTML = data.items.map(function (item) {
            return '<div class="result-card">'
              + '<div><b>Subscription key:</b> ' + escapeHtmlText(item.subscriptionKey || '') + '</div>'
              + '<div><b>Owner:</b> ' + escapeHtmlText(item.ownerUrn || '-') + '</div>'
              + '<div><b>Kunde:</b> ' + escapeHtmlText(item.customerId || '-') + '</div>'
              + '<div><b>Webhook hos LinkedIn:</b> ' + escapeHtmlText(item.webhookUrlForLinkedIn || '-') + '</div>'
              + '<div><b>Forward URL:</b> ' + escapeHtmlText(item.customerWebhookUrl || '-') + '</div>'
              + '<div class="muted">Opprettet: ' + escapeHtmlText(item.createdAt || '-') + '</div>'
              + '</div>';
          }).join('');
        } catch (_error) {
          lookupResults.textContent = 'Feil ved kall mot API.';
        } finally {
          lookupButton.disabled = false;
          lookupButton.textContent = 'Sok';
        }
      }

      function escapeHtmlText(value) {
        return String(value)
          .replace(/&/g, '&amp;')
          .replace(/</g, '&lt;')
          .replace(/>/g, '&gt;')
          .replace(/"/g, '&quot;')
          .replace(/'/g, '&#039;');
      }

      lookupButton.addEventListener('click', lookupSubscriptions);
      ownerInput.addEventListener('keydown', function (event) {
        if (event.key === 'Enter') {
          event.preventDefault();
          lookupSubscriptions();
        }
      });
    </script>
  </body>
</html>`);
  }
});

app.http('startPage', {
  methods: ['GET'],
  authLevel: 'anonymous',
  route: 'start',
  handler: async () => {
    return htmlResponse(renderStartOAuthForm(process.env.LINKEDIN_API_VERSION || '202605'));
  }
});

app.http('startOAuth', {
  methods: ['GET', 'POST'],
  authLevel: 'anonymous',
  route: 'auth/linkedin/start',
  handler: async (request) => {
    try {
      assertConfig();
      if (request.method === 'GET') {
        const lookupOwnerUrn = (request.query.get('lookupOwnerUrn') || '').trim();
        const lookupApiVersion = (request.query.get('apiVersion') || process.env.LINKEDIN_API_VERSION || '202605').trim();

        if (lookupOwnerUrn) {
          const state = crypto.randomUUID();
          oauthStateStore.set(state, {
            mode: 'lookup',
            ownerUrn: lookupOwnerUrn,
            apiVersion: lookupApiVersion
          });

          const authUrl = new URL('https://www.linkedin.com/oauth/v2/authorization');
          authUrl.searchParams.set('response_type', 'code');
          authUrl.searchParams.set('client_id', process.env.LINKEDIN_CLIENT_ID || '');
          authUrl.searchParams.set('redirect_uri', getRedirectUri());
          authUrl.searchParams.set('scope', process.env.LINKEDIN_OAUTH_SCOPES || 'r_marketing_leadgen_automation');
          authUrl.searchParams.set('state', state);

          return redirectResponse(authUrl.toString());
        }

        return htmlResponse(renderStartOAuthForm(process.env.LINKEDIN_API_VERSION || '202605'));
      }

      const form = await readForm(request);

      const customerId = (form.customerId || '').trim();
      const customerWebhookUrl = (form.customerWebhookUrl || '').trim();
      const ownerType = (form.ownerType || '').trim();
      const ownerUrn = (form.ownerUrn || '').trim();
      const leadType = (form.leadType || 'SPONSORED').trim();
      const apiVersion = (form.apiVersion || process.env.LINKEDIN_API_VERSION || '202605').trim();
      const versionedForm = (form.versionedForm || '').trim();
      const associatedEntity = parseOptionalJson((form.associatedEntityJson || '').trim(), 'associatedEntityJson');

      if (!customerId) {
        return jsonResponse(400, { error: 'customerId mangler' });
      }

      if (!customerWebhookUrl) {
        return jsonResponse(400, { error: 'Power Automate webhook URL mangler' });
      }

      const paUrl = new URL(customerWebhookUrl);
      if (paUrl.protocol !== 'https:') {
        return jsonResponse(400, { error: 'Power Automate webhook URL må være HTTPS' });
      }

      if (!['sponsoredAccount', 'organization'].includes(ownerType)) {
        return jsonResponse(400, { error: 'ownerType må være sponsoredAccount eller organization' });
      }

      const state = crypto.randomUUID();
      oauthStateStore.set(state, {
        customerId,
        customerWebhookUrl,
        ownerType,
        ownerUrn,
        leadType,
        apiVersion,
        versionedForm,
        associatedEntity
      });

      const authUrl = new URL('https://www.linkedin.com/oauth/v2/authorization');
      authUrl.searchParams.set('response_type', 'code');
      authUrl.searchParams.set('client_id', process.env.LINKEDIN_CLIENT_ID || '');
      authUrl.searchParams.set('redirect_uri', getRedirectUri());
      authUrl.searchParams.set('scope', process.env.LINKEDIN_OAUTH_SCOPES || 'r_marketing_leadgen_automation');
      authUrl.searchParams.set('state', state);

      return redirectResponse(authUrl.toString());
    } catch (error) {
      return jsonResponse(500, { error: toMessage(error) });
    }
  }
});

app.http('startLookupOAuth', {
  methods: ['GET'],
  authLevel: 'anonymous',
  route: 'auth/linkedin/lookup',
  handler: async (request) => {
    try {
      assertConfig();

      const ownerUrn = (request.query.get('ownerUrn') || '').trim();
      const apiVersion = (request.query.get('apiVersion') || process.env.LINKEDIN_API_VERSION || '202605').trim();

      if (!ownerUrn) {
        return jsonResponse(400, { error: 'ownerUrn mangler' });
      }

      const state = crypto.randomUUID();
      oauthStateStore.set(state, {
        mode: 'lookup',
        ownerUrn,
        apiVersion
      });

      const authUrl = new URL('https://www.linkedin.com/oauth/v2/authorization');
      authUrl.searchParams.set('response_type', 'code');
      authUrl.searchParams.set('client_id', process.env.LINKEDIN_CLIENT_ID || '');
      authUrl.searchParams.set('redirect_uri', getRedirectUri());
      authUrl.searchParams.set('scope', process.env.LINKEDIN_OAUTH_SCOPES || 'r_marketing_leadgen_automation');
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
      assertConfig();

      const code = (request.query.get('code') || '').toString();
      const state = (request.query.get('state') || '').toString();

      if (!code || !state) {
        return jsonResponse(400, { error: 'Mangler code/state i callback' });
      }

      const config = oauthStateStore.get(state);
      if (!config) {
        return jsonResponse(400, { error: 'Ugyldig eller utløpt state' });
      }

      oauthStateStore.delete(state);

      const tokenResponse = await fetchLinkedInToken(code);
      const token = tokenResponse.access_token;
      if (!token) {
        return jsonResponse(500, { error: 'Fikk ikke access_token fra LinkedIn' });
      }

      if (config.mode === 'lookup') {
        const linkedInSubscriptions = await fetchLinkedInSubscriptions(token, config.ownerUrn, config.apiVersion);
        return htmlResponse(renderLinkedInLookupResultPage(config.ownerUrn, linkedInSubscriptions));
      }

      const subscriptionKey = crypto.randomUUID();
      const webhookUrlForLinkedIn = `${getWebhookBaseUrl()}/webhooks/linkedin/${subscriptionKey}`;

      const linkedInResult = await createLeadNotificationSubscription(token, {
        ownerType: config.ownerType,
        ownerUrn: config.ownerUrn,
        leadType: config.leadType,
        webhook: webhookUrlForLinkedIn,
        versionedForm: config.versionedForm,
        associatedEntity: config.associatedEntity,
        apiVersion: config.apiVersion
      });

      const savedSubscription = {
        createdAt: new Date().toISOString(),
        customerId: config.customerId,
        ownerType: config.ownerType,
        ownerUrn: config.ownerUrn,
        customerWebhookUrl: config.customerWebhookUrl,
        webhookUrlForLinkedIn,
        linkedInSubscription: linkedInResult
      };

      await saveSubscription(subscriptionKey, savedSubscription);

      return htmlResponse(`<!doctype html>
<html lang="no">
  <head><meta charset="utf-8" /><title>Registrert</title></head>
  <body style="font-family:Segoe UI,sans-serif;padding:24px">
    <h2>Webhook registrert</h2>
    <p><b>Kunde:</b> ${escapeHtml(config.customerId)}</p>
    <p><b>Webhook URL sendt til LinkedIn:</b> ${escapeHtml(webhookUrlForLinkedIn)}</p>
    <p><b>Videresending til Power Automate:</b> ${escapeHtml(config.customerWebhookUrl)}</p>
    <p><a href="/">Tilbake</a></p>
  </body>
</html>`);
    } catch (error) {
      return jsonResponse(500, { error: toMessage(error) });
    }
  }
});

app.http('linkedinWebhook', {
  methods: ['GET', 'POST'],
  authLevel: 'anonymous',
  route: 'webhooks/linkedin/{subscriptionKey}',
  handler: async (request) => {
    try {
      const subscriptionKey = (request.params.subscriptionKey || '').trim();
      if (!subscriptionKey) {
        return jsonResponse(400, { error: 'Mangler subscriptionKey i URL' });
      }

      if (request.method === 'GET') {
        return challengeResponse(request.query.get('challengeCode') || '');
      }

      const challengeCode = await readChallengeCodeFromPost(request);
      if (challengeCode) {
        return challengeResponse(challengeCode);
      }

      const config = await getSubscription(subscriptionKey);
      if (!config) {
        return jsonResponse(404, { error: 'Ukjent subscriptionKey' });
      }

      const rawBody = await request.text();

      await incrementEndpointStats(subscriptionKey, config.customerId, { received: 1 });

      if (readBoolEnv('VERIFY_LINKEDIN_SIGNATURE')) {
        const signatureHeader = request.headers.get('x-li-signature');
        if (!verifyLinkedInSignature(rawBody, signatureHeader, process.env.LINKEDIN_CLIENT_SECRET || '')) {
          await incrementEndpointStats(subscriptionKey, config.customerId, { forwardFailed: 1 });
          return jsonResponse(401, { error: 'Ugyldig X-LI-Signature' });
        }
      }

      const forwardResult = await forwardToPowerAutomate(config.customerWebhookUrl, rawBody, request.headers.get('content-type'));

      if (forwardResult.status === 202) {
        await incrementEndpointStats(subscriptionKey, config.customerId, { forwarded: 1 });
      } else {
        await incrementEndpointStats(subscriptionKey, config.customerId, { forwardFailed: 1 });
      }

      return forwardResult;
    } catch (error) {
      return jsonResponse(500, { error: toMessage(error) });
    }
  }
});

app.http('listSubscriptions', {
  methods: ['GET'],
  authLevel: 'anonymous',
  route: 'api/subscriptions',
  handler: async (request) => {
    const ownerFilter = (request.query.get('owner') || '').trim();
    const items = await listSubscriptions(ownerFilter);

    return jsonResponse(200, { count: items.length, items });
  }
});

app.http('endpointStats', {
  methods: ['GET'],
  authLevel: 'anonymous',
  route: 'api/endpoint-stats',
  handler: async (request) => {
    const subscriptionKey = (request.query.get('subscriptionKey') || '').trim();
    const customerId = (request.query.get('customerId') || '').trim();
    const items = await listEndpointStats(subscriptionKey, customerId);

    return jsonResponse(200, { count: items.length, items });
  }
});

async function saveSubscription(subscriptionKey, value) {
  subscriptionStore.set(subscriptionKey, value);

  const client = await getSubscriptionsTableClient();
  await client.upsertEntity({
    partitionKey: subscriptionsPartitionKey,
    rowKey: subscriptionKey,
    customerId: value.customerId || '',
    createdAt: value.createdAt || new Date().toISOString(),
    payload: JSON.stringify(value)
  }, 'Replace');
}

async function getSubscription(subscriptionKey) {
  const fromMemory = subscriptionStore.get(subscriptionKey);
  if (fromMemory) {
    return fromMemory;
  }

  const client = await getSubscriptionsTableClient();

  try {
    const entity = await client.getEntity(subscriptionsPartitionKey, subscriptionKey);
    const parsed = parseStoredPayload(entity.payload);
    if (!parsed) {
      return null;
    }

    subscriptionStore.set(subscriptionKey, parsed);
    return parsed;
  } catch (error) {
    if (error && error.statusCode === 404) {
      return null;
    }

    throw error;
  }
}

async function listSubscriptions(ownerFilter) {
  const client = await getSubscriptionsTableClient();
  const items = [];
  const normalizedOwnerFilter = normalizeOwnerFilter(ownerFilter);

  for await (const entity of client.listEntities({ queryOptions: { filter: `PartitionKey eq '${subscriptionsPartitionKey}'` } })) {
    const parsed = parseStoredPayload(entity.payload);
    if (!parsed) {
      continue;
    }

    if (normalizedOwnerFilter && !subscriptionMatchesOwner(parsed, normalizedOwnerFilter)) {
      continue;
    }

    subscriptionStore.set(entity.rowKey, parsed);
    items.push({
      subscriptionKey: entity.rowKey,
      ...parsed
    });
  }

  return items;
}

function normalizeOwnerFilter(value) {
  if (!value) {
    return '';
  }

  const trimmed = String(value).trim();
  if (!trimmed) {
    return '';
  }

  if (trimmed.startsWith('urn:li:')) {
    return trimmed.toLowerCase();
  }

  return trimmed.replace(/^urn:li:[^:]+:/i, '').toLowerCase();
}

function subscriptionMatchesOwner(subscription, normalizedOwnerFilter) {
  const ownerUrn = String(subscription.ownerUrn || '').trim();
  if (!ownerUrn) {
    return false;
  }

  const normalizedOwnerUrn = ownerUrn.toLowerCase();
  const ownerIdPart = ownerUrn.includes(':') ? ownerUrn.split(':').pop().toLowerCase() : normalizedOwnerUrn;

  return normalizedOwnerUrn === normalizedOwnerFilter || ownerIdPart === normalizedOwnerFilter;
}

async function getSubscriptionsTableClient() {
  if (subscriptionsTableClient) {
    return subscriptionsTableClient;
  }

  const connectionString = process.env.AzureWebJobsStorage || '';
  if (!connectionString) {
    throw new Error('AzureWebJobsStorage mangler for subscription-persistens');
  }

  const client = TableClient.fromConnectionString(connectionString, subscriptionsTableName);

  try {
    await client.createTable();
  } catch (error) {
    if (!(error && error.statusCode === 409)) {
      throw error;
    }
  }

  subscriptionsTableClient = client;
  return subscriptionsTableClient;
}

async function getEndpointStatsTableClient() {
  if (endpointStatsTableClient) {
    return endpointStatsTableClient;
  }

  const connectionString = process.env.AzureWebJobsStorage || '';
  if (!connectionString) {
    throw new Error('AzureWebJobsStorage mangler for endpoint-statistikk');
  }

  const client = TableClient.fromConnectionString(connectionString, endpointStatsTableName);

  try {
    await client.createTable();
  } catch (error) {
    if (!(error && error.statusCode === 409)) {
      throw error;
    }
  }

  endpointStatsTableClient = client;
  return endpointStatsTableClient;
}

async function incrementEndpointStats(subscriptionKey, customerId, delta) {
  const client = await getEndpointStatsTableClient();
  const now = new Date().toISOString();

  let current = {
    partitionKey: endpointStatsPartitionKey,
    rowKey: subscriptionKey,
    customerId: customerId || '',
    received: 0,
    forwarded: 0,
    forwardFailed: 0,
    updatedAt: now
  };

  try {
    const existing = await client.getEntity(endpointStatsPartitionKey, subscriptionKey);
    current = {
      ...current,
      ...existing,
      received: Number(existing.received || 0),
      forwarded: Number(existing.forwarded || 0),
      forwardFailed: Number(existing.forwardFailed || 0)
    };
  } catch (error) {
    if (!(error && error.statusCode === 404)) {
      throw error;
    }
  }

  const next = {
    partitionKey: endpointStatsPartitionKey,
    rowKey: subscriptionKey,
    customerId: customerId || current.customerId || '',
    received: current.received + Number(delta.received || 0),
    forwarded: current.forwarded + Number(delta.forwarded || 0),
    forwardFailed: current.forwardFailed + Number(delta.forwardFailed || 0),
    updatedAt: now
  };

  await client.upsertEntity(next, 'Replace');
}

async function listEndpointStats(subscriptionKeyFilter, customerIdFilter) {
  const client = await getEndpointStatsTableClient();
  const items = [];
  const normalizedKeyFilter = (subscriptionKeyFilter || '').trim();
  const normalizedCustomerFilter = (customerIdFilter || '').trim().toLowerCase();

  for await (const entity of client.listEntities({ queryOptions: { filter: `PartitionKey eq '${endpointStatsPartitionKey}'` } })) {
    if (normalizedKeyFilter && String(entity.rowKey || '') !== normalizedKeyFilter) {
      continue;
    }

    if (normalizedCustomerFilter && String(entity.customerId || '').trim().toLowerCase() !== normalizedCustomerFilter) {
      continue;
    }

    items.push({
      subscriptionKey: entity.rowKey,
      customerId: entity.customerId || '',
      received: Number(entity.received || 0),
      forwarded: Number(entity.forwarded || 0),
      forwardFailed: Number(entity.forwardFailed || 0),
      updatedAt: entity.updatedAt || ''
    });
  }

  return items;
}

function parseStoredPayload(payload) {
  if (!payload || typeof payload !== 'string') {
    return null;
  }

  try {
    return JSON.parse(payload);
  } catch (_error) {
    return null;
  }
}

function challengeResponse(challengeCode) {
  const secret = process.env.LINKEDIN_CLIENT_SECRET || '';

  if (!challengeCode) {
    return jsonResponse(200, { status: 'ok' });
  }

  if (!secret) {
    return jsonResponse(500, { error: 'LINKEDIN_CLIENT_SECRET mangler' });
  }

  const challengeResponseHex = crypto
    .createHmac('sha256', secret)
    .update(challengeCode, 'utf8')
    .digest('hex');

  return jsonResponse(200, {
    challengeCode,
    challengeResponse: challengeResponseHex
  });
}

async function readChallengeCodeFromPost(request) {
  const queryChallenge = request.query.get('challengeCode') || '';
  if (queryChallenge) {
    return queryChallenge;
  }

  const contentType = (request.headers.get('content-type') || '').toLowerCase();

  if (contentType.includes('application/json')) {
    const body = await request.json().catch(() => null);
    if (body && typeof body.challengeCode === 'string') {
      return body.challengeCode;
    }
  }

  if (contentType.includes('application/x-www-form-urlencoded')) {
    const textBody = await request.text().catch(() => '');
    return new URLSearchParams(textBody).get('challengeCode') || '';
  }

  return '';
}

async function forwardToPowerAutomate(url, body, contentType) {
  const method = readForwardMethod();

  let response = await sendForward(url, body, contentType, method);
  let errorText = response.ok ? '' : await response.text();

  if (!response.ok && method === 'POST' && errorText.includes('TriggerRequestMethodNotValid') && errorText.includes("expected 'GET'")) {
    response = await sendForward(url, body, contentType, 'GET');
    errorText = response.ok ? '' : await response.text();
  }

  if (!response.ok) {
    return jsonResponse(502, { error: `Videresending feilet (${response.status}): ${errorText}` });
  }

  return jsonResponse(202, { status: 'forwarded' });
}

async function sendForward(url, body, contentType, method) {
  if (method === 'GET') {
    const target = new URL(url);
    target.searchParams.set('payloadBase64', Buffer.from(body || '', 'utf8').toString('base64'));
    target.searchParams.set('payloadContentType', contentType || 'application/json');
    target.searchParams.set('source', 'linkedin-function-app');
    return fetch(target.toString(), { method: 'GET', headers: { 'x-forwarded-by': 'linkedin-function-app' } });
  }

  return fetch(url, {
    method: 'POST',
    headers: {
      'content-type': contentType || 'application/json',
      'x-forwarded-by': 'linkedin-function-app'
    },
    body
  });
}

async function readForm(request) {
  const text = await request.text();
  const params = new URLSearchParams(text);
  return Object.fromEntries(params.entries());
}

function assertConfig() {
  const clientId = process.env.LINKEDIN_CLIENT_ID || '';
  const secret = process.env.LINKEDIN_CLIENT_SECRET || '';
  if (!clientId || !secret) {
    throw new Error('LINKEDIN_CLIENT_ID og LINKEDIN_CLIENT_SECRET må settes');
  }
}

function getRedirectUri() {
  return (process.env.LINKEDIN_REDIRECT_URI || '').trim() || `${getWebhookBaseUrl()}/auth/linkedin/callback`;
}

function getWebhookBaseUrl() {
  const raw = (process.env.WEBHOOK_PUBLIC_BASE_URL || '').trim();
  if (!raw) {
    throw new Error('WEBHOOK_PUBLIC_BASE_URL må settes');
  }

  const url = new URL(raw);
  if (url.protocol !== 'https:') {
    throw new Error('WEBHOOK_PUBLIC_BASE_URL må være HTTPS');
  }

  return raw.replace(/\/+$/, '');
}

function getWebhookBaseUrlHint() {
  const raw = (process.env.WEBHOOK_PUBLIC_BASE_URL || '').trim();
  return raw || 'IKKE SATT';
}

function parseOptionalJson(value, fieldName) {
  if (!value) {
    return undefined;
  }

  try {
    return JSON.parse(value);
  } catch (_error) {
    throw new Error(`${fieldName} må være gyldig JSON`);
  }
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

async function fetchLinkedInSubscriptions(token, ownerUrn, apiVersion) {
  let subscriptions;

  try {
    subscriptions = await fetchLinkedInSubscriptionsRaw(token, apiVersion, ownerUrn);
  } catch (error) {
    const fallbackSubscriptions = await fetchLinkedInSubscriptionsByKnownIds(token, apiVersion);
    if (fallbackSubscriptions.length === 0) {
      throw error;
    }

    subscriptions = fallbackSubscriptions;
  }

  const normalizedOwnerUrn = (ownerUrn || '').trim().toLowerCase();

  if (!normalizedOwnerUrn) {
    return subscriptions;
  }

  return subscriptions.filter((item) => subscriptionMatchesOwnerUrn(item, normalizedOwnerUrn));
}

async function fetchLinkedInSubscriptionsByKnownIds(token, apiVersion) {
  const localItems = await listSubscriptions('');
  const knownIds = new Set();

  for (const item of localItems) {
    const id = item && item.linkedInSubscription && item.linkedInSubscription.xRestLiId;
    if (id && String(id).trim()) {
      knownIds.add(String(id).trim());
    }
  }

  const resolved = [];
  for (const id of knownIds) {
    try {
      const remoteSubscription = await fetchLinkedInSubscriptionById(token, id, apiVersion);
      resolved.push(remoteSubscription);
    } catch (_error) {
      // Continue if one ID is gone or inaccessible.
    }
  }

  return resolved;
}

async function fetchLinkedInSubscriptionById(token, subscriptionId, apiVersion) {
  const response = await fetch(`https://api.linkedin.com/rest/leadNotifications/${encodeURIComponent(subscriptionId)}`, {
    method: 'GET',
    headers: {
      Authorization: `Bearer ${token}`,
      'LinkedIn-Version': apiVersion,
      'X-RestLi-Protocol-Version': '2.0.0'
    }
  });

  const text = await response.text();
  const body = tryJson(text);

  if (!response.ok) {
    throw new Error(`leadNotifications get feilet (${response.status}) id=${subscriptionId}: ${JSON.stringify(body)}`);
  }

  return body;
}

async function fetchLinkedInSubscriptionsRaw(token, apiVersion, ownerUrn) {
  const owner = (ownerUrn || '').trim();
  const attempts = [];

  // LinkedIn Rest.li resources often require a finder query (q=...).
  if (owner) {
    const ownerCandidates = buildOwnerFinderCandidates(owner);
    for (const ownerCandidate of ownerCandidates) {
      attempts.push(`https://api.linkedin.com/rest/leadNotifications?q=owner&owner=${encodeURIComponent(ownerCandidate)}`);
      attempts.push(`https://api.linkedin.com/rest/leadNotifications?q=owners&owners=${encodeURIComponent(`List(${ownerCandidate})`)}`);
    }
  }

  attempts.push('https://api.linkedin.com/rest/leadNotifications?q=owner');
  attempts.push('https://api.linkedin.com/rest/leadNotifications');

  let lastError;

  for (const url of attempts) {
    const response = await fetch(url, {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${token}`,
        'LinkedIn-Version': apiVersion,
        'X-RestLi-Protocol-Version': '2.0.0'
      }
    });

    const text = await response.text();
    const body = tryJson(text);

    if (response.ok) {
      if (Array.isArray(body)) {
        return body;
      }

      if (Array.isArray(body.elements)) {
        return body.elements;
      }

      if (Array.isArray(body.results)) {
        return body.results;
      }

      return [];
    }

    lastError = { status: response.status, body, url };

    // Continue probing alternative finder shapes for validation/missing-resource errors.
    if (response.status !== 404 && response.status !== 400) {
      break;
    }
  }

  const errorDetails = lastError || { status: 0, body: {}, url: 'unknown' };
  throw new Error(`leadNotifications list feilet (${errorDetails.status}) via ${errorDetails.url}: ${JSON.stringify(errorDetails.body)}`);
}

function buildOwnerFinderCandidates(ownerUrn) {
  const raw = String(ownerUrn || '').trim();
  if (!raw) {
    return [];
  }

  const normalized = raw.startsWith('urn:li:') ? raw : `urn:li:sponsoredAccount:${raw}`;
  const lower = normalized.toLowerCase();

  let restliUnionType = 'SPONSORED_ACCOUNT';
  let ownerField = 'sponsoredAccount';

  if (lower.includes(':organization:')) {
    restliUnionType = 'ORGANIZATION';
    ownerField = 'organization';
  }

  return [
    normalized,
    `(${ownerField}:${normalized})`,
    `(value:${normalized},type:${restliUnionType})`
  ];
}

function subscriptionMatchesOwnerUrn(item, normalizedOwnerUrn) {
  const owner = item && item.owner;

  if (owner && typeof owner === 'object') {
    for (const value of Object.values(owner)) {
      if (typeof value === 'string' && value.toLowerCase() === normalizedOwnerUrn) {
        return true;
      }
    }
  }

  if (typeof item.ownerUrn === 'string' && item.ownerUrn.toLowerCase() === normalizedOwnerUrn) {
    return true;
  }

  return JSON.stringify(item).toLowerCase().includes(normalizedOwnerUrn);
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
  const body = tryJson(text);

  if (!response.ok) {
    throw new Error(`leadNotifications create feilet (${response.status}): ${JSON.stringify(body)}`);
  }

  return {
    status: response.status,
    xRestLiId: response.headers.get('x-restli-id'),
    body
  };
}

function tryJson(text) {
  try {
    return text ? JSON.parse(text) : {};
  } catch (_error) {
    return { raw: text };
  }
}

function verifyLinkedInSignature(rawBody, signatureHeader, clientSecret) {
  if (!signatureHeader || typeof signatureHeader !== 'string' || !clientSecret) {
    return false;
  }

  const expected = `hmacsha256=${crypto.createHmac('sha256', clientSecret).update(rawBody, 'utf8').digest('hex')}`;
  if (expected.length !== signatureHeader.length) {
    return false;
  }

  return crypto.timingSafeEqual(Buffer.from(expected, 'utf8'), Buffer.from(signatureHeader, 'utf8'));
}

function readBoolEnv(name) {
  const value = (process.env[name] || '').trim().toLowerCase();
  return value === '1' || value === 'true' || value === 'yes';
}

function readForwardMethod() {
  const method = (process.env.POWER_AUTOMATE_WEBHOOK_METHOD || 'POST').trim().toUpperCase();
  return method === 'GET' ? 'GET' : 'POST';
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

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

function renderStartOAuthForm(apiVersion) {
  return `<!doctype html>
<html lang="no">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Start LinkedIn OAuth</title>
    <style>
      body { font-family: Segoe UI, sans-serif; margin: 0; background: #f4f7fb; color: #1f2430; }
      .wrap { max-width: 900px; margin: 40px auto; padding: 0 16px; }
      .card { background: #fff; border: 1px solid #d7e0ec; border-radius: 12px; padding: 22px; }
      form { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; }
      label { display: flex; flex-direction: column; gap: 6px; font-size: 14px; }
      input, select, textarea { padding: 10px 12px; border-radius: 8px; border: 1px solid #cfd9e6; }
      textarea { min-height: 90px; resize: vertical; }
      .full { grid-column: span 2; }
      button { grid-column: span 2; border: 0; border-radius: 8px; padding: 11px 14px; background: #0a66c2; color: #fff; font-weight: 600; cursor: pointer; }
      .lookup { margin-top: 22px; padding-top: 14px; border-top: 1px solid #e7edf6; }
      .lookup-row { display: grid; grid-template-columns: 1fr auto; gap: 10px; align-items: end; }
      .lookup-row button { grid-column: auto; }
      .results { margin-top: 12px; display: grid; gap: 10px; }
      .result-card { border: 1px solid #d7e0ec; border-radius: 10px; padding: 10px 12px; background: #fbfdff; }
      .muted { color: #5a687f; font-size: 13px; }
      @media (max-width: 740px) { form { grid-template-columns: 1fr; } .full, button { grid-column: span 1; } }
    </style>
  </head>
  <body>
    <div class="wrap">
      <div class="card">
        <h1>Start LinkedIn OAuth</h1>
        <form method="POST" action="/auth/linkedin/start">
          <label>
            Kunde-ID
            <input name="customerId" required placeholder="kunde-a" />
          </label>
          <label>
            Power Automate webhook URL (https)
            <input name="customerWebhookUrl" required placeholder="https://..." />
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
            <input name="apiVersion" value="${escapeHtml(apiVersion)}" />
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

        <div class="lookup">
          <h2>Finn registrerte webhooks per LinkedIn ID</h2>
          <div class="lookup-row">
            <label>
              LinkedIn owner URN eller ID
              <input id="ownerLookup" placeholder="urn:li:sponsoredAccount:123456 eller 123456" />
            </label>
            <button id="lookupButton" type="button">Sok</button>
          </div>
          <p class="muted">Tips: Du kan bruke full URN eller bare numerisk ID.</p>
          <div id="lookupResults" class="results"></div>
        </div>
      </div>
    </div>

    <script>
      const ownerInput = document.getElementById('ownerLookup');
      const lookupButton = document.getElementById('lookupButton');
      const lookupResults = document.getElementById('lookupResults');

      async function lookupSubscriptions() {
        const ownerValue = (ownerInput.value || '').trim();
        lookupResults.innerHTML = '';

        if (!ownerValue) {
          lookupResults.textContent = 'Skriv inn LinkedIn owner URN eller ID.';
          return;
        }

        lookupButton.disabled = true;
        lookupButton.textContent = 'Starter OAuth...';
        window.location.href = '/auth/linkedin/start?lookupOwnerUrn=' + encodeURIComponent(ownerValue)
          + '&apiVersion=' + encodeURIComponent('${escapeHtml(apiVersion)}');
      }

      function escapeHtmlText(value) {
        return String(value)
          .replace(/&/g, '&amp;')
          .replace(/</g, '&lt;')
          .replace(/>/g, '&gt;')
          .replace(/"/g, '&quot;')
          .replace(/'/g, '&#039;');
      }

      lookupButton.addEventListener('click', lookupSubscriptions);
      ownerInput.addEventListener('keydown', function (event) {
        if (event.key === 'Enter') {
          event.preventDefault();
          lookupSubscriptions();
        }
      });
    </script>
  </body>
</html>`;
}

function renderLinkedInLookupResultPage(ownerUrn, items) {
  const rows = items.length
    ? items.map((item) => `<div class="result-card"><pre>${escapeHtml(JSON.stringify(item, null, 2))}</pre></div>`).join('')
    : '<p>Ingen subscriptions funnet hos LinkedIn for angitt owner.</p>';

  return `<!doctype html>
<html lang="no">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>LinkedIn Subscriptions</title>
    <style>
      body { font-family: Segoe UI, sans-serif; margin: 0; background: #f4f7fb; color: #1f2430; }
      .wrap { max-width: 980px; margin: 32px auto; padding: 0 16px; }
      .card { background: #fff; border: 1px solid #d7e0ec; border-radius: 12px; padding: 22px; }
      .result-card { border: 1px solid #d7e0ec; border-radius: 10px; margin-top: 10px; padding: 12px; background: #fbfdff; }
      pre { margin: 0; white-space: pre-wrap; word-break: break-word; }
      a { color: #0a66c2; }
    </style>
  </head>
  <body>
    <div class="wrap">
      <div class="card">
        <h1>Subscriptions fra LinkedIn API</h1>
        <p><b>Owner filter:</b> ${escapeHtml(ownerUrn)}</p>
        <p><b>Antall treff:</b> ${items.length}</p>
        ${rows}
        <p><a href="/start">Tilbake til start</a></p>
      </div>
    </div>
  </body>
</html>`;
}

function toMessage(error) {
  return error instanceof Error ? error.message : String(error);
}
