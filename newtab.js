// NeTab - private-first new tab dashboard
// The app intentionally keeps user edits in chrome.storage.local / IndexedDB and
// supports git-ignored local JSON files for personal links and media.

const APP = {
  linksKey: "netab.links.v2",
  mediaKey: "netab.media.v2",
  uiKey: "netab.ui.v2",
  dbName: "netab-media-db",
  dbVersion: 1,
  mediaStore: "files",
};

const MEDIA_DIRS = { photos: "media/photos", videos: "media/videos" };
const EXT = {
  photos: new Set([".jpg", ".jpeg", ".png", ".webp", ".gif", ".svg"]),
  videos: new Set([".mp4", ".webm", ".ogg"]),
};
const FAVICON_TTL_MS = 120 * 60 * 60 * 1000;
const FAVICON_MAX_BYTES = 256 * 1024;

function $(id) {
  const el = document.getElementById(id);
  if (!el) throw new Error(`Missing element #${id}`);
  return el;
}

function uid(prefix = "id") {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function basename(path = "") {
  return String(path).split(/[\\/]/).filter(Boolean).pop() || "Untitled";
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function pickRandom(arr) {
  return arr[Math.floor(Math.random() * arr.length)];
}

function asBool(value, fallback = true) {
  return typeof value === "boolean" ? value : fallback;
}

function fileKindFromName(name, mime = "") {
  const lowerMime = String(mime).toLowerCase();
  if (lowerMime.startsWith("image/")) return "photo";
  if (lowerMime.startsWith("video/")) return "video";
  const dot = String(name).lastIndexOf(".");
  const ext = dot >= 0 ? String(name).slice(dot).toLowerCase() : "";
  if (EXT.photos.has(ext)) return "photo";
  if (EXT.videos.has(ext)) return "video";
  return "";
}

function setStatus(text) {
  const el = document.getElementById("statusPill");
  if (el) el.textContent = text;
}

function setNotice(message, timeout = 3400) {
  const el = document.getElementById("settingsNotice");
  if (!el) return;
  el.textContent = message;
  el.classList.remove("hidden");
  window.clearTimeout(setNotice.timer);
  if (timeout) {
    setNotice.timer = window.setTimeout(() => el.classList.add("hidden"), timeout);
  }
}

const ExtensionAPI = (() => {
  const isExtension = Boolean(globalThis.chrome?.runtime?.id);

  function url(path) {
    if (isExtension) return chrome.runtime.getURL(path);
    return path;
  }

  function storageGet(key) {
    return new Promise((resolve) => {
      if (isExtension && chrome.storage?.local) {
        chrome.storage.local.get([key], (res) => resolve(res[key] ?? null));
        return;
      }
      try {
        const raw = localStorage.getItem(key);
        resolve(raw ? JSON.parse(raw) : null);
      } catch {
        resolve(null);
      }
    });
  }

  function storageSet(key, value) {
    return new Promise((resolve) => {
      if (isExtension && chrome.storage?.local) {
        chrome.storage.local.set({ [key]: value }, resolve);
        return;
      }
      localStorage.setItem(key, JSON.stringify(value));
      resolve();
    });
  }

  function storageRemove(keys) {
    return new Promise((resolve) => {
      const list = Array.isArray(keys) ? keys : [keys];
      if (isExtension && chrome.storage?.local) {
        chrome.storage.local.remove(list, resolve);
        return;
      }
      for (const key of list) localStorage.removeItem(key);
      resolve();
    });
  }

  return { isExtension, url, storageGet, storageSet, storageRemove };
})();

function extUrl(path) {
  if (!path) return "";
  if (/^(https?:|data:|blob:)/i.test(path)) return path;
  return ExtensionAPI.url(path);
}

const MediaDB = (() => {
  let dbPromise = null;

  function open() {
    if (dbPromise) return dbPromise;
    dbPromise = new Promise((resolve, reject) => {
      const request = indexedDB.open(APP.dbName, APP.dbVersion);
      request.onupgradeneeded = () => {
        const db = request.result;
        if (!db.objectStoreNames.contains(APP.mediaStore)) {
          db.createObjectStore(APP.mediaStore, { keyPath: "id" });
        }
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error || new Error("IndexedDB failed to open"));
    });
    return dbPromise;
  }

  async function tx(mode, callback) {
    const db = await open();
    return new Promise((resolve, reject) => {
      const transaction = db.transaction(APP.mediaStore, mode);
      const store = transaction.objectStore(APP.mediaStore);
      const result = callback(store);
      transaction.oncomplete = () => resolve(result);
      transaction.onerror = () => reject(transaction.error || new Error("IndexedDB transaction failed"));
      transaction.onabort = () => reject(transaction.error || new Error("IndexedDB transaction aborted"));
    });
  }

  async function put(record) {
    await tx("readwrite", (store) => store.put(record));
  }

  async function get(id) {
    const request = await tx("readonly", (store) => store.get(id));
    return new Promise((resolve, reject) => {
      request.onsuccess = () => resolve(request.result || null);
      request.onerror = () => reject(request.error || new Error("IndexedDB read failed"));
    });
  }

  async function remove(id) {
    await tx("readwrite", (store) => store.delete(id));
  }

  async function clear() {
    await tx("readwrite", (store) => store.clear());
  }

  return { put, get, remove, clear };
})();

const Config = (() => {
  async function fetchJson(path) {
    const res = await fetch(extUrl(path), { cache: "no-store" });
    if (!res.ok) throw new Error(`${path} returned ${res.status}`);
    return res.json();
  }

  async function firstJson(paths) {
    const errors = [];
    for (const path of paths) {
      try {
        const data = await fetchJson(path);
        return { data, source: path };
      } catch (e) {
        errors.push(`${path}: ${e.message}`);
      }
    }
    throw new Error(errors.join(" | "));
  }

  function normalizeLink(item) {
    return {
      id: item?.id || uid("link"),
      label: String(item?.label || "New Link"),
      note: String(item?.note || ""),
      url: String(item?.url || "https://example.com/"),
      icon: String(item?.icon || ""),
      enabled: asBool(item?.enabled, true),
    };
  }

  function normalizeGroup(group) {
    return {
      id: group?.id || uid("group"),
      name: String(group?.name || "New Category"),
      icon: String(group?.icon || "📁"),
      enabled: asBool(group?.enabled, true),
      links: Array.isArray(group?.links) ? group.links.map(normalizeLink) : [],
    };
  }

  function normalizeLinks(data) {
    return {
      title: String(data?.title || "Quick Links"),
      groups: Array.isArray(data?.groups) ? data.groups.map(normalizeGroup) : [],
    };
  }

  function normalizeMediaItem(item, kind) {
    if (typeof item === "string") {
      return {
        id: uid(kind),
        source: "packaged",
        kind,
        name: basename(item),
        path: item,
        enabled: true,
      };
    }
    return {
      id: item?.id || uid(kind),
      source: item?.source || (item?.path ? "packaged" : "uploaded"),
      kind: item?.kind || kind,
      name: String(item?.name || basename(item?.path) || (kind === "photo" ? "Photo" : "Video")),
      path: String(item?.path || ""),
      mime: String(item?.mime || ""),
      size: Number(item?.size || 0),
      createdAt: item?.createdAt || new Date().toISOString(),
      enabled: asBool(item?.enabled, true),
    };
  }

  function normalizeMedia(data) {
    const settings = data?.settings || {};
    return {
      settings: {
        mode: ["mixed", "photos", "videos"].includes(settings.mode) ? settings.mode : "mixed",
        videoVolume: Number.isFinite(Number(settings.videoVolume)) ? Math.min(100, Math.max(0, Number(settings.videoVolume))) : 0,
        shadeStrength: Number.isFinite(Number(settings.shadeStrength)) ? Math.min(90, Math.max(0, Number(settings.shadeStrength))) : 64,
        blur: Number.isFinite(Number(settings.blur)) ? Math.min(16, Math.max(0, Number(settings.blur))) : 0,
        scale: Number.isFinite(Number(settings.scale)) ? Math.min(112, Math.max(100, Number(settings.scale))) : 102,
      },
      photos: Array.isArray(data?.photos) ? data.photos.map((x) => normalizeMediaItem(x, "photo")) : [],
      videos: Array.isArray(data?.videos) ? data.videos.map((x) => normalizeMediaItem(x, "video")) : [],
    };
  }

  async function scanPackageMedia() {
    if (!ExtensionAPI.isExtension || !chrome.runtime.getPackageDirectoryEntry) return { photos: [], videos: [] };

    const root = await new Promise((resolve, reject) => {
      chrome.runtime.getPackageDirectoryEntry((entry) => (entry ? resolve(entry) : reject(new Error("No package entry"))));
    });

    function getDirectory(path) {
      return new Promise((resolve) => {
        root.getDirectory(path, { create: false }, (dir) => resolve(dir), () => resolve(null));
      });
    }

    function readEntries(dirEntry) {
      return new Promise((resolve, reject) => {
        const reader = dirEntry.createReader();
        const all = [];
        const loop = () => reader.readEntries((batch) => {
          if (!batch || batch.length === 0) return resolve(all);
          all.push(...batch);
          loop();
        }, reject);
        loop();
      });
    }

    async function walk(dirEntry, basePath, extsSet, kind) {
      const out = [];
      const entries = await readEntries(dirEntry);
      for (const entry of entries) {
        if (entry.isFile) {
          const dot = entry.name.lastIndexOf(".");
          const ext = dot >= 0 ? entry.name.slice(dot).toLowerCase() : "";
          if (extsSet.has(ext)) out.push(normalizeMediaItem(`${basePath}/${entry.name}`, kind));
        } else if (entry.isDirectory) {
          out.push(...(await walk(entry, `${basePath}/${entry.name}`, extsSet, kind)));
        }
      }
      return out;
    }

    const photosDir = await getDirectory(MEDIA_DIRS.photos);
    const videosDir = await getDirectory(MEDIA_DIRS.videos);
    return {
      photos: photosDir ? await walk(photosDir, MEDIA_DIRS.photos, EXT.photos, "photo") : [],
      videos: videosDir ? await walk(videosDir, MEDIA_DIRS.videos, EXT.videos, "video") : [],
    };
  }

  async function loadLinks({ ignoreStored = false, publicOnly = false } = {}) {
    if (!ignoreStored) {
      const stored = await ExtensionAPI.storageGet(APP.linksKey);
      if (stored) return { links: normalizeLinks(stored), source: "chrome.storage.local" };
    }
    const candidates = publicOnly ? ["data/links.json"] : ["data/links.local.json", "data/links.json"];
    const { data, source } = await firstJson(candidates);
    return { links: normalizeLinks(data), source };
  }

  async function loadMedia({ ignoreStored = false, publicOnly = false } = {}) {
    if (!ignoreStored) {
      const stored = await ExtensionAPI.storageGet(APP.mediaKey);
      if (stored) return { media: normalizeMedia(stored), source: "chrome.storage.local" };
    }
    const candidates = publicOnly ? ["data/media.json"] : ["data/media.local.json", "data/media.json"];
    const { data, source } = await firstJson(candidates);
    const media = normalizeMedia(data);
    if (!media.photos.length && !media.videos.length) {
      const scanned = await scanPackageMedia();
      media.photos = scanned.photos;
      media.videos = scanned.videos;
    }
    return { media, source };
  }

  async function loadAll(options = {}) {
    const [{ links, source: linksSource }, { media, source: mediaSource }] = await Promise.all([
      loadLinks(options),
      loadMedia(options),
    ]);
    const ui = (await ExtensionAPI.storageGet(APP.uiKey)) || { openFirstGroup: true };
    return { links, media, ui: { openFirstGroup: asBool(ui.openFirstGroup, true) }, sources: { linksSource, mediaSource } };
  }

  async function saveAll({ links, media, ui }) {
    await Promise.all([
      ExtensionAPI.storageSet(APP.linksKey, normalizeLinks(links)),
      ExtensionAPI.storageSet(APP.mediaKey, normalizeMedia(media)),
      ExtensionAPI.storageSet(APP.uiKey, { openFirstGroup: asBool(ui?.openFirstGroup, true) }),
    ]);
  }

  async function reset({ publicOnly = true } = {}) {
    await ExtensionAPI.storageRemove([APP.linksKey, APP.mediaKey, APP.uiKey]);
    if (publicOnly) await MediaDB.clear();
    return loadAll({ ignoreStored: true, publicOnly });
  }

  return { normalizeLinks, normalizeMedia, loadAll, saveAll, reset };
})();

const FaviconCache = (() => {
  const pending = new Map();

  function normalizePageUrl(pageUrl) {
    try {
      const url = new URL(pageUrl);
      return url.href;
    } catch {
      try { return new URL(`https://${pageUrl}`).href; } catch { return pageUrl; }
    }
  }

  function pageHostname(pageUrl) {
    try { return new URL(normalizePageUrl(pageUrl)).hostname; } catch { return ""; }
  }

  function pageOrigin(pageUrl) {
    try { return new URL(normalizePageUrl(pageUrl)).origin; } catch { return ""; }
  }

  function originKey(pageUrl) {
    return pageOrigin(pageUrl) || pageUrl;
  }

  function chromeFaviconUrl(pageUrl, size = 64) {
    if (!ExtensionAPI.isExtension) return "";
    const url = new URL(chrome.runtime.getURL("/_favicon/"));
    url.searchParams.set("pageUrl", normalizePageUrl(pageUrl));
    url.searchParams.set("size", String(size));
    return url.toString();
  }

  function rootIconUrls(pageUrl) {
    const origin = pageOrigin(pageUrl);
    return origin ? [`${origin}/favicon.ico`, `${origin}/favicon.png`, `${origin}/apple-touch-icon.png`] : [];
  }

  function fallbackDataUrl(pageUrl) {
    const host = pageHostname(pageUrl) || "?";
    const label = (host.replace(/^www\./, "").charAt(0) || "?").toUpperCase();
    const hue = [...host].reduce((sum, char) => sum + char.charCodeAt(0), 0) % 360;
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64" viewBox="0 0 64 64"><rect width="64" height="64" rx="14" fill="hsl(${hue} 66% 42%)"/><text x="50%" y="55%" dominant-baseline="middle" text-anchor="middle" font-family="Arial" font-size="32" font-weight="700" fill="white">${label}</text></svg>`;
    return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
  }

  function displayFallbackUrls(pageUrl) {
    const host = pageHostname(pageUrl);
    return [
      chromeFaviconUrl(pageUrl),
      ...rootIconUrls(pageUrl),
      host ? `https://icons.duckduckgo.com/ip3/${host}.ico` : "",
      `https://www.google.com/s2/favicons?domain_url=${encodeURIComponent(normalizePageUrl(pageUrl))}&sz=64`,
      fallbackDataUrl(pageUrl),
    ].filter(Boolean);
  }

  function blobToDataUrl(blob) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result);
      reader.onerror = () => reject(reader.error || new Error("Failed to read icon"));
      reader.readAsDataURL(blob);
    });
  }

  async function fetchIcon(url) {
    const res = await fetch(url, { cache: "reload", credentials: "omit", redirect: "follow" });
    if (!res.ok) throw new Error(`Icon candidate returned ${res.status}`);
    const blob = await res.blob();
    const type = (blob.type || res.headers.get("content-type") || "").toLowerCase();
    if (!blob.size || blob.size > FAVICON_MAX_BYTES) throw new Error("Invalid icon size");
    if (type && !type.startsWith("image/") && !type.includes("svg") && !type.includes("xml") && !type.includes("octet-stream")) {
      throw new Error(`Not an image: ${type}`);
    }
    return blobToDataUrl(blob);
  }

  async function resolveDataUrl(pageUrl) {
    for (const url of displayFallbackUrls(pageUrl)) {
      try { return await fetchIcon(url); } catch { /* try next */ }
    }
    return fallbackDataUrl(pageUrl);
  }

  function useFallbacks(imgEl, pageUrl) {
    const urls = displayFallbackUrls(pageUrl);
    let index = 0;
    const next = () => {
      const url = urls[index++];
      if (!url) {
        imgEl.classList.add("favicon-missing");
        imgEl.removeAttribute("src");
        return;
      }
      imgEl.src = url;
    };
    imgEl.onerror = next;
    next();
  }

  async function setImg(imgEl, pageUrl) {
    const key = `favicon:${originKey(pageUrl)}`;
    const cached = await ExtensionAPI.storageGet(key);
    const now = Date.now();
    imgEl.classList.remove("favicon-missing");

    if (cached?.dataUrl) {
      imgEl.onerror = () => useFallbacks(imgEl, pageUrl);
      imgEl.src = cached.dataUrl;
    } else {
      useFallbacks(imgEl, pageUrl);
    }

    if (cached?.dataUrl && cached?.expiresAt > now) return;
    if (!pending.has(key)) {
      pending.set(key, (async () => {
        const dataUrl = await resolveDataUrl(pageUrl);
        await ExtensionAPI.storageSet(key, { dataUrl, cachedAt: now, expiresAt: now + FAVICON_TTL_MS });
        return dataUrl;
      })().finally(() => pending.delete(key)));
    }

    try {
      const dataUrl = await pending.get(key);
      imgEl.onerror = () => useFallbacks(imgEl, pageUrl);
      imgEl.src = dataUrl;
    } catch {
      useFallbacks(imgEl, pageUrl);
    }
  }

  return { setImg };
})();

