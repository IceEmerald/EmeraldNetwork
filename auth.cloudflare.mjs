const DEFAULT_RESPONSE = {
  ok: true,
  service: 'emeraldnetwork-auth'
};

function getAppBaseUrl(env) {
  return (env.APP_BASE_URL || 'https://emeraldnetwork.groups.id').replace(/\/+$/, '');
}

function getPublicBaseUrl(env) {
  return (env.PUBLIC_BASE_URL || 'https://emeraldnetwork-auth.iceemerald.workers.dev').replace(/\/+$/, '');
}

function hasD1Config(env) {
  return !!(env.DB && typeof env.DB.prepare === 'function');
}

function safeRedirectValue(value, fallback = '/') {
  if (!value || typeof value !== 'string') return fallback;
  const cleaned = value.trim();
  if (!cleaned) return fallback;
  if (cleaned.startsWith('http://') || cleaned.startsWith('https://')) {
    return cleaned;
  }
  if (cleaned.startsWith('/')) {
    return cleaned;
  }
  return '/' + cleaned.replace(/^\/+/, '');
}

function getAllowedOrigin(request, env) {
  const origin = request.headers.get('Origin') || '';
  const appOrigin = getAppBaseUrl(env);
  const allowed = new Set([
    appOrigin,
    'https://emeraldnetwork.groups.id',
    'http://localhost:8787',
    'http://localhost:8000',
    'http://localhost:3000'
  ]);

  if (origin && allowed.has(origin)) {
    return origin;
  }

  return appOrigin;
}

function corsHeaders(request, env) {
  const origin = getAllowedOrigin(request, env);
  return {
    'Access-Control-Allow-Origin': origin,
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-Requested-With',
    'Access-Control-Allow-Credentials': 'true',
    'Vary': 'Origin'
  };
}

function jsonResponse(data, status = 200, headers = {}, request = null, env = {}) {
  const req = request || new Request('https://example.com');
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      ...corsHeaders(req, env),
      ...headers
    }
  });
}

function base64urlEncode(input) {
  const bytes = typeof input === 'string' ? new TextEncoder().encode(input) : input;
  let binary = '';
  bytes.forEach((byte) => {
    binary += String.fromCharCode(byte);
  });

  return btoa(binary)
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/g, '');
}

async function createJwt(secret, payload) {
  if (!secret) throw new Error('JWT_SECRET is not configured for this worker.');
  const header = base64urlEncode(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const body = base64urlEncode(JSON.stringify(payload));
  const signingInput = `${header}.${body}`;

  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );

  const signature = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(signingInput));
  return `${signingInput}.${base64urlEncode(new Uint8Array(signature))}`;
}

function decodeJwtPayload(token) {
  try {
    const parts = String(token || '').split('.');
    if (parts.length !== 3) return null;
    const payload = parts[1];
    if (!payload) return null;
    const decoded = atob(payload.replace(/-/g, '+').replace(/_/g, '/'));
    return JSON.parse(decoded);
  } catch (_) {
    return null;
  }
}

async function verifyJwt(secret, token) {
  if (!secret || typeof token !== 'string') return null;
  const parts = token.split('.');
  if (parts.length !== 3) return null;

  try {
    const header = JSON.parse(atob(parts[0].replace(/-/g, '+').replace(/_/g, '/')));
    if (!header || header.alg !== 'HS256' || header.typ !== 'JWT') return null;
    const key = await crypto.subtle.importKey(
      'raw', new TextEncoder().encode(secret),
      { name: 'HMAC', hash: 'SHA-256' }, false, ['verify']
    );
    const signature = Uint8Array.from(atob(parts[2].replace(/-/g, '+').replace(/_/g, '/')), (char) => char.charCodeAt(0));
    const valid = await crypto.subtle.verify(
      'HMAC', key, signature, new TextEncoder().encode(`${parts[0]}.${parts[1]}`)
    );
    if (!valid) return null;
    const payload = decodeJwtPayload(token);
    if (!payload || !payload.email || !payload.exp || payload.exp <= Math.floor(Date.now() / 1000)) return null;
    return payload;
  } catch (_) {
    return null;
  }
}

