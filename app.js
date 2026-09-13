const STORAGE_KEY = "trading-watchlists-v1";

const DEFAULT_LISTS = {
  "TECH": [
    "NASDAQ:NVDA",
    "NASDAQ:AMD",
    "NASDAQ:AVGO",
    "NASDAQ:MSFT",
    "NASDAQ:GOOGL",
    "NASDAQ:AMZN",
    "NASDAQ:META",
    "NASDAQ:AAPL"
  ],
  "ETF": [
    "AMEX:SPY",
    "NASDAQ:QQQ",
    "AMEX:GLD",
    "NASDAQ:TLT",
    "AMEX:SLV",
    "AMEX:IWM"
  ],
  "MOMENTUM": [
    "NASDAQ:PLTR",
    "NASDAQ:CRWD",
    "NASDAQ:TSLA",
    "NASDAQ:MU",
    "NASDAQ:ARM"
  ],
  "INDEX": [
    "SP:SPX",
    "NASDAQ:NDX",
    "TVC:VIX",
    "TVC:DXY"
  ],
  "COMMODITIES": [
    "TVC:GOLD",
    "TVC:SILVER",
    "NYMEX:CL1!",
    "NYMEX:NG1!"
  ],
  "WATCH": [
    "NYSE:JPM",
    "NYSE:LLY",
    "NYSE:CAT",
    "NYSE:GE"
  ]
};

let state = {
  lists: loadLists(),
  selected: null,
  drag: null
};

const FINNHUB_KEY_STORAGE = "finnhub-api-key-v1";
const QUOTE_REFRESH_MS = 60000;
let quoteTimer = null;
let quoteRequestInFlight = false;
let labelsRequestInFlight = false;
let quoteValues = {};

const QUOTE_UNAVAILABLE_STORAGE = "trading-quote-unavailable-v2";
const QUOTE_RETRY_COOLDOWN_MS = 6 * 60 * 60 * 1000; // 6h: on retente de temps en temps, au cas où Finnhub couvrirait un jour ce symbole
let quoteUnavailable = {};
try {
  quoteUnavailable = JSON.parse(localStorage.getItem(QUOTE_UNAVAILABLE_STORAGE) || "{}");
} catch (e) {
  quoteUnavailable = {};
}

// Le endpoint /quote gratuit de Finnhub ne comprend que des tickers actions/ETF US classiques.
// Les indices (SPX, NDX, VIX, DXY) et les futures en notation continue (CL1!, NG1!) ne sont
// pas des symboles /quote valides côté gratuit : inutile de retaper l'API à chaque minute.
const KNOWN_NON_QUOTABLE = new Set([
  "SP:SPX", "NASDAQ:NDX", "TVC:VIX", "TVC:DXY", "TVC:GOLD", "TVC:SILVER",
  "NYMEX:CL1!", "NYMEX:NG1!"
]);

function markQuoteUnavailable(symbol) {
  quoteUnavailable[symbol] = Date.now();
  localStorage.setItem(QUOTE_UNAVAILABLE_STORAGE, JSON.stringify(quoteUnavailable));
}

function clearQuoteUnavailable(symbol) {
  if (quoteUnavailable[symbol] === undefined) return;
  delete quoteUnavailable[symbol];
  localStorage.setItem(QUOTE_UNAVAILABLE_STORAGE, JSON.stringify(quoteUnavailable));
}

function isQuoteSkippable(symbol) {
  if (KNOWN_NON_QUOTABLE.has(symbol)) return true;
  const failedAt = quoteUnavailable[symbol];
  return typeof failedAt === "number" && (Date.now() - failedAt) < QUOTE_RETRY_COOLDOWN_MS;
}

const PROFILE_CACHE_STORAGE = "trading-symbol-profiles-v4";
let symbolProfiles = {};
try {
  symbolProfiles = JSON.parse(localStorage.getItem(PROFILE_CACHE_STORAGE) || "{}");
} catch (e) {
  symbolProfiles = {};
}

