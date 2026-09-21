/**
 * LinkBox Pro — preview function
 * GET /.netlify/functions/preview?url=<encoded url>
 * Returns: { title, description, image, site, type, source }
 *
 * Order of attempts:
 *   1. YouTube  -> oEmbed
 *   2. TikTok   -> oEmbed
 *   3. Anything else (or an incomplete result) -> fetch the page and read og:/twitter: tags
 *   4. Still incomplete -> microlink.io as a backup
 *   5. Last resort -> hostname as the title, so the link can always be saved
 *
 * Uses Node's built-in fetch (Node 18+), so node-fetch is not needed.
 */

const cheerio = require('cheerio');
const dns = require('dns').promises;
const net = require('net');

const TOTAL_TIMEOUT_MS = 8000; // hard limit for the whole request
const PAGE_TIMEOUT_MS = 5000; // limit for a single page fetch, so a fallback still has time
const MAX_HTML_BYTES = 2 * 1024 * 1024; // 2MB
const MAX_REDIRECTS = 5;

const BROWSER_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';
// Instagram / Facebook serve Open Graph tags to their own crawler more readily than to browsers.
const CRAWLER_UA = 'facebookexternalhit/1.1 (+http://www.facebook.com/externalhit_uatext.php)';

/* ---------- URL safety (SSRF protection) ---------- */

function isPrivateIp(ip) {
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split('.').map(Number);
    return (
      a === 0 ||
      a === 10 ||
      a === 127 ||
      (a === 100 && b >= 64 && b <= 127) ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      a >= 224
    );
  }
  if (net.isIPv6(ip)) {
    const v = ip.toLowerCase();
    if (v === '::' || v === '::1') return true;
    if (v.startsWith('::ffff:')) return isPrivateIp(v.slice(7)) || !net.isIPv4(v.slice(7));
    return /^(fc|fd|fe8|fe9|fea|feb)/.test(v);
  }
  return true;
}