const MediaResolver = (() => {
  const objectUrls = new Map();

  async function urlFor(item) {
    if (!item) return "";
    if (item.source === "uploaded") {
      if (objectUrls.has(item.id)) return objectUrls.get(item.id);
      const record = await MediaDB.get(item.id);
      if (!record?.blob) return "";
      const url = URL.createObjectURL(record.blob);
      objectUrls.set(item.id, url);
      return url;
    }
    return extUrl(item.path);
  }

  function revoke(id) {
    const url = objectUrls.get(id);
    if (url) URL.revokeObjectURL(url);
    objectUrls.delete(id);
  }

  return { urlFor, revoke };
})();

const Background = (() => {
  function applySettings(media) {
    const settings = media.settings || {};
    document.documentElement.style.setProperty("--shade", String(settings.shadeStrength ?? 64));
    document.documentElement.style.setProperty("--bg-blur", String(settings.blur ?? 0));
    document.documentElement.style.setProperty("--bg-scale", String(settings.scale ?? 102));
  }

  function setImageVisible(value) { $("bgImage").style.opacity = value ? "1" : "0"; }
  function setVideoVisible(value) { $("bgVideo").style.opacity = value ? "1" : "0"; }

  function showFallbackGradient() {
    setImageVisible(false);
    setVideoVisible(false);
    document.body.style.background = "radial-gradient(circle at center, #202435, #05060a 72%)";
  }

  async function showPhoto(item) {
    const img = $("bgImage");
    const video = $("bgVideo");
    try { video.pause(); } catch {}
    video.removeAttribute("src");
    video.load();
    setVideoVisible(false);

    const url = await MediaResolver.urlFor(item);
    if (!url) return false;
    const ok = await new Promise((resolve) => {
      img.onload = () => resolve(true);
      img.onerror = () => resolve(false);
      img.src = url;
    });
    if (ok) setImageVisible(true);
    return ok;
  }

  async function showVideo(item, volume = 0) {
    const video = $("bgVideo");
    setImageVisible(false);
    const url = await MediaResolver.urlFor(item);
    if (!url) return false;

    const ok = await new Promise((resolve) => {
      const cleanup = (result) => {
        video.removeEventListener("canplay", onCanPlay);
        video.removeEventListener("error", onError);
        resolve(result);
      };
      const onCanPlay = () => cleanup(true);
      const onError = () => cleanup(false);
      video.loop = true;
      video.playsInline = true;
      video.muted = Number(volume) <= 0;
      video.volume = Math.min(1, Math.max(0, Number(volume) / 100));
      video.src = url;
      video.addEventListener("canplay", onCanPlay);
      video.addEventListener("error", onError);
      video.load();
    });

    if (!ok) return false;
    setVideoVisible(true);
    try {
      await video.play();
      return true;
    } catch {
      video.muted = true;
      try { await video.play(); return true; } catch { setVideoVisible(false); return false; }
    }
  }

  function enabledItems(media) {
    const mode = media.settings?.mode || "mixed";
    const photos = mode !== "videos" ? media.photos.filter((x) => x.enabled) : [];
    const videos = mode !== "photos" ? media.videos.filter((x) => x.enabled) : [];
    return { photos, videos };
  }

  async function init(media) {
    applySettings(media);
    const { photos, videos } = enabledItems(media);
    if (!photos.length && !videos.length) {
      setStatus("No media");
      showFallbackGradient();
      return;
    }

    let candidates = [];
    if (photos.length) candidates.push("photo");
    if (videos.length) candidates.push("video");
    const mode = pickRandom(candidates);
    let ok = false;
    if (mode === "video") ok = await showVideo(pickRandom(videos), media.settings.videoVolume);
    if (!ok && photos.length) ok = await showPhoto(pickRandom(photos));
    if (!ok && videos.length) ok = await showVideo(pickRandom(videos), 0);
    if (!ok) showFallbackGradient();
    setStatus(`${photos.length} photos · ${videos.length} videos`);
  }

  return { init, applySettings };
})();

