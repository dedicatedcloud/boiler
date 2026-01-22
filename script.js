(() => {
  "use strict";

  /**
   * GitHub Releases (latest) → UI updater with caching + timeouts + retries
   * Works on GitHub Pages. No auth token needed, but rate-limited.
   */

  const GITHUB_API = "https://api.github.com";
  const CACHE_PREFIX = "boiler:gh_latest:";
  const CACHE_TTL_MS = 6 * 60 * 60 * 1000; // 6 hours
  const REQUEST_TIMEOUT_MS = 9000;
  const MAX_RETRIES = 2;

  // ---------------------------
  // Small helpers
  // ---------------------------

  const $all = (sel) => Array.from(document.querySelectorAll(sel));

  const setText = (selector, text) => {
    if (text == null) return;
    const str = String(text);
    $all(selector).forEach((el) => {
      el.textContent = str;
    });
  };

  const setAttr = (selector, attr, value) => {
    if (value == null) return;
    const str = String(value);
    $all(selector).forEach((el) => {
      el.setAttribute(attr, str);
    });
  };

  const safeJsonParse = (raw) => {
    try {
      return JSON.parse(raw);
    } catch {
      return null;
    }
  };

  const cacheKey = (repo) => `${CACHE_PREFIX}${repo}`;

  const getCached = (repo) => {
    const raw = localStorage.getItem(cacheKey(repo));
    if (!raw) return null;

    const obj = safeJsonParse(raw);
    if (!obj || typeof obj !== "object") return null;

    const { ts, data } = obj;
    if (!ts || !data) return null;

    if (Date.now() - ts > CACHE_TTL_MS) return null;
    return data;
  };

  const setCached = (repo, data) => {
    try {
      localStorage.setItem(
        cacheKey(repo),
        JSON.stringify({ ts: Date.now(), data })
      );
    } catch {
      // storage full or blocked; silently ignore
    }
  };

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  const fetchWithTimeout = async (url, { timeoutMs = REQUEST_TIMEOUT_MS } = {}) => {
    const controller = new AbortController();
    const t = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const res = await fetch(url, {
        method: "GET",
        mode: "cors",
        cache: "no-store",
        signal: controller.signal,
        headers: {
          // Not strictly required, but helps ensure JSON
          Accept: "application/vnd.github+json",
        },
      });

      // GitHub rate-limit / errors
      if (!res.ok) {
        const text = await res.text().catch(() => "");
        const err = new Error(`GitHub API error ${res.status} ${res.statusText}`);
        err.status = res.status;
        err.body = text;
        throw err;
      }

      return await res.json();
    } finally {
      clearTimeout(t);
    }
  };

  const fetchLatestRelease = async (repo) => {
    // 1) Use cache if present
    const cached = getCached(repo);
    if (cached) return cached;

    const url = `${GITHUB_API}/repos/${repo}/releases/latest`;

    // 2) Try with retries (simple backoff)
    let lastErr = null;
    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      try {
        const data = await fetchWithTimeout(url);
        setCached(repo, data);
        return data;
      } catch (err) {
        lastErr = err;

        // If rate limited or forbidden, no point retrying aggressively
        if (err && (err.status === 403 || err.status === 429)) break;

        if (attempt < MAX_RETRIES) {
          // backoff: 400ms, 900ms, ...
          await sleep(400 + attempt * 500);
        }
      }
    }

    // 3) If we had stale cached data, use it as a fallback (even if expired)
    // (Optional) You can remove this if you prefer to show nothing on failure.
    const raw = localStorage.getItem(cacheKey(repo));
    const stale = raw ? safeJsonParse(raw) : null;
    if (stale && stale.data) return stale.data;

    throw lastErr || new Error("Unknown error fetching release data");
  };

  // ---------------------------
  // Your mappings (repo → UI)
  // ---------------------------

  /**
   * Normalize versions:
   * - Bootstrap uses tag_name like "v5.3.3" and name like "v5.3.3"
   * - jQuery uses tag_name like "3.7.1"
   * - modern-normalize uses tag_name like "v2.0.0"
   * - Splide uses name like "v4.1.4"
   */
  const normalizeVersion = (release, { prefer = "tag_name", stripLeadingV = true } = {}) => {
    if (!release) return null;
    let v = release[prefer] || release.tag_name || release.name || null;
    if (typeof v !== "string") return null;
    v = v.trim();
    if (stripLeadingV) v = v.replace(/^v/i, "");
    return v;
  };

  const getFirstAssetUrl = (release) => {
    const assets = Array.isArray(release?.assets) ? release.assets : [];
    const first = assets[0];
    const url = first?.browser_download_url;
    return typeof url === "string" && url.length ? url : null;
  };

  const run = async () => {
    // Bootstrap (versions + links)
    try {
      const boot = await fetchLatestRelease("twbs/bootstrap");

      // .bv = version (your old code used result.name.slice(1))
      const bv = normalizeVersion(boot, { prefer: "name", stripLeadingV: true });
      setText(".bv", bv);

      // Dist download link (your old code used assets[0])
      const dist = getFirstAssetUrl(boot);
      if (dist) setAttr(".bdu-dist", "href", dist);

      // Source zip (your old code built a zip URL from tag)
      const tag = boot?.tag_name;
      if (typeof tag === "string" && tag.length) {
        const src = `https://github.com/twbs/bootstrap/archive/${encodeURIComponent(tag)}.zip`;
        setAttr(".bdu-src", "href", src);
      }
    } catch (e) {
      // optional: show fallback text
      // setText(".bv", "—");
    }

    // jQuery
    try {
      const jq = await fetchLatestRelease("jquery/jquery");
      const jv = normalizeVersion(jq, { prefer: "tag_name", stripLeadingV: false });
      setText(".jv", jv);
    } catch (e) {
      // setText(".jv", "—");
    }

    // modern-normalize
    try {
      const nn = await fetchLatestRelease("sindresorhus/modern-normalize");
      const nv = normalizeVersion(nn, { prefer: "tag_name", stripLeadingV: true });
      setText(".nv", nv);
    } catch (e) {
      // setText(".nv", "—");
    }

    // Splide
    try {
      const sp = await fetchLatestRelease("Splidejs/splide");
      const sv = normalizeVersion(sp, { prefer: "name", stripLeadingV: true });
      setText(".sv", sv);
    } catch (e) {
      // setText(".sv", "—");
    }
  };

  // Run after DOM is ready
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", run, { once: true });
  } else {
    run();
  }
})();