// Finnhub's free "stock/profile2" endpoint only covers equities (company profiles).
// ETFs, indices and futures continuistes return an empty {} on the free tier
// (the dedicated /etf/profile endpoint is a paid add-on: see finnhub.io/pricing-etf-indices).
// We short-circuit those with a small local dictionary so their label is instant,
// reliable, and costs zero API calls.
const KNOWN_LABELS = {
  "AMEX:SPY": "SPDR S&P 500 ETF Trust",
  "NASDAQ:QQQ": "Invesco QQQ Trust",
  "AMEX:GLD": "SPDR Gold Shares",
  "NASDAQ:TLT": "iShares 20+ Year Treasury Bond ETF",
  "AMEX:SLV": "iShares Silver Trust",
  "AMEX:IWM": "iShares Russell 2000 ETF",
  "SP:SPX": "S&P 500 Index",
  "NASDAQ:NDX": "Nasdaq-100 Index",
  "TVC:VIX": "CBOE Volatility Index",
  "TVC:DXY": "US Dollar Index",
  "TVC:GOLD": "Gold Spot",
  "TVC:SILVER": "Silver Spot",
  "NYMEX:CL1!": "WTI Crude Oil Futures",
  "NYMEX:NG1!": "Natural Gas Futures"
};


const els = {
  watchlists: document.querySelector("#watchlists"),
  search: document.querySelector("#searchInput"),
  chart: document.querySelector("#chartContainer"),
  selectedSymbol: document.querySelector("#selectedSymbol"),
  selectedExchange: document.querySelector("#selectedExchange"),
  openTV: document.querySelector("#openTradingViewBtn"),
  newList: document.querySelector("#newListBtn"),
  addSymbol: document.querySelector("#addSymbolBtn"),
  exportBtn: document.querySelector("#exportBtn"),
  importBtn: document.querySelector("#importBtn"),
  resetListsBtn: document.querySelector("#resetListsBtn"),
  importFile: document.querySelector("#importFile"),
  quotesSettingsBtn: document.querySelector("#quotesSettingsBtn"),
  quotesModal: document.querySelector("#quotesModal"),
  finnhubKeyInput: document.querySelector("#finnhubKeyInput"),
  cancelQuotesBtn: document.querySelector("#cancelQuotesBtn"),
  saveQuotesBtn: document.querySelector("#saveQuotesBtn"),
  modal: document.querySelector("#modal"),
  modalTitle: document.querySelector("#modalTitle"),
  symbolInput: document.querySelector("#symbolInput"),
  cancelModal: document.querySelector("#cancelModalBtn"),
  confirmModal: document.querySelector("#confirmModalBtn"),
  toast: document.querySelector("#toast")
};

function loadLists() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) return JSON.parse(raw);
  } catch (e) {
    console.warn("Impossible de lire les watchlists", e);
  }
  return structuredClone(DEFAULT_LISTS);
}

function saveLists() {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(state.lists));
}

function displayName(symbol) {
  return symbol.includes(":") ? symbol.split(":").pop() : symbol;
}

function exchangeName(symbol) {
  return symbol.includes(":") ? symbol.split(":")[0] : "";
}

function tvUrl(symbol) {
  return `https://www.tradingview.com/chart/?symbol=${encodeURIComponent(symbol)}`;
}

function getFinnhubKey() {
  return localStorage.getItem(FINNHUB_KEY_STORAGE) || "";
}

function openQuotesSettings() {
  els.finnhubKeyInput.value = getFinnhubKey();
  els.quotesModal.classList.remove("hidden");
  setTimeout(() => els.finnhubKeyInput.focus(), 0);
}

function closeQuotesSettings() {
  els.quotesModal.classList.add("hidden");
}

async function refreshAll() {
  // Enchaînées, pas en parallèle : les deux tapent le même quota Finnhub
  // (60 appels/minute côté gratuit), donc autant éviter de les cumuler.
  await refreshQuotes();
  await refreshSymbolLabels();
}

function saveQuotesSettings() {
  const key = els.finnhubKeyInput.value.trim();
  if (key) localStorage.setItem(FINNHUB_KEY_STORAGE, key);
  else localStorage.removeItem(FINNHUB_KEY_STORAGE);
  closeQuotesSettings();
  showToast(key ? "Clé Finnhub enregistrée." : "Cotations désactivées.");
  refreshAll();
}

function quoteSymbol(symbol) {
  const [exchange, ticker] = symbol.split(":");
  if (!ticker) return ticker || symbol;
  // Finnhub's free quote endpoint covers US-listed stocks and ETFs.
  // Keep the raw ticker; exchange prefixes are TradingView-specific here.
  return ticker.replace(/!$/, "");
}

