const fs = require('node:fs');
const path = require('node:path');

const HOST = 'aeconnect.io';
const KEY_FILE = /^[a-f0-9]{32}\.txt$/;

function findKey(root) {
  const names = fs.readdirSync(root).filter((name) => KEY_FILE.test(name));
  const matches = [];
  for (const name of names) {
    const key = name.slice(0, -4);
    const body = fs.readFileSync(path.join(root, name), 'utf8').trim();
    if (body === key) matches.push(key);
  }
  if (matches.length !== 1) {
    throw new Error(`Expected one IndexNow key file at the site root, found ${matches.length}`);
  }
  return matches[0];
}

function sitemapUrls(xml) {
  return [...xml.matchAll(/<loc>([^<]+)<\/loc>/g)]
    .map((match) => match[1].trim())
    .filter((url) => url.startsWith(`https://${HOST}/`));
}

async function ping({ key, urls, fetchImpl = fetch }) {
  const response = await fetchImpl('https://api.indexnow.org/indexnow', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json; charset=utf-8' },
    body: JSON.stringify({
      host: HOST,
      key,
      keyLocation: `https://${HOST}/${key}.txt`,
      urlList: urls,
    }),
  });
  const body = await response.text();
  return { status: response.status, body };
}

module.exports = { findKey, sitemapUrls, ping, HOST };
