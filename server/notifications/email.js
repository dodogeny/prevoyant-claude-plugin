'use strict';

// Reusable SMTP send module. Reads config from process.env at call time
// so env changes take effect without restart. Extracted from ticketWatcherWorker.js.

const net = require('net');
const tls = require('tls');

async function sendEmail({ to, subject, body }) {
  const smtpHost = process.env.PRX_SMTP_HOST || '';
  const smtpPort = process.env.PRX_SMTP_PORT || '587';
  const smtpUser = process.env.PRX_SMTP_USER || '';
  const smtpPass = process.env.PRX_SMTP_PASS || '';

  if (!smtpHost || !smtpUser || !smtpPass || !to) {
    console.log('[email] Skipped — SMTP not fully configured');
    return;
  }

  return new Promise((resolve, reject) => {
    const USE_SSL = parseInt(smtpPort, 10) === 465;
    let sock = null, active = null, buf = '', phase = 'greeting', settled = false;

    function done(err) {
      if (settled) return; settled = true;
      try { (active || sock) && (active || sock).destroy(); } catch (_) {}
      err ? reject(err) : resolve();
    }
    function write(s) { active.write(s + '\r\n'); }
    function handle(code) {
      switch (phase) {
        case 'greeting':  if (code !== 220) return done(new Error(`Greeting ${code}`));
                          phase = 'ehlo1'; write('EHLO prevoyant'); break;
        case 'ehlo1':     if (code === 250) { if (USE_SSL) { phase = 'auth'; write('AUTH LOGIN'); }
                            else { phase = 'starttls'; write('STARTTLS'); } } break;
        case 'starttls':  if (code !== 220) return done(new Error(`STARTTLS ${code}`));
                          phase = 'ehlo2';
                          { const up = tls.connect({ socket: sock, host: smtpHost, rejectUnauthorized: false });
                            up.on('secureConnect', () => { active = up; write('EHLO prevoyant'); });
                            up.on('data', onData); up.on('error', done); }
                          break;
        case 'ehlo2':     if (code === 250) { phase = 'auth'; write('AUTH LOGIN'); } break;
        case 'auth':      if (code !== 334) return done(new Error(`AUTH ${code}`));
                          phase = 'user'; write(Buffer.from(smtpUser).toString('base64')); break;
        case 'user':      if (code !== 334) return done(new Error(`USER ${code}`));
                          phase = 'pass'; write(Buffer.from(smtpPass).toString('base64')); break;
        case 'pass':      if (code !== 235) return done(new Error(`PASS ${code}`));
                          phase = 'mail'; write(`MAIL FROM:<${smtpUser}>`); break;
        case 'mail':      if (code !== 250) return done(new Error(`MAIL ${code}`));
                          phase = 'rcpt'; write(`RCPT TO:<${to}>`); break;
        case 'rcpt':      if (code !== 250) return done(new Error(`RCPT ${code}`));
                          phase = 'data'; write('DATA'); break;
        case 'data':      if (code !== 354) return done(new Error(`DATA ${code}`));
                          phase = 'body';
                          write(`From: Prevoyant Field Assistant <${smtpUser}>`);
                          write(`To: ${to}`);
                          write(`Subject: ${subject}`);
                          write(`Date: ${new Date().toUTCString()}`);
                          write('MIME-Version: 1.0');
                          write('Content-Type: text/plain; charset=utf-8');
                          write('');
                          for (const line of body.split('\n')) write(line.startsWith('.') ? '.' + line : line);
                          write('.');
                          break;
        case 'body':      if (code !== 250) return done(new Error(`MSG ${code}`));
                          phase = 'quit'; write('QUIT'); break;
        case 'quit':      done(null); break;
      }
    }
    function onData(chunk) {
      buf += chunk.toString();
      let idx;
      while ((idx = buf.indexOf('\r\n')) !== -1) {
        const line = buf.slice(0, idx); buf = buf.slice(idx + 2);
        if (!line) continue;
        const code = parseInt(line.slice(0, 3), 10);
        if (line[3] !== '-' && !isNaN(code)) handle(code);
      }
    }
    const co = { host: smtpHost, port: parseInt(smtpPort, 10), rejectUnauthorized: false };
    sock = USE_SSL ? tls.connect(co) : net.connect(co);
    active = sock;
    sock.on('data', onData); sock.on('error', done);
    sock.setTimeout(20000, () => done(new Error('SMTP timeout')));
  });
}

module.exports = { sendEmail };
