const express = require("express");
const https = require("https");

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.static("public"));

// --- Persistent HTTPS agent for connection reuse ---
const agent = new https.Agent({
  keepAlive: true,
  maxSockets: 5,
  timeout: 20000,
});

// --- Session state (NSE direct) ---
let sessionCookies = "";
let lastCookieRefresh = 0;
const COOKIE_TTL = 2 * 60 * 1000;

// --- Response cache ---
const cache = {};
const CACHE_TTL = 15 * 1000;

// --- Track which source works ---
let nseDirectWorks = true; // optimistic, will flip on failure

const UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

// ── Index → Yahoo Finance ticker mappings ──
const INDEX_YAHOO_SYMBOLS = {
  "NIFTY 50": [
    "RELIANCE.NS","TCS.NS","HDFCBANK.NS","INFY.NS","ICICIBANK.NS",
    "HINDUNILVR.NS","BHARTIARTL.NS","SBIN.NS","BAJFINANCE.NS","ITC.NS",
    "KOTAKBANK.NS","LT.NS","HCLTECH.NS","AXISBANK.NS","ASIANPAINT.NS",
    "MARUTI.NS","SUNPHARMA.NS","TITAN.NS","ULTRACEMCO.NS","WIPRO.NS",
    "NESTLEIND.NS","BAJAJFINSV.NS","TATAMOTORS.NS","NTPC.NS","POWERGRID.NS",
    "M&M.NS","TATASTEEL.NS","ONGC.NS","JSWSTEEL.NS","ADANIPORTS.NS",
    "COALINDIA.NS","TECHM.NS","HDFCLIFE.NS","CIPLA.NS","DRREDDY.NS",
    "GRASIM.NS","DIVISLAB.NS","BPCL.NS","HEROMOTOCO.NS","INDUSINDBK.NS",
    "SBILIFE.NS","BRITANNIA.NS","EICHERMOT.NS","HINDALCO.NS","APOLLOHOSP.NS",
    "TATACONSUM.NS","BAJAJ-AUTO.NS","SHRIRAMFIN.NS","BEL.NS","TRENT.NS"
  ],
  "NIFTY BANK": [
    "HDFCBANK.NS","ICICIBANK.NS","SBIN.NS","KOTAKBANK.NS","AXISBANK.NS",
    "INDUSINDBK.NS","BANKBARODA.NS","PNB.NS","FEDERALBNK.NS","IDFCFIRSTB.NS",
    "BANDHANBNK.NS","AUBANK.NS"
  ],
  "NIFTY IT": [
    "TCS.NS","INFY.NS","HCLTECH.NS","WIPRO.NS","TECHM.NS",
    "LTIM.NS","PERSISTENT.NS","COFORGE.NS","MPHASIS.NS","LTTS.NS"
  ],
  "NIFTY AUTO": [
    "TATAMOTORS.NS","M&M.NS","MARUTI.NS","BAJAJ-AUTO.NS","HEROMOTOCO.NS",
    "EICHERMOT.NS","ASHOKLEY.NS","BALKRISIND.NS","BHARATFORG.NS","BOSCHLTD.NS",
    "MOTHERSON.NS","TVSMOTOR.NS","MRF.NS","EXIDEIND.NS","TIINDIA.NS"
  ],
  "NIFTY PHARMA": [
    "SUNPHARMA.NS","DRREDDY.NS","CIPLA.NS","DIVISLAB.NS","APOLLOHOSP.NS",
    "LUPIN.NS","AUROPHARMA.NS","TORNTPHARM.NS","ALKEM.NS","BIOCON.NS",
    "IPCALAB.NS","GLENMARK.NS","ABBOTINDIA.NS","LAURUSLABS.NS","ZYDUSLIFE.NS"
  ],
  "NIFTY MIDCAP 50": [
    "POLYCAB.NS","PIIND.NS","MUTHOOTFIN.NS","ASTRAL.NS","VOLTAS.NS",
    "JUBLFOOD.NS","AUROPHARMA.NS","PAGEIND.NS","OBEROI.NS","LICHSGFIN.NS",
    "CUMMINSIND.NS","MFSL.NS","ESCORTS.NS","ATUL.NS","COROMANDEL.NS",
    "IDFCFIRSTB.NS","NAVINFLUOR.NS","PETRONET.NS","PRESTIGE.NS","PEL.NS"
  ],
};

