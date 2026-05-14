'use strict';

// Marker safety net — called after every ticket run.
//
// Agents emit [KB+], [CMM+], [LL+] markers inline during investigation.
// Step 13 is supposed to collect and write them. If the session was killed,
// errored, or timed out before Step 13 ran, those markers are lost.
//
// This module scans the tracker outputLog after the run and writes any found
// markers to ~/.prevoyant/knowledge-buildup/rescued-markers/{ticketKey}.md
// so they can be manually reviewed and promoted to the KB.
//
// It does NOT write to the KB directly — promotion still requires a human
// or the Step 13j review process.

const fs   = require('fs');
const os   = require('os');
const path = require('path');

const RESCUE_DIR  = path.join(os.homedir(), '.prevoyant', 'knowledge-buildup', 'rescued-markers');
const MARKER_RE   = /\[(KB\+|CMM\+|LL\+)[^\]]*\][^\n]*/g;
const STEP13_RE   = /Step\s+13\s*[—–\-]/i;

function rescueMarkers(ticketKey, outputLog, runStatus) {
  const lines = (outputLog || []).map(e => (typeof e === 'object' ? e.text : e) || '');
  if (!lines.length) return 0;

  // Collect all marker lines
  const found = [];
  for (const line of lines) {
    let m;
    MARKER_RE.lastIndex = 0;
    while ((m = MARKER_RE.exec(line)) !== null) {
      found.push(m[0].trim());
    }
  }

  if (!found.length) return 0;

  // If Step 13 ran and the run completed normally, markers were processed —
  // nothing to rescue.
  const step13Ran   = lines.some(l => STEP13_RE.test(l));
  const completedOk = runStatus === 'completed';
  if (step13Ran && completedOk) return 0;

  try {
    fs.mkdirSync(RESCUE_DIR, { recursive: true });
    const outFile = path.join(RESCUE_DIR, `${ticketKey}.md`);

    // Append — a ticket can be re-run multiple times; keep all attempts.
    const header = [
      `\n## Run rescued at ${new Date().toISOString()}`,
      `**Status:** ${runStatus}  **Step 13 ran:** ${step13Ran ? 'partial' : 'no'}`,
      '',
      `${found.length} marker(s) found:`,
      '',
    ].join('\n');

    const body = found.map(m => `- \`${m.slice(0, 200)}\``).join('\n');

    const preamble = !fs.existsSync(outFile)
      ? `# Rescued Markers — ${ticketKey}\n\n` +
        `These markers were emitted during session(s) but Step 13 did not run to completion.\n` +
        `Review and manually promote relevant entries to the KB.\n`
      : '';

    fs.appendFileSync(outFile, preamble + header + body + '\n', 'utf8');
    console.log(`[marker-rescue] ${ticketKey} — rescued ${found.length} marker(s) → ${outFile}`);
    return found.length;
  } catch (err) {
    console.warn(`[marker-rescue] ${ticketKey} — rescue write failed: ${err.message}`);
    return 0;
  }
}

module.exports = { rescueMarkers };
