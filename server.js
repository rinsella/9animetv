/**
 * 9animetv mirror – SEO-aware reverse proxy
 *
 * Deploy targets: Railway, Render, Fly.io, any VPS (Node 18+ or Docker).
 *
 * Features:
 *  - Full reverse proxy of an upstream site (default: 9anime.me.uk).
 *  - Rewrites HTML, JSON-LD, sitemap.xml, robots.txt, redirects, cookies,
 *    and `Location` headers so every URL points at the mirror domain.
 *  - Forces a self-referencing `<link rel="canonical">` and `og:url` to
 *    eliminate the "Google chose a different canonical" issue.
 *  - Strips/rewrites hreflang + alternate links so the upstream domain is
 *    never advertised as the canonical.
 *  - Fixes BreadcrumbList / structured data URLs.
 *  - Generates /robots.txt and proxies/rewrites /sitemap.xml (recursively
 *    for sitemap indexes) so search engines can crawl the mirror.
 *  - Returns proper 404 / 410 / 5xx so Google doesn't keep "Not found" URLs
 *    in soft-404 limbo.
 *  - Removes upstream noindex / X-Robots-Tag: noindex headers.
 *
 * Configuration via env vars (all optional except UPSTREAM_HOST):
 *   UPSTREAM_HOST       Upstream hostname           (default: 9anime.me.uk)
 *   UPSTREAM_PROTOCOL   http | https                (default: https)
 *   PUBLIC_HOST         Mirror's public hostname    (auto-detect from Host)
 *   PUBLIC_PROTOCOL     http | https                (default: https)
 *   PORT                Listen port                 (default: 3000)
 *   FORCE_INDEX         "1" to strip noindex        (default: 1)
 *   EXTRA_ALIASES       Comma list of extra upstream
 *                       hostnames to also rewrite
 *                       (e.g. cdn.9anime.me.uk)
 */

'use strict';

const express = require('express');
const zlib = require('zlib');
const { Readable } = require('stream');

const UPSTREAM_HOST = (process.env.UPSTREAM_HOST || '9animetv.ing').trim();
const UPSTREAM_PROTOCOL = (process.env.UPSTREAM_PROTOCOL || 'https').trim();
const UPSTREAM_ORIGIN = `${UPSTREAM_PROTOCOL}://${UPSTREAM_HOST}`;
const PUBLIC_PROTOCOL = (process.env.PUBLIC_PROTOCOL || 'https').trim();
const PUBLIC_HOST_ENV = (process.env.PUBLIC_HOST || '').trim();
const FORCE_INDEX = (process.env.FORCE_INDEX || '1') === '1';
const EXTRA_ALIASES = (process.env.EXTRA_ALIASES || '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);
const PORT = Number(process.env.PORT || 3000);

// --- Ad popup config (per-visitor throttled) -------------------------------
// Triggered when the visitor clicks the play button / video / iframe area.
// Throttled per anime page (sessionStorage) AND globally (localStorage cooldown)
// so it does not fire on every click or on every episode switch.
const AD_URL = (process.env.AD_URL || 'https://omg10.com/4/10956241').trim();
const AD_COOLDOWN_MIN = Number(process.env.AD_COOLDOWN_MIN || 30); // global cooldown in minutes

// Hostnames in upstream content that must be rewritten to the mirror.
const ALIAS_HOSTS = Array.from(new Set([UPSTREAM_HOST, ...EXTRA_ALIASES]));

// Hop-by-hop headers that must never be forwarded.
const HOP_BY_HOP = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
  'host',
  'content-length',
  'accept-encoding',
]);

// Headers we strip from the upstream response unconditionally.
// NOTE: 'content-length' is intentionally NOT here; we keep it for binary
// streaming (videos, images) so the browser knows total bytes / can seek.
// We will manually drop it on textual rewrites where size changes.
const STRIP_RESPONSE_HEADERS = new Set([
  'content-encoding',
  'transfer-encoding',
  'connection',
  'keep-alive',
  'strict-transport-security',
  'public-key-pins',
  'content-security-policy',
  'content-security-policy-report-only',
  'report-to',
  'expect-ct',
  'alt-svc',
]);

const app = express();
app.disable('x-powered-by');
app.disable('etag');
app.set('trust proxy', true);

