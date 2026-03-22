const express = require("express");
const https = require("https");

const app = express();
const PORT = 3000;

app.use(express.static("public"));

// --- Persistent HTTPS agent for connection reuse (like a real browser) ---
const agent = new https.Agent({
  keepAlive: true,
  maxSockets: 5,
  timeout: 20000,
});

// --- Session state ---
let sessionCookies = "";
let lastCookieRefresh = 0;
const COOKIE_TTL = 2 * 60 * 1000; // refresh cookies every 2 min

// --- Response cache so frontend always has data ---
const cache = {}; // { index: { data, timestamp } }
const CACHE_TTL = 15 * 1000; // 15 seconds

const UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

function httpsGet(url, headers = {}, redirectCount = 0) {
  return new Promise((resolve, reject) => {
    if (redirectCount > 3) return reject(new Error("Too many redirects"));
    const parsed = new URL(url);
    const options = {
      hostname: parsed.hostname,
      path: parsed.pathname + parsed.search,
      method: "GET",
      agent,
      headers: {
        Host: parsed.hostname,
        "User-Agent": UA,
        Accept:
          "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8",
        "Accept-Language": "en-US,en;q=0.9",
        "Accept-Encoding": "identity",
        "Cache-Control": "no-cache",
        Pragma: "no-cache",
        Connection: "keep-alive",
        "Sec-Ch-Ua": '"Chromium";v="131", "Not_A Brand";v="24"',
        "Sec-Ch-Ua-Mobile": "?0",
        "Sec-Ch-Ua-Platform": '"macOS"',
        "Sec-Fetch-Dest": "document",
        "Sec-Fetch-Mode": "navigate",
        "Sec-Fetch-Site": "none",
        "Sec-Fetch-User": "?1",
        "Upgrade-Insecure-Requests": "1",
        ...headers,
      },
      timeout: 15000,
    };

    const req = https.request(options, (res) => {
      // Follow redirects
      if ([301, 302, 307, 308].includes(res.statusCode) && res.headers.location) {
        const loc = res.headers.location.startsWith("http")
          ? res.headers.location
          : `https://${parsed.hostname}${res.headers.location}`;
        // Consume body
        res.resume();
        return httpsGet(loc, headers, redirectCount + 1).then(resolve, reject);
      }

      const chunks = [];
      res.on("data", (chunk) => chunks.push(chunk));
      res.on("end", () => {
        resolve({
          status: res.statusCode,
          headers: res.headers,
          body: Buffer.concat(chunks).toString("utf-8"),
        });
      });
    });

    req.on("error", reject);
    req.on("timeout", () => {
      req.destroy();
      reject(new Error("Request timed out"));
    });
    req.end();
  });
}

function parseCookies(res) {
  const setCookies = res.headers["set-cookie"];
  if (!setCookies || setCookies.length === 0) return null;
  return setCookies.map((c) => c.split(";")[0]).join("; ");
}

async function refreshCookies(force = false) {
  const now = Date.now();
  if (!force && now - lastCookieRefresh < COOKIE_TTL && sessionCookies) return true;

  // Try multiple endpoints — NSE sometimes blocks one but not another
  const endpoints = [
    "https://www.nseindia.com/",
    "https://www.nseindia.com/market-data/live-equity-market",
    "https://www.nseindia.com/get-quotes/equity?symbol=RELIANCE",
  ];

  for (const url of endpoints) {
    try {
      const res = await httpsGet(url);
      const cookies = parseCookies(res);
      if (cookies) {
        sessionCookies = cookies;
        lastCookieRefresh = Date.now();
        console.log(`[NSE] Cookies refreshed from ${url} (status ${res.status})`);
        return true;
      }
      // Sometimes Akamai returns 403 but still sets cookies — already handled above
      console.log(`[NSE] No cookies from ${url} (status ${res.status})`);
    } catch (err) {
      console.log(`[NSE] Failed ${url}: ${err.message}`);
    }
  }

  console.error("[NSE] All cookie endpoints failed");
  return false;
}

async function fetchFromNSE(index) {
  const apiUrl = `https://www.nseindia.com/api/equity-stockIndices?index=${encodeURIComponent(index)}`;

  const response = await httpsGet(apiUrl, {
    Accept: "application/json, text/javascript, */*; q=0.01",
    Referer: "https://www.nseindia.com/market-data/live-equity-market",
    "X-Requested-With": "XMLHttpRequest",
    "Sec-Fetch-Dest": "empty",
    "Sec-Fetch-Mode": "cors",
    "Sec-Fetch-Site": "same-origin",
    Cookie: sessionCookies,
  });

  if (response.status === 401 || response.status === 403) {
    throw new Error(`AUTH_FAIL_${response.status}`);
  }

  if (response.status !== 200) {
    throw new Error(`HTTP ${response.status}`);
  }

  return JSON.parse(response.body);
}

// --- API proxy with retry + cache fallback ---
app.get("/api/gainers-losers", async (req, res) => {
  const index = req.query.index || "NIFTY 50";

  // Return cache if fresh enough
  const cached = cache[index];
  if (cached && Date.now() - cached.timestamp < CACHE_TTL) {
    return res.json(cached.data);
  }

  // Attempt up to 3 tries with cookie refresh on auth failures
  let lastErr = null;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      // Refresh cookies if needed
      const gotCookies = await refreshCookies(attempt > 1);
      if (!gotCookies) {
        lastErr = new Error("Could not get NSE session cookies");
        continue;
      }

      const data = fetchFromNSE(index);
      // Small delay between cookie fetch and API call for first attempt
      if (attempt === 1) {
        const result = await data;
        // Cache the successful result
        cache[index] = { data: result, timestamp: Date.now() };
        return res.json(result);
      } else {
        // On retry, add a small delay
        await new Promise((r) => setTimeout(r, 1000));
        const result = await data;
        cache[index] = { data: result, timestamp: Date.now() };
        return res.json(result);
      }
    } catch (err) {
      lastErr = err;
      console.error(`[NSE] Attempt ${attempt}/3 failed for ${index}: ${err.message}`);

      if (err.message.startsWith("AUTH_FAIL")) {
        // Force cookie refresh on next attempt
        sessionCookies = "";
        lastCookieRefresh = 0;
        // Wait before retry
        await new Promise((r) => setTimeout(r, 500 * attempt));
      }
    }
  }

  // All retries failed — return stale cache if available
  if (cached) {
    console.log(`[NSE] Returning stale cache for ${index}`);
    return res.json({ ...cached.data, _stale: true });
  }

  res.status(502).json({
    error: `Failed to fetch data from NSE after 3 attempts. ${lastErr?.message || ""}`,
  });
});

// Pre-warm cookies on startup
refreshCookies().then((ok) => {
  if (ok) console.log("[NSE] Initial cookie warmup done");
  else console.log("[NSE] Initial cookie warmup failed — will retry on first request");
});

app.listen(PORT, () => {
  console.log(`NSE Scanner running → http://localhost:${PORT}`);
});
