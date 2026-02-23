import { connect } from 'node:tls';
import { getCredential } from './credentials.js';

// Minimal IMAP client for Gmail (just enough to read inbox)

class IMAPClient {
  constructor(socket) {
    this.socket = socket;
    this.tag = 0;
    this.buffer = '';
    this._resolvers = [];
  }

  static async connect(host, port) {
    return new Promise((resolve, reject) => {
      const socket = connect({ host, port, servername: host, rejectUnauthorized: true }, () => {
        const client = new IMAPClient(socket);
        // Read greeting
        client._readUntilReady().then(() => resolve(client)).catch(reject);
      });
      socket.on('error', reject);
      socket.setEncoding('utf-8');
    });
  }

  _readUntilReady() {
    return new Promise((resolve) => {
      const onData = (data) => {
        this.buffer += data;
        if (this.buffer.includes('OK')) {
          this.socket.removeListener('data', onData);
          this.buffer = '';
          resolve();
        }
      };
      this.socket.on('data', onData);
    });
  }

  async command(cmd) {
    this.tag++;
    const tag = `A${String(this.tag).padStart(4, '0')}`;
    const line = `${tag} ${cmd}\r\n`;

    return new Promise((resolve, reject) => {
      let response = '';
      const timeout = setTimeout(() => {
        this.socket.removeListener('data', onData);
        reject(new Error(`IMAP timeout on: ${cmd.split(' ')[0]}`));
      }, 30000);

      const onData = (data) => {
        response += data;
        // Check if we got the tagged response (success or failure)
        const lines = response.split('\r\n');
        for (const l of lines) {
          if (l.startsWith(`${tag} OK`) || l.startsWith(`${tag} NO`) || l.startsWith(`${tag} BAD`)) {
            clearTimeout(timeout);
            this.socket.removeListener('data', onData);
            if (l.startsWith(`${tag} NO`) || l.startsWith(`${tag} BAD`)) {
              reject(new Error(`IMAP error: ${l}`));
            } else {
              resolve(response);
            }
            return;
          }
        }
      };

      this.socket.on('data', onData);
      this.socket.write(line);
    });
  }

  async login(user, pass) {
    // Quote the password to handle special chars
    await this.command(`LOGIN ${user} "${pass.replace(/["\\]/g, '\\$&')}"`);
  }

  async select(mailbox) {
    const res = await this.command(`SELECT "${mailbox}"`);
    const existsMatch = res.match(/\* (\d+) EXISTS/);
    return { exists: existsMatch ? parseInt(existsMatch[1]) : 0 };
  }

  async search(criteria) {
    const res = await this.command(`SEARCH ${criteria}`);
    const searchLine = res.split('\r\n').find(l => l.startsWith('* SEARCH'));
    if (!searchLine) return [];
    return searchLine.replace('* SEARCH ', '').trim().split(' ').filter(Boolean).map(Number);
  }

  async fetchHeaders(seqNums) {
    if (seqNums.length === 0) return [];
    const set = seqNums.join(',');
    const res = await this.command(`FETCH ${set} (BODY.PEEK[HEADER.FIELDS (FROM SUBJECT DATE)] FLAGS)`);
    return parseFetchResults(res, seqNums);
  }

  async fetchBody(seqNum) {
    const res = await this.command(`FETCH ${seqNum} (BODY.PEEK[TEXT] BODY.PEEK[HEADER.FIELDS (FROM TO SUBJECT DATE)])`);
    return parseFetchBody(res);
  }

  async logout() {
    try {
      await this.command('LOGOUT');
    } catch { /* ignore */ }
    this.socket.destroy();
  }
}

function parseFetchResults(raw, seqNums) {
  const results = [];
  // Split by fetch response boundaries
  const parts = raw.split(/\* \d+ FETCH/);

  for (let i = 1; i < parts.length; i++) {
    const part = parts[i];
    const headers = {};

    const fromMatch = part.match(/From:\s*(.+)/i);
    if (fromMatch) headers.from = fromMatch[1].trim();

    const subjectMatch = part.match(/Subject:\s*(.+)/i);
    if (subjectMatch) headers.subject = subjectMatch[1].trim();

    const dateMatch = part.match(/Date:\s*(.+)/i);
    if (dateMatch) headers.date = dateMatch[1].trim();

    const seen = part.includes('\\Seen');

    results.push({
      seq: seqNums[i - 1] || i,
      from: headers.from || '(unknown)',
      subject: headers.subject || '(no subject)',
      date: headers.date || '',
      read: seen,
    });
  }

  return results;
}

