#!/usr/bin/env node
/**
 * Log in to any Google account via the browser to obtain a refresh token
 * and add it directly to the Antigravity Pool database.
 * Run: node scripts/login.js
 */

const http = require('http');
const { spawn } = require('child_process');
const { PrismaClient } = require('@prisma/client');

const prisma = new PrismaClient();

const fs = require('fs');
const path = require('path');

// Dynamically load .env file variables into process.env
function loadEnv() {
  try {
    const envPath = path.resolve(process.cwd(), '.env');
    if (fs.existsSync(envPath)) {
      const content = fs.readFileSync(envPath, 'utf8');
      const lines = content.split('\n');
      for (const line of lines) {
        const match = line.match(/^\s*([\w.-]+)\s*=\s*(.*)?\s*$/);
        if (match) {
          const key = match[1];
          let value = match[2] || '';
          value = value.trim();
          if (value.startsWith('"') && value.endsWith('"')) {
            value = value.slice(1, -1);
          } else if (value.startsWith("'") && value.endsWith("'")) {
            value = value.slice(1, -1);
          }
          process.env[key] = value;
        }
      }
    }
  } catch (err) {
    console.error('Failed to load .env file in login script:', err);
  }
}
loadEnv();

const CLIENT_ID = process.env.GOOGLE_CLIENT_ID;
const CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET;

if (!CLIENT_ID || !CLIENT_SECRET) {
  console.error("❌ Error: GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET must be configured in your .env file.");
  process.exit(1);
}

const PORT = 8085;
const REDIRECT_URI = `http://localhost:${PORT}`;

// Load proxy agent if configured
const proxyUrl = process.env.HTTP_PROXY || process.env.HTTPS_PROXY;
let fetchFn = require('undici').fetch;
let fetchOptions = {};
if (proxyUrl) {
  const { ProxyAgent } = require('undici');
  fetchOptions.dispatcher = new ProxyAgent(proxyUrl);
}

const scopes = [
  'openid',
  'https://www.googleapis.com/auth/userinfo.email',
  'https://www.googleapis.com/auth/cloud-platform',
  'https://www.googleapis.com/auth/userinfo.profile'
];

const authUrl = `https://accounts.google.com/o/oauth2/v2/auth?` + new URLSearchParams({
  client_id: CLIENT_ID,
  redirect_uri: REDIRECT_URI,
  response_type: 'code',
  scope: scopes.join(' '),
  access_type: 'offline',
  prompt: 'consent'
}).toString();

function openBrowser(url) {
  const command = process.platform === 'win32'
    ? 'cmd'
    : process.platform === 'darwin'
      ? 'open'
      : 'xdg-open';
  const args = process.platform === 'win32' ? ['/c', 'start', '', url] : [url];

  try {
    const child = spawn(command, args, {
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
    });
    child.unref();
  } catch {
    // Ignore browser open errors; the URL is printed below for manual use.
  }
}

console.log('==================================================');
console.log('🔑  Google Account Login for Antigravity Pool');
console.log('==================================================\n');

const server = http.createServer(async (req, res) => {
  const urlObj = new URL(req.url, `http://${req.headers.host}`);
  const code = urlObj.searchParams.get('code');

  if (!code) {
    res.writeHead(400, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end('<h3>错误：未收到授权码 (Authorization Code)</h3>');
    return;
  }

  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
  res.end('<h3>🔑 授权成功！您可以关闭此窗口，并返回终端查看结果。</h3>');
  
  // Close server after response
  server.close();

  console.log('🔄 Exchanging authorization code for refresh token...');
  try {
    const tokenRes = await fetchFn('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: CLIENT_ID,
        client_secret: CLIENT_SECRET,
        code: code,
        grant_type: 'authorization_code',
        redirect_uri: REDIRECT_URI,
      }),
      ...fetchOptions
    });

    const data = await tokenRes.json();
    if (!tokenRes.ok) {
      throw new Error(`Token exchange failed: ${JSON.stringify(data)}`);
    }

    const { refresh_token, access_token } = data;
    if (!refresh_token) {
      throw new Error('No refresh token received. Try removing the application from your Google Account permissions and logging in again.');
    }

    console.log('✓ Received refresh token successfully.');

    // Fetch account email dynamically
    console.log('📧 Fetching account email info...');
    const userinfoRes = await fetchFn('https://www.googleapis.com/oauth2/v3/userinfo', {
      headers: { 'Authorization': `Bearer ${access_token}` },
      ...fetchOptions
    });
    const userinfo = await userinfoRes.json();
    const email = userinfo.email || 'unknown@gmail.com';
    const name = userinfo.name || email.split('@')[0];

    console.log(`✓ Email: ${email}`);

    // Insert or update database
    console.log('💾 Saving account to the local database...');
    
    // Check if account already exists
    const existing = await prisma.account.findFirst({
      where: { email }
    });

    let savedAccount;
    if (existing) {
      savedAccount = await prisma.account.update({
        where: { id: existing.id },
        data: {
          name,
          refreshToken: refresh_token,
          status: 'active',
          quotaStatus: 'available',
          quotaResetAt: null
        }
      });
      console.log(`✓ Updated existing account in pool.`);
    } else {
      savedAccount = await prisma.account.create({
        data: {
          name,
          email,
          refreshToken: refresh_token,
          status: 'active',
        }
      });
      console.log(`✓ Created new account in pool.`);
    }

    console.log('\n==================================================');
    console.log('🎉 SUCCESS: Account configured and ready in pool!');
    console.log(`👤 Name: ${savedAccount.name}`);
    console.log(`📧 Email: ${savedAccount.email}`);
    console.log('==================================================\n');

  } catch (err) {
    console.error('\n❌ Login / Exchange failed:', err.message);
  } finally {
    await prisma.$disconnect();
    process.exit(0);
  }
});

server.listen(PORT, 'localhost', () => {
  console.log(`🔗 Opening browser for Google login...\n`);
  console.log(`If the browser did not open automatically, please open this link manually:\n${authUrl}\n`);

  openBrowser(authUrl);
});
