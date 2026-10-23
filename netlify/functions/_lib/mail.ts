export type MailProvider = 'log' | 'resend' | 'postmark' | 'unconfigured';

function isHosted(): boolean {
  return process.env.NODE_ENV === 'production' || !!process.env.AWS_LAMBDA_FUNCTION_NAME;
}

/** log prints the message (dev). resend/postmark call the provider. Hosted runtimes refuse when unset. */
export function mailProvider(): MailProvider {
  const raw = (process.env.EMAIL_PROVIDER || '').trim().toLowerCase();
  if (raw === 'log' || raw === 'resend' || raw === 'postmark') return raw;
  if (isHosted()) return 'unconfigured';
  return 'log';
}

export function mailConfigError(): string | null {
  const provider = mailProvider();
  if (provider === 'unconfigured') return 'Password reset email is not configured.';
  if (provider === 'resend' || provider === 'postmark') {
    if (!process.env.EMAIL_API_KEY || !process.env.EMAIL_FROM) {
      return 'Password reset email is not configured.';
    }
  }
  return null;
}

export async function sendMail(msg: { to: string; subject: string; text: string }): Promise<void> {
  const provider = mailProvider();
  const from = process.env.EMAIL_FROM || 'AE Connect <noreply@aeconnect.io>';
  if (provider === 'log') {
    console.log(`[mail] to=${msg.to} subject=${msg.subject}\n${msg.text}`);
    return;
  }
  if (provider === 'unconfigured') throw new Error('Password reset email is not configured.');

  const key = process.env.EMAIL_API_KEY || '';
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), 10_000);
  try {
    if (provider === 'resend') {
      const res = await fetch('https://api.resend.com/emails', {
        method: 'POST',
        signal: ac.signal,
        headers: {
          Authorization: `Bearer ${key}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ from, to: [msg.to], subject: msg.subject, text: msg.text }),
      });
      if (!res.ok) {
        console.error(`[mail] resend status ${res.status}`);
        throw new Error('Email provider rejected the message');
      }
      return;
    }
    const res = await fetch('https://api.postmarkapp.com/email', {
      method: 'POST',
      signal: ac.signal,
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json',
        'X-Postmark-Server-Token': key,
      },
      body: JSON.stringify({
        From: from,
        To: msg.to,
        Subject: msg.subject,
        TextBody: msg.text,
        MessageStream: 'outbound',
      }),
    });
    if (!res.ok) {
      console.error(`[mail] postmark status ${res.status}`);
      throw new Error('Email provider rejected the message');
    }
  } finally {
    clearTimeout(timer);
  }
}