async function fetchQuote(symbol) {
  const key = getFinnhubKey();
  if (!key) return null;
  const ticker = quoteSymbol(symbol);
  const url = `https://finnhub.io/api/v1/quote?symbol=${encodeURIComponent(ticker)}&token=${encodeURIComponent(key)}`;
  const response = await fetch(url, { method: "GET" });
  if (!response.ok) throw new Error(`Finnhub HTTP ${response.status}`);
  const data = await response.json();
  if (!data || typeof data.dp !== "number") return null;
  return { percent: data.dp, price: data.c, timestamp: data.t };
}

async function refreshQuotes() {
  if (quoteRequestInFlight) return;
  const key = getFinnhubKey();
  if (!key) {
    renderLists();
    return;
  }

  quoteRequestInFlight = true;
  // On ne cible que les symboles réellement cotables ; les indices/futures connus
  // et les échecs récents (cooldown 6h) sont exclus avant même le premier appel.
  const targets = [...new Set(Object.values(state.lists).flat())]
    .filter(symbol => !isQuoteSkippable(symbol));

  try {
    // Small delay between calls avoids bursting the API and makes rate limiting less likely.
    for (const symbol of targets) {
      try {
        const q = await fetchQuote(symbol);
        if (q) {
          quoteValues[symbol] = q;
          clearQuoteUnavailable(symbol);
        } else {
          markQuoteUnavailable(symbol);
        }
      } catch (err) {
        console.warn("Quote unavailable for", symbol, err);
        markQuoteUnavailable(symbol);
      }
      await new Promise(resolve => setTimeout(resolve, 80));
    }
    renderLists();
  } finally {
    quoteRequestInFlight = false;
  }
}

function profileSymbol(symbol) {
  const parts = symbol.split(":");
  const ticker = (parts.length > 1 ? parts[1] : parts[0]).replace(/!$/, "");
  return ticker;
}

function cacheLabel(symbol, label) {
  // "" is a valid cached outcome: it means "we looked, Finnhub has nothing for
  // this symbol on the free tier". That stops refreshSymbolLabels from retrying
  // it forever and burning the 60 calls/minute free quota on the same misses.
  symbolProfiles[symbol] = label;
  localStorage.setItem(PROFILE_CACHE_STORAGE, JSON.stringify(symbolProfiles));
}

async function fetchSymbolProfile(symbol) {
  const key = getFinnhubKey();
  if (!key) return null;

  if (KNOWN_LABELS[symbol]) {
    cacheLabel(symbol, KNOWN_LABELS[symbol]);
    return KNOWN_LABELS[symbol];
  }

  const ticker = profileSymbol(symbol);

  // 1) stock/profile2: works for company stocks, empty {} for ETFs/indices/futures.
  try {
    const url = `https://finnhub.io/api/v1/stock/profile2?symbol=${encodeURIComponent(ticker)}&token=${encodeURIComponent(key)}`;
    const response = await fetch(url, { method: "GET" });
    if (!response.ok) throw new Error(`Finnhub HTTP ${response.status}`);
    const data = await response.json();
    const label = data && typeof data.name === "string" ? data.name.trim() : "";
    if (label) {
      cacheLabel(symbol, label);
      return label;
    }
  } catch (err) {
    console.warn("stock/profile2 indisponible pour", symbol, err);
  }

  // 2) Fallback for ETFs not in KNOWN_LABELS: the free /search endpoint indexes
  // ETFs too (unlike profile2) and returns a "description" per matching symbol.
  try {
    const url = `https://finnhub.io/api/v1/search?q=${encodeURIComponent(ticker)}&token=${encodeURIComponent(key)}`;
    const response = await fetch(url, { method: "GET" });
    if (!response.ok) throw new Error(`Finnhub HTTP ${response.status}`);
    const data = await response.json();
    const match = Array.isArray(data?.result)
      ? data.result.find(r => r.symbol === ticker || r.displaySymbol === ticker)
      : null;
    const label = match && typeof match.description === "string" ? match.description.trim() : "";
    if (label) {
      cacheLabel(symbol, label);
      return label;
    }
  } catch (err) {
    console.warn("/search indisponible pour", symbol, err);
  }

  // Nothing found anywhere: cache the miss so we don't retry every refresh.
  cacheLabel(symbol, "");
  return null;
}

