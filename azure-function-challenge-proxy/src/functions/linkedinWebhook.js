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

      return handleEventForward(request, context);
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

async function handleEventForward(request, context) {
  const forwardUrl = (process.env.POWER_AUTOMATE_WEBHOOK_URL || '').trim();

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

    return forwardPayload(forwardUrl, rawBody, request.headers.get('content-type'));
  }

  const rawBody = await request.text();
  return forwardPayload(forwardUrl, rawBody, request.headers.get('content-type'));
}

async function forwardPayload(forwardUrl, body, contentType) {
  const response = await fetch(forwardUrl, {
    method: 'POST',
    headers: {
      'content-type': contentType || 'application/json',
      'x-forwarded-by': 'linkedin-challenge-proxy-function'
    },
    body
  });

  if (!response.ok) {
    const errorText = await response.text();
    return jsonResponse(502, {
      error: `Videresending feilet (${response.status}): ${errorText}`
    });
  }

  return jsonResponse(202, { status: 'forwarded' });
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
