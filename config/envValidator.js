/**
 * Environment Validation Module
 * Validates all required environment variables before server startup.
 * Logs clear errors and exits gracefully if configuration is missing or invalid.
 */

function validateEnv() {
  const errors = [];

  // ── Sanitize ALL env vars ──
  // Trim whitespace, newlines, and carriage returns from sensitive env vars.
  // Trailing \n or \r from .env files or deployment platforms is a common cause
  // of "Invalid Header" errors when these values are used in HTTP headers.
  const varsToSanitize = [
    'FIREBASE_PROJECT_ID',
    'FIREBASE_PRIVATE_KEY_ID',
    'FIREBASE_PRIVATE_KEY',
    'FIREBASE_CLIENT_EMAIL',
    'FIREBASE_CLIENT_ID',
    'FIREBASE_DATABASE_URL',
    'GMAIL_CLIENT_ID',
    'GMAIL_CLIENT_SECRET',
    'GMAIL_REDIRECT_URI',
    'GMAIL_REFRESH_TOKEN',
    'ZAPUPI_TOKEN_KEY',
    'ZAPUPI_SECRET_KEY',
    'ZAPUPI_WEBHOOK_URL',
    'PORT'
  ];

  let sanitizedCount = 0;
  varsToSanitize.forEach((envVar) => {
    if (process.env[envVar]) {
      const original = process.env[envVar];
      // Trim whitespace and strip embedded newlines/carriage returns
      const cleaned = original.replace(/[\r\n]+/g, '').trim();
      if (cleaned !== original) {
        process.env[envVar] = cleaned;
        sanitizedCount++;
        console.warn(`[EnvValidator] Sanitized ${envVar} (removed whitespace/newline chars)`);
      }
    }
  });
  if (sanitizedCount > 0) {
    console.log(`[EnvValidator] Sanitized ${sanitizedCount} environment variable(s)`);
  }

  // Required Firebase Configuration
  const requiredFirebaseVars = [
    'FIREBASE_PROJECT_ID',
    'FIREBASE_PRIVATE_KEY_ID',
    'FIREBASE_PRIVATE_KEY',
    'FIREBASE_CLIENT_EMAIL',
    'FIREBASE_CLIENT_ID',
    'FIREBASE_DATABASE_URL'
  ];

  requiredFirebaseVars.forEach((envVar) => {
    if (!process.env[envVar]) {
      errors.push(`Missing Firebase configuration: ${envVar}`);
    }
  });

  // Required ZapUPI Configuration
  const requiredZapupiVars = [
    'ZAPUPI_TOKEN_KEY',
    'ZAPUPI_SECRET_KEY',
    'ZAPUPI_WEBHOOK_URL'
  ];

  requiredZapupiVars.forEach((envVar) => {
    if (!process.env[envVar]) {
      errors.push(`Missing ZapUPI configuration: ${envVar}`);
    }
  });

  // Gmail Configuration — downgraded to warnings (legacy, will be removed)
  const legacyGmailVars = [
    'GMAIL_CLIENT_ID',
    'GMAIL_CLIENT_SECRET',
    'GMAIL_REDIRECT_URI',
    'GMAIL_REFRESH_TOKEN'
  ];

  const missingGmailVars = legacyGmailVars.filter(v => !process.env[v]);
  if (missingGmailVars.length > 0) {
    console.warn(`[EnvValidator] Gmail configuration incomplete (legacy – not required for ZapUPI): ${missingGmailVars.join(', ')}`);
  }

  // Check obsolete variables to prevent confusion
  const obsoleteVars = [
    'FIREBASE_SERVICE_ACCOUNT',
    'ONESIGNAL_APP_ID',
    'ONESIGNAL_API_KEY',
    'GMAIL_OAUTH_CREDENTIALS',
    'GMAIL_OAUTH_TOKEN'
  ];

  obsoleteVars.forEach((envVar) => {
    if (process.env[envVar]) {
      console.warn(`[Warning] Obsolete environment variable found and ignored: ${envVar}`);
    }
  });

  // Required general variables
  if (!process.env.PORT) {
    console.warn("[Warning] PORT is not set, defaulting to 8080");
  }

  // If there are errors, exit gracefully
  if (errors.length > 0) {
    console.error('==================================================');
    console.error('ENVIRONMENT VALIDATION FAILED');
    console.error('==================================================');
    errors.forEach(err => console.error(`- ${err}`));
    console.error('==================================================');
    console.error('Please check your .env file or deployment variables.');
    process.exit(1);
  }

  console.log('✓ Environment validation passed.');
}

module.exports = { validateEnv };