function httpsGet(url, headers = {}, redirectCount = 0) {
  return new Promise((resolve, reject) => {
    if (redirectCount > 5) return reject(new Error("Too many redirects"));
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
      if ([301, 302, 307, 308].includes(res.statusCode) && res.headers.location) {
        const loc = res.headers.location.startsWith("http")
          ? res.headers.location
          : `https://${parsed.hostname}${res.headers.location}`;
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

// ══════════════════════════════════════════
// SOURCE 1: NSE Direct
// ══════════════════════════════════════════

function parseCookies(res) {
  const setCookies = res.headers["set-cookie"];
  if (!setCookies || setCookies.length === 0) return null;
  return setCookies.map((c) => c.split(";")[0]).join("; ");
}

async function refreshCookies(force = false) {
  const now = Date.now();
  if (!force && now - lastCookieRefresh < COOKIE_TTL && sessionCookies) return true;

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
    } catch (err) {
      console.log(`[NSE] Failed ${url}: ${err.message}`);
    }
  }
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

async function tryNSEDirect(index) {
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      const gotCookies = await refreshCookies(attempt > 1);
      if (!gotCookies) continue;

      if (attempt > 1) await new Promise((r) => setTimeout(r, 500));
      const result = await fetchFromNSE(index);
      nseDirectWorks = true;
      return result;
    } catch (err) {
      console.error(`[NSE Direct] Attempt ${attempt}/2 failed: ${err.message}`);
      if (err.message.startsWith("AUTH_FAIL")) {
        sessionCookies = "";
        lastCookieRefresh = 0;
      }
    }
  }
  nseDirectWorks = false;
  return null;
}

// ══════════════════════════════════════════
// SOURCE 2: Yahoo Finance (fallback)
// ══════════════════════════════════════════

let yahooCrumb = "";
let yahooCookies = "";

async function getYahooCrumb() {
  if (yahooCrumb && yahooCookies) return true;
  try {
    // Step 1: Get cookies from Yahoo Finance
    const page = await httpsGet("https://finance.yahoo.com/quote/RELIANCE.NS/", {
      Accept: "text/html",
    });
    const cookies = parseCookies(page);
    if (cookies) yahooCookies = cookies;

    // Step 2: Get crumb
    const crumbRes = await httpsGet("https://query2.finance.yahoo.com/v1/test/getcrumb", {
      Accept: "text/plain",
      Cookie: yahooCookies,
    });
    if (crumbRes.status === 200 && crumbRes.body && crumbRes.body.length < 50) {
      yahooCrumb = crumbRes.body.trim();
      console.log("[Yahoo] Got crumb:", yahooCrumb);
      return true;
    }
  } catch (err) {
    console.error("[Yahoo] Crumb fetch failed:", err.message);
  }
  return false;
}

async function fetchFromYahoo(index) {
  const symbols = INDEX_YAHOO_SYMBOLS[index];
  if (!symbols) throw new Error(`No Yahoo mapping for index: ${index}`);

  // Try with crumb first
  const hasCrumb = await getYahooCrumb();

  const symbolList = symbols.join(",");

  // Try v7 with crumb, then v6, then without crumb
  const urls = [];
  if (hasCrumb) {
    urls.push(`https://query2.finance.yahoo.com/v7/finance/quote?symbols=${encodeURIComponent(symbolList)}&crumb=${encodeURIComponent(yahooCrumb)}`);
  }
  urls.push(`https://query1.finance.yahoo.com/v7/finance/quote?symbols=${encodeURIComponent(symbolList)}`);
  urls.push(`https://query2.finance.yahoo.com/v7/finance/quote?symbols=${encodeURIComponent(symbolList)}`);

  let lastStatus = 0;
  for (const url of urls) {
    try {
      const response = await httpsGet(url, {
        Accept: "application/json",
        Cookie: yahooCookies || "",
      });
      lastStatus = response.status;

      if (response.status !== 200) continue;

      const json = JSON.parse(response.body);
      const quotes = json.quoteResponse?.result;
      if (!quotes || quotes.length === 0) continue;

      const data = quotes.map((q) => ({
        symbol: q.symbol.replace(".NS", ""),
        lastPrice: q.regularMarketPrice,
        change: q.regularMarketChange,
        pChange: q.regularMarketChangePercent,
        previousClose: q.regularMarketPreviousClose,
        open: q.regularMarketOpen,
        dayHigh: q.regularMarketDayHigh,
        dayLow: q.regularMarketDayLow,
        totalTradedVolume: q.regularMarketVolume,
        meta: { companyName: q.shortName },
      }));

      console.log(`[Yahoo] Fetched ${data.length} stocks for ${index}`);
      return { name: index, data, _source: "yahoo" };
    } catch (err) {
      console.log(`[Yahoo] URL failed: ${err.message}`);
    }
  }

  // Reset crumb on failure
  yahooCrumb = "";
  yahooCookies = "";
  throw new Error(`Yahoo Finance failed (last status: ${lastStatus})`);
}

// ══════════════════════════════════════════
// SOURCE 3: Google Finance scrape (last resort)
// ══════════════════════════════════════════

const INDEX_GOOGLE_SYMBOLS = {
  "NIFTY 50": [
    "RELIANCE","TCS","HDFCBANK","INFY","ICICIBANK","HINDUNILVR","BHARTIARTL",
    "SBIN","BAJFINANCE","ITC","KOTAKBANK","LT","HCLTECH","AXISBANK",
    "ASIANPAINT","MARUTI","SUNPHARMA","TITAN","WIPRO","TATAMOTORS",
    "NTPC","POWERGRID","M&M","TATASTEEL","ONGC","JSWSTEEL","ADANIPORTS",
    "COALINDIA","TECHM","CIPLA","DRREDDY","HINDALCO","BAJAJ-AUTO","BEL","TRENT"
  ],
  "NIFTY BANK": [
    "HDFCBANK","ICICIBANK","SBIN","KOTAKBANK","AXISBANK","INDUSINDBK",
    "BANKBARODA","PNB","FEDERALBNK","IDFCFIRSTB","BANDHANBNK","AUBANK"
  ],
  "NIFTY IT": [
    "TCS","INFY","HCLTECH","WIPRO","TECHM","LTIM","PERSISTENT","COFORGE","MPHASIS","LTTS"
  ],
  "NIFTY AUTO": [
    "TATAMOTORS","M&M","MARUTI","BAJAJ-AUTO","HEROMOTOCO","EICHERMOT",
    "ASHOKLEY","TVSMOTOR","MRF","MOTHERSON"
  ],
  "NIFTY PHARMA": [
    "SUNPHARMA","DRREDDY","CIPLA","DIVISLAB","APOLLOHOSP","LUPIN",
    "AUROPHARMA","TORNTPHARM","ALKEM","BIOCON"
  ],
  "NIFTY MIDCAP 50": [
    "POLYCAB","PIIND","MUTHOOTFIN","ASTRAL","VOLTAS","JUBLFOOD",
    "AUROPHARMA","PAGEIND","CUMMINSIND","ESCORTS"
  ],
};

async function fetchSingleGoogle(symbol) {
  const url = `https://www.google.com/finance/quote/${encodeURIComponent(symbol)}:NSE`;
  try {
    const res = await httpsGet(url, { Accept: "text/html" });
    if (res.status !== 200) return null;
    const html = res.body;

    // Extract current price
    const priceMatch = html.match(/data-last-price="([^"]+)"/);
    if (!priceMatch) return null;
    const lastPrice = parseFloat(priceMatch[1]);

    // Extract previous close from "Previous close" section: ₹1,384.80
    let previousClose = lastPrice;
    const prevIdx = html.indexOf("Previous close");
    if (prevIdx > -1) {
      const snippet = html.substring(prevIdx, prevIdx + 300);
      const prevMatch = snippet.match(/₹([\d,]+\.?\d*)/);
      if (prevMatch) {
        previousClose = parseFloat(prevMatch[1].replace(/,/g, ""));
      }
    }

    const change = lastPrice - previousClose;
    const pChange = previousClose ? (change / previousClose) * 100 : 0;

    return {
      symbol,
      lastPrice,
      change: Math.round(change * 100) / 100,
      pChange: Math.round(pChange * 100) / 100,
      previousClose,
      totalTradedVolume: 0,
    };
  } catch {
    return null;
  }
}

