import crypto from "node:crypto";
import fs from "node:fs/promises";
import { createWriteStream } from "node:fs";
import http from "node:http";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import { fileURLToPath } from "node:url";
import { gunzipSync } from "node:zlib";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, "..");
const publicDir = path.join(rootDir, "public");
const dataDir = path.join(rootDir, "data");
const statePath = path.join(dataDir, "state.json");
const salesStatePath = path.join(dataDir, "sales-state.json");
const logPath = path.join(dataDir, "dashboard.log");
const envPath = path.join(rootDir, ".env");
const apiBase = "https://api.appstoreconnect.apple.com";

const reportModes = (process.env.ASC_REPORT_MODES || "ONGOING").split(",").map((mode) => mode.trim()).filter(Boolean);
const requestDelayMs = Number(process.env.ASC_SYNC_DELAY_MS || 800);
const defaultReportNames = [
  "App Downloads Standard",
  "App Store Discovery and Engagement Standard"
];
const allowedReportNames = new Set(
  (process.env.ASC_REPORT_NAMES || defaultReportNames.join("|"))
    .split("|")
    .map((name) => name.trim())
    .filter(Boolean)
);
const analyticsInstanceLimit = Number(process.env.ASC_ANALYTICS_INSTANCE_LIMIT || 2);
const defaultUsdRates = {
  USD: 1,
  EUR: 1.1626,
  JPY: 0.0063,
  CLP: 0.001121
};
const syncStatus = {
  running: false,
  startedAt: null,
  finishedAt: null,
  message: "Idle",
  error: null
};
const salesSyncStatus = {
  running: false,
  startedAt: null,
  finishedAt: null,
  message: "Idle",
  error: null
};

