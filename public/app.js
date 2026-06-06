const state = {
  status: null,
  salesRows: [],
  settings: null,
  analyticsRange: "30",
  analyticsSummary: null
};

const $ = (selector) => document.querySelector(selector);
const format = (value) => new Intl.NumberFormat().format(Math.round(Number(value || 0)));
const usd = (value) => new Intl.NumberFormat(undefined, { style: "currency", currency: "USD" }).format(Number(value || 0));
const percent = (value) => new Intl.NumberFormat(undefined, { style: "percent", maximumFractionDigits: 1 }).format(Number(value || 0));
const dateFormatter = new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric", year: "numeric" });

function toast(message) {
  const element = $("#toast");
  element.textContent = message;
  element.classList.add("show");
  setTimeout(() => element.classList.remove("show"), 5200);
}

async function api(path, options) {
  const response = await fetch(path, options);
  const json = await response.json();
  if (!response.ok) throw new Error(json.error || "Request failed");
  return json;
}

function parseAppleDate(value) {
  if (!value) return null;
  const text = String(value).trim();
  const slash = text.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (slash) return new Date(Number(slash[3]), Number(slash[1]) - 1, Number(slash[2]));
  const iso = text.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
  if (iso) return new Date(Number(iso[1]), Number(iso[2]) - 1, Number(iso[3]));
  const parsed = new Date(text);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function salesCoverageLabel() {
  const dates = state.salesRows
    .map((row) => parseAppleDate(row.reportDate || row["Begin Date"] || row["Start Date"] || row["Report Date"]))
    .filter(Boolean)
    .sort((left, right) => left - right);
  if (!dates.length) return "No data yet";
  const end = dates[dates.length - 1];
  const start = new Date(end);
  start.setDate(start.getDate() - 29);
  return `${displayIsoDate(isoDateKey(start))} – ${displayIsoDate(isoDateKey(end))}`;
}

function moneyBucket(bucket) {
  const entries = Object.entries(bucket || {})
    .filter(([, value]) => Number(value))
    .sort(([left], [right]) => left.localeCompare(right));

  if (!entries.length) return "—";
  return entries.map(([currency, value]) => {
    try {
      return new Intl.NumberFormat(undefined, { style: "currency", currency }).format(Number(value));
    } catch {
      return `${currency} ${new Intl.NumberFormat(undefined, { maximumFractionDigits: 2 }).format(Number(value))}`;
    }
  }).join(" · ");
}

function displayAppleDate(value) {
  const match = String(value || "").match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (!match) return value;
  return `${match[2].padStart(2, "0")}/${match[1].padStart(2, "0")}/${match[3]}`;
}

function isoDateKey(date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function displayIsoDate(value) {
  const match = String(value || "").match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) return displayAppleDate(value);
  return `${match[3]}/${match[2]}/${match[1]}`;
}

function renderStatus() {
  const configured = state.status?.configured && state.status?.salesConfigured;
  const sync = state.status?.salesSync || {};
  const analyticsSync = state.status?.sync || {};
  const summary = state.status?.salesSummary || {};
  const button = $("#syncButton");
  const analyticsButton = $("#syncAnalyticsButton");

  $("#configDot").classList.toggle("ok", configured);
  $("#configLabel").textContent = configured ? "Sales credentials configured" : "Add ASC_VENDOR_NUMBER";
  $("#lastIngest").textContent = state.status?.salesIngestedAt ? new Date(state.status.salesIngestedAt).toLocaleString() : "Never";
  $("#coverageRange").textContent = salesCoverageLabel();
  $("#columnCount").textContent = format(summary.reportCount || 0);
  $("#rowCount").textContent = format(summary.rowCount || 0);
  $("#syncPulse").classList.toggle("running", Boolean(sync.running));
  $("#syncPulse").classList.toggle("error", Boolean(sync.error));
  $("#syncMessage").textContent = sync.message || "Idle";
  $("#syncDetail").textContent = sync.running
    ? `Started ${sync.startedAt ? new Date(sync.startedAt).toLocaleTimeString() : "now"}`
    : sync.error
      ? sync.error
      : sync.finishedAt
        ? `Finished ${new Date(sync.finishedAt).toLocaleTimeString()}`
        : "No sales sync running.";
  button.disabled = Boolean(sync.running);
  button.textContent = sync.running ? "Sales sync running…" : "Sync Sales & Trends";

  $("#analyticsPulse").classList.toggle("running", Boolean(analyticsSync.running));
  $("#analyticsPulse").classList.toggle("error", Boolean(analyticsSync.error));
  $("#analyticsMessage").textContent = analyticsSync.message || "Analytics idle";
  $("#analyticsDetail").textContent = analyticsSync.running
    ? `Started ${analyticsSync.startedAt ? new Date(analyticsSync.startedAt).toLocaleTimeString() : "now"}`
    : analyticsSync.error
      ? analyticsSync.error
      : state.status?.ingestedAt
        ? `Last analytics ingest ${new Date(state.status.ingestedAt).toLocaleString()}`
        : "No analytics sync yet.";
  analyticsButton.disabled = Boolean(analyticsSync.running);
  analyticsButton.textContent = analyticsSync.running ? "Analytics sync running…" : "Sync Analytics";
}

function renderKpis() {
  const summary = state.status?.salesSummary || {};
  const items = [
    ["App Units", summary.units || 0],
    ["All Row Units", summary.allUnits || 0],
    ["Rows", summary.rowCount || 0],
    ["Reports", summary.reportCount || 0]
  ];
  const numericCards = items.map(([label, value]) => `
    <div class="kpi">
      <span>${label}</span>
      <strong>${typeof value === "number" ? format(value) : value}</strong>
    </div>
  `).join("");
  const proceedsUsd = summary.proceedsUsd?.total || 0;
  const customerPriceUsd = summary.customerPriceUsd?.total || 0;
  $("#kpis").innerHTML = `${numericCards}
    <div class="kpi money-kpi">
      <div>
        <span>Proceeds</span>
        <strong>${moneyBucket(summary.proceedsByCurrency)}</strong>
        <small>≈ ${usd(proceedsUsd)}</small>
      </div>
      <div>
        <span>Customer Sales</span>
        <strong>${moneyBucket(summary.customerPriceByCurrency)}</strong>
        <small>≈ ${usd(customerPriceUsd)}</small>
      </div>
    </div>
  `;
}

function renderCoverage() {
  const byDate = state.status?.salesSummary?.byDate || {};
  const max = Math.max(1, ...Object.values(byDate).map((row) => row.units || 0));
  const source = Object.fromEntries(Object.entries(byDate).map(([date, value]) => [isoDateKey(parseAppleDate(date) || new Date(date)), value]));
  const availableDates = Object.keys(source).sort();
  const latestDate = parseAppleDate(availableDates[availableDates.length - 1]);
  if (!latestDate) {
    $("#coverage").innerHTML = `<p class="muted">No Sales & Trends rows yet. Add <code>ASC_VENDOR_NUMBER</code>, then sync.</p>`;
    return;
  }
  const rows = Array.from({ length: 30 }, (_, index) => {
    const date = new Date(latestDate);
    date.setHours(0, 0, 0, 0);
    date.setDate(date.getDate() - index);
    const key = isoDateKey(date);
    return [key, source[key] || { units: 0, missing: true }];
  });

  $("#coverage").innerHTML = rows.length ? rows.map(([date, value]) => `
    <div class="bar-row ${value.missing ? "missing-report" : ""}">
      <strong title="${displayIsoDate(date)}">${displayIsoDate(date)}</strong>
      <div class="bar-with-value">
        <div class="bar" style="height:16px;overflow:hidden;border-radius:999px;background:rgba(255,255,255,0.08);">
          <span class="bar-fill" style="display:block;height:100%;width:${value.units ? Math.max(4, ((value.units || 0) / max) * 100) : 0}%;border-radius:999px;background:linear-gradient(90deg,#77f2d2,#91b7ff);"></span>
        </div>
        <span class="bar-value">${value.missing ? "no report" : format(value.units || 0)}</span>
      </div>
    </div>
  `).join("") : `<p class="muted">No Sales & Trends rows yet. Add <code>ASC_VENDOR_NUMBER</code>, then sync.</p>`;
}

function renderApps() {
  const byApp = state.status?.salesSummary?.byApp || {};
  const apps = Object.entries(byApp).sort((a, b) => (b[1].units || 0) - (a[1].units || 0));
  $("#apps").innerHTML = apps.length ? apps.map(([app, value]) => `
    <div class="app-card">
      <strong>${app}</strong>
      <span>${format(value.units || 0)} app units · ${format(value.updates || 0)} updates · ${format(value.redownloads || 0)} redownloads · ${moneyBucket(value.proceedsByCurrency)} proceeds · ≈ ${usd(value.proceedsUsd?.total || 0)}</span>
    </div>
  `).join("") : `<p class="muted">Apps with Sales & Trends rows appear here after sync.</p>`;
}

function renderAnalytics() {
  const analytics = state.analyticsSummary?.analytics || {};
  const range = state.analyticsSummary?.analyticsRange || {};
  $("#analyticsRange").value = state.analyticsRange;
  $("#analyticsRangeLabel").textContent = range.startDate && range.endDate
    ? `${displayIsoDate(range.startDate)} – ${displayIsoDate(range.endDate)}`
    : "No Analytics dates available.";
  const items = [
    ["Impressions", analytics.impressions || 0],
    ["Product Page Views", analytics.productPageViews || 0],
    ["Downloads", analytics.downloads || 0],
    ["Conversion", percent(analytics.conversionRate || 0)]
  ];
  $("#analyticsKpis").innerHTML = items.map(([label, value]) => `
    <div class="kpi">
      <span>${label}</span>
      <strong>${typeof value === "number" ? format(value) : value}</strong>
    </div>
  `).join("");

  const apps = Object.entries(analytics.byApp || {})
    .sort((a, b) => (b[1].impressions || 0) - (a[1].impressions || 0));
  $("#analyticsApps").innerHTML = apps.length ? apps.map(([app, value]) => `
    <div class="app-card">
      <strong>${app}</strong>
      <span>${format(value.impressions || 0)} impressions · ${format(value.productPageViews || 0)} page views · ${format(value.downloads || 0)} downloads · ${percent(value.conversionRate || 0)} conversion</span>
    </div>
  `).join("") : `<p class="muted">No analytics rows yet. Click <code>Sync Analytics</code>; Apple may need time to prepare report segments.</p>`;
}

function renderTable() {
  const rows = state.salesRows.slice(0, 120);
  const preferred = ["reportDate", "Title", "SKU", "Apple Identifier", "Product Type Identifier", "Units", "Developer Proceeds", "Customer Price", "Country Code", "Currency of Proceeds"];
  const available = new Set(rows.flatMap((row) => Object.keys(row)));
  const columns = preferred.filter((column) => available.has(column));
  $("#tableHead").innerHTML = `<tr>${columns.map((column) => `<th>${column}</th>`).join("")}</tr>`;
  $("#tableBody").innerHTML = rows.length ? rows.map((row) => `
    <tr>${columns.map((column) => `<td>${row[column] ?? ""}</td>`).join("")}</tr>
  `).join("") : `<tr><td colspan="${Math.max(1, columns.length)}">No Sales & Trends rows yet.</td></tr>`;
}

function renderSettings() {
  if (!state.settings) return;
  const form = $("#settingsForm");
  for (const [key, value] of Object.entries(state.settings)) {
    const field = form.elements[key];
    if (!field) continue;
    field.placeholder = value || field.placeholder;
    if (["ASC_SALES_DAYS", "ASC_USD_RATES", "ASC_ANALYTICS_INSTANCE_LIMIT"].includes(key)) {
      field.value = value || "";
    }
  }
}

async function loadAll() {
  state.status = await api("/api/status");
  state.salesRows = await api("/api/sales/rows?limit=1000");
  state.settings = await api("/api/settings");
  state.analyticsSummary = await api(`/api/analytics/summary?range=${encodeURIComponent(state.analyticsRange)}`);
  renderStatus();
  renderKpis();
  renderCoverage();
  renderApps();
  renderAnalytics();
  renderTable();
  renderSettings();
}

$("#syncButton").addEventListener("click", async () => {
  const button = $("#syncButton");
  button.disabled = true;
  button.textContent = "Starting…";
  try {
    await api("/api/sales/sync", { method: "POST" });
    await loadAll();
    toast("Sales & Trends sync started. Daily reports will appear as Apple returns them.");
  } catch (error) {
    toast(error.message);
    button.disabled = false;
    button.textContent = "Sync Sales & Trends";
  }
});

$("#syncAnalyticsButton").addEventListener("click", async () => {
  const button = $("#syncAnalyticsButton");
  button.disabled = true;
  button.textContent = "Starting…";
  try {
    await api("/api/analytics/sync", { method: "POST" });
    await loadAll();
    toast("Focused analytics sync started: impressions, page views, downloads, conversion.");
  } catch (error) {
    toast(error.message);
    button.disabled = false;
    button.textContent = "Sync Analytics";
  }
});

$("#settingsForm").addEventListener("submit", async (event) => {
  event.preventDefault();
  const button = $("#saveSettingsButton");
  button.disabled = true;
  button.textContent = "Saving…";
  try {
    const data = Object.fromEntries(new FormData(event.currentTarget).entries());
    state.settings = (await api("/api/settings", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(data)
    })).settings;
    event.currentTarget.reset();
    renderSettings();
    await loadAll();
    toast("Credentials saved locally. New syncs will use the updated settings.");
  } catch (error) {
    toast(error.message);
  } finally {
    button.disabled = false;
    button.textContent = "Save credentials";
  }
});

$("#analyticsRange").addEventListener("change", async (event) => {
  state.analyticsRange = event.currentTarget.value;
  try {
    state.analyticsSummary = await api(`/api/analytics/summary?range=${encodeURIComponent(state.analyticsRange)}`);
    renderAnalytics();
  } catch (error) {
    toast(error.message);
  }
});

setInterval(async () => {
  try {
    await loadAll();
  } catch {
    // Keep last rendered state.
  }
}, 3500);

document.querySelectorAll(".nav-item").forEach((button) => {
  button.addEventListener("click", () => {
    document.querySelectorAll(".nav-item").forEach((item) => item.classList.remove("active"));
    button.classList.add("active");
    const target = button.dataset.filter;
    $("#settingsPanel").classList.toggle("show", target === "settings");
    const selector = target === "settings" ? "#settingsPanel" : target === "apps" ? "#apps" : target === "raw" ? ".table-wrap" : target === "reports" ? "#coverage" : target === "analytics" ? "#analyticsApps" : ".topbar";
    document.querySelector(selector).scrollIntoView({ behavior: "smooth", block: "center" });
  });
});

loadAll().catch((error) => toast(error.message));
