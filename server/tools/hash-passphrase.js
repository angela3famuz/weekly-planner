#!/usr/bin/env node
/*
 * Turns your passphrase into a hash to paste into Railway.
 *
 * Your passphrase is never written to disk, never printed, never sent anywhere.
 * It exists only in this process's memory for the moment it takes to hash it.
 * The only output is the PASSPHRASE_HASH line, which is safe to paste into
 * Railway's env vars — the hash cannot be turned back into the passphrase.
 *
 *   node tools/hash-passphrase.js      (or: npm run hash)
 *
 * Needs nothing installed — it imports kdf.js, which is node:crypto only.
 * On Windows, `npm` may be blocked by PowerShell's execution policy; running
 * node directly sidesteps that entirely.
 */
import readline from 'node:readline';
// kdf.js, not auth.js: importing auth.js would drag in db.js and therefore pg.
import { hashPassphrase } from '../kdf.js';

function askHidden(prompt) {
  return new Promise((resolve, reject) => {
    if (!process.stdin.isTTY) {
      reject(new Error('Run this in a real terminal — it must be able to hide what you type.'));
      return;
    }
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    process.stdout.write(prompt);
    // Swallow echo so the passphrase never appears on screen or in scrollback.
    rl._writeToOutput = () => {};
    rl.question('', (answer) => {
      rl.close();
      process.stdout.write('\n');
      resolve(answer);
    });
  });
}

// Advisory only. A weak passphrase is the single biggest risk to this data, but
// it is the user's call, not the tool's.
function critique(p) {
  const words = p.trim().split(/[\s-]+/).filter(Boolean);
  if (/^\d+$/.test(p)) return `That is ${p.length} digits — around ${Math.pow(10, p.length).toLocaleString()} guesses. This is the only thing protecting your schedule; four random words would be far stronger.`;
  if (p.length < 12) return 'That is quite short. Four random words is easier to type than it looks and vastly harder to guess.';
  if (words.length < 3) return 'Consider four random words rather than one long one — length from separate words is what makes it hard to guess.';
  return null;
}

const main = async () => {
  console.log('\nWeekly Planner — passphrase hash\n');
  console.log('Nothing you type is stored, printed, or sent. Only the hash is shown.\n');

  const p1 = await askHidden('Passphrase: ');
  if (!p1) { console.error('\nNothing entered. Aborted.'); process.exit(1); }

  const p2 = await askHidden('Again to confirm: ');
  if (p1 !== p2) { console.error('\nThose did not match. Nothing was written. Run it again.'); process.exit(1); }

  const warning = critique(p1);
  if (warning) console.log(`\n  Note: ${warning}\n`);

  const hash = await hashPassphrase(p1);

  console.log('\nPaste this into Railway as an environment variable:\n');
  console.log('  PASSPHRASE_HASH=' + hash + '\n');
  console.log('Then redeploy. Keep the passphrase itself in your password manager —');
  console.log('it cannot be recovered from this hash, and you will need it on each device.\n');
};

main().catch((e) => { console.error('\n' + e.message); process.exit(1); });
