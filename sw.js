/* ArturGames — cache local no celular. Intercepta /play/<id>/... */
const SHELL = "ag-shell-v1";
const MAX_CACHE_BYTES = 20 * 1024 * 1024;
const FALLBACK_FILES = {
  denselands: ["icon.svg", "card.png", "manifest.json", "service-worker.js", "map.html", "wiki.html"],
  hillfight: ["icon.svg", "card.png"],
  driftmania: ["icon.svg", "card.png"]
};

self.addEventListener("install", (event) => {
  event.waitUntil(self.skipWaiting());
});

self.addEventListener("activate", (event) => {
  event.waitUntil(self.clients.claim());
});

function playMatch(url) {
  const path = url.pathname;
  const marker = "/play/";
  const idx = path.indexOf(marker);
  if (idx === -1) return null;
  const rest = path.slice(idx + marker.length);
  const slash = rest.indexOf("/");
  if (slash === -1) return { id: decodeURIComponent(rest), rel: "index.html" };
  return {
    id: decodeURIComponent(rest.slice(0, slash)),
    rel: decodeURIComponent(rest.slice(slash + 1) || "index.html")
  };
}

function cacheName(id) {
  return `ag-game-${id}`;
}

async function readMeta(id) {
  const cache = await caches.open(cacheName(id));
  const res = await cache.match("__meta.json");
  if (!res) return null;
  try {
    return await res.json();
  } catch {
    return null;
  }
}

async function writeMeta(id, meta) {
  const cache = await caches.open(cacheName(id));
  await cache.put(
    "__meta.json",
    new Response(JSON.stringify(meta), { headers: { "Content-Type": "application/json" } })
  );
}

function allowed(meta, rel) {
  const keep = meta?.keep || ["index.html", "icon.svg"];
  const extra = meta?.files || FALLBACK_FILES[meta?.id] || [];
  const set = new Set(["__meta.json", ...keep, ...extra]);
  return set.has(rel);
}

async function fetchAndStore(cache, request, remoteUrl, id, rel) {
  const incoming = await fetch(remoteUrl, { mode: "cors" });
  if (!incoming.ok) throw new Error("HTTP " + incoming.status);
  let body = incoming;
  if (rel === "index.html") {
    const text = (await incoming.text()).replace(
      /navigator\.serviceWorker\.register\s*\(/g,
      "false && navigator.serviceWorker.register("
    );
    body = new Response(text, {
      status: 200,
      headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-cache" }
    });
  } else {
    body = incoming.clone();
  }
  const stored = body.clone();
  await cache.put(request, stored);
  const meta = (await readMeta(id)) || {};
  meta.lastUsed = meta.lastUsed || {};
  meta.lastUsed[rel] = Date.now();
  await writeMeta(id, meta);
  return body;
}

async function handlePlay(event, url, part) {
  const { id, rel } = part;
  const cache = await caches.open(cacheName(id));
  const localReq = new Request(url.href);
  const hit = await cache.match(localReq);
  if (hit) {
    const meta = (await readMeta(id)) || {};
    meta.lastUsed = meta.lastUsed || {};
    meta.lastUsed[rel] = Date.now();
    writeMeta(id, meta);
    return hit;
  }

  const meta = await readMeta(id);
  if (!meta || !allowed(meta, rel)) {
    return new Response("Fora do files.json", { status: 404 });
  }
  if (!meta.base) {
    return new Response("Jogo sem base remota", { status: 404 });
  }

  try {
    const remote = new URL(rel, meta.base).href;
    return await fetchAndStore(cache, localReq, remote, id, rel);
  } catch (err) {
    return new Response("Sem conexão para " + rel, { status: 503 });
  }
}

self.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);
  if (url.origin !== self.location.origin) return;
  const part = playMatch(url);
  if (!part) return;
  event.respondWith(handlePlay(event, url, part));
});

self.addEventListener("message", (event) => {
  const data = event.data || {};
  if (data.type === "evict") {
    event.waitUntil(evict(data.id));
  }
});

async function evict(id) {
  const cache = await caches.open(cacheName(id));
  const meta = (await readMeta(id)) || {};
  const keep = new Set(["__meta.json", ...(meta.keep || ["index.html", "icon.svg"])]);
  const keys = await cache.keys();
  const rows = [];
  let extraBytes = 0;
  for (const req of keys) {
    const u = new URL(req.url);
    const part = playMatch(u);
    const rel = part?.rel || (u.pathname.endsWith("__meta.json") ? "__meta.json" : "");
    const res = await cache.match(req);
    const buf = res ? await res.clone().arrayBuffer() : new ArrayBuffer(0);
    const row = { req, rel, bytes: buf.byteLength, used: meta.lastUsed?.[rel] || 0 };
    if (!keep.has(rel)) {
      extraBytes += row.bytes;
      rows.push(row);
    }
  }
  rows.sort((a, b) => a.used - b.used);
  for (const row of rows) {
    if (extraBytes <= MAX_CACHE_BYTES) break;
    await cache.delete(row.req);
    extraBytes -= row.bytes;
    if (meta.lastUsed) delete meta.lastUsed[row.rel];
  }
  await writeMeta(id, meta);
}
