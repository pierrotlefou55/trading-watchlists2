const STORAGE_KEY = "trading-watchlists-v1";

// Filet de sécurité UNIQUEMENT si default-lists.json est absent ou illisible
// (ex: app ouverte en file:// où fetch() est bloqué). Le vrai contenu par
// défaut vit désormais dans default-lists.json, jamais dans ce fichier.
const FALLBACK_LISTS = {
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
  ]
};

const DEFAULT_LISTS_URL = "./default-lists.json";
let cachedDefaultLists = null;

async function fetchDefaultLists() {
  if (cachedDefaultLists) return cachedDefaultLists;
  try {
    const response = await fetch(DEFAULT_LISTS_URL, { cache: "no-store" });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const data = await response.json();
    if (!data || typeof data !== "object" || Array.isArray(data)) {
      throw new Error("Format invalide dans default-lists.json");
    }
    cachedDefaultLists = data;
  } catch (err) {
    console.warn("default-lists.json indisponible, repli sur les listes intégrées.", err);
    cachedDefaultLists = FALLBACK_LISTS;
  }
  return cachedDefaultLists;
}

let state = {
  lists: {},
  selected: null,
  drag: null
};

let quoteTimer = null;
let quoteRequestInFlight = false;
let labelsRequestInFlight = false;
let quoteValues = {};

// ---------------------------------------------------------------------------
// #2 — Cache générique à expiration négative.
// Un seul mécanisme pour "on a déjà tenté ce symbole, voici le résultat",
// réutilisé pour les cotations (succès jamais persisté : elles doivent
// toujours être fraîches) et les libellés (succès persisté indéfiniment,
// un nom d'ETF ne change pas). Avant ce refactor, ces deux caches étaient
// dupliqués avec une logique légèrement différente à chaque fois.
// ---------------------------------------------------------------------------
function createResultCache(storageKey, { cooldownMs, persistSuccess }) {
  let store = {};
  try {
    store = JSON.parse(localStorage.getItem(storageKey) || "{}");
  } catch (e) {
    store = {};
  }
  function persist() {
    localStorage.setItem(storageKey, JSON.stringify(store));
  }
  return {
    recordSuccess(key, value) {
      if (persistSuccess) {
        store[key] = { ok: true, value, checkedAt: Date.now() };
        persist();
      } else if (store[key] !== undefined) {
        delete store[key];
        persist();
      }
    },
    recordFailure(key) {
      store[key] = { ok: false, checkedAt: Date.now() };
      persist();
    },
    getValue(key) {
      const entry = store[key];
      return entry && entry.ok ? entry.value : undefined;
    },
    shouldSkip(key) {
      const entry = store[key];
      if (!entry) return false;
      if (entry.ok) return persistSuccess;
      return (Date.now() - entry.checkedAt) < cooldownMs;
    }
  };
}

const RETRY_COOLDOWN_MS = 6 * 60 * 60 * 1000; // 6h avant de retenter un échec

const quoteCache = createResultCache("trading-quote-unavailable-v3", {
  cooldownMs: RETRY_COOLDOWN_MS,
  persistSuccess: false
});

const labelCache = createResultCache("trading-symbol-profiles-v6", {
  cooldownMs: RETRY_COOLDOWN_MS,
  persistSuccess: true
});

// ---------------------------------------------------------------------------
// #1 — Résolution de symbole + routage multi-provider.
// bareTicker() est le SEUL endroit qui parse "EXCHANGE:TICKER" pour en tirer
// le ticker nu ; resolveQuoteRoute() est le SEUL endroit qui décide quel
// provider (ou aucun) interroger pour un symbole donné. Avant ce refactor,
// ces deux responsabilités étaient éparpillées dans quoteSymbol/profileSymbol/
// KNOWN_NON_QUOTABLE/CRYPTO_QUOTE_SYMBOLS — exactement la dispersion qui a causé
// les bugs précédents (libellés mal indexés, tickers PEA à risque de collision).
// ---------------------------------------------------------------------------
function bareTicker(symbol) {
  const parts = symbol.split(":");
  const ticker = parts.length > 1 ? parts[1] : parts[0];
  return ticker.replace(/!$/, "");
}

