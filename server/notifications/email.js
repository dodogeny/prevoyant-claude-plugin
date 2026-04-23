'use strict';

// Email notifications — stub for future implementation.
// Planned: nodemailer + SMTP (reuse PRX_SMTP_* vars from .env).
// When ready, wire into claudeRunner.js after a successful analysis.

async function sendEmail({ to, subject, body }) {
  console.log('[email] sendEmail not yet implemented');
}

module.exports = { sendEmail };