const LinksUI = (() => {
  function showLinksError(msg) {
    const el = document.createElement("div");
    el.className = "empty-state";
    el.textContent = msg;
    const container = $("groups");
    container.innerHTML = "";
    container.appendChild(el);
  }

  function visibleGroups(links) {
    return links.groups
      .filter((g) => g.enabled)
      .map((g) => ({ ...g, links: g.links.filter((l) => l.enabled && l.url && l.label) }));
  }

  function render(links, ui = { openFirstGroup: true }) {
    $("title").textContent = links.title || "Quick Links";
    const container = $("groups");
    container.innerHTML = "";
    const groups = visibleGroups(links);
    if (!groups.length) {
      showLinksError("No enabled categories yet. Open Settings to add your first link.");
      return;
    }

    groups.forEach((group, index) => {
      const groupEl = document.createElement("article");
      groupEl.className = `group${ui.openFirstGroup && index === 0 ? " open" : ""}`;

      const header = document.createElement("button");
      header.className = "group-header";
      header.type = "button";

      const left = document.createElement("div");
      left.className = "group-left";
      const icon = document.createElement("div");
      icon.className = "group-icon";
      icon.textContent = group.icon || "📁";
      const name = document.createElement("div");
      name.className = "group-name";
      name.textContent = group.name || "Category";
      left.append(icon, name);

      const count = document.createElement("div");
      count.className = "group-count";
      count.textContent = String(group.links.length);
      header.append(left, count);

      const body = document.createElement("div");
      body.className = "group-body";
      for (const item of group.links) {
        const link = document.createElement("a");
        link.className = "link-item";
        link.href = item.url;
        link.target = "_self";
        link.rel = "noopener noreferrer";

        if (item.icon) {
          const iconBox = document.createElement("div");
          iconBox.className = "link-icon";
          iconBox.textContent = item.icon;
          link.appendChild(iconBox);
        } else {
          const fav = document.createElement("img");
          fav.className = "favicon";
          fav.alt = "";
          fav.loading = "lazy";
          fav.referrerPolicy = "no-referrer";
          FaviconCache.setImg(fav, item.url);
          link.appendChild(fav);
        }

        const text = document.createElement("div");
        text.className = "link-text";
        const label = document.createElement("div");
        label.className = "link-label";
        label.textContent = item.label;
        const note = document.createElement("div");
        note.className = "link-note";
        note.textContent = item.note || item.url;
        text.append(label, note);
        link.appendChild(text);
        body.appendChild(link);
      }

      header.addEventListener("click", () => {
        for (const other of container.querySelectorAll(".group.open")) {
          if (other !== groupEl) other.classList.remove("open");
        }
        groupEl.classList.toggle("open");
      });

      groupEl.append(header, body);
      container.appendChild(groupEl);
    });
  }

  return { render };
})();