function parseFetchBody(raw) {
  const headers = {};
  const fromMatch = raw.match(/From:\s*(.+)/i);
  if (fromMatch) headers.from = fromMatch[1].trim();

  const toMatch = raw.match(/To:\s*(.+)/i);
  if (toMatch) headers.to = toMatch[1].trim();

  const subjectMatch = raw.match(/Subject:\s*(.+)/i);
  if (subjectMatch) headers.subject = subjectMatch[1].trim();

  const dateMatch = raw.match(/Date:\s*(.+)/i);
  if (dateMatch) headers.date = dateMatch[1].trim();

  // Extract body text — find content between the header block and the tagged response
  let body = '';
  const bodyParts = raw.split(/\r\n\r\n/);
  if (bodyParts.length > 1) {
    // Take everything after headers, remove IMAP protocol lines
    body = bodyParts.slice(1).join('\n\n')
      .replace(/\)\r\n.*$/s, '')  // Remove trailing IMAP response
      .replace(/A\d{4} OK.*/g, '')
      .trim();
  }

  // Decode quoted-printable if present
  if (body.includes('=\r\n') || body.includes('=3D')) {
    body = decodeQuotedPrintable(body);
  }

  // Strip HTML tags for a text preview
  if (body.includes('<html') || body.includes('<div') || body.includes('<p')) {
    body = stripHtml(body);
  }

  return { ...headers, body: body.slice(0, 5000) }; // Cap at 5000 chars
}

function decodeQuotedPrintable(str) {
  return str
    .replace(/=\r?\n/g, '') // Soft line breaks
    .replace(/=([0-9A-Fa-f]{2})/g, (_, hex) => String.fromCharCode(parseInt(hex, 16)));
}

function stripHtml(html) {
  return html
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/\s+/g, ' ')
    .trim();
}


// Minimal SMTP client for Gmail

async function smtpConnect(host, port) {
  return new Promise((resolve, reject) => {
    const socket = connect({ host, port, servername: host, rejectUnauthorized: true }, () => {
      let greeting = '';
      const onData = (data) => {
        greeting += data;
        if (greeting.includes('220 ')) {
          socket.removeListener('data', onData);
          resolve(socket);
        }
      };
      socket.setEncoding('utf-8');
      socket.on('data', onData);
    });
    socket.on('error', reject);
  });
}

async function smtpCommand(socket, cmd, expectCode) {
  return new Promise((resolve, reject) => {
    let response = '';
    const timeout = setTimeout(() => {
      socket.removeListener('data', onData);
      reject(new Error(`SMTP timeout on: ${cmd?.split(' ')[0] || 'response'}`));
    }, 15000);

    const onData = (data) => {
      response += data;
      const lines = response.split('\r\n');
      for (const line of lines) {
        if (line.match(/^\d{3}\s/) || line.match(/^\d{3}$/)) {
          clearTimeout(timeout);
          socket.removeListener('data', onData);
          const code = parseInt(line.slice(0, 3));
          if (expectCode && code !== expectCode) {
            reject(new Error(`SMTP error: expected ${expectCode}, got: ${line}`));
          } else {
            resolve(response);
          }
          return;
        }
      }
    };

    socket.on('data', onData);
    if (cmd) socket.write(cmd + '\r\n');
  });
}

// Public API

export async function checkEmail(opts = {}) {
  const email = await getCredential('google_email');
  const password = await getCredential('google_app_password');
  if (!email || !password) throw new Error('Email credentials not configured (run: claw creds set google_email / google_app_password)');

  const client = await IMAPClient.connect('imap.gmail.com', 993);
  try {
    await client.login(email, password);
    await client.select('INBOX');

    const criteria = opts.unreadOnly !== false ? 'UNSEEN' : 'ALL';
    let ids = await client.search(criteria);

    // Get latest N
    const limit = opts.limit || 10;
    ids = ids.slice(-limit);

    if (ids.length === 0) return [];

    const messages = await client.fetchHeaders(ids);
    return messages;
  } finally {
    await client.logout();
  }
}

export async function readEmail(seqNum) {
  const email = await getCredential('google_email');
  const password = await getCredential('google_app_password');
  if (!email || !password) throw new Error('Email credentials not configured');

  const client = await IMAPClient.connect('imap.gmail.com', 993);
  try {
    await client.login(email, password);
    await client.select('INBOX');
    const msg = await client.fetchBody(seqNum);
    return msg;
  } finally {
    await client.logout();
  }
}

export async function sendEmail(to, subject, body) {
  const email = await getCredential('google_email');
  const password = await getCredential('google_app_password');
  if (!email || !password) throw new Error('Email credentials not configured');

  const socket = await smtpConnect('smtp.gmail.com', 465);
  try {
    await smtpCommand(socket, `EHLO betterbot`, 250);

    // AUTH LOGIN
    await smtpCommand(socket, 'AUTH LOGIN', 334);
    await smtpCommand(socket, Buffer.from(email).toString('base64'), 334);
    await smtpCommand(socket, Buffer.from(password).toString('base64'), 235);

    await smtpCommand(socket, `MAIL FROM:<${email}>`, 250);
    await smtpCommand(socket, `RCPT TO:<${to}>`, 250);
    await smtpCommand(socket, 'DATA', 354);

    const message = [
      `From: ${email}`,
      `To: ${to}`,
      `Subject: ${subject}`,
      `Date: ${new Date().toUTCString()}`,
      `Content-Type: text/plain; charset=utf-8`,
      '',
      body,
      '',
      '.',
    ].join('\r\n');

    await smtpCommand(socket, message, 250);
    await smtpCommand(socket, 'QUIT', 221);

    return { sent: true, to, subject };
  } finally {
    socket.destroy();
  }
}