function getSymbolLabel(symbol) {
  return symbolProfiles[symbol] || "";
}

async function refreshSymbolLabels() {
  if (labelsRequestInFlight) return;
  const key = getFinnhubKey();
  if (!key) return;

  labelsRequestInFlight = true;
  try {
    // Only fetch symbols never looked up before (undefined), not just "no label yet" -
    // a cached "" means we already tried and Finnhub has nothing, so skip it.
    const targets = [...new Set(Object.values(state.lists).flat())]
      .filter(symbol => symbolProfiles[symbol] === undefined);
    for (const symbol of targets) {
      try {
        await fetchSymbolProfile(symbol);
      } catch (err) {
        console.warn("Libellé indisponible pour", symbol, err);
      }
      await new Promise(resolve => setTimeout(resolve, 80));
    }
    renderLists();
    if (state.selected) {
      els.selectedExchange.textContent = getSymbolLabel(state.selected) || "";
    }
  } finally {
    labelsRequestInFlight = false;
  }
}

function quoteMarkup(symbol) {
  const q = quoteValues[symbol];
  if (!q || !Number.isFinite(q.percent)) return `<span class="quote-change muted">—</span>`;
  const cls = q.percent > 0 ? "up" : q.percent < 0 ? "down" : "muted";
  const sign = q.percent > 0 ? "+" : "";
  return `<span class="quote-change ${cls}" title="Variation du jour">${sign}${q.percent.toFixed(2).replace(".", ",")} %</span>`;
}

function renderLists() {
  const query = els.search.value.trim().toLowerCase();
  els.watchlists.innerHTML = "";

  Object.entries(state.lists).forEach(([listName, symbols]) => {
    const visibleSymbols = symbols.filter(s =>
      !query ||
      s.toLowerCase().includes(query) ||
      displayName(s).toLowerCase().includes(query)
    );

    const list = document.createElement("section");
    list.className = "list";

    const header = document.createElement("div");
    header.className = "list-header";
    header.innerHTML = `
      <span class="list-title">${escapeHtml(listName)} <span class="symbol-exchange">(${symbols.length})</span></span>
      <span class="list-tools">
        <button class="small-btn add-list-symbol" title="Ajouter">+</button>
        <button class="small-btn rename-list" title="Renommer">✎</button>
        <button class="small-btn delete-list" title="Supprimer">×</button>
      </span>
    `;

    header.querySelector(".add-list-symbol").onclick = e => {
      e.stopPropagation();
      openAddSymbolModal(listName);
    };

    header.querySelector(".rename-list").onclick = e => {
      e.stopPropagation();
      renameList(listName);
    };

    header.querySelector(".delete-list").onclick = e => {
      e.stopPropagation();
      deleteList(listName);
    };

    list.appendChild(header);

    visibleSymbols.forEach(symbol => {
      const row = document.createElement("div");
      row.className = "symbol-row" + (state.selected === symbol ? " selected" : "");
      row.draggable = true;
      row.dataset.symbol = symbol;
      row.dataset.list = listName;

      row.innerHTML = `
        <span class="symbol-name">${escapeHtml(displayName(symbol))}</span>
        <span class="product-label">${escapeHtml(getSymbolLabel(symbol))}</span>
        ${quoteMarkup(symbol)}
        <span class="symbol-actions">
          <button class="small-btn delete-symbol" title="Supprimer">×</button>
        </span>
      `;

      row.onclick = () => selectSymbol(symbol);
      row.querySelector(".delete-symbol").onclick = e => {
        e.stopPropagation();
        removeSymbol(listName, symbol);
      };

      row.addEventListener("dragstart", () => {
        state.drag = { symbol, fromList: listName };
        row.classList.add("dragging");
      });

      row.addEventListener("dragend", () => {
        state.drag = null;
        row.classList.remove("dragging");
      });

      row.addEventListener("dragover", e => e.preventDefault());

      row.addEventListener("drop", e => {
        e.preventDefault();
        if (!state.drag) return;
        moveSymbol(state.drag.symbol, state.drag.fromList, listName, symbol);
      });

      list.appendChild(row);
    });

    // Zone de dépôt après le dernier élément : sans elle, impossible de déplacer
    // une valeur en toute fin de liste (on ne peut viser que les lignes existantes).
    const dropzone = document.createElement("div");
    dropzone.className = "list-dropzone";
    dropzone.addEventListener("dragover", e => e.preventDefault());
    dropzone.addEventListener("dragenter", () => dropzone.classList.add("drop-target"));
    dropzone.addEventListener("dragleave", () => dropzone.classList.remove("drop-target"));
    dropzone.addEventListener("drop", e => {
      e.preventDefault();
      dropzone.classList.remove("drop-target");
      if (!state.drag) return;
      moveSymbol(state.drag.symbol, state.drag.fromList, listName, null);
    });
    list.appendChild(dropzone);

    if (query && visibleSymbols.length === 0) {
      return;
    }

    els.watchlists.appendChild(list);
  });
}