const SettingsUI = (() => {
  let state = null;
  let draft = null;

  function currentDraft() {
    return draft || clone(state);
  }

  function bindModal(openBtnId, modalId, closeBtnId) {
    const openBtn = $(openBtnId);
    const modal = $(modalId);
    const closeBtn = $(closeBtnId);
    const open = () => modal.classList.remove("hidden");
    const close = () => modal.classList.add("hidden");
    openBtn.addEventListener("click", open);
    closeBtn.addEventListener("click", close);
    modal.addEventListener("click", (e) => {
      if (e.target?.classList?.contains("modal-backdrop")) close();
    });
    return { open, close };
  }

  function bindTabs() {
    for (const btn of document.querySelectorAll(".tab-btn")) {
      btn.addEventListener("click", () => {
        for (const b of document.querySelectorAll(".tab-btn")) b.classList.toggle("active", b === btn);
        for (const panel of document.querySelectorAll(".tab-panel")) {
          panel.classList.toggle("active", panel.dataset.panel === btn.dataset.tab);
        }
      });
    }
  }

  function renderLinksEditor() {
    const d = currentDraft();
    $("linksTitleInput").value = d.links.title;
    const container = $("groupsEditor");
    container.innerHTML = "";
    const groupTemplate = $("groupTemplate");
    const linkTemplate = $("linkTemplate");

    d.links.groups.forEach((group, groupIndex) => {
      const groupNode = groupTemplate.content.firstElementChild.cloneNode(true);
      groupNode.querySelector('[data-field="enabled"]').checked = group.enabled;
      groupNode.querySelector('[data-field="name"]').value = group.name;
      groupNode.querySelector('[data-field="icon"]').value = group.icon;

      groupNode.querySelector('[data-field="enabled"]').addEventListener("change", (e) => { group.enabled = e.target.checked; });
      groupNode.querySelector('[data-field="name"]').addEventListener("input", (e) => { group.name = e.target.value; });
      groupNode.querySelector('[data-field="icon"]').addEventListener("input", (e) => { group.icon = e.target.value; });

      groupNode.querySelector('[data-action="delete-group"]').addEventListener("click", () => {
        d.links.groups.splice(groupIndex, 1);
        renderLinksEditor();
      });
      groupNode.querySelector('[data-action="add-link"]').addEventListener("click", () => {
        group.links.push({ id: uid("link"), label: "New Link", note: "", url: "https://example.com/", icon: "", enabled: true });
        renderLinksEditor();
      });

      const linksHost = groupNode.querySelector('[data-role="links"]');
      group.links.forEach((link, linkIndex) => {
        const linkNode = linkTemplate.content.firstElementChild.cloneNode(true);
        for (const field of ["enabled", "label", "url", "note", "icon"]) {
          const input = linkNode.querySelector(`[data-field="${field}"]`);
          if (field === "enabled") input.checked = link.enabled;
          else input.value = link[field] || "";
          input.addEventListener(field === "enabled" ? "change" : "input", (e) => {
            link[field] = field === "enabled" ? e.target.checked : e.target.value;
          });
        }
        linkNode.querySelector('[data-action="delete-link"]').addEventListener("click", () => {
          group.links.splice(linkIndex, 1);
          renderLinksEditor();
        });
        linksHost.appendChild(linkNode);
      });

      container.appendChild(groupNode);
    });
  }

  async function renderMediaCard(item, kind, host) {
    const card = document.createElement("article");
    card.className = "media-card";
    const preview = document.createElement("div");
    preview.className = "media-preview";
    const url = await MediaResolver.urlFor(item);
    if (kind === "photo") {
      const img = document.createElement("img");
      img.alt = item.name;
      img.loading = "lazy";
      img.src = url;
      preview.appendChild(img);
    } else {
      const video = document.createElement("video");
      video.src = url;
      video.controls = true;
      video.muted = true;
      video.loop = true;
      video.preload = "metadata";
      preview.appendChild(video);
    }

    const meta = document.createElement("div");
    meta.className = "media-meta";
    const name = document.createElement("div");
    name.className = "media-name";
    name.textContent = item.name;
    const path = document.createElement("div");
    path.className = "media-path";
    path.textContent = item.source === "uploaded" ? "Stored locally in browser" : item.path;
    const actions = document.createElement("div");
    actions.className = "media-actions";
    const enabledLabel = document.createElement("label");
    enabledLabel.className = "mini-check";
    const enabled = document.createElement("input");
    enabled.type = "checkbox";
    enabled.checked = item.enabled;
    enabled.addEventListener("change", (e) => { item.enabled = e.target.checked; });
    enabledLabel.append(enabled, " Show");
    const remove = document.createElement("button");
    remove.className = "tiny-button danger-text";
    remove.type = "button";
    remove.textContent = "Remove";
    remove.addEventListener("click", async () => {
      const d = currentDraft();
      const list = kind === "photo" ? d.media.photos : d.media.videos;
      const index = list.findIndex((x) => x.id === item.id);
      if (index >= 0) list.splice(index, 1);
      if (item.source === "uploaded") await MediaDB.remove(item.id);
      MediaResolver.revoke(item.id);
      renderMediaEditor();
    });
    actions.append(enabledLabel, remove);
    meta.append(name, path, actions);
    card.append(preview, meta);
    host.appendChild(card);
  }

  async function renderMediaSection(title, items, kind, container) {
    const section = document.createElement("section");
    section.className = "media-section";
    const h = document.createElement("h3");
    h.textContent = `${title} (${items.length})`;
    const grid = document.createElement("div");
    grid.className = "media-grid";
    section.append(h, grid);
    container.appendChild(section);
    for (const item of items) await renderMediaCard(item, kind, grid);
  }

  async function renderMediaEditor() {
    const d = currentDraft();
    $("mediaModeInput").value = d.media.settings.mode;
    $("videoVolumeInput").value = d.media.settings.videoVolume;
    $("shadeStrengthInput").value = d.media.settings.shadeStrength;
    $("blurInput").value = d.media.settings.blur;
    $("scaleInput").value = d.media.settings.scale;
    $("openFirstGroupInput").checked = d.ui.openFirstGroup;

    const container = $("mediaEditor");
    container.innerHTML = "";
    await renderMediaSection("Photos", d.media.photos, "photo", container);
    await renderMediaSection("Videos", d.media.videos, "video", container);
  }

  function bindFormInputs() {
    $("linksTitleInput").addEventListener("input", (e) => { currentDraft().links.title = e.target.value; });
    $("addGroupBtn").addEventListener("click", () => {
      currentDraft().links.groups.push({ id: uid("group"), name: "New Category", icon: "📁", enabled: true, links: [] });
      renderLinksEditor();
    });

    const mediaFields = {
      mediaModeInput: ["mode", String],
      videoVolumeInput: ["videoVolume", Number],
      shadeStrengthInput: ["shadeStrength", Number],
      blurInput: ["blur", Number],
      scaleInput: ["scale", Number],
    };
    for (const [id, [field, cast]] of Object.entries(mediaFields)) {
      $(id).addEventListener("input", (e) => {
        currentDraft().media.settings[field] = cast(e.target.value);
        Background.applySettings(currentDraft().media);
      });
    }
    $("openFirstGroupInput").addEventListener("change", (e) => { currentDraft().ui.openFirstGroup = e.target.checked; });

    $("mediaUploadInput").addEventListener("change", async (e) => {
      const files = [...(e.target.files || [])];
      const d = currentDraft();
      for (const file of files) {
        const kind = fileKindFromName(file.name, file.type);
        if (!kind) continue;
        const id = uid(kind);
        await MediaDB.put({ id, blob: file, name: file.name, type: file.type, size: file.size, createdAt: new Date().toISOString() });
        const item = { id, source: "uploaded", kind, name: file.name, mime: file.type, size: file.size, enabled: true, createdAt: new Date().toISOString() };
        if (kind === "photo") d.media.photos.push(item);
        else d.media.videos.push(item);
      }
      e.target.value = "";
      await renderMediaEditor();
      setNotice("Media added locally. Click Save changes to keep it in your settings.");
    });

    $("addMediaPathBtn").addEventListener("click", async () => {
      const path = prompt("Enter a packaged media path, for example: media/photos/wallpaper.jpg");
      if (!path) return;
      const kind = fileKindFromName(path);
      if (!kind) {
        setNotice("Unsupported file type. Use jpg, png, webp, gif, svg, mp4, webm, or ogg.");
        return;
      }
      const item = { id: uid(kind), source: "packaged", kind, name: basename(path), path, enabled: true };
      const d = currentDraft();
      if (kind === "photo") d.media.photos.push(item);
      else d.media.videos.push(item);
      await renderMediaEditor();
    });
  }

  function downloadJson(filename, data) {
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  }

  function bindDataActions() {
    $("exportConfigBtn").addEventListener("click", () => {
      const data = { version: 2, exportedAt: new Date().toISOString(), ...currentDraft() };
      downloadJson("netab-config.json", data);
    });

    $("importConfigInput").addEventListener("change", async (e) => {
      const file = e.target.files?.[0];
      if (!file) return;
      try {
        const imported = JSON.parse(await file.text());
        draft = {
          links: Config.normalizeLinks(imported.links || imported),
          media: Config.normalizeMedia(imported.media || {}),
          ui: { openFirstGroup: asBool(imported.ui?.openFirstGroup, true) },
        };
        renderAllEditors();
        setNotice("Config imported. Review it, then click Save changes.");
      } catch (err) {
        setNotice(`Import failed: ${err.message}`);
      } finally {
        e.target.value = "";
      }
    });

    $("reloadLocalBtn").addEventListener("click", async () => {
      const loaded = await Config.loadAll({ ignoreStored: true, publicOnly: false });
      draft = { links: loaded.links, media: loaded.media, ui: loaded.ui };
      renderAllEditors();
      setNotice(`Loaded ${loaded.sources.linksSource} and ${loaded.sources.mediaSource}. Click Save changes to persist.`);
    });

    $("resetSettingsBtn").addEventListener("click", async () => {
      if (!confirm("Reset NeTab to public defaults and remove uploaded media from IndexedDB?")) return;
      const loaded = await Config.reset({ publicOnly: true });
      state = { links: loaded.links, media: loaded.media, ui: loaded.ui };
      draft = clone(state);
      renderAllEditors();
      LinksUI.render(state.links, state.ui);
      await Background.init(state.media);
      setNotice("Reset complete. Public defaults are active.");
    });
  }

  function renderPrivacyHelp() {
    $("privacyHelp").textContent = `Private workflow:\n\n1. Keep personal links in data/links.local.json.\n2. Keep personal media in media/photos and media/videos.\n3. Git ignores .env, data/*.local.json, and personal media by default.\n4. Public users get safe defaults from data/links.json and sample media from media/samples.\n5. The Settings panel saves user edits to chrome.storage.local and uploaded media to IndexedDB.\n\nFor .env users:\n- Copy .env.example to .env\n- Set NETAB_LINKS_JSON or NETAB_MEDIA_JSON\n- Run npm run sync:env`;
  }

  function renderAllEditors() {
    renderLinksEditor();
    renderMediaEditor();
    renderPrivacyHelp();
  }

  async function save() {
    const d = currentDraft();
    d.links = Config.normalizeLinks(d.links);
    d.media = Config.normalizeMedia(d.media);
    await Config.saveAll(d);
    state = clone(d);
    draft = clone(d);
    LinksUI.render(state.links, state.ui);
    await Background.init(state.media);
    renderAllEditors();
    setNotice("Saved. Your private configuration is stored locally in this browser.");
  }

  async function init(initialState) {
    state = clone(initialState);
    draft = clone(initialState);
    bindModal("settingsBtn", "settingsModal", "settingsClose");
    bindTabs();
    bindFormInputs();
    bindDataActions();
    $("saveSettingsBtn").addEventListener("click", save);
    window.addEventListener("keydown", (e) => {
      if (e.key === "Escape") {
        $("settingsModal").classList.add("hidden");
        $("widgetsModal").classList.add("hidden");
      }
    });
    renderAllEditors();
  }

  return { init };
})();

