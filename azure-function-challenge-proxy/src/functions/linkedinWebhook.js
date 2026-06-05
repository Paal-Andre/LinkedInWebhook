const crypto = require('crypto');
const { app } = require('@azure/functions');

app.http('linkedinWebhook', {
  methods: ['GET', 'POST'],
  authLevel: 'anonymous',
  route: 'webhooks/linkedin/{subscriptionKey}',
  handler: async (request, context) => {
    const subscriptionKey = request.params.subscriptionKey;

    if (!subscriptionKey) {
      return jsonResponse(400, { error: 'Mangler subscriptionKey i URL' });
    }

    if (request.method === 'GET') {
      return handleChallenge(request.query.get('challengeCode') || '');
    }

    if (request.method === 'POST') {
      // Some integrations may send challengeCode in POST instead of GET.
      const challengeCode = await readChallengeCodeFromPost(request);
      if (challengeCode) {
        return handleChallenge(challengeCode);
      }

      return handleEventForward(request);
    }

    return jsonResponse(405, { error: 'Metode ikke tillatt' });
  }
});

function handleChallenge(challengeCode) {
  const linkedInClientSecret = process.env.LINKEDIN_CLIENT_SECRET || '';

  if (!challengeCode) {
    return jsonResponse(200, { status: 'ok' });
  }

  if (!linkedInClientSecret) {
    return jsonResponse(500, { error: 'LINKEDIN_CLIENT_SECRET mangler' });
  }

  const challengeResponse = crypto
    .createHmac('sha256', linkedInClientSecret)
    .update(challengeCode, 'utf8')
    .digest('hex');

  return jsonResponse(200, {
    challengeCode,
    challengeResponse
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
    const params = new URLSearchParams(textBody);
    return params.get('challengeCode') || '';
  }

  return '';
}

async function handleEventForward(request) {
  const forwardUrl = (process.env.POWER_AUTOMATE_WEBHOOK_URL || '').trim();
  const forwardMethod = readForwardMethod();

  if (!forwardUrl) {
    return jsonResponse(500, { error: 'POWER_AUTOMATE_WEBHOOK_URL mangler' });
  }

  if (readBoolEnv('VERIFY_LINKEDIN_SIGNATURE')) {
    const signatureHeader = request.headers.get('x-li-signature');
    const linkedInClientSecret = process.env.LINKEDIN_CLIENT_SECRET || '';

    if (!linkedInClientSecret) {
      return jsonResponse(500, { error: 'LINKEDIN_CLIENT_SECRET mangler for signaturverifisering' });
    }

    const rawBody = await request.text();
    if (!verifyLinkedInSignature(rawBody, signatureHeader, linkedInClientSecret)) {
      return jsonResponse(401, { error: 'Ugyldig X-LI-Signature' });
    }

    return forwardPayload(forwardUrl, rawBody, request.headers.get('content-type'), forwardMethod);
  }

  const rawBody = await request.text();
  return forwardPayload(forwardUrl, rawBody, request.headers.get('content-type'), forwardMethod);
}

async function forwardPayload(forwardUrl, body, contentType, method) {
  let response = await sendToPowerAutomate(forwardUrl, body, contentType, method);
  let errorText = response.ok ? '' : await response.text();

  if (!response.ok && method === 'POST' && shouldRetryAsGet(errorText)) {
    response = await sendToPowerAutomate(forwardUrl, body, contentType, 'GET');
    errorText = response.ok ? '' : await response.text();
  }

  if (!response.ok) {
    return jsonResponse(502, {
      error: `Videresending feilet (${response.status}): ${errorText}`
    });
  }

  return jsonResponse(202, { status: 'forwarded' });
}

async function sendToPowerAutomate(forwardUrl, body, contentType, method) {
  if (method === 'GET') {
    const url = new URL(forwardUrl);
    url.searchParams.set('payloadBase64', Buffer.from(body || '', 'utf8').toString('base64'));
    url.searchParams.set('payloadContentType', contentType || 'application/json');
    url.searchParams.set('source', 'linkedin-challenge-proxy-function');

    return fetch(url.toString(), {
      method: 'GET',
      headers: {
        'x-forwarded-by': 'linkedin-challenge-proxy-function'
      }
    });
  }

  return fetch(forwardUrl, {
    method: 'POST',
    headers: {
      'content-type': contentType || 'application/json',
      'x-forwarded-by': 'linkedin-challenge-proxy-function'
    },
    body
  });
}

function shouldRetryAsGet(errorText) {
  if (!errorText) {
    return false;
  }

  return errorText.includes('TriggerRequestMethodNotValid') && errorText.includes("expected 'GET'");
}

function readForwardMethod() {
  const method = (process.env.POWER_AUTOMATE_WEBHOOK_METHOD || 'POST').trim().toUpperCase();
  return method === 'GET' ? 'GET' : 'POST';
}

function verifyLinkedInSignature(rawBody, signatureHeader, clientSecret) {
  if (!signatureHeader || typeof signatureHeader !== 'string') {
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

function jsonResponse(status, body) {
  return {
    status,
    jsonBody: body
  };
}