// Finnhub identifie chaque crypto par EXCHANGE:PAIRE (ex: BINANCE:BTCUSDT).
const CRYPTO_QUOTE_SYMBOLS = {
  "BTCUSD": "BINANCE:BTCUSDT",
  "ETHUSD": "BINANCE:ETHUSDT",
  "SOLUSD": "BINANCE:SOLUSDT",
  "XRPUSD": "BINANCE:XRPUSDT"
};

// Le endpoint /quote gratuit de Finnhub ne couvre que les actions/ETF US,
// le forex et la crypto. Indices et futures en notation continue échouent
// systématiquement -> inutile de les interroger.
const FINNHUB_UNQUOTABLE = new Set(["SPX", "NDX", "VIX", "DXY", "GOLD", "SILVER", "CL1", "NG1", "DAX", "CAC"]);

// #4 — Positions PEA (Euronext/Xetra/BME) routées vers Twelve Data plutôt que
// bloquées. Codes d'exchange Twelve Data à confirmer empiriquement (pas testés
// avec une vraie clé) : "Euronext", "XETRA", "BME" sont les noms documentés,
// mais si un ticker ne matche rien, vérifiez le nom exact via /symbol_search.
const TWELVEDATA_ROUTES = {
  "LVE": "Euronext",
  "CL2": "Euronext",
  "AIR": "Euronext",
  "BN": "Euronext",
  "MRK": "XETRA",
  "ENR": "XETRA",
  "BAYN": "XETRA",
  "LHA": "XETRA",
  "MTX": "XETRA",
  "IBE": "BME",
  "VID": "BME"
};

// Tickers dont je ne suis pas assez sûr de la place de cotation pour router
// en confiance (RDC, NAE, MLP sont ambigus) : mieux vaut bloquer que risquer
// d'afficher la variation d'un autre titre.
const UNRESOLVED_TICKERS = new Set(["RDC", "NAE", "MLP"]);

function resolveQuoteRoute(symbol) {
  const ticker = bareTicker(symbol);
  if (CRYPTO_QUOTE_SYMBOLS[ticker]) {
    return { provider: "finnhub", ticker: CRYPTO_QUOTE_SYMBOLS[ticker] };
  }
  if (TWELVEDATA_ROUTES[ticker]) {
    return { provider: "twelvedata", ticker, exchange: TWELVEDATA_ROUTES[ticker] };
  }
  if (FINNHUB_UNQUOTABLE.has(ticker) || UNRESOLVED_TICKERS.has(ticker)) {
    return null; // volontairement non routé (voir commentaires ci-dessus)
  }
  return { provider: "finnhub", ticker };
}

const FINNHUB_KEY_STORAGE = "finnhub-api-key-v1";
const TWELVEDATA_KEY_STORAGE = "twelvedata-api-key-v1";
const QUOTE_REFRESH_MS = 60000;

function getFinnhubKey() {
  return localStorage.getItem(FINNHUB_KEY_STORAGE) || "";
}

function getTwelveDataKey() {
  return localStorage.getItem(TWELVEDATA_KEY_STORAGE) || "";
}

// Registre de providers : chaque provider expose isConfigured(), delayMs
// (espacement entre deux appels, propre à son rate limit) et fetchQuote().
// Ajouter un futur provider = un objet de plus ici, rien d'autre à toucher.
const QuoteProviders = {
  finnhub: {
    isConfigured: () => !!getFinnhubKey(),
    delayMs: 80,
    async fetchQuote(route) {
      const key = getFinnhubKey();
      const url = `https://finnhub.io/api/v1/quote?symbol=${encodeURIComponent(route.ticker)}&token=${encodeURIComponent(key)}`;
      const response = await fetch(url, { method: "GET" });
      if (!response.ok) throw new Error(`Finnhub HTTP ${response.status}`);
      const data = await response.json();
      if (!data || typeof data.dp !== "number") return null;
      return { percent: data.dp, price: data.c, timestamp: data.t };
    }
  },
  twelvedata: {
    isConfigured: () => !!getTwelveDataKey(),
    delayMs: 8000, // plan gratuit : 8 requêtes/minute max, donc rafraîchissement plus lent
    async fetchQuote(route) {
      const key = getTwelveDataKey();
      const url = `https://api.twelvedata.com/quote?symbol=${encodeURIComponent(route.ticker)}&exchange=${encodeURIComponent(route.exchange)}&apikey=${encodeURIComponent(key)}`;
      const response = await fetch(url, { method: "GET" });
      if (!response.ok) throw new Error(`Twelve Data HTTP ${response.status}`);
      const data = await response.json();
      const percent = data && data.percent_change !== undefined ? Number(data.percent_change) : NaN;
      if (!Number.isFinite(percent)) return null;
      return { percent, price: Number(data.close), timestamp: null };
    }
  }
};

