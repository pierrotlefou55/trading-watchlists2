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

// Live/near-real-time quote cache. Data is read from Yahoo Finance's public chart endpoint.
const quotes = new Map();
let quoteTimer = null;
const yahooMap = {
  "SP:SPX": "^GSPC",
  "NASDAQ:NDX": "^NDX",
  "TVC:VIX": "^VIX",
  "TVC:DXY": "DX-Y.NYB",
  "TVC:GOLD": "GC=F",
  "TVC:SILVER": "SI=F",
  "NYMEX:CL1!": "CL=F",
  "NYMEX:NG1!": "NG=F"
};

function yahooSymbol(symbol) {
  if (yahooMap[symbol]) return yahooMap[symbol];
  return symbol.includes(":") ? symbol.split(":").pop() : symbol;
}

async function fetchQuote(symbol) {
  const ticker = yahooSymbol(symbol);
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(ticker)}?interval=1m&range=1d`;
  try {
    const response = await fetch(url, { cache: "no-store" });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const json = await response.json();
    const meta = json?.chart?.result?.[0]?.meta;
    if (!meta) throw new Error("No quote");

    let pct = meta.regularMarketChangePercent;
    if (typeof pct !== "number" && typeof meta.regularMarketPrice === "number" && typeof meta.previousClose === "number" && meta.previousClose) {
      pct = ((meta.regularMarketPrice - meta.previousClose) / meta.previousClose) * 100;
    }
    if (typeof pct === "number" && Number.isFinite(pct)) quotes.set(symbol, pct);
  } catch (error) {
    console.debug("Quote indisponible pour", symbol, error);
  }
}

async function refreshQuotes() {
  const symbols = [...new Set(Object.values(state.lists).flat())];
  await Promise.all(symbols.map(fetchQuote));
  renderLists();
}

function startQuoteRefresh() {
  if (quoteTimer) clearInterval(quoteTimer);
  refreshQuotes();
  quoteTimer = setInterval(refreshQuotes, 15000);
}


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
  importFile: document.querySelector("#importFile"),
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

      const change = quotes.get(symbol);
      const changeText = typeof change === "number" ? `${change >= 0 ? "+" : ""}${change.toFixed(2)}%` : "—";
      const changeClass = typeof change === "number" ? (change >= 0 ? "quote-up" : "quote-down") : "quote-na";

      row.innerHTML = `
        <span class="symbol-name">${escapeHtml(displayName(symbol))}</span>
        <span class="symbol-meta symbol-exchange">${escapeHtml(exchangeName(symbol))}</span>
        <span class="symbol-change ${changeClass}">${changeText}</span>
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
  els.selectedExchange.textContent = exchangeName(symbol) || "TradingView";
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
  showToast(`${symbol} ajouté.`);
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

els.newList.onclick = createList;
els.addSymbol.onclick = () => openAddSymbolModal();
els.exportBtn.onclick = exportLists;
els.importBtn.onclick = importLists;
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
startQuoteRefresh();