function openTradingView(symbol) {
  if (!symbol) return;
  window.open(tvUrl(symbol), "_blank", "noopener,noreferrer");
}

function selectSymbol(symbol) {
  state.selected = symbol;
  els.selectedSymbol.textContent = displayName(symbol);
  els.selectedExchange.textContent = getSymbolLabel(symbol) || "";
  els.openTV.disabled = false;
  els.openTV.onclick = () => openTradingView(symbol);
  renderLists();

  // Ouvre directement la vraie page TradingView dans un nouvel onglet.
  // Ainsi, la session, les layouts et les indicateurs du compte TradingView
  // de l'utilisateur sont utilisés. Aucun widget/iframe n'est embarqué ici.
  openTradingView(symbol);
}

function openAddSymbolModal(listName = Object.keys(state.lists)[0]) {
  if (!listName) {
    showToast("Créez d'abord une liste.");
    return;
  }

  els.modal.dataset.list = listName;
  els.modal.dataset.mode = "add";
  els.modalTitle.textContent = `Ajouter une valeur à ${listName}`;
  els.symbolInput.value = "";
  els.confirmModal.textContent = "Ajouter";
  els.modal.classList.remove("hidden");
  setTimeout(() => els.symbolInput.focus(), 0);
}

function closeModal() {
  els.modal.classList.add("hidden");
}

function confirmModal() {
  const listName = els.modal.dataset.list;
  const mode = els.modal.dataset.mode;
  const symbol = els.symbolInput.value.trim().toUpperCase();

  if (mode !== "add" || !symbol) {
    closeModal();
    return;
  }

  if (!state.lists[listName]) {
    showToast("Liste introuvable.");
    return;
  }

  if (state.lists[listName].includes(symbol)) {
    showToast("Cette valeur existe déjà dans la liste.");
    return;
  }

  state.lists[listName].push(symbol);
  saveLists();
  closeModal();
  renderLists();
  selectSymbol(symbol);
  refreshSymbolLabels();
  showToast(`${symbol} ajouté.`);
}

function resetListsFromSite() {
  if (!confirm("Remplacer vos watchlists actuelles par les listes intégrées au site ?")) return;
  state.lists = structuredClone(DEFAULT_LISTS);
  state.selected = null;
  saveLists();
  renderLists();
  refreshAll();
  showToast("Listes du site rechargées.");
}

function createList() {
  const name = prompt("Nom de la nouvelle liste :");
  if (!name) return;

  const clean = name.trim();
  if (!clean) return;

  if (state.lists[clean]) {
    showToast("Cette liste existe déjà.");
    return;
  }

  state.lists[clean] = [];
  saveLists();
  renderLists();
  showToast(`Liste "${clean}" créée.`);
}

function renameList(oldName) {
  const newName = prompt("Nouveau nom :", oldName);
  if (!newName || newName.trim() === oldName) return;

  const clean = newName.trim();
  if (state.lists[clean]) {
    showToast("Ce nom existe déjà.");
    return;
  }

  state.lists[clean] = state.lists[oldName];
  delete state.lists[oldName];
  saveLists();
  renderLists();
}

function deleteList(listName) {
  if (!confirm(`Supprimer la liste "${listName}" ?`)) return;

  delete state.lists[listName];
  saveLists();

  if (state.selected && !Object.values(state.lists).flat().includes(state.selected)) {
    state.selected = null;
    els.selectedSymbol.textContent = "Sélectionnez une valeur";
    els.selectedExchange.textContent = "—";
    els.openTV.disabled = true;
    els.chart.innerHTML = `
      <div class="empty-state">
        <div class="empty-icon">↗</div>
        <h2>TradingView s'ouvre dans un nouvel onglet</h2>
        <p>Cliquez sur une valeur dans une watchlist pour ouvrir sa page TradingView avec votre session et vos réglages.</p>
      </div>
    `;
  }

  renderLists();
}