function hasAnyQuoteProviderConfigured() {
  return QuoteProviders.finnhub.isConfigured() || QuoteProviders.twelvedata.isConfigured();
}

// Finnhub's free "stock/profile2" endpoint only covers equities (company profiles).
// ETFs, indices and futures continuistes return an empty {} on the free tier
// (the dedicated /etf/profile endpoint is a paid add-on: see finnhub.io/pricing-etf-indices).
// We short-circuit those with a small local dictionary so their label is instant,
// reliable, and costs zero API calls.
const KNOWN_LABELS = {
  "SPY": "SPDR S&P 500 ETF Trust",
  "QQQ": "Invesco QQQ Trust",
  "GLD": "SPDR Gold Shares",
  "TLT": "iShares 20+ Year Treasury Bond ETF",
  "SLV": "iShares Silver Trust",
  "IWM": "iShares Russell 2000 ETF",
  "SPX": "S&P 500 Index",
  "NDX": "Nasdaq-100 Index",
  "VIX": "CBOE Volatility Index",
  "DXY": "US Dollar Index",
  "GOLD": "Gold Spot",
  "SILVER": "Silver Spot",
  "CL1": "WTI Crude Oil Futures",
  "NG1": "Natural Gas Futures",
  "BTCUSD": "Bitcoin / US Dollar",
  "ETHUSD": "Ethereum / US Dollar",
  "SOLUSD": "Solana / US Dollar",
  "XRPUSD": "XRP / US Dollar"
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
  twelvedataKeyInput: document.querySelector("#twelvedataKeyInput"),
  cancelQuotesBtn: document.querySelector("#cancelQuotesBtn"),
  saveQuotesBtn: document.querySelector("#saveQuotesBtn"),
  modal: document.querySelector("#modal"),
  modalTitle: document.querySelector("#modalTitle"),
  symbolInput: document.querySelector("#symbolInput"),
  cancelModal: document.querySelector("#cancelModalBtn"),
  confirmModal: document.querySelector("#confirmModalBtn"),
  toast: document.querySelector("#toast")
};

async function loadLists() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) return JSON.parse(raw);
  } catch (e) {
    console.warn("Impossible de lire les watchlists", e);
  }
  return structuredClone(await fetchDefaultLists());
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

function openQuotesSettings() {
  els.finnhubKeyInput.value = getFinnhubKey();
  els.twelvedataKeyInput.value = getTwelveDataKey();
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
  const finnhubKey = els.finnhubKeyInput.value.trim();
  if (finnhubKey) localStorage.setItem(FINNHUB_KEY_STORAGE, finnhubKey);
  else localStorage.removeItem(FINNHUB_KEY_STORAGE);

  const twelvedataKey = els.twelvedataKeyInput.value.trim();
  if (twelvedataKey) localStorage.setItem(TWELVEDATA_KEY_STORAGE, twelvedataKey);
  else localStorage.removeItem(TWELVEDATA_KEY_STORAGE);

  closeQuotesSettings();
  showToast(hasAnyQuoteProviderConfigured() ? "Clés enregistrées." : "Cotations désactivées.");
  refreshAll();
}

