/**
 * Test harness for the auth routes.
 *
 * Mounts the real router (and the real `verifyAuth` middleware, with only its
 * token verifier injected) on an ephemeral HTTP server so request
 * behaviour is asserted end to end without touching Firebase credentials.
 */

const express = require('express');
const { createAuthRouter, createRateLimiter } = require('../../routes/authRoutes');
const { createVerifyAuth } = require('../../middleware/auth');

/**
 * Build the real `verifyAuth` middleware with a stubbed token verifier.
 * `firebase-admin`'s exports are a Proxy, so patching `admin.auth` is silently
 * ignored — the verifier has to be injected instead.
 */
function makeAuthenticator(tokens) {
  return createVerifyAuth({
    verifyIdToken: async idToken => {
      const record = tokens[idToken];
      if (!record) {
        const error = new Error('Invalid Firebase ID token');
        error.code = 'auth/argument-error';
        throw error;
      }
      return record;
    }
  });
}

function createTestApp({ firestore, limiter, authenticator } = {}) {
  const app = express();
  app.set('trust proxy', true);
  app.use(express.json());
  app.use('/api/auth', createAuthRouter({
    firestore: () => firestore,
    authenticator,
    limiter: limiter || createRateLimiter()
  }));
  return app;
}

async function startServer(app) {
  const server = await new Promise(resolve => {
    const listener = app.listen(0, '127.0.0.1', () => resolve(listener));
  });
  const { port } = server.address();
  return {
    server,
    baseUrl: `http://127.0.0.1:${port}`,
    async close() {
      await new Promise(resolve => server.close(resolve));
    }
  };
}

async function request(baseUrl, path, { method = 'GET', token, body } = {}) {
  const headers = {};
  if (token) headers.Authorization = `Bearer ${token}`;
  if (body !== undefined) headers['Content-Type'] = 'application/json';

  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  const text = await response.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = null;
  }
  return { status: response.status, body: json, text };
}

module.exports = { makeAuthenticator, createTestApp, startServer, request };