function publicOriginFromReq(req) {
  const host = PUBLIC_HOST_ENV || req.headers['x-forwarded-host'] || req.headers.host;
  const proto =
    PUBLIC_HOST_ENV
      ? PUBLIC_PROTOCOL
      : (req.headers['x-forwarded-proto'] || req.protocol || PUBLIC_PROTOCOL);
  return `${proto}://${host}`;
}

function escapeRegex(str) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// Build a regex that matches absolute URLs pointing at any upstream alias.
function buildHostRewriteRegex() {
  const hosts = ALIAS_HOSTS.map(escapeRegex).join('|');
  // Matches https://host, http://host, //host (protocol-relative).
  return new RegExp(`(https?:)?//(?:${hosts})`, 'gi');
}
const HOST_REWRITE_RE = buildHostRewriteRegex();

function rewriteUrlString(value, publicOrigin) {
  if (!value) return value;
  return value.replace(HOST_REWRITE_RE, publicOrigin);
}

// Decompress upstream body if needed.
async function decompressBody(buf, encoding) {
  if (!buf || !buf.length) return Buffer.alloc(0);
  const enc = (encoding || '').toLowerCase();
  try {
    if (enc.includes('br')) return zlib.brotliDecompressSync(buf);
    if (enc.includes('gzip')) return zlib.gunzipSync(buf);
    if (enc.includes('deflate')) return zlib.inflateSync(buf);
  } catch (e) {
    // Fall through – return raw buffer as a last resort.
  }
  return buf;
}

function isTextual(contentType) {
  if (!contentType) return false;
  const ct = contentType.toLowerCase();
  return (
    ct.startsWith('text/') ||
    ct.includes('json') ||
    ct.includes('xml') ||
    ct.includes('javascript') ||
    ct.includes('ecmascript') ||
    ct.includes('svg') ||
    ct.includes('manifest')
  );
}

// --- Static asset cache headers --------------------------------------------
// Browser & CDN cache hints so videos / images / css / js are not re-fetched
// from upstream on every navigation. Aggressive but safe values; upstream's
// own cache-control still wins if it sets one.
const CACHE_RULES = [
  { re: /\.(mp4|m4s|m3u8|ts|webm|mkv|mov|aac|mp3|ogg|wav)(\?|$)/i, ttl: 86400 * 7 },
  { re: /\.(woff2?|ttf|otf|eot)(\?|$)/i,                            ttl: 86400 * 30 },
  { re: /\.(png|jpe?g|gif|webp|avif|svg|ico|bmp)(\?|$)/i,           ttl: 86400 * 7 },
  { re: /\.(css|js|mjs)(\?|$)/i,                                    ttl: 86400 },
];
function applyStaticCache(res, pathOrUrl, ct) {
  if (res.getHeader('cache-control')) return; // upstream already set it
  for (const r of CACHE_RULES) {
    if (r.re.test(pathOrUrl)) {
      res.setHeader('cache-control', `public, max-age=${r.ttl}, stale-while-revalidate=86400`);
      return;
    }
  }
  if (ct && (ct.startsWith('image/') || ct.startsWith('video/') || ct.startsWith('audio/') || ct.startsWith('font/'))) {
    res.setHeader('cache-control', 'public, max-age=86400, stale-while-revalidate=86400');
  }
}

// --- Stream upstream body straight to client (binary / video) --------------
// Critical for video playback: do NOT buffer the whole response. Forwards
// Range / Content-Range / Accept-Ranges and uses the original status (e.g.
// 206 Partial Content) so video.js can seek and show the play button.
function streamPassthrough(upstream, req, res, outHeaders, status) {
  res.status(status);
  for (const [k, v] of Object.entries(outHeaders)) res.setHeader(k, v);
  // Only forward content-length when the upstream body wasn't compressed
  // (Node's fetch auto-decompresses, so the byte length we forward differs
  // from the compressed content-length the upstream advertised).
  const upstreamEnc = (upstream.headers.get('content-encoding') || '').toLowerCase();
  const cl = upstream.headers.get('content-length');
  if (cl && !upstreamEnc) res.setHeader('content-length', cl);
  const cr = upstream.headers.get('content-range');
  if (cr) res.setHeader('content-range', cr);
  if (!res.getHeader('accept-ranges')) {
    const ar = upstream.headers.get('accept-ranges');
    if (ar) res.setHeader('accept-ranges', ar);
  }
  applyStaticCache(res, req.path || req.originalUrl || '', upstream.headers.get('content-type') || '');

  const body = upstream.raw.body;
  if (!body) { res.end(); return; }
  const node = Readable.fromWeb(body);
  node.on('error', (e) => { try { res.destroy(e); } catch {} });
  res.on('close', () => { try { node.destroy(); } catch {} });
  node.pipe(res);
}