async function log(message) {
  const line = `[${new Date().toISOString()}] ${message}\n`;
  await fs.mkdir(dataDir, { recursive: true });
  await fs.appendFile(logPath, line);
  console.log(message);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function usdRates() {
  const rates = { ...defaultUsdRates };
  for (const pair of (process.env.ASC_USD_RATES || "").split(",")) {
    const [currency, value] = pair.split(":").map((part) => part?.trim());
    const rate = Number(value);
    if (currency && Number.isFinite(rate) && rate > 0) rates[currency.toUpperCase()] = rate;
  }
  return rates;
}

function pruneAnalyticsState(state) {
  state.reports = (state.reports || []).filter(isEssentialReport);
  const reportIds = new Set(state.reports.map((report) => report.id));
  state.instances = (state.instances || []).filter((instance) => reportIds.has(instance.reportId) || allowedReportNames.has(instance.reportName));
  state.segments = (state.segments || []).filter((segment) => reportIds.has(segment.reportId) || allowedReportNames.has(segment.reportName));
  state.rows = (state.rows || []).filter((row) => allowedReportNames.has(row.reportName));
  return state;
}

function convertBucketToUsd(bucket, rates) {
  let total = 0;
  const missing = [];
  for (const [currency, amount] of Object.entries(bucket || {})) {
    const rate = rates[currency];
    if (!rate) {
      missing.push(currency);
      continue;
    }
    total += Number(amount || 0) * rate;
  }
  return { total, missing };
}

function loadEnvFile() {
  return fs
    .readFile(envPath, "utf8")
    .then((contents) => {
      for (const line of contents.split(/\r?\n/)) {
        const match = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
        if (!match || process.env[match[1]]) continue;
        process.env[match[1]] = match[2].replace(/^['"]|['"]$/g, "");
      }
    })
    .catch(() => {});
}

async function readEnvValues() {
  const values = {};
  try {
    const contents = await fs.readFile(envPath, "utf8");
    for (const line of contents.split(/\r?\n/)) {
      const match = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
      if (match) values[match[1]] = match[2].replace(/^['"]|['"]$/g, "");
    }
  } catch {}
  return values;
}

function masked(value) {
  if (!value) return "";
  if (value.length <= 6) return "••••";
  return `••••${value.slice(-4)}`;
}

function serializeEnvValue(value) {
  const text = String(value ?? "").trim();
  if (!text) return "";
  if (/[\s#"'\\]/.test(text)) return JSON.stringify(text);
  return text;
}

async function writeEnvValues(updates) {
  const current = await readEnvValues();
  const allowed = [
    "ASC_ISSUER_ID",
    "ASC_KEY_ID",
    "ASC_PRIVATE_KEY_PATH",
    "ASC_PRIVATE_KEY",
    "ASC_VENDOR_NUMBER",
    "ASC_SALES_DAYS",
    "ASC_USD_RATES",
    "ASC_ANALYTICS_INSTANCE_LIMIT"
  ];

  for (const key of allowed) {
    if (Object.prototype.hasOwnProperty.call(updates, key) && String(updates[key] ?? "").trim()) {
      current[key] = String(updates[key]).trim();
      process.env[key] = current[key];
    }
  }

  const lines = allowed
    .filter((key) => current[key])
    .map((key) => `${key}=${serializeEnvValue(current[key])}`);
  await fs.writeFile(envPath, `${lines.join("\n")}\n`);
  return current;
}

function publicSettings(values) {
  return {
    ASC_ISSUER_ID: masked(values.ASC_ISSUER_ID || process.env.ASC_ISSUER_ID),
    ASC_KEY_ID: masked(values.ASC_KEY_ID || process.env.ASC_KEY_ID),
    ASC_PRIVATE_KEY_PATH: values.ASC_PRIVATE_KEY_PATH || process.env.ASC_PRIVATE_KEY_PATH || "",
    ASC_PRIVATE_KEY: values.ASC_PRIVATE_KEY || process.env.ASC_PRIVATE_KEY ? "configured" : "",
    ASC_VENDOR_NUMBER: masked(values.ASC_VENDOR_NUMBER || process.env.ASC_VENDOR_NUMBER),
    ASC_SALES_DAYS: values.ASC_SALES_DAYS || process.env.ASC_SALES_DAYS || "30",
    ASC_USD_RATES: values.ASC_USD_RATES || process.env.ASC_USD_RATES || "",
    ASC_ANALYTICS_INSTANCE_LIMIT: values.ASC_ANALYTICS_INSTANCE_LIMIT || process.env.ASC_ANALYTICS_INSTANCE_LIMIT || "2"
  };
}

function base64Url(input) {
  return Buffer.from(input).toString("base64url");
}

async function createJwt() {
  const issuerId = process.env.ASC_ISSUER_ID;
  const keyId = process.env.ASC_KEY_ID;
  const privateKeyPath = process.env.ASC_PRIVATE_KEY_PATH;
  const inlinePrivateKey = process.env.ASC_PRIVATE_KEY?.replace(/\\n/g, "\n");

  if (!issuerId || !keyId || (!privateKeyPath && !inlinePrivateKey)) {
    throw new Error("Missing ASC_ISSUER_ID, ASC_KEY_ID, or private key configuration.");
  }

  const privateKey = inlinePrivateKey || (await fs.readFile(path.resolve(rootDir, privateKeyPath), "utf8"));
  const now = Math.floor(Date.now() / 1000);
  const header = { alg: "ES256", kid: keyId, typ: "JWT" };
  const payload = {
    iss: issuerId,
    iat: now,
    exp: now + 20 * 60,
    aud: "appstoreconnect-v1"
  };
  const signingInput = `${base64Url(JSON.stringify(header))}.${base64Url(JSON.stringify(payload))}`;
  const signature = crypto.sign("sha256", Buffer.from(signingInput), {
    key: privateKey,
    dsaEncoding: "ieee-p1363"
  });
  return `${signingInput}.${signature.toString("base64url")}`;
}

async function ascFetch(url, options = {}) {
  await sleep(requestDelayMs);
  const token = await createJwt();
  const requestUrl = url.startsWith("http") ? url : `${apiBase}${url}`;
  let response;

  for (let attempt = 0; attempt < 6; attempt += 1) {
    response = await fetch(requestUrl, {
      ...options,
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
        ...(options.headers || {})
      }
    });

    if (response.status !== 429) break;
    const retryAfter = Number(response.headers.get("retry-after") || 0);
    const waitMs = retryAfter > 0 ? retryAfter * 1000 : Math.min(45000, 3000 * 2 ** attempt);
    syncStatus.message = `Rate limited by Apple. Waiting ${Math.round(waitMs / 1000)}s before retry.`;
    await log(syncStatus.message);
    await sleep(waitMs);
  }

  if (!response.ok) {
    const body = await response.text();
    if (response.status === 401) {
      await log("Apple returned 401. Check that the API key is active, issuer ID/key ID match, and the private key file belongs to that key.");
    }
    throw new Error(`App Store Connect API ${response.status}: ${body}`);
  }

  if (response.status === 204) return null;
  return response.json();
}

async function ascDownload(url, options = {}, status = syncStatus) {
  await sleep(requestDelayMs);
  const token = await createJwt();
  const requestUrl = url.startsWith("http") ? url : `${apiBase}${url}`;
  let response;

  for (let attempt = 0; attempt < 6; attempt += 1) {
    response = await fetch(requestUrl, {
      ...options,
      headers: {
        Authorization: `Bearer ${token}`,
        ...(options.headers || {})
      }
    });

    if (response.status !== 429) break;
    const retryAfter = Number(response.headers.get("retry-after") || 0);
    const waitMs = retryAfter > 0 ? retryAfter * 1000 : Math.min(45000, 3000 * 2 ** attempt);
    status.message = `Rate limited by Apple. Waiting ${Math.round(waitMs / 1000)}s before retry.`;
    await log(status.message);
    await sleep(waitMs);
  }

  if (!response.ok) {
    const body = await response.text();
    if (response.status === 401) {
      await log("Apple returned 401 for Sales & Trends. Use a Team API key with Sales and Reports, Finance, Admin, or Account Holder access.");
    }
    throw new Error(`App Store Connect API ${response.status}: ${body}`);
  }

  return Buffer.from(await response.arrayBuffer());
}

async function readState() {
  try {
    const state = JSON.parse(await fs.readFile(statePath, "utf8"));
    state.apps ||= [];
    state.requests ||= [];
    state.reports ||= [];
    state.instances ||= [];
    state.segments ||= [];
    state.rows ||= [];
    pruneAnalyticsState(state);
    state.summary = summarize(state.rows, state);
    return state;
  } catch {
    return {
      apps: [],
      requests: [],
      reports: [],
      instances: [],
      segments: [],
      ingestedAt: null,
      rows: [],
      summary: {}
    };
  }
}

async function writeState(state) {
  await fs.mkdir(dataDir, { recursive: true });
  await fs.writeFile(statePath, JSON.stringify(state, null, 2));
}

async function readSalesState() {
  try {
    const state = JSON.parse(await fs.readFile(salesStatePath, "utf8"));
    state.reports ||= [];
    state.rows ||= [];
    state.summary = summarizeSalesRows(state.rows, state.reports);
    return state;
  } catch {
    return {
      ingestedAt: null,
      reports: [],
      rows: [],
      summary: {}
    };
  }
}

async function writeSalesState(state) {
  await fs.mkdir(dataDir, { recursive: true });
  await fs.writeFile(salesStatePath, JSON.stringify(state, null, 2));
}

function mergeById(existing, incoming) {
  const byId = new Map(existing.map((item) => [item.id, item]));
  for (const item of incoming) byId.set(item.id, { ...byId.get(item.id), ...item });
  return [...byId.values()];
}

async function collectPaginated(firstUrl) {
  const rows = [];
  let url = firstUrl;
  while (url) {
    const page = await ascFetch(url);
    rows.push(...(page.data || []));
    url = page.links?.next || null;
  }
  return rows;
}

async function listApps() {
  await log("Fetching apps");
  const apps = await collectPaginated("/v1/apps?limit=200");
  return apps.map((app) => ({
    id: app.id,
    name: app.attributes?.name || "Untitled app",
    bundleId: app.attributes?.bundleId || "",
    sku: app.attributes?.sku || "",
    primaryLocale: app.attributes?.primaryLocale || ""
  }));
}

async function createReportRequest(appId, accessType) {
  return ascFetch("/v1/analyticsReportRequests", {
    method: "POST",
    body: JSON.stringify({
      data: {
        type: "analyticsReportRequests",
        attributes: { accessType },
        relationships: {
          app: {
            data: { type: "apps", id: appId }
          }
        }
      }
    })
  });
}

async function ensureReportRequests(appId) {
  syncStatus.message = `Checking report requests for app ${appId}`;
  await log(syncStatus.message);
  let requests = await collectPaginated(`/v1/apps/${appId}/analyticsReportRequests?limit=200`);
  const existingModes = new Set(requests.map((request) => request.attributes?.accessType));
  for (const mode of reportModes) {
    if (!existingModes.has(mode)) {
      try {
        const created = await createReportRequest(appId, mode);
        await log(`Created ${mode} report request for app ${appId}`);
        requests.push(created.data);
      } catch (error) {
        if (!String(error.message).includes("409")) throw error;
      }
    }
  }
  return requests.map(normalizeRecord);
}

function normalizeRecord(record) {
  return {
    id: record.id,
    type: record.type,
    attributes: record.attributes || {},
    relationships: record.relationships || {}
  };
}

function isEssentialReport(report) {
  return allowedReportNames.has(report.attributes?.name || "");
}

async function collectReportsForRequest(requestId) {
  syncStatus.message = `Fetching reports for request ${requestId}`;
  await log(syncStatus.message);
  return (await collectPaginated(`/v1/analyticsReportRequests/${requestId}/reports?limit=200`)).map(normalizeRecord);
}

async function collectInstancesForReport(reportId) {
  syncStatus.message = `Fetching instances for report ${reportId}`;
  await log(syncStatus.message);
  const sorted = (await collectPaginated(`/v1/analyticsReports/${reportId}/instances?limit=200`))
    .map(normalizeRecord)
    .sort((left, right) => {
      const leftKey = left.attributes?.processingDate || left.attributes?.startDate || left.attributes?.granularity || left.id;
      const rightKey = right.attributes?.processingDate || right.attributes?.startDate || right.attributes?.granularity || right.id;
      return String(rightKey).localeCompare(String(leftKey));
    });
  const seenGranularities = new Set();
  const instances = sorted
    .filter((instance) => {
      const granularity = instance.attributes?.granularity || instance.id;
      if (seenGranularities.has(granularity)) return false;
      seenGranularities.add(granularity);
      return true;
    })
    .slice(0, Math.max(1, analyticsInstanceLimit));
  await log(`Report ${reportId}: ${instances.length} downloadable instance(s)`);
  return instances;
}

async function collectSegmentsForInstance(instanceId) {
  syncStatus.message = `Fetching segments for instance ${instanceId}`;
  await log(syncStatus.message);
  return (await collectPaginated(`/v1/analyticsReportInstances/${instanceId}/segments?limit=200`)).map(normalizeRecord);
}

function safeName(value) {
  return String(value || "unknown").replace(/[^a-z0-9._-]+/gi, "_").slice(0, 120);
}

async function downloadSegment(segment, context) {
  const url = segment.attributes?.url;
  if (!url) return null;
  const fileName = `${safeName(context.appName)}_${safeName(context.reportName)}_${safeName(context.instanceName)}_${segment.id}.tsv`;
  const outputPath = path.join(dataDir, "reports", fileName);
  await fs.mkdir(path.dirname(outputPath), { recursive: true });

  syncStatus.message = `Downloading ${context.reportName} segment ${segment.id}`;
  await log(syncStatus.message);
  const response = await fetch(url);
  if (!response.ok || !response.body) throw new Error(`Segment download ${response.status}: ${segment.id}`);
  const source = response.headers.get("content-encoding") === "gzip" || url.includes(".gz")
    ? response.body.pipeThrough(new DecompressionStream("gzip"))
    : response.body;
  await pipeline(source, createWriteStream(outputPath));
  return outputPath;
}

async function parseTsv(filePath, context, segment) {
  syncStatus.message = `Parsing ${context.reportName} segment ${segment.id}`;
  await log(syncStatus.message);
  const text = await fs.readFile(filePath, "utf8");
  const lines = text.trim().split(/\r?\n/);
  if (lines.length < 2) return [];
  const headers = lines[0].split("\t");
  return lines.slice(1).map((line) => {
    const values = line.split("\t");
    const data = Object.fromEntries(headers.map((header, index) => [header, values[index] ?? ""]));
    return {
      id: crypto.createHash("sha1").update(`${segment.id}:${line}`).digest("hex"),
      appId: context.appId,
      appName: context.appName,
      reportId: context.reportId,
      reportName: context.reportName,
      category: context.category,
      instanceId: context.instanceId,
      instanceName: context.instanceName,
      segmentId: segment.id,
      data
    };
  });
}

function numeric(value) {
  if (value === undefined || value === null || value === "") return 0;
  const parsed = Number(String(value).replace(/[$,%\s,]/g, ""));
  return Number.isFinite(parsed) ? parsed : 0;
}

function isoDate(date) {
  return date.toISOString().slice(0, 10);
}

function recentReportDates(days) {
  const dates = [];
  const today = new Date();
  for (let offset = 1; offset <= days; offset += 1) {
    const date = new Date(today);
    date.setDate(today.getDate() - offset);
    dates.push(isoDate(date));
  }
  return dates;
}

function parseTabDelimited(text) {
  const lines = text.trim().split(/\r?\n/).filter(Boolean);
  if (lines.length < 2) return [];
  const headers = lines[0].split("\t").map((header) => header.trim());
  return lines.slice(1).map((line) => {
    const values = line.split("\t");
    return Object.fromEntries(headers.map((header, index) => [header, values[index] ?? ""]));
  });
}

async function downloadSalesReport({ vendorNumber, reportDate, reportType = "SALES", reportSubType = "SUMMARY", frequency = "DAILY", version = "1_0" }) {
  const params = new URLSearchParams({
    "filter[frequency]": frequency,
    "filter[reportSubType]": reportSubType,
    "filter[reportType]": reportType,
    "filter[vendorNumber]": vendorNumber,
    "filter[version]": version
  });
  if (reportDate) params.set("filter[reportDate]", reportDate);

  salesSyncStatus.message = `Downloading ${reportType} ${reportSubType} ${frequency} ${reportDate || "latest"}`;
  await log(salesSyncStatus.message);

  const gzBuffer = await ascDownload(`/v1/salesReports?${params}`, {}, salesSyncStatus);
  const text = gunzipSync(gzBuffer).toString("utf8");
  const reportDir = path.join(dataDir, "sales-reports");
  await fs.mkdir(reportDir, { recursive: true });
  const filePath = path.join(reportDir, `${reportType}_${reportSubType}_${frequency}_${reportDate || "latest"}.txt`);
  await fs.writeFile(filePath, text);
  return {
    id: `${reportType}:${reportSubType}:${frequency}:${reportDate || "latest"}`,
    reportType,
    reportSubType,
    frequency,
    reportDate: reportDate || "latest",
    filePath,
    rows: parseTabDelimited(text)
  };
}

function summarizeSalesRows(rows, reports) {
  const appUnitProductTypes = new Set(["1", "1F", "1T", "1E", "1EP", "1EU", "F1"]);
  const rates = usdRates();
  const byApp = {};
  const byDate = {};
  const byCountry = {};
  const byProductType = {};
  const proceedsByCurrency = {};
  const customerPriceByCurrency = {};
  let units = 0;
  let allUnits = 0;
  let proceeds = 0;
  let customerPrice = 0;

  const addCurrencyAmount = (bucket, currency, amount) => {
    if (!currency || !amount) return;
    bucket[currency] = (bucket[currency] || 0) + amount;
  };

  for (const row of rows) {
    const app = row.Title || row["Parent Title"] || row.SKU || row["Apple Identifier"] || "Unknown";
    const date = row["Begin Date"] || row["End Date"] || row.reportDate || "Unknown";
    const country = row["Country Code"] || "Unknown";
    const productType = row["Product Type Identifier"] || "Unknown";
    const rowUnits = numeric(row.Units);
    const rowProceeds = numeric(row["Developer Proceeds"]) * rowUnits;
    const rowCustomerPrice = numeric(row["Customer Price"]) * rowUnits;
    const proceedsCurrency = row["Currency of Proceeds"];
    const customerCurrency = row["Customer Currency"];
    const isAppUnit = appUnitProductTypes.has(productType);

    allUnits += rowUnits;
    if (isAppUnit) units += rowUnits;
    proceeds += rowProceeds;
    customerPrice += rowCustomerPrice;
    addCurrencyAmount(proceedsByCurrency, proceedsCurrency, rowProceeds);
    addCurrencyAmount(customerPriceByCurrency, customerCurrency, rowCustomerPrice);

    byApp[app] ||= { units: 0, allUnits: 0, updates: 0, redownloads: 0, proceeds: 0, proceedsByCurrency: {}, customerPrice: 0, customerPriceByCurrency: {}, rows: 0 };
    byApp[app].allUnits += rowUnits;
    if (isAppUnit) byApp[app].units += rowUnits;
    if (/^7/.test(productType) || /^F7/.test(productType)) byApp[app].updates += rowUnits;
    if (/^3/.test(productType) || /^F3/.test(productType)) byApp[app].redownloads += rowUnits;
    byApp[app].proceeds += rowProceeds;
    byApp[app].customerPrice += rowCustomerPrice;
    addCurrencyAmount(byApp[app].proceedsByCurrency, proceedsCurrency, rowProceeds);
    addCurrencyAmount(byApp[app].customerPriceByCurrency, customerCurrency, rowCustomerPrice);
    byApp[app].rows += 1;

    byDate[date] ||= { units: 0, allUnits: 0, updates: 0, redownloads: 0, proceeds: 0, rows: 0 };
    byDate[date].allUnits += rowUnits;
    if (isAppUnit) byDate[date].units += rowUnits;
    if (/^7/.test(productType) || /^F7/.test(productType)) byDate[date].updates += rowUnits;
    if (/^3/.test(productType) || /^F3/.test(productType)) byDate[date].redownloads += rowUnits;
    byDate[date].proceeds += rowProceeds;
    byDate[date].rows += 1;

    if (isAppUnit) byCountry[country] = (byCountry[country] || 0) + rowUnits;
    byProductType[productType] = (byProductType[productType] || 0) + rowUnits;
  }

  const proceedsUsd = convertBucketToUsd(proceedsByCurrency, rates);
  const customerPriceUsd = convertBucketToUsd(customerPriceByCurrency, rates);
  for (const app of Object.values(byApp)) {
    app.proceedsUsd = convertBucketToUsd(app.proceedsByCurrency, rates);
    app.customerPriceUsd = convertBucketToUsd(app.customerPriceByCurrency, rates);
  }

  return {
    reportCount: reports.length,
    rowCount: rows.length,
    units,
    allUnits,
    proceeds,
    proceedsByCurrency,
    proceedsUsd,
    customerPrice,
    customerPriceByCurrency,
    customerPriceUsd,
    usdRates: rates,
    byApp,
    byDate,
    byCountry,
    byProductType
  };
}

async function syncSalesAndTrends() {
  if (salesSyncStatus.running) {
    throw new Error("A Sales & Trends sync is already running.");
  }

  const vendorNumber = process.env.ASC_VENDOR_NUMBER;
  if (!vendorNumber) {
    throw new Error("Missing ASC_VENDOR_NUMBER in .env. Find it in App Store Connect → Payments and Financial Reports, or Sales and Trends report settings.");
  }

  salesSyncStatus.running = true;
  salesSyncStatus.startedAt = new Date().toISOString();
  salesSyncStatus.finishedAt = null;
  salesSyncStatus.error = null;
  salesSyncStatus.message = "Starting Sales & Trends sync";
  await log(salesSyncStatus.message);

  const state = await readSalesState();
  const days = Number(process.env.ASC_SALES_DAYS || 30);
  const reportDates = recentReportDates(days);
  const reports = [];
  const rows = [];

  try {
    for (const reportDate of reportDates) {
      try {
        const report = await downloadSalesReport({ vendorNumber, reportDate });
        reports.push({ ...report, rows: undefined });
        rows.push(...report.rows.map((row) => ({ ...row, reportDate, reportId: report.id })));
        state.reports = mergeById(state.reports, reports);
        state.rows = mergeById(state.rows, rows.map((row) => ({
          id: crypto.createHash("sha1").update(`${row.reportId}:${JSON.stringify(row)}`).digest("hex"),
          ...row
        })));
        state.summary = summarizeSalesRows(state.rows, state.reports);
        await writeSalesState(state);
        await log(`${reportDate}: ${report.rows.length} Sales & Trends row(s)`);
      } catch (error) {
        if (String(error.message).includes("404") || String(error.message).includes("There were no sales")) {
          await log(`${reportDate}: no sales report available`);
          continue;
        }
        throw error;
      }
    }

    state.ingestedAt = new Date().toISOString();
    state.summary = summarizeSalesRows(state.rows, state.reports);
    await writeSalesState(state);
    salesSyncStatus.message = `Sales sync complete: ${state.rows.length} row(s), ${state.summary.units} unit(s)`;
    await log(salesSyncStatus.message);
    return state;
  } catch (error) {
    salesSyncStatus.error = error.message;
    salesSyncStatus.message = `Sales sync failed: ${error.message}`;
    await log(salesSyncStatus.message);
    throw error;
  } finally {
    salesSyncStatus.running = false;
    salesSyncStatus.finishedAt = new Date().toISOString();
  }
}

function summarize(rows, state, range = "all") {
  const newestInstances = new Map();
  for (const instance of state.instances || []) {
    const granularity = instance.attributes?.granularity || instance.instanceName || "UNKNOWN";
    const key = `${instance.appId || ""}:${instance.reportId || ""}:${granularity}`;
    const processingDate = instance.attributes?.processingDate || "";
    const current = newestInstances.get(key);
    if (!current || processingDate > current.processingDate) {
      newestInstances.set(key, { id: instance.id, processingDate });
    }
  }
  const newestInstanceIds = new Set([...newestInstances.values()].map((instance) => instance.id));
  const effectiveRows = newestInstanceIds.size
    ? rows.filter((row) => newestInstanceIds.has(row.instanceId))
    : rows;
  const datedRows = effectiveRows
    .map((row) => ({ row, date: String(row.data?.Date || "") }))
    .filter(({ date }) => /^\d{4}-\d{2}-\d{2}$/.test(date));
  const latestDate = datedRows.map(({ date }) => date).sort().at(-1) || null;
  const rangeDays = range === "7" ? 7 : range === "30" ? 30 : null;
  let rangeStart = null;
  if (latestDate && rangeDays) {
    const start = new Date(`${latestDate}T00:00:00`);
    start.setDate(start.getDate() - (rangeDays - 1));
    rangeStart = start.toISOString().slice(0, 10);
  }
  const rangedRows = rangeStart
    ? effectiveRows.filter((row) => String(row.data?.Date || "") >= rangeStart && String(row.data?.Date || "") <= latestDate)
    : effectiveRows;
  const metrics = {};
  const byReport = {};
  const byApp = {};
  const discoveredColumns = new Set();
  const analytics = {
    impressions: 0,
    productPageViews: 0,
    downloads: 0,
    conversionRate: 0,
    downloadCoverage: {
      appCount: 0,
      expectedAppCount: state.apps.length,
      complete: false
    },
    byApp: {}
  };
  const appsWithDownloadRows = new Set();

  for (const row of rangedRows) {
    byReport[row.reportName] = (byReport[row.reportName] || 0) + 1;
    byApp[row.appName] = (byApp[row.appName] || 0) + 1;
    const count = numeric(row.data.Counts);
    const impressions = row.reportName === "App Store Discovery and Engagement Standard"
      && row.data.Event === "Impression"
      ? count
      : 0;
    const productPageViews = row.reportName === "App Store Discovery and Engagement Standard"
      && row.data.Event === "Page view"
      && row.data["Page Type"] === "Product page"
      ? count
      : 0;
    const downloads = row.reportName === "App Downloads Standard"
      && row.data["Download Type"] === "First-time download"
      ? count
      : 0;
    if (row.reportName === "App Downloads Standard") appsWithDownloadRows.add(row.appName);
    analytics.impressions += impressions;
    analytics.productPageViews += productPageViews;
    analytics.downloads += downloads;
    analytics.byApp[row.appName] ||= { impressions: 0, productPageViews: 0, downloads: 0, downloadRows: 0, rows: 0 };
    analytics.byApp[row.appName].impressions += impressions;
    analytics.byApp[row.appName].productPageViews += productPageViews;
    analytics.byApp[row.appName].downloads += downloads;
    if (row.reportName === "App Downloads Standard") analytics.byApp[row.appName].downloadRows += 1;
    analytics.byApp[row.appName].rows += 1;
    for (const [key, value] of Object.entries(row.data)) {
      discoveredColumns.add(key);
      if (/counts|impression|download|install|session|proceed|sale|crash|view|revenue|unit|subscriber|conversion|retention/i.test(key)) {
        metrics[key] = (metrics[key] || 0) + numeric(value);
      }
    }
  }

  analytics.impressions = Math.max(0, analytics.impressions);
  analytics.productPageViews = Math.max(0, analytics.productPageViews);
  analytics.downloads = Math.max(0, analytics.downloads);
  analytics.downloadCoverage.appCount = appsWithDownloadRows.size;
  analytics.downloadCoverage.complete = state.apps.length > 0 && appsWithDownloadRows.size === state.apps.length;
  analytics.conversionRate = analytics.productPageViews ? analytics.downloads / analytics.productPageViews : 0;
  for (const app of Object.values(analytics.byApp)) {
    app.impressions = Math.max(0, app.impressions);
    app.productPageViews = Math.max(0, app.productPageViews);
    app.downloads = Math.max(0, app.downloads);
    app.conversionRate = app.productPageViews ? app.downloads / app.productPageViews : 0;
  }

  return {
    appCount: state.apps.length,
    requestCount: state.requests.length,
    reportCount: state.reports.length,
    instanceCount: state.instances.length,
    segmentCount: state.segments.length,
    rowCount: rangedRows.length,
    metrics,
    byReport,
    byApp,
    analytics,
    analyticsRange: {
      selection: range,
      startDate: rangeStart || datedRows.map(({ date }) => date).sort()[0] || null,
      endDate: latestDate
    },
    columns: [...discoveredColumns].sort()
  };
}

async function syncAll() {
  if (syncStatus.running) {
    throw new Error("A sync is already running.");
  }
  syncStatus.running = true;
  syncStatus.startedAt = new Date().toISOString();
  syncStatus.finishedAt = null;
  syncStatus.error = null;
  syncStatus.message = "Starting sync";
  await log(syncStatus.message);

  const state = await readState();
  state.requests = [];
  state.reports = [];
  state.instances = [];
  state.segments = [];
  state.rows = [];
  const newRequests = [];
  const newReports = [];
  const newInstances = [];
  const newSegments = [];
  const newRows = [];

  async function persistPartial() {
    state.requests = mergeById(state.requests, newRequests);
    state.reports = mergeById(state.reports, newReports);
    state.instances = mergeById(state.instances, newInstances);
    state.segments = mergeById(state.segments, newSegments);
    state.rows = mergeById(state.rows, newRows);
    state.summary = summarize(state.rows, state);
    await writeState(state);
  }

  try {
    state.apps = await listApps();
    await log(`Found ${state.apps.length} app(s)`);
    await persistPartial();

    for (const app of state.apps) {
      syncStatus.message = `Syncing ${app.name}`;
      await log(syncStatus.message);
      const requests = (await ensureReportRequests(app.id)).filter((request) => reportModes.includes(request.attributes?.accessType));
      newRequests.push(...requests.map((request) => ({ ...request, appId: app.id, appName: app.name })));
      await log(`${app.name}: ${requests.length} report request(s)`);
      await persistPartial();

      for (const request of requests) {
        const allReports = await collectReportsForRequest(request.id);
        const reports = allReports.filter(isEssentialReport);
        await log(`${app.name}: using ${reports.length} essential report(s), skipping ${allReports.length - reports.length} noisy report(s)`);
        newReports.push(...reports.map((report) => ({ ...report, appId: app.id, appName: app.name, requestId: request.id })));
        await persistPartial();

        for (const report of reports) {
          const reportName = report.attributes?.name || report.id;
          await log(`${app.name}: report ${reportName}`);
          const instances = await collectInstancesForReport(report.id);
          newInstances.push(...instances.map((instance) => ({ ...instance, appId: app.id, appName: app.name, reportId: report.id, reportName })));
          await persistPartial();

          for (const instance of instances) {
            const segments = await collectSegmentsForInstance(instance.id);
            await log(`${reportName}: ${segments.length} segment(s)`);

            for (const segment of segments) {
              const existing = state.segments.find((stored) => stored.id === segment.id && stored.localPath);
              const context = {
                appId: app.id,
                appName: app.name,
                reportId: report.id,
                reportName,
                category: report.attributes?.category || "Analytics",
                instanceId: instance.id,
                instanceName: instance.attributes?.granularity || instance.attributes?.processingDate || instance.id
              };
              const localPath = existing?.localPath || (await downloadSegment(segment, context));
              if (localPath) {
                segment.localPath = localPath;
                newRows.push(...(await parseTsv(localPath, context, segment)));
              }
              newSegments.push({ ...segment, appId: app.id, appName: app.name, reportId: report.id, instanceId: instance.id });
              await persistPartial();
            }
          }
        }
      }
      await persistPartial();
    }

    state.requests = mergeById(state.requests, newRequests);
    state.reports = mergeById(state.reports, newReports);
    state.instances = mergeById(state.instances, newInstances);
    state.segments = mergeById(state.segments, newSegments);
    state.rows = mergeById(state.rows, newRows);
    state.ingestedAt = new Date().toISOString();
    state.summary = summarize(state.rows, state);
    await writeState(state);
    syncStatus.message = `Sync complete: ${state.rows.length} row(s), ${state.segments.length} segment(s)`;
    await log(syncStatus.message);
    return state;
  } catch (error) {
    await persistPartial();
    syncStatus.error = error.message;
    syncStatus.message = `Sync failed: ${error.message}`;
    await log(syncStatus.message);
    throw error;
  } finally {
    syncStatus.running = false;
    syncStatus.finishedAt = new Date().toISOString();
  }
}

function sendJson(response, value, status = 200) {
  response.writeHead(status, { "Content-Type": "application/json" });
  response.end(JSON.stringify(value));
}

async function readBody(request) {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  return Buffer.concat(chunks).toString("utf8");
}

async function handleApi(request, response) {
  try {
    const url = new URL(request.url, "http://localhost");
    if (url.pathname === "/api/status") {
      const state = await readState();
      const salesState = await readSalesState();
      return sendJson(response, {
        configured: Boolean(process.env.ASC_ISSUER_ID && process.env.ASC_KEY_ID && (process.env.ASC_PRIVATE_KEY_PATH || process.env.ASC_PRIVATE_KEY)),
        salesConfigured: Boolean(process.env.ASC_VENDOR_NUMBER),
        ingestedAt: state.ingestedAt,
        salesIngestedAt: salesState.ingestedAt,
        sync: syncStatus,
        salesSync: salesSyncStatus,
        salesSummary: salesState.summary,
        summary: state.summary
      });
    }
    if (url.pathname === "/api/settings" && request.method === "GET") {
      return sendJson(response, publicSettings(await readEnvValues()));
    }
    if (url.pathname === "/api/analytics/summary" && request.method === "GET") {
      const state = await readState();
      const range = ["7", "30", "all"].includes(url.searchParams.get("range"))
        ? url.searchParams.get("range")
        : "30";
      return sendJson(response, summarize(state.rows, state, range));
    }
    if (url.pathname === "/api/settings" && request.method === "POST") {
      const body = JSON.parse(await readBody(request) || "{}");
      const values = await writeEnvValues(body);
      await log("Settings updated from local dashboard UI");
      return sendJson(response, { ok: true, settings: publicSettings(values) });
    }
    if (url.pathname === "/api/sales/sync" && request.method === "POST") {
      if (salesSyncStatus.running) {
        return sendJson(response, { ok: true, alreadyRunning: true, sync: salesSyncStatus });
      }
      syncSalesAndTrends().catch((error) => {
        log(`Background Sales & Trends sync error: ${error.message}`).catch(() => {});
      });
      return sendJson(response, { ok: true, started: true, sync: salesSyncStatus });
    }
    if (url.pathname === "/api/sales/rows") {
      const state = await readSalesState();
      const limit = Number(url.searchParams.get("limit") || 1000);
      return sendJson(response, state.rows.slice(0, limit));
    }
    if (url.pathname === "/api/sales/export.csv") {
      const state = await readSalesState();
      const columns = [...new Set(state.rows.flatMap((row) => Object.keys(row)))];
      const csv = [
        columns.join(","),
        ...state.rows.map((row) => columns.map((column) => JSON.stringify(row[column] ?? "")).join(","))
      ].join("\n");
      response.writeHead(200, { "Content-Type": "text/csv", "Content-Disposition": "attachment; filename=appstore-sales-trends.csv" });
      return response.end(csv);
    }
    if ((url.pathname === "/api/sync" || url.pathname === "/api/analytics/sync") && request.method === "POST") {
      if (syncStatus.running) {
        return sendJson(response, { ok: true, alreadyRunning: true, sync: syncStatus });
      }
      syncAll().catch((error) => {
        log(`Background sync error: ${error.message}`).catch(() => {});
      });
      return sendJson(response, { ok: true, started: true, sync: syncStatus });
    }
    if (url.pathname === "/api/logs") {
      let contents = "";
      try {
        contents = await fs.readFile(logPath, "utf8");
      } catch {
        contents = "No dashboard log yet.";
      }
      return sendJson(response, { logPath, lines: contents.trim().split(/\r?\n/).slice(-200) });
    }
    if (url.pathname === "/api/apps") return sendJson(response, (await readState()).apps);
    if (url.pathname === "/api/reports") {
      const state = await readState();
      return sendJson(response, {
        requests: state.requests,
        reports: state.reports,
        instances: state.instances,
        segments: state.segments
      });
    }
    if (url.pathname === "/api/rows") {
      const state = await readState();
      const report = url.searchParams.get("report");
      const app = url.searchParams.get("app");
      const limit = Number(url.searchParams.get("limit") || 500);
      const rows = state.rows
        .filter((row) => !report || row.reportName === report)
        .filter((row) => !app || row.appName === app)
        .slice(0, limit);
      return sendJson(response, rows);
    }
    if (url.pathname === "/api/export.csv") {
      const state = await readState();
      const columns = ["appName", "reportName", "category", "instanceName", ...state.summary.columns];
      const csv = [
        columns.join(","),
        ...state.rows.map((row) => columns.map((column) => JSON.stringify(row[column] ?? row.data[column] ?? "")).join(","))
      ].join("\n");
      response.writeHead(200, { "Content-Type": "text/csv", "Content-Disposition": "attachment; filename=appstore-reports.csv" });
      return response.end(csv);
    }
    sendJson(response, { error: "Not found" }, 404);
  } catch (error) {
    sendJson(response, { error: error.message }, 500);
  }
}

async function serveStatic(request, response) {
  const url = new URL(request.url, "http://localhost");
  const requested = url.pathname === "/" ? "/index.html" : url.pathname;
  const filePath = path.normalize(path.join(publicDir, requested));
  if (!filePath.startsWith(publicDir)) {
    response.writeHead(403);
    response.end("Forbidden");
    return;
  }
  try {
    const content = await fs.readFile(filePath);
    const ext = path.extname(filePath);
    const type = ext === ".css" ? "text/css" : ext === ".js" ? "text/javascript" : "text/html";
    response.writeHead(200, { "Content-Type": type });
    response.end(content);
  } catch {
    response.writeHead(404);
    response.end("Not found");
  }
}

await loadEnvFile();
await fs.mkdir(path.join(dataDir, "reports"), { recursive: true });
await log("Dashboard server booted");

const server = http.createServer((request, response) => {
  if (request.url.startsWith("/api/")) return handleApi(request, response);
  return serveStatic(request, response);
});

const port = Number(process.env.PORT || 4173);
const host = process.env.HOST || "127.0.0.1";
server.listen(port, host, () => {
  console.log(`App Store Reports dashboard running at http://${host}:${port}`);
});