async function fetchFromGoogle(index) {
  const symbols = INDEX_GOOGLE_SYMBOLS[index] || INDEX_GOOGLE_SYMBOLS["NIFTY 50"];
  // Fetch in batches of 5 to avoid rate limiting
  const results = [];
  for (let i = 0; i < symbols.length; i += 5) {
    const batch = symbols.slice(i, i + 5);
    const batchResults = await Promise.all(batch.map(fetchSingleGoogle));
    results.push(...batchResults.filter(Boolean));
    if (i + 5 < symbols.length) await new Promise((r) => setTimeout(r, 200));
  }

  if (results.length === 0) throw new Error("Google Finance returned no data");
  console.log(`[Google] Fetched ${results.length} stocks for ${index}`);
  return { name: index, data: results, _source: "google" };
}

// ══════════════════════════════════════════
// API ENDPOINT — tries sources in order
// ══════════════════════════════════════════

app.get("/api/gainers-losers", async (req, res) => {
  const index = req.query.index || "NIFTY 50";

  // Return cache if fresh
  const cached = cache[index];
  if (cached && Date.now() - cached.timestamp < CACHE_TTL) {
    return res.json(cached.data);
  }

  // Source 1: NSE Direct (skip if it already failed recently)
  if (nseDirectWorks) {
    const nseData = await tryNSEDirect(index);
    if (nseData) {
      nseData._source = "nse";
      cache[index] = { data: nseData, timestamp: Date.now() };
      return res.json(nseData);
    }
  }

  // Source 2: Yahoo Finance
  try {
    console.log(`[Fallback] Trying Yahoo Finance for ${index}...`);
    const yahooData = await fetchFromYahoo(index);
    cache[index] = { data: yahooData, timestamp: Date.now() };
    return res.json(yahooData);
  } catch (err) {
    console.error(`[Yahoo] Failed: ${err.message}`);
  }

  // Source 3: Google Finance (slowest, last resort)
  try {
    console.log(`[Fallback] Trying Google Finance for ${index}...`);
    const googleData = await fetchFromGoogle(index);
    cache[index] = { data: googleData, timestamp: Date.now() };
    return res.json(googleData);
  } catch (err) {
    console.error(`[Google] Failed: ${err.message}`);
  }

  // All sources failed — return stale cache if available
  if (cached) {
    console.log(`[Cache] Returning stale data for ${index}`);
    return res.json({ ...cached.data, _stale: true });
  }

  res.status(502).json({
    error: "All data sources failed (NSE, Yahoo, Google). Please try again.",
  });
});

// Pre-warm
refreshCookies().then((ok) => {
  if (ok) console.log("[NSE] Initial cookie warmup done");
  else {
    console.log("[NSE] Direct access blocked — will use Yahoo/Google fallback");
    nseDirectWorks = false;
  }
});

app.listen(PORT, () => {
  console.log(`NSE Scanner running → http://localhost:${PORT}`);
});