// --- Ad popup script (injected into HTML pages and embed iframes) ----------
// Throttled: at most once per anime page (sessionStorage) AND once per
// AD_COOLDOWN_MIN globally (localStorage). Triggers on the first user click
// inside the player area / play button / video element. Falls back to a
// regular new-tab anchor click if window.open is blocked.
function buildAdScript() {
  return `<script>(function(){try{
var U=${JSON.stringify(AD_URL)},CD=${AD_COOLDOWN_MIN}*60*1000;
var key='__mad_'+(location.pathname||'/');
function pk(k,s){try{return s?sessionStorage.getItem(k):localStorage.getItem(k);}catch(e){return null;}}
function pkS(k,v,s){try{(s?sessionStorage:localStorage).setItem(k,v);}catch(e){}}
function ok(){if(pk(key,1))return false;var t=parseInt(pk('__mad_last',0)||'0',10);return Date.now()-t>CD;}
var fired=false;
function fire(ev){
  if(fired||!ok())return;fired=true;
  pkS(key,'1',1);pkS('__mad_last',String(Date.now()),0);
  try{var w=window.open(U,'_blank','noopener,noreferrer');if(w){return;}}catch(e){}
  try{var a=document.createElement('a');a.href=U;a.target='_blank';a.rel='noopener noreferrer';
    (document.body||document.documentElement).appendChild(a);a.click();a.remove();}catch(e){}
}
function isPlayHit(t){
  if(!t||!t.closest)return false;
  return !!t.closest('video,.vjs-big-play-button,.vjs-play-control,.vjs-tech,[class*="play-button"],[class*="playBtn"],[id*="play"],iframe,#embed_holder,.player-embed,.video-content,.jw-display-icon-container,.plyr__control--overlaid');
}
document.addEventListener('click',function(e){if(isPlayHit(e.target))fire(e);},true);
document.addEventListener('touchstart',function(e){if(isPlayHit(e.target))fire(e);},{capture:true,passive:true});
// Also fire when an embedded iframe takes focus (mobile inline play).
window.addEventListener('blur',function(){setTimeout(function(){
  if(document.activeElement&&document.activeElement.tagName==='IFRAME')fire();
},50);});
}catch(e){}})();</script>`;
}
const AD_SCRIPT = buildAdScript();

// --- HTML rewriting ---------------------------------------------------------

