import 'dotenv/config';
import { randomBytes } from 'crypto';
import { prisma } from '../netlify/functions/_lib/prisma.js';
import { writeAudit } from '../netlify/functions/_lib/audit.js';
import { normalizeEmail, passwordError, setPasswordAndInvalidateSessions } from '../netlify/functions/_lib/auth.js';

/**
 * Set a user's password from the operator's machine.
 *
 *   npm run reset-password -- <email>
 *   npm run reset-password -- <email> --generate
 *
 * A terminal prompts twice and does not print the password. A non-interactive
 * shell, or --generate, creates a password and prints it once on stdout as
 * NEW_PASSWORD=... so it is not written to a file or the audit log.
 */
function usage(): never {
  console.error('Usage: npm run reset-password -- <email> [--generate]');
  process.exit(2);
}

function promptHidden(question: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const stdin = process.stdin;
    const stdout = process.stdout;
    if (typeof stdin.setRawMode !== 'function') {
      reject(new Error('No terminal available for a password prompt. Re-run with --generate.'));
      return;
    }
    stdout.write(question);
    stdin.setRawMode(true);
    stdin.resume();
    stdin.setEncoding('utf8');
    let value = '';
    const onData = (ch: string) => {
      if (ch === '\n' || ch === '\r' || ch === '\u0004') {
        stdin.setRawMode(false);
        stdin.pause();
        stdin.off('data', onData);
        stdout.write('\n');
        resolve(value);
      } else if (ch === '\u0003') {
        stdin.setRawMode(false);
        process.exit(1);
      } else if (ch === '\u007f' || ch === '\b') {
        value = value.slice(0, -1);
      } else {
        value += ch;
      }
    };
    stdin.on('data', onData);
  });
}

async function choosePassword(generate: boolean): Promise<string> {
  if (generate || !process.stdin.isTTY) {
    return randomBytes(18).toString('base64url');
  }
  const first = await promptHidden('New password: ');
  const second = await promptHidden('Confirm password: ');
  if (first !== second) {
    console.error('Passwords did not match. Nothing was changed.');
    process.exit(1);
  }
  const problem = passwordError(first);
  if (problem) {
    console.error(`${problem}. Nothing was changed.`);
    process.exit(1);
  }
  return first;
}

async function main() {
  const args = process.argv.slice(2).filter((arg) => arg !== '--');
  const generate = args.includes('--generate');
  const emailArg = args.find((arg) => !arg.startsWith('--'));
  if (!emailArg) usage();
  if (!process.env.DATABASE_URL) {
    console.error('DATABASE_URL is not set.');
    process.exit(1);
  }

  const email = normalizeEmail(emailArg) ?? emailArg.trim().toLowerCase();
  if (!email || !email.includes('@')) {
    console.error('Enter an email address.');
    process.exit(1);
  }

  const user = await prisma.user.findUnique({
    where: { email },
    select: { id: true, email: true },
  });
  if (!user) {
    console.error(`No account found for ${email}.`);
    process.exitCode = 1;
    return;
  }

  console.log(`Account found for ${user.email}.`);
  const password = await choosePassword(generate);
  const showGenerated = generate || !process.stdin.isTTY;
  await setPasswordAndInvalidateSessions(user.id, password);
  await writeAudit({ userId: user.id, action: 'PASSWORD_RESET', detail: { via: 'admin-script' } });
  console.log('Password updated. Existing sessions were signed out.');
  if (showGenerated) console.log(`NEW_PASSWORD=${password}`);
}

main()
  .catch((err) => {
    console.error(err instanceof Error ? err.message : 'Password reset failed.');
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