async function hashPassword(password, pepper) {
  const value = `${password}${pepper || 'emeraldnetwork-dev'}`;
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
}

function isValidEmail(email) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(String(email || ''));
}

function parseJsonBody(request) {
  return request.json().catch(() => ({}));
}

async function readUserByEmail(env, email) {
  if (!hasD1Config(env)) {
    return null;
  }

  const row = await env.DB.prepare(
    'SELECT * FROM users WHERE email = ? LIMIT 1'
  ).bind(String(email).trim().toLowerCase()).first();

  if (!row) return null;

  return {
    ...row,
    data: row.data ? JSON.parse(row.data) : {},
    email: String(row.email || '').trim().toLowerCase()
  };
}

async function upsertUser(env, userDoc) {
  if (!hasD1Config(env)) {
    return userDoc;
  }

  const email = String(userDoc.email || '').trim().toLowerCase();
  const existing = await readUserByEmail(env, email);

  if (existing) {
    await env.DB.prepare(`
      UPDATE users
      SET passwordHash = ?,
          provider = ?,
          data = ?,
          updatedAt = ?,
          lastLoginAt = ?
      WHERE email = ?
    `).bind(
      userDoc.passwordHash ?? existing.passwordHash ?? null,
      userDoc.provider ?? existing.provider ?? 'email',
      JSON.stringify(userDoc.data ?? existing.data ?? {}),
      new Date().toISOString(),
      new Date().toISOString(),
      email
    ).run();

    return await readUserByEmail(env, email);
  }

  await env.DB.prepare(`
    INSERT INTO users (email, passwordHash, provider, data, createdAt, updatedAt, lastLoginAt)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).bind(
    email,
    userDoc.passwordHash ?? null,
    userDoc.provider || 'email',
    JSON.stringify(userDoc.data || {}),
    new Date().toISOString(),
    new Date().toISOString(),
    new Date().toISOString()
  ).run();

  return await readUserByEmail(env, email);
}

function buildAuthSession(email, provider, token) {
  return {
    user: { email, provider },
    token,
    updatedAt: Date.now()
  };
}

async function handleRegister(request, env) {
  if (!hasD1Config(env)) {
    return jsonResponse({ error: 'Cloudflare D1 is not configured for this worker.' }, 500, {}, request, env);
  }

  const payload = await parseJsonBody(request);
  const email = String(payload.email || '').trim().toLowerCase();
  const password = String(payload.password || '');
  const redirect = safeRedirectValue(payload.redirect, '/');

  if (!isValidEmail(email)) {
    return jsonResponse({ error: 'Please enter a valid email address.' }, 400, {}, request, env);
  }

  if (password.length < 8) {
    return jsonResponse({ error: 'Password must be at least 8 characters long.' }, 400, {}, request, env);
  }

  const existing = await readUserByEmail(env, email);
  if (existing) {
    return jsonResponse({ error: 'An account with this email already exists.' }, 409, {}, request, env);
  }

  const passwordHash = await hashPassword(password, env.PASSWORD_PEPPER || 'emeraldnetwork-dev');
  const user = {
    email,
    passwordHash,
    provider: 'email',
    data: {},
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    lastLoginAt: new Date().toISOString()
  };

  const savedUser = await upsertUser(env, user);
  const token = await createJwt(env.JWT_SECRET, {
    sub: savedUser.email,
    email: savedUser.email,
    provider: 'email',
    iat: Math.floor(Date.now() / 1000),
    exp: Math.floor(Date.now() / 1000) + 60 * 60 * 24 * 7
  });

  return jsonResponse({ ok: true, redirectUrl: redirect, session: buildAuthSession(savedUser.email, 'email', token) }, 200, {}, request, env);
}

async function handleLogin(request, env) {
  if (!hasD1Config(env)) {
    return jsonResponse({ error: 'Cloudflare D1 is not configured for this worker.' }, 500, {}, request, env);
  }

  const payload = await parseJsonBody(request);
  const email = String(payload.email || '').trim().toLowerCase();
  const password = String(payload.password || '');
  const redirect = safeRedirectValue(payload.redirect, '/');

  if (!isValidEmail(email) || !password) {
    return jsonResponse({ error: 'Email and password are required.' }, 400, {}, request, env);
  }

  const existing = await readUserByEmail(env, email);
  if (!existing) {
    return jsonResponse({ error: 'No account was found for that email.' }, 404, {}, request, env);
  }

  const passwordHash = await hashPassword(password, env.PASSWORD_PEPPER || 'emeraldnetwork-dev');
  if (existing.passwordHash !== passwordHash) {
    return jsonResponse({ error: 'Incorrect password.' }, 401, {}, request, env);
  }

  const token = await createJwt(env.JWT_SECRET, {
    sub: existing.email,
    email: existing.email,
    provider: existing.provider || 'email',
    iat: Math.floor(Date.now() / 1000),
    exp: Math.floor(Date.now() / 1000) + 60 * 60 * 24 * 7
  });

  return jsonResponse({ ok: true, redirectUrl: redirect, session: buildAuthSession(existing.email, existing.provider || 'email', token) }, 200, {}, request, env);
}

async function handleSync(request, env) {
  const authHeader = request.headers.get('Authorization') || '';
  const token = authHeader.replace(/^Bearer\s+/i, '');
  if (!token) {
    return jsonResponse({ error: 'Missing token.' }, 401, {}, request, env);
  }

  const jwtPayload = await verifyJwt(env.JWT_SECRET, token);
  if (!jwtPayload) {
    return jsonResponse({ error: 'Invalid token.' }, 401, {}, request, env);
  }

  const user = await readUserByEmail(env, jwtPayload.email);
  if (!user) {
    return jsonResponse({ error: 'User not found.' }, 404, {}, request, env);
  }

  if (request.method === 'GET') {
    return jsonResponse({
      ok: true,
      user: { email: user.email },
      snapshot: user.data || {},
      syncedAt: Date.now()
    }, 200, {}, request, env);
  }

  const body = await parseJsonBody(request);
  const incoming = body.snapshot && typeof body.snapshot === 'object' ? body.snapshot : {};
  const merged = { ...(user.data || {}), ...incoming };

  await upsertUser(env, {
    ...user,
    data: merged,
    updatedAt: new Date().toISOString(),
    lastLoginAt: new Date().toISOString()
  });

  return jsonResponse({
    ok: true,
    user: { email: user.email },
    syncedAt: Date.now(),
    count: Object.keys(merged).length,
    snapshot: merged
  }, 200, {}, request, env);
}

function buildOAuthUrl(env, baseUrl, provider, redirect, intent) {
  if (provider !== 'google') return null;
  const clientId = env.GOOGLE_CLIENT_ID;
  if (!clientId) return null;

  const statePayload = {
    redirect: redirect || '/',
    intent: String(intent || 'login').toLowerCase()
  };

  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: `${baseUrl}/api/auth/google/callback`,
    response_type: 'code',
    scope: 'openid email profile',
    state: encodeURIComponent(JSON.stringify(statePayload))
  });

  return `https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}`;
}

async function handleOAuthStart(url, env, provider, request) {
  const redirect = safeRedirectValue(url.searchParams.get('redirect'), '/');
  const intent = String(url.searchParams.get('intent') || 'login').toLowerCase();
  const baseUrl = getPublicBaseUrl(env);
  const oauthUrl = buildOAuthUrl(env, baseUrl, provider, redirect, intent);

  if (!oauthUrl) {
    return jsonResponse({ error: 'Google OAuth is not configured.' }, 500, {}, request, env);
  }

  return Response.redirect(oauthUrl, 302);
}

async function handleOAuthCallback(url, env, provider) {
  if (provider !== 'google') {
    return Response.redirect(`${getAppBaseUrl(env)}/account.html?error=oauth_provider_disabled`, 302);
  }

  const code = url.searchParams.get('code');
  const rawState = url.searchParams.get('state') || '';
  let state = '/';
  let intent = 'login';

  try {
    const parsed = JSON.parse(decodeURIComponent(rawState));
    state = safeRedirectValue(parsed.redirect || '/', '/');
    intent = String(parsed.intent || 'login').toLowerCase();
  } catch (_) {
    state = safeRedirectValue(decodeURIComponent(rawState || '/'), '/');
  }

  const baseUrl = getPublicBaseUrl(env);

  if (!code) {
    return Response.redirect(`${getAppBaseUrl(env)}/account.html?error=oauth_failed`, 302);
  }

  const tokenResponse = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: env.GOOGLE_CLIENT_ID,
      client_secret: env.GOOGLE_CLIENT_SECRET,
      code,
      redirect_uri: `${baseUrl}/api/auth/google/callback`,
      grant_type: 'authorization_code'
    })
  });

  const tokenJson = await tokenResponse.json().catch(() => ({}));
  const accessToken = tokenJson.access_token;
  if (!accessToken) {
    return Response.redirect(`${getAppBaseUrl(env)}/account.html?error=oauth_failed`, 302);
  }

  const userResponse = await fetch('https://www.googleapis.com/oauth2/v2/userinfo', {
    headers: { Authorization: `Bearer ${accessToken}` }
  });

  const userJson = await userResponse.json().catch(() => ({}));
  const email = String(userJson.email || '').trim().toLowerCase();
  const emailVerified = userJson.email_verified === true || userJson.verified_email === true ||
    userJson.email_verified === 'true' || userJson.verified_email === 'true';
  if (!email) {
    return Response.redirect(`${getAppBaseUrl(env)}/account.html?error=email_missing`, 302);
  }
  if (!emailVerified) {
    return Response.redirect(`${getAppBaseUrl(env)}/account.html?error=email_unverified`, 302);
  }

  const existingUser = await readUserByEmail(env, email);
  if (!existingUser) {
    if (intent === 'register') {
      const newUser = {
        email,
        provider,
        data: {},
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        lastLoginAt: new Date().toISOString(),
        passwordHash: null
      };
      await upsertUser(env, newUser);
    } else {
      const redirectUrl = `${getAppBaseUrl(env)}/account.html?error=no_account&provider=google&redirect=${encodeURIComponent(state)}`;
      return Response.redirect(redirectUrl, 302);
    }
  } else if (intent === 'register') {
    const redirectUrl = `${getAppBaseUrl(env)}/account.html?error=already_account&provider=google&redirect=${encodeURIComponent(state)}`;
    return Response.redirect(redirectUrl, 302);
  }

  const user = {
    ...(existingUser || {}),
    email,
    provider,
    updatedAt: new Date().toISOString(),
    lastLoginAt: new Date().toISOString()
  };

  await upsertUser(env, user);
  const token = await createJwt(env.JWT_SECRET, {
    sub: email,
    email,
    provider,
    iat: Math.floor(Date.now() / 1000),
    exp: Math.floor(Date.now() / 1000) + 60 * 60 * 24 * 7
  });

  const finalUrl = new URL(safeRedirectValue(state, '/'), getAppBaseUrl(env));
  finalUrl.searchParams.set('auth_session', token);
  finalUrl.searchParams.set('auth_email', email);
  finalUrl.searchParams.set('auth_provider', provider);

  return Response.redirect(finalUrl.toString(), 302);
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const pathname = url.pathname.replace(/\/+$/, '');

    if (request.method === 'OPTIONS') {
      return new Response(null, {
        status: 204,
        headers: corsHeaders(request, env)
      });
    }

    if (pathname === '/health') {
      return jsonResponse({ ...DEFAULT_RESPONSE, ok: true }, 200, {}, request, env);
    }

    if (pathname.startsWith('/api/auth/') && !env.JWT_SECRET) {
      return jsonResponse({ error: 'Authentication is not configured: JWT_SECRET must be set.' }, 503, {}, request, env);
    }

    if (pathname === '/api/auth/register' && request.method === 'POST') {
      return handleRegister(request, env);
    }

    if (pathname === '/api/auth/login' && request.method === 'POST') {
      return handleLogin(request, env);
    }

    if (pathname === '/api/auth/sync' && (request.method === 'GET' || request.method === 'POST')) {
      return handleSync(request, env);
    }

    if (pathname === '/api/auth/google' && request.method === 'GET') {
      return handleOAuthStart(url, env, 'google', request);
    }

    if (pathname === '/api/auth/google/callback' && request.method === 'GET') {
      return handleOAuthCallback(url, env, 'google');


    return jsonResponse({ error: 'Not found.' }, 404, {}, request, env);
  }
};