function removeSymbol(listName, symbol) {
  state.lists[listName] = state.lists[listName].filter(s => s !== symbol);
  saveLists();

  if (state.selected === symbol) {
    state.selected = null;
    els.selectedSymbol.textContent = "Sélectionnez une valeur";
    els.selectedExchange.textContent = "—";
    els.openTV.disabled = true;
    els.chart.innerHTML = `
      <div class="empty-state">
        <div class="empty-icon">↗</div>
        <h2>TradingView s'ouvre dans un nouvel onglet</h2>
        <p>Cliquez sur une valeur dans une watchlist pour ouvrir sa page TradingView avec votre session et vos réglages.</p>
      </div>
    `;
  }

  renderLists();
}

function moveSymbol(symbol, fromList, toList, beforeSymbol) {
  if (fromList === toList && symbol === beforeSymbol) return;

  const from = state.lists[fromList];
  const to = state.lists[toList];

  const index = from.indexOf(symbol);
  if (index < 0) return;

  from.splice(index, 1);

  const existing = to.indexOf(symbol);
  if (existing >= 0) to.splice(existing, 1);

  const target = to.indexOf(beforeSymbol);
  if (target >= 0) to.splice(target, 0, symbol);
  else to.push(symbol);

  saveLists();
  renderLists();
}

function exportLists() {
  const blob = new Blob(
    [JSON.stringify(state.lists, null, 2)],
    { type: "application/json" }
  );

  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = "trading-watchlists.json";
  a.click();
  URL.revokeObjectURL(url);
  showToast("Watchlists exportées.");
}

function importLists() {
  els.importFile.click();
}

function handleImport(event) {
  const file = event.target.files[0];
  if (!file) return;

  const reader = new FileReader();

  reader.onload = () => {
    try {
      const imported = JSON.parse(reader.result);

      if (!imported || typeof imported !== "object" || Array.isArray(imported)) {
        throw new Error("Format invalide");
      }

      for (const [name, symbols] of Object.entries(imported)) {
        if (!Array.isArray(symbols)) throw new Error("Format invalide");
        if (!symbols.every(s => typeof s === "string")) throw new Error("Format invalide");
      }

      state.lists = imported;
      saveLists();
      renderLists();
      refreshSymbolLabels();
      showToast("Watchlists importées.");
    } catch (e) {
      alert("Impossible d'importer ce fichier JSON.");
    }

    event.target.value = "";
  };

  reader.readAsText(file);
}

function escapeHtml(value) {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

let toastTimer;

function showToast(message) {
  clearTimeout(toastTimer);
  els.toast.textContent = message;
  els.toast.classList.add("show");

  toastTimer = setTimeout(() => {
    els.toast.classList.remove("show");
  }, 1800);
}

els.quotesSettingsBtn.onclick = openQuotesSettings;
els.cancelQuotesBtn.onclick = closeQuotesSettings;
els.saveQuotesBtn.onclick = saveQuotesSettings;
els.quotesModal.addEventListener("click", e => {
  if (e.target === els.quotesModal) closeQuotesSettings();
});

els.newList.onclick = createList;
els.addSymbol.onclick = () => openAddSymbolModal();
els.exportBtn.onclick = exportLists;
els.importBtn.onclick = importLists;
els.resetListsBtn.onclick = resetListsFromSite;
els.importFile.onchange = handleImport;
els.cancelModal.onclick = closeModal;
els.confirmModal.onclick = confirmModal;

els.search.addEventListener("input", renderLists);

els.symbolInput.addEventListener("keydown", e => {
  if (e.key === "Enter") confirmModal();
  if (e.key === "Escape") closeModal();
});

els.modal.addEventListener("click", e => {
  if (e.target === els.modal) closeModal();
});

renderLists();

// Initialisation des cotations et des libellés (séquentiel), puis actualisation des cotations chaque minute.
refreshAll();
clearInterval(quoteTimer);
quoteTimer = setInterval(refreshQuotes, QUOTE_REFRESH_MS);