// Rewrite any absolute or protocol-relative URL pointing at a *third-party*
// host (i.e. not the upstream / aliases / mirror) into a path-based reverse
// proxy on the mirror itself. Used for video player iframes & their assets
// served from hosts like `my.1anime.site` so the browser sees a same-origin
// request and the upstream's referer-check still passes.
function rewriteThirdPartyToEmbed(input, publicOrigin) {
  if (!input) return input;
  const publicHost = publicOrigin.replace(/^https?:\/\//, '').toLowerCase();
  // Match http(s)://host or //host followed by /, ", ', space or end.
  return input.replace(
    /(href=|src=|action=|data-src=|data-url=|content=|url\(|=)?(["'(]?)(https?:)?\/\/([a-z0-9.-]+\.[a-z]{2,})(\/[^\s"'<>)]*)?/gi,
    (match, attr, quote, proto, host, path) => {
      const h = host.toLowerCase();
      if (h === publicHost) return match;
      if (ALIAS_HOSTS.some((a) => a.toLowerCase() === h)) return match;
      const newUrl = `${publicOrigin}/__embed/${h}${path || '/'}`;
      return `${attr || ''}${quote || ''}${newUrl}`;
    },
  );
}

function rewriteHtml(html, publicOrigin, currentPath) {
  let out = html;

  // 1. Replace any absolute upstream URL with the mirror origin.
  out = out.replace(HOST_REWRITE_RE, publicOrigin);

  // 1b. Rewrite third-party hosts (video embeds, CDNs, etc.) to the embed
  //     proxy path so the browser stays same-origin and we can fix Referer.
  out = rewriteThirdPartyToEmbed(out, publicOrigin);

  // 1c. Player mirror <select> uses base64-encoded iframe HTML in option
  //     `value="..."`; the page's JS decodes and injects it, bypassing any
  //     plain HTML rewrite. Decode each option value, rewrite URLs inside,
  //     then re-encode.
  out = out.replace(
    /(<option\b[^>]*\bvalue=)(["'])([A-Za-z0-9+/=]{16,})\2/gi,
    (full, prefix, quote, b64) => {
      try {
        const decoded = Buffer.from(b64, 'base64').toString('utf8');
        if (!/[<>]|https?:|\/\//i.test(decoded)) return full;
        let rewritten = decoded.replace(HOST_REWRITE_RE, publicOrigin);
        rewritten = rewriteThirdPartyToEmbed(rewritten, publicOrigin);
        if (rewritten === decoded) return full;
        const reb64 = Buffer.from(rewritten, 'utf8').toString('base64');
        return `${prefix}${quote}${reb64}${quote}`;
      } catch {
        return full;
      }
    },
  );

  // 2. Force a self-referencing canonical.
  const canonicalUrl = publicOrigin + currentPath;
  const canonicalTag = `<link rel="canonical" href="${escapeAttr(canonicalUrl)}">`;

  // Remove every existing canonical (upstream may emit several).
  out = out.replace(/<link[^>]+rel=["']?canonical["']?[^>]*>/gi, '');

  // Remove hreflang alternates that point at upstream (avoid duplicate signals).
  out = out.replace(/<link[^>]+rel=["']?alternate["']?[^>]*hreflang=[^>]*>/gi, '');

  // Replace existing og:url / twitter:url with mirror URL.
  out = out.replace(
    /<meta[^>]+property=["']og:url["'][^>]*>/gi,
    `<meta property="og:url" content="${escapeAttr(canonicalUrl)}">`,
  );
  out = out.replace(
    /<meta[^>]+name=["']twitter:url["'][^>]*>/gi,
    `<meta name="twitter:url" content="${escapeAttr(canonicalUrl)}">`,
  );

  // 3. Strip noindex if FORCE_INDEX is on.
  if (FORCE_INDEX) {
    out = out.replace(
      /<meta[^>]+name=["']robots["'][^>]*content=["'][^"']*noindex[^"']*["'][^>]*>/gi,
      '',
    );
    out = out.replace(
      /<meta[^>]+name=["']googlebot["'][^>]*content=["'][^"']*noindex[^"']*["'][^>]*>/gi,
      '',
    );
  }

  // 4. Inject canonical (and a basic robots tag) into <head>.
  const headInjection =
    canonicalTag +
    (FORCE_INDEX ? '<meta name="robots" content="index,follow,max-image-preview:large">' : '') +
    AD_SCRIPT;

  if (/<head[^>]*>/i.test(out)) {
    out = out.replace(/<head[^>]*>/i, (m) => `${m}${headInjection}`);
  } else {
    out = headInjection + out;
  }

  // 5. Rewrite JSON-LD blocks (BreadcrumbList etc.) – fix any leftover URLs
  //    and validate JSON parses (otherwise drop the broken block so Search
  //    Console doesn't report "Data terstruktur tidak dapat diurai").
  out = out.replace(
    /<script\b[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi,
    (full, body) => {
      const fixed = rewriteJsonLd(body, publicOrigin, canonicalUrl);
      if (fixed === null) return ''; // drop unparsable block
      return full.replace(body, '\n' + fixed + '\n');
    },
  );

  return out;
}

function escapeAttr(s) {
  return String(s).replace(/&/g, '&amp;').replace(/"/g, '&quot;');
}

function rewriteJsonLd(raw, publicOrigin, canonicalUrl) {
  const cleaned = raw
    // Strip CDATA wrappers commonly used in older CMSes.
    .replace(/^\s*<!\[CDATA\[/, '')
    .replace(/\]\]>\s*$/, '')
    .trim();
  if (!cleaned) return '';
  let parsed;
  try {
    parsed = JSON.parse(cleaned);
  } catch (e) {
    // Common upstream bug: trailing commas. Try a forgiving cleanup.
    try {
      parsed = JSON.parse(cleaned.replace(/,(\s*[}\]])/g, '$1'));
    } catch (e2) {
      return null; // signal: drop block
    }
  }

  const walk = (node) => {
    if (Array.isArray(node)) return node.map(walk);
    if (node && typeof node === 'object') {
      const next = {};
      for (const [k, v] of Object.entries(node)) {
        if (typeof v === 'string') {
          next[k] = rewriteUrlString(v, publicOrigin);
        } else {
          next[k] = walk(v);
        }
      }
      // Self-heal BreadcrumbList items missing positions or @id.
      if (next['@type'] === 'BreadcrumbList' && Array.isArray(next.itemListElement)) {
        next.itemListElement = next.itemListElement.map((el, i) => {
          const item = { ...el };
          if (item['@type'] !== 'ListItem') item['@type'] = 'ListItem';
          if (typeof item.position !== 'number') item.position = i + 1;
          if (item.item && typeof item.item === 'object' && !item.item['@id'] && item.item.url) {
            item.item['@id'] = item.item.url;
          }
          return item;
        });
      }
      return next;
    }
    return node;
  };

  const fixed = walk(parsed);
  return JSON.stringify(fixed);
}

// --- XML / sitemap rewriting ------------------------------------------------

function rewriteXml(xml, publicOrigin) {
  return xml.replace(HOST_REWRITE_RE, publicOrigin);
}

// --- Cookie / Location header rewriting -------------------------------------

function rewriteSetCookie(values, publicHost) {
  if (!values) return [];
  const arr = Array.isArray(values) ? values : [values];
  return arr.map((c) =>
    c
      // Replace any explicit Domain= attribute with the mirror host so the
      // browser actually accepts the cookie.
      .replace(/;\s*Domain=[^;]+/gi, `; Domain=${publicHost}`)
      // Drop SameSite=None without Secure if we're proxying over http (dev).
      .replace(/;\s*SameSite=None/gi, PUBLIC_PROTOCOL === 'https' ? '; SameSite=None' : '; SameSite=Lax'),
  );
}

function rewriteLocation(loc, publicOrigin) {
  if (!loc) return loc;
  // Absolute upstream URL -> mirror.
  let next = rewriteUrlString(loc, publicOrigin);
  // Protocol-relative.
  next = next.replace(/^\/\//, `${publicOrigin.split('://')[0]}://`);
  return next;
}

// --- robots.txt / fallback sitemap -----------------------------------------

app.get('/robots.txt', async (req, res) => {
  const publicOrigin = publicOriginFromReq(req);
  // Try upstream first; fall back to a permissive default.
  try {
    const upstream = await fetchUpstream(req, '/robots.txt');
    if (upstream.status === 200) {
      const text = (await upstream.bodyText())
        .replace(HOST_REWRITE_RE, publicOrigin)
        // Drop any upstream "Disallow: /" that would block indexing.
        .replace(/^\s*Disallow:\s*\/\s*$/gim, '# Disallow: /');
      res.type('text/plain').send(
        text + `\n\nSitemap: ${publicOrigin}/sitemap.xml\n`,
      );
      return;
    }
  } catch (_) {}
  res.type('text/plain').send(
    `User-agent: *\nAllow: /\n\nSitemap: ${publicOrigin}/sitemap.xml\n`,
  );
});

// --- Embed reverse-proxy ----------------------------------------------------
// Generic per-host proxy used for video player iframes & their assets. Path:
//   /__embed/<host>/<path...>?<query>
// We forward Referer/Origin as the embed's own host so anti-hotlink checks
// pass, and rewrite any absolute / third-party URLs in the response to keep
// the browser on the mirror domain.

const EMBED_PATH_RE = /^\/__embed\/([^\/]+)(\/.*)?$/;

app.all(/^\/__embed\//, async (req, res) => {
  const m = req.path.match(EMBED_PATH_RE);
  if (!m) return res.status(400).type('text/plain').send('Bad embed path');
  const host = m[1];
  const restPath = m[2] || '/';
  if (!/^[a-z0-9.-]+\.[a-z]{2,}$/i.test(host)) {
    return res.status(400).type('text/plain').send('Bad embed host');
  }
  const qIdx = req.originalUrl.indexOf('?');
  const query = qIdx >= 0 ? req.originalUrl.slice(qIdx) : '';
  const targetUrl = `https://${host}${restPath}${query}`;

  const headers = {};
  for (const [k, v] of Object.entries(req.headers)) {
    if (HOP_BY_HOP.has(k.toLowerCase())) continue;
    if (Array.isArray(v)) headers[k] = v.join(', ');
    else if (v != null) headers[k] = String(v);
  }
  headers['host'] = host;
  headers['accept-encoding'] = 'gzip, br';
  // Pretend we're embedded from the embed's own host so referer-checks pass.
  headers['referer'] = `https://${host}/`;
  headers['origin'] = `https://${host}`;

  const init = {
    method: req.method,
    headers,
    redirect: 'manual',
  };
  if (!['GET', 'HEAD'].includes(req.method.toUpperCase())) {
    init.body = Readable.toWeb(req);
    init.duplex = 'half';
  }

  let resp;
  try {
    resp = await fetch(targetUrl, init);
  } catch (err) {
    console.error('[embed proxy error]', host, err.message);
    return res.status(502).type('text/plain').send('Embed gateway error');
  }
  const upstream = wrapResponse(resp);
  await pipeEmbed(upstream, req, res, host);
});

async function pipeEmbed(upstream, req, res, host) {
  const publicOrigin = publicOriginFromReq(req);
  const publicHost = publicOrigin.replace(/^https?:\/\//, '');
  const status = upstream.status;
  const ct = upstream.headers.get('content-type') || '';

  const outHeaders = {};
  upstream.headers.forEach((value, key) => {
    const lk = key.toLowerCase();
    if (STRIP_RESPONSE_HEADERS.has(lk)) return;
    if (lk === 'set-cookie') return;
    if (lk === 'x-frame-options') return; // allow embedding on mirror
    if (lk === 'location') {
      // Rewrite redirects to stay inside the mirror.
      let loc = value;
      try {
        const u = new URL(loc, `https://${host}`);
        outHeaders['location'] = `${publicOrigin}/__embed/${u.host}${u.pathname}${u.search}`;
      } catch {
        outHeaders['location'] = loc;
      }
      return;
    }
    outHeaders[key] = value;
  });

  // Rewrite cookies' Domain so the browser keeps them on the mirror.
  const rawCookies = upstream.raw.headers.getSetCookie
    ? upstream.raw.headers.getSetCookie()
    : upstream.headers.get('set-cookie');
  const cookies = rewriteSetCookie(rawCookies, publicHost);
  if (cookies.length) res.setHeader('set-cookie', cookies);

  if (status >= 300 && status < 400 && outHeaders['location']) {
    res.status(status).set(outHeaders).end();
    return;
  }

  if (!isTextual(ct)) {
    streamPassthrough(upstream, req, res, outHeaders, status);
    return;
  }

  let body = await upstream.bodyText();
  // Rewrite the embed's own host AND any other third-party hosts in the body
  // to /__embed/<host>/... so all subresources stay on the mirror.
  body = rewriteThirdPartyToEmbed(body, publicOrigin);
  // If this is the embed's HTML, also inject the throttled ad popup script
  // so clicks on the play button inside the iframe trigger it (clicks inside
  // an iframe never reach the parent page).
  if (ct.includes('text/html')) {
    if (/<head[^>]*>/i.test(body)) {
      body = body.replace(/<head[^>]*>/i, (m) => `${m}${AD_SCRIPT}`);
    } else {
      body = AD_SCRIPT + body;
    }
    if (!/charset=/i.test(ct)) {
      outHeaders['content-type'] = 'text/html; charset=utf-8';
    }
  }
  res.status(status).set(outHeaders).end(body);
}

// --- Catch-all proxy --------------------------------------------------------

app.all('*', async (req, res) => {
  try {
    const upstream = await fetchUpstream(req, req.originalUrl);
    await pipeUpstream(upstream, req, res);
  } catch (err) {
    console.error('[proxy error]', err);
    res.status(502).type('text/plain').send('Bad gateway');
  }
});

async function fetchUpstream(req, pathAndQuery) {
  const targetUrl = UPSTREAM_ORIGIN + pathAndQuery;

  const headers = {};
  for (const [k, v] of Object.entries(req.headers)) {
    if (HOP_BY_HOP.has(k.toLowerCase())) continue;
    if (Array.isArray(v)) headers[k] = v.join(', ');
    else if (v != null) headers[k] = String(v);
  }
  headers['host'] = UPSTREAM_HOST;
  // Ask for identity so we can rewrite reliably; we re-encode if needed.
  headers['accept-encoding'] = 'gzip, br';
  // Rewrite Referer so upstream doesn't see the mirror's domain (some sites
  // 403 on cross-origin referer).
  if (headers.referer) {
    headers.referer = rewriteRefererToUpstream(headers.referer);
  }
  if (headers.origin) {
    headers.origin = UPSTREAM_ORIGIN;
  }

  const init = {
    method: req.method,
    headers,
    redirect: 'manual',
  };

  if (!['GET', 'HEAD'].includes(req.method.toUpperCase())) {
    init.body = Readable.toWeb(req);
    init.duplex = 'half';
  }

  const resp = await fetch(targetUrl, init);
  return wrapResponse(resp);
}

function rewriteRefererToUpstream(ref) {
  try {
    const u = new URL(ref);
    u.protocol = UPSTREAM_PROTOCOL + ':';
    u.host = UPSTREAM_HOST;
    return u.toString();
  } catch {
    return UPSTREAM_ORIGIN + '/';
  }
}

function wrapResponse(resp) {
  return {
    status: resp.status,
    headers: resp.headers,
    raw: resp,
    async bodyBuffer() {
      const ab = await resp.arrayBuffer();
      return Buffer.from(ab);
    },
    async bodyText() {
      const buf = await this.bodyBuffer();
      const enc = resp.headers.get('content-encoding') || '';
      const decoded = await decompressBody(buf, enc);
      return decoded.toString('utf8');
    },
  };
}

async function pipeUpstream(upstream, req, res) {
  const publicOrigin = publicOriginFromReq(req);
  const publicHost = publicOrigin.replace(/^https?:\/\//, '');
  const status = upstream.status;
  const ct = upstream.headers.get('content-type') || '';

  // Build outbound headers.
  const outHeaders = {};
  upstream.headers.forEach((value, key) => {
    const lk = key.toLowerCase();
    if (STRIP_RESPONSE_HEADERS.has(lk)) return;
    if (lk === 'set-cookie') return; // handled below
    if (lk === 'location') {
      outHeaders['location'] = rewriteLocation(value, publicOrigin);
      return;
    }
    if (lk === 'link') {
      outHeaders['link'] = rewriteUrlString(value, publicOrigin);
      return;
    }
    if (lk === 'x-robots-tag') {
      if (FORCE_INDEX) return; // drop noindex from upstream
    }
    outHeaders[key] = value;
  });

  // set-cookie may appear multiple times.
  const rawCookies = upstream.raw.headers.getSetCookie
    ? upstream.raw.headers.getSetCookie()
    : upstream.headers.get('set-cookie');
  const cookies = rewriteSetCookie(rawCookies, publicHost);
  if (cookies.length) res.setHeader('set-cookie', cookies);

  // Redirects: forward as-is (Location already rewritten).
  if (status >= 300 && status < 400 && outHeaders['location']) {
    res.status(status).set(outHeaders).end();
    return;
  }

  const path = req.path || '/';
  const isHtml = ct.includes('text/html');
  const isXml = ct.includes('xml') || /\.xml(\?|$)/i.test(path);
  const isSitemap = /sitemap.*\.xml(\?|$)/i.test(path);

  // For non-text bodies, stream straight through (videos / images / fonts).
  // We MUST NOT buffer mp4 / m3u8 chunks – that breaks seeking and the play
  // button on video.js, and uses huge amounts of memory.
  if (!isTextual(ct) && !isSitemap) {
    streamPassthrough(upstream, req, res, outHeaders, status);
    return;
  }

  let body = await upstream.bodyText();

  if (isHtml) {
    body = rewriteHtml(body, publicOrigin, path);
  } else if (isXml || isSitemap) {
    body = rewriteXml(body, publicOrigin);
  } else {
    // JSON, JS, CSS, plain text – just rewrite absolute URLs.
    body = rewriteUrlString(body, publicOrigin);
    body = rewriteThirdPartyToEmbed(body, publicOrigin);
  }

  // Force a clean utf-8 content-type if upstream omitted charset for HTML.
  if (isHtml && !/charset=/i.test(ct)) {
    outHeaders['content-type'] = 'text/html; charset=utf-8';
  }

  res.status(status).set(outHeaders).end(body);
}

app.listen(PORT, () => {
  console.log(
    `[mirror] listening on :${PORT}  upstream=${UPSTREAM_ORIGIN}  aliases=[${ALIAS_HOSTS.join(', ')}]`,
  );
});
