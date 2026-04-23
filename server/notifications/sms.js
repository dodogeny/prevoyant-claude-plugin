'use strict';

// SMS notifications — stub for future implementation.
// Planned: Twilio SDK. Config vars: TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN,
// TWILIO_FROM_NUMBER, PRX_SMS_TO.

async function sendSMS({ to, message }) {
  console.log('[sms] sendSMS not yet implemented');
}

module.exports = { sendSMS };