const WidgetsUI = (() => {
  function init() {
    const btn = $("widgetsBtn");
    const modal = $("widgetsModal");
    const closeBtn = $("widgetsClose");
    const open = () => modal.classList.remove("hidden");
    const close = () => modal.classList.add("hidden");
    btn.addEventListener("click", open);
    closeBtn.addEventListener("click", close);
    modal.addEventListener("click", (e) => {
      if (e.target?.classList?.contains("modal-backdrop")) close();
    });
  }
  return { init };
})();

(async function main() {
  try {
    const loaded = await Config.loadAll();
    LinksUI.render(loaded.links, loaded.ui);
    WidgetsUI.init();
    await SettingsUI.init({ links: loaded.links, media: loaded.media, ui: loaded.ui });
    Background.init(loaded.media).catch((e) => {
      console.error("Background failed", e);
      setStatus("Media error");
    });

    // Screenshot/documentation helper for local previews only.
    const previewTab = new URLSearchParams(location.search).get("settings");
    if (previewTab) {
      setTimeout(() => {
        document.getElementById("settingsBtn")?.click();
        document.querySelector(`.tab-btn[data-tab="${previewTab}"]`)?.click();
      }, 250);
    }
  } catch (e) {
    console.error(e);
    setStatus("Config error");
    const container = $("groups");
    container.innerHTML = "";
    const msg = document.createElement("div");
    msg.className = "empty-state";
    msg.textContent = "NeTab failed to load its configuration. Check data/links.json and data/media.json.";
    container.appendChild(msg);
  }
})();