async function assertPublicUrl(rawUrl) {
  if (typeof rawUrl !== 'string' || rawUrl.length > 2048) throw new Error('invalid_url');
  let u;
  try {
    u = new URL(rawUrl);
  } catch {
    throw new Error('invalid_url');
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new Error('invalid_url');
  if (u.username || u.password) throw new Error('invalid_url');

  const host = u.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (host === 'localhost' || host.endsWith('.local') || host.endsWith('.internal')) {
    throw new Error('invalid_url');
  }
  if (net.isIP(host)) {
    if (isPrivateIp(host)) throw new Error('invalid_url');
  } else {
    if (!host.includes('.')) throw new Error('invalid_url');
    const addrs = await dns.lookup(host, { all: true });
    if (!addrs.length || addrs.some((a) => isPrivateIp(a.address))) throw new Error('invalid_url');
  }
  return u;
}

/* ---------- helpers ---------- */

const clean = (s, max) =>
  typeof s === 'string' ? s.replace(/\s+/g, ' ').trim().slice(0, max) : '';

const hostOf = (u) => u.hostname.replace(/^www\./, '');

function makeDeadline() {
  const end = Date.now() + TOTAL_TIMEOUT_MS;
  return { left: () => Math.max(0, end - Date.now()) };
}

function decodeBody(buf, contentType) {
  const m = /charset=([^;]+)/i.exec(contentType || '');
  const charset = m ? m[1].trim().replace(/["']/g, '') : 'utf-8';
  try {
    return new TextDecoder(charset).decode(buf);
  } catch {
    return new TextDecoder('utf-8').decode(buf);
  }
}

async function readLimited(res, maxBytes) {
  const reader = res.body.getReader();
  const chunks = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (total + value.length > maxBytes) {
      chunks.push(value.slice(0, maxBytes - total));
      await reader.cancel();
      break; // meta tags live in <head>, so a truncated page is fine
    }
    total += value.length;
    chunks.push(value);
  }
  return Buffer.concat(chunks);
}

/** fetch that follows redirects manually so every hop is checked against the SSRF rules */
async function safeFetch(startUrl, { ua, deadline, cap = PAGE_TIMEOUT_MS, accept = 'text/html,*/*' }) {
  let current = startUrl;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    const u = await assertPublicUrl(current);
    const budget = Math.min(deadline.left(), cap);
    if (budget < 300) throw new Error('timeout');
    const res = await fetch(u.href, {
      redirect: 'manual',
      signal: AbortSignal.timeout(budget),
      headers: {
        'User-Agent': ua,
        Accept: accept,
        'Accept-Language': 'he-IL,he;q=0.9,en;q=0.8',
      },
    });
    if (res.status >= 300 && res.status < 400 && res.headers.get('location')) {
      current = new URL(res.headers.get('location'), u.href).href;
      await res.body?.cancel();
      continue;
    }
    return { res, finalUrl: u.href };
  }
  throw new Error('too_many_redirects');
}

async function fetchJson(url, deadline, cap = 4000) {
  const { res } = await safeFetch(url, { ua: BROWSER_UA, deadline, cap, accept: 'application/json' });
  if (!res.ok) {
    await res.body?.cancel();
    throw new Error('http_' + res.status);
  }
  const buf = await readLimited(res, 512 * 1024);
  return JSON.parse(buf.toString('utf8'));
}

/* ---------- strategies ---------- */

/** Reads Open Graph / Twitter / plain meta tags out of an HTML string. Exported for testing. */
function parseHtml(html, baseUrl) {
  const $ = cheerio.load(html);
  const meta = (...names) => {
    for (const n of names) {
      const v = $(`meta[property="${n}"], meta[name="${n}"]`).first().attr('content');
      if (v && v.trim()) return v;
    }
    return '';
  };

  let image =
    meta('og:image:secure_url', 'og:image', 'twitter:image', 'twitter:image:src') ||
    $('link[rel="image_src"]').first().attr('href') ||
    '';
  if (image) {
    try {
      image = new URL(image, baseUrl).href;
    } catch {
      image = '';
    }
  }

  return {
    title: clean(meta('og:title', 'twitter:title') || $('title').first().text(), 300),
    description: clean(meta('og:description', 'twitter:description', 'description'), 500),
    image,
    site: clean(meta('og:site_name'), 100),
    type: clean(meta('og:type'), 50),
  };
}

async function tryOEmbed(endpoint, pageUrl, deadline, site, type) {
  try {
    const data = await fetchJson(`${endpoint}${encodeURIComponent(pageUrl)}`, deadline);
    return {
      title: clean(data.title, 300),
      description: clean(data.author_name, 200),
      image: typeof data.thumbnail_url === 'string' ? data.thumbnail_url : '',
      site,
      type,
      source: 'oembed',
    };
  } catch {
    return null;
  }
}

async function tryWeb(pageUrl, deadline, ua) {
  try {
    const { res, finalUrl } = await safeFetch(pageUrl, { ua, deadline });
    const ct = res.headers.get('content-type') || '';
    if (!/text\/html|application\/xhtml/i.test(ct)) {
      await res.body?.cancel();
      // a direct link to an image is its own preview
      return /^image\//i.test(ct) ? { title: '', description: '', image: finalUrl, site: '', type: 'image', source: 'web' } : null;
    }
    const html = decodeBody(await readLimited(res, MAX_HTML_BYTES), ct);
    return { ...parseHtml(html, finalUrl), source: 'web' };
  } catch {
    return null;
  }
}

async function tryMicrolink(pageUrl, deadline) {
  try {
    const data = await fetchJson(`https://api.microlink.io/?url=${encodeURIComponent(pageUrl)}`, deadline);
    if (data.status !== 'success' || !data.data) return null;
    const d = data.data;
    return {
      title: clean(d.title, 300),
      description: clean(d.description, 500),
      image: (d.image && d.image.url) || (d.logo && d.logo.url) || '',
      site: clean(d.publisher, 100),
      type: '',
      source: 'microlink',
    };
  } catch {
    return null;
  }
}

/** fills empty fields of `a` from `b` */
function merge(a, b) {
  if (!a) return b;
  if (!b) return a;
  const out = { ...a };
  for (const k of ['title', 'description', 'image', 'site', 'type']) {
    if (!out[k] && b[k]) out[k] = b[k];
  }
  return out;
}

const isComplete = (r) => !!(r && r.title && r.image);

/* ---------- handler ---------- */

const json = (statusCode, body, cache) => ({
  statusCode,
  headers: {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': cache || 'no-store',
  },
  body: JSON.stringify(body),
});

exports.handler = async (event) => {
  if (event.httpMethod && event.httpMethod !== 'GET') {
    return json(405, { error: 'method_not_allowed' });
  }

  const raw = ((event.queryStringParameters || {}).url || '').trim();
  let target;
  try {
    target = await assertPublicUrl(raw);
  } catch {
    return json(400, { error: 'invalid_url' });
  }

  const deadline = makeDeadline();
  const host = hostOf(target);
  const isYouTube = /(^|\.)youtube\.com$|^youtu\.be$/.test(host);
  const isTikTok = /(^|\.)tiktok\.com$/.test(host);
  const isMeta = /(^|\.)(instagram|facebook)\.com$|^fb\.watch$/.test(host);

  let result = null;

  if (isYouTube) {
    result = await tryOEmbed('https://www.youtube.com/oembed?format=json&url=', target.href, deadline, 'YouTube', 'video');
  } else if (isTikTok) {
    result = await tryOEmbed('https://www.tiktok.com/oembed?url=', target.href, deadline, 'TikTok', 'video');
  }

  if (!isComplete(result)) {
    const web = await tryWeb(target.href, deadline, isMeta ? CRAWLER_UA : BROWSER_UA);
    result = merge(result, web);
  }

  if (!isComplete(result)) {
    const ml = await tryMicrolink(target.href, deadline);
    result = merge(result, ml);
  }

  const found = !!(result && (result.title || result.image));
  const out = {
    title: (result && result.title) || host,
    description: (result && result.description) || '',
    image: (result && result.image) || '',
    site: (result && result.site) || host,
    type: (result && result.type) || 'website',
    source: found ? result.source : 'fallback',
  };

  // Only cache good answers for long; a weak one should be retried soon.
  const cache = isComplete(out)
    ? 'public, max-age=3600, s-maxage=86400, stale-while-revalidate=86400'
    : 'public, max-age=60';
  return json(200, out, cache);
};

exports.parseHtml = parseHtml;
exports.isPrivateIp = isPrivateIp;
exports.assertPublicUrl = assertPublicUrl;