async function refreshQuotes() {
  if (quoteRequestInFlight) return;
  if (!hasAnyQuoteProviderConfigured()) {
    renderLists();
    return;
  }

  quoteRequestInFlight = true;
  // On ne cible que les symboles routés vers un provider configuré et pas en
  // cooldown (échec récent) ; tout le routage vient de resolveQuoteRoute().
  const targets = [...new Set(Object.values(state.lists).flat())]
    .map(symbol => ({ symbol, route: resolveQuoteRoute(symbol) }))
    .filter(({ symbol, route }) => {
      if (!route) return false;
      if (!QuoteProviders[route.provider].isConfigured()) return false;
      return !quoteCache.shouldSkip(symbol);
    });

  try {
    for (const { symbol, route } of targets) {
      const provider = QuoteProviders[route.provider];
      try {
        const q = await provider.fetchQuote(route);
        if (q) {
          quoteValues[symbol] = q;
          quoteCache.recordSuccess(symbol);
        } else {
          quoteCache.recordFailure(symbol);
        }
      } catch (err) {
        console.warn("Quote unavailable for", symbol, err);
        quoteCache.recordFailure(symbol);
      }
      // Délai propre à chaque provider (80ms Finnhub, 8s Twelve Data en gratuit).
      await new Promise(resolve => setTimeout(resolve, provider.delayMs));
    }
    renderLists();
  } finally {
    quoteRequestInFlight = false;
  }
}

function getSymbolLabel(symbol) {
  return labelCache.getValue(symbol) || "";
}

async function fetchSymbolProfile(symbol) {
  const key = getFinnhubKey();
  if (!key) return null;

  const ticker = bareTicker(symbol);

  if (KNOWN_LABELS[ticker]) {
    labelCache.recordSuccess(symbol, KNOWN_LABELS[ticker]);
    return KNOWN_LABELS[ticker];
  }

  // 1) stock/profile2: works for company stocks, empty {} for ETFs/indices/futures.
  try {
    const url = `https://finnhub.io/api/v1/stock/profile2?symbol=${encodeURIComponent(ticker)}&token=${encodeURIComponent(key)}`;
    const response = await fetch(url, { method: "GET" });
    if (!response.ok) throw new Error(`Finnhub HTTP ${response.status}`);
    const data = await response.json();
    const label = data && typeof data.name === "string" ? data.name.trim() : "";
    if (label) {
      labelCache.recordSuccess(symbol, label);
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
      labelCache.recordSuccess(symbol, label);
      return label;
    }
  } catch (err) {
    console.warn("/search indisponible pour", symbol, err);
  }

  // Nothing found anywhere: cache the miss so we don't retry every refresh.
  labelCache.recordFailure(symbol);
  return null;
}

async function refreshSymbolLabels() {
  if (labelsRequestInFlight) return;
  const key = getFinnhubKey();
  if (!key) return;

  labelsRequestInFlight = true;
  try {
    const targets = [...new Set(Object.values(state.lists).flat())]
      .filter(symbol => !labelCache.shouldSkip(symbol));
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
  if (q && Number.isFinite(q.percent)) {
    const cls = q.percent > 0 ? "up" : q.percent < 0 ? "down" : "muted";
    const sign = q.percent > 0 ? "+" : "";
    return `<span class="quote-change ${cls}" title="Variation du jour">${sign}${q.percent.toFixed(2).replace(".", ",")} %</span>`;
  }
  // Distingue "non routé par design" (marché non couvert) d'un simple échec
  // réseau temporaire, pour que le survol du tiret soit informatif.
  const route = resolveQuoteRoute(symbol);
  const title = !route
    ? "Cotation non disponible pour ce marché (aucun fournisseur configuré ne le couvre)"
    : "Cotation indisponible pour le moment";
  return `<span class="quote-change muted" title="${title}">—</span>`;
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

async function resetListsFromSite() {
  if (!confirm("Remplacer vos watchlists actuelles par les listes intégrées au site ?")) return;
  state.lists = structuredClone(await fetchDefaultLists());
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

async function init() {
  state.lists = await loadLists();
  renderLists();

  // Initialisation des cotations et des libellés (séquentiel), puis actualisation des cotations chaque minute.
  await refreshAll();
  clearInterval(quoteTimer);
  quoteTimer = setInterval(refreshQuotes, QUOTE_REFRESH_MS);
}

init();
