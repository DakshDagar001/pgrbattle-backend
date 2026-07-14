/**
 * Environment Validation Module
 * Validates all required environment variables before server startup.
 * Logs clear errors and exits gracefully if configuration is missing or invalid.
 */

function validateEnv() {
  const errors = [];

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

  // Required Gmail Configuration
  const requiredGmailVars = [
    'GMAIL_CLIENT_ID',
    'GMAIL_CLIENT_SECRET',
    'GMAIL_REDIRECT_URI',
    'GMAIL_REFRESH_TOKEN'
  ];

  requiredGmailVars.forEach((envVar) => {
    if (!process.env[envVar]) {
      errors.push(`Missing Gmail configuration: ${envVar}`);
    }
  });

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
