/* Baby Name ELO Rater
 * - Load bundled JSON dataset with progress indicator
 * - Show two names at a time, with median percentile and current ELO
 * - Choose with left/right keys or by clicking a card
 * - Pairings chosen based on ELO proximity with a sprinkle of randomness
 * - Export current state to JSON or CSV
 */

// Config constants
const DURATION = 320;           // ms selection animation
const RECENT_WINDOW = 20;       // for repeat-pair avoidance
const HISTORY_LIMIT = 100;      // how many pairs to retain
const SAMPLE_ANCHOR = 16;       // sample size to pick anchor by fewest games
const SAMPLE_OPPONENT = 32;     // sample size to pick closest-elo opponent

// Basic state
const state = {
  items: [], // {id, name, median, elo, games, wins, losses}
  rawRecords: [],
  filters: null,
  datasetStats: null,
  k: 24,
  totalMatches: 0,
  datasetKey: null,
  currentPair: null, // [idA, idB]
  pairHistory: [], // recent pairs to avoid repeats
  busy: false, // lock during selection feedback
};

// DOM refs
const el = {
  filterBtn: document.getElementById('filterBtn'),
  kFactor: document.getElementById('kFactor'),
  datasetLabel: document.getElementById('datasetLabel'),
  matchCount: document.getElementById('matchCount'),
  resultsBtn: document.getElementById('resultsBtn'),
  arenaMessage: document.getElementById('arenaMessage'),
  loading: {
    overlay: document.getElementById('loadingOverlay'),
    bar: document.getElementById('loadingBar'),
    percent: document.getElementById('loadingPercent'),
  },
  filters: {
    panel: document.getElementById('filtersPanel'),
    closeBtn: document.getElementById('filtersCloseBtn'),
    sex: document.getElementById('sexFilter'),
    rankMin: document.getElementById('rankMin'),
    rankMax: document.getElementById('rankMax'),
    yearMin: document.getElementById('yearMin'),
    yearMax: document.getElementById('yearMax'),
    applyBtn: document.getElementById('applyFiltersBtn'),
  },
  resultsPanel: {
    panel: document.getElementById('resultsPanel'),
    closeBtn: document.getElementById('resultsCloseBtn'),
    content: document.getElementById('resultsContent'),
  },
  left: {
    card: document.getElementById('leftCard'),
    name: document.getElementById('leftName'),
    sex: document.getElementById('leftSex'),
    rank: document.getElementById('leftRank'),
    year: document.getElementById('leftYear'),
    median: document.getElementById('leftMedian'),
    elo: document.getElementById('leftElo'),
    removeBtn: document.getElementById('leftRemoveBtn'),
  },
  right: {
    card: document.getElementById('rightCard'),
    name: document.getElementById('rightName'),
    sex: document.getElementById('rightSex'),
    rank: document.getElementById('rightRank'),
    year: document.getElementById('rightYear'),
    median: document.getElementById('rightMedian'),
    elo: document.getElementById('rightElo'),
    removeBtn: document.getElementById('rightRemoveBtn'),
  },
};

const DATA_URL = 'data/names.json';
const FALLBACK_SIZE_ESTIMATE = 32 * 1024 * 1024; // 32 MB guess for progress

// Utilities
function setArenaMessage(msg) {
  if (!el.arenaMessage) return;
  if (!msg) {
    el.arenaMessage.textContent = '';
    el.arenaMessage.style.display = 'none';
  } else {
    el.arenaMessage.textContent = msg;
    el.arenaMessage.style.display = 'block';
  }
}

function showFilterPanel() {
  el.filters.panel?.classList.add('open');
}

function hideFilterPanel() {
  el.filters.panel?.classList.remove('open');
}

function showResultsPanel() {
  if (!state.items.length) {
    alert('Apply filters and start rating names before viewing results.');
    return;
  }
  renderResultsContent();
  el.resultsPanel.panel?.classList.add('open');
}

function hideResultsPanel() {
  el.resultsPanel.panel?.classList.remove('open');
}

function setLoadingVisible(visible) {
  if (!el.loading?.overlay) return;
  el.loading.overlay.classList.toggle('hidden', !visible);
}

function updateLoadingProgress(value) {
  if (!el.loading) return;
  const pct = Math.min(1, Math.max(0, value || 0));
  el.loading.bar.style.width = `${Math.round(pct * 100)}%`;
  el.loading.percent.textContent = `${Math.round(pct * 100)}%`;
}

function pickField(obj, keys) {
  for (const key of keys) {
    if (obj[key] !== undefined && obj[key] !== null && obj[key] !== '') return obj[key];
    const alt = key.toLowerCase();
    if (obj[alt] !== undefined && obj[alt] !== null && obj[alt] !== '') return obj[alt];
    const upper = key.toUpperCase();
    if (obj[upper] !== undefined && obj[upper] !== null && obj[upper] !== '') return obj[upper];
  }
  return null;
}

function toNumber(value) {
  if (value === undefined || value === null || value === '') return null;
  const num = Number(value);
  return Number.isFinite(num) ? num : null;
}

function normalizeRecord(record) {
  const nameRaw = pickField(record, ['Name']);
  const name = nameRaw ? String(nameRaw).trim() : '';
  const rank = toNumber(pickField(record, ['Rank']));
  const percent = toNumber(pickField(record, ['Percent', 'Percentile']));
  const year = toNumber(pickField(record, ['Year']));
  let sex = pickField(record, ['Sex']);
  sex = sex ? String(sex).trim().charAt(0).toUpperCase() : null;
  return { name, rank, percent, year, sex };
}

function computeDatasetStats(records) {
  const stats = {
    rankMin: Infinity,
    rankMax: -Infinity,
    yearMin: Infinity,
    yearMax: -Infinity,
    percentMin: Infinity,
    percentMax: -Infinity,
    sexes: new Set(),
  };
  for (const rec of records) {
    if (rec.rank != null) {
      stats.rankMin = Math.min(stats.rankMin, rec.rank);
      stats.rankMax = Math.max(stats.rankMax, rec.rank);
    }
    if (rec.year != null) {
      stats.yearMin = Math.min(stats.yearMin, rec.year);
      stats.yearMax = Math.max(stats.yearMax, rec.year);
    }
    if (rec.percent != null) {
      stats.percentMin = Math.min(stats.percentMin, rec.percent);
      stats.percentMax = Math.max(stats.percentMax, rec.percent);
    }
    if (rec.sex) stats.sexes.add(rec.sex);
  }
  for (const key of ['rankMin','yearMin','percentMin']) {
    if (!Number.isFinite(stats[key])) stats[key] = null;
  }
  for (const key of ['rankMax','yearMax','percentMax']) {
    if (!Number.isFinite(stats[key])) stats[key] = null;
  }
  stats.sexes = Array.from(stats.sexes).sort();
  return stats;
}

function applyStatsToInputs() {
  if (!state.datasetStats) return;
  const stats = state.datasetStats;
  const setField = (input, min, max, step = null) => {
    if (!input) return;
    if (min != null) input.min = min;
    if (max != null) input.max = max;
    if (step) input.step = step;
  };
  setField(el.filters.rankMin, stats.rankMin ?? 1, stats.rankMax ?? undefined);
  setField(el.filters.rankMax, stats.rankMin ?? 1, stats.rankMax ?? undefined);
  setField(el.filters.yearMin, stats.yearMin ?? undefined, stats.yearMax ?? undefined);
  setField(el.filters.yearMax, stats.yearMin ?? undefined, stats.yearMax ?? undefined);
  if (stats.rankMin != null) el.filters.rankMin.value = stats.rankMin;
  if (stats.rankMax != null) el.filters.rankMax.value = stats.rankMax;
  if (stats.yearMin != null) el.filters.yearMin.value = stats.yearMin;
  if (stats.yearMax != null) el.filters.yearMax.value = stats.yearMax;
}

function readFilterValues() {
  const parse = (input) => {
    if (!input) return null;
    const val = Number(input.value);
    return Number.isFinite(val) ? val : null;
  };
  return {
    sex: el.filters.sex.value || 'any',
    rankMin: parse(el.filters.rankMin),
    rankMax: parse(el.filters.rankMax),
    yearMin: parse(el.filters.yearMin),
    yearMax: parse(el.filters.yearMax),
  };
}

async function fetchJsonWithProgress(url) {
  const attemptFetch = async () => {
    const resp = await fetch(url, { cache: 'no-store' });
    if (!resp.ok) throw new Error(`Failed to load dataset (${resp.status})`);
    const total = parseInt(resp.headers.get('Content-Length') || '', 10);
    if (!resp.body) {
      const text = await resp.text();
      updateLoadingProgress(1);
      return JSON.parse(text);
    }
    const reader = resp.body.getReader();
    const decoder = new TextDecoder();
    const chunks = [];
    let received = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      received += value.length;
      chunks.push(decoder.decode(value, { stream: true }));
      if (Number.isFinite(total) && total > 0) {
        updateLoadingProgress(received / total);
      } else {
        const approx = Math.min(0.95, received / FALLBACK_SIZE_ESTIMATE);
        updateLoadingProgress(approx);
      }
    }
    chunks.push(decoder.decode());
    updateLoadingProgress(1);
    const text = chunks.join('');
    return JSON.parse(text);
  };

  try {
    return await attemptFetch();
  } catch (err) {
    if (location.protocol === 'file:') {
      console.warn('Fetch under file:// failed, attempting XHR fallback', err);
      return fetchJsonViaXHR(url);
    }
    throw err;
  }
}

function fetchJsonViaXHR(url) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('GET', url, true);
    xhr.responseType = 'text';
    xhr.onprogress = (event) => {
      if (event.lengthComputable && event.total > 0) {
        updateLoadingProgress(event.loaded / event.total);
      } else if (event.loaded) {
        const approx = Math.min(0.95, event.loaded / FALLBACK_SIZE_ESTIMATE);
        updateLoadingProgress(approx);
      }
    };
    xhr.onerror = () => reject(new Error('Network error while loading dataset'));
    xhr.onload = () => {
      const okStatus = xhr.status === 0 || (xhr.status >= 200 && xhr.status < 300);
      if (!okStatus) {
        reject(new Error(`XHR failed with status ${xhr.status}`));
        return;
      }
      try {
        updateLoadingProgress(1);
        const data = JSON.parse(xhr.responseText);
        resolve(data);
      } catch (e) {
        reject(e);
      }
    };
    xhr.send();
  });
}

async function hashDatasetKey(names) {
  const data = new TextEncoder().encode(names.join('\u241F'));
  const digest = await crypto.subtle.digest('SHA-256', data);
  const bytes = Array.from(new Uint8Array(digest)).map(b => b.toString(16).padStart(2,'0')).join('');
  return bytes.slice(0, 16);
}

function loadFromLocalStorage(key, items) {
  try {
    const raw = localStorage.getItem('babyname_elo_' + key);
    if (!raw) return;
    const saved = JSON.parse(raw);
    const map = new Map(saved.items.map(x => [x.name, x]));
    let applied = 0;
    for (const it of items) {
      const s = map.get(it.name);
      if (!s) continue;
      it.elo = s.elo ?? it.elo;
      it.games = s.games ?? 0;
      it.wins = s.wins ?? 0;
      it.losses = s.losses ?? 0;
      it.active = (s.active === undefined ? true : !!s.active);
      applied++;
    }
    console.log(`Restored ${applied} items from local storage for key ${key}`);
  } catch (e) {
    console.warn('Failed to load local state', e);
  }
}

function saveToLocalStorage() {
  if (!state.datasetKey) return;
  try {
    const data = { items: state.items.map(({name, median, elo, games, wins, losses, active}) => ({ name, median, elo, games, wins, losses, active })), totalMatches: state.totalMatches };
    localStorage.setItem('babyname_elo_' + state.datasetKey, JSON.stringify(data));
  } catch (e) { console.warn('Failed to save local state', e); }
}

function filterRecords(records, filters) {
  return records.filter((rec) => {
    if (filters.sex !== 'any' && rec.sex !== filters.sex) return false;
    if (filters.rankMin != null && (rec.rank == null || rec.rank < filters.rankMin)) return false;
    if (filters.rankMax != null && (rec.rank == null || rec.rank > filters.rankMax)) return false;
    if (filters.yearMin != null && (rec.year == null || rec.year < filters.yearMin)) return false;
    if (filters.yearMax != null && (rec.year == null || rec.year > filters.yearMax)) return false;
    return true;
  });
}

function buildItems(records) {
  return records.map((rec, idx) => ({
    id: idx,
    name: rec.name,
    median: rec.percent != null ? rec.percent : null,
    percent: rec.percent,
    rank: rec.rank,
    sex: rec.sex,
    year: rec.year,
    elo: 1500,
    games: 0,
    wins: 0,
    losses: 0,
    active: true,
  }));
}

function expectedScore(rA, rB) {
  // Logistic ELO: expected score for A vs B
  return 1 / (1 + Math.pow(10, (rB - rA) / 400));
}

function updateElo(idWinner, idLoser) {
  const a = state.items[idWinner];
  const b = state.items[idLoser];
  const k = state.k;
  const Ea = expectedScore(a.elo, b.elo);
  const Eb = expectedScore(b.elo, a.elo);
  a.elo = a.elo + k * (1 - Ea);
  b.elo = b.elo + k * (0 - Eb);
  a.games++; a.wins++;
  b.games++; b.losses++;
  state.totalMatches++;
}

function randomInt(n) { return Math.floor(Math.random() * n); }

function getActiveItems() { return state.items.filter(it => it.active !== false); }

function chooseAnchor(active) {
  const N = active.length;
  let best = null;
  for (let i = 0; i < Math.min(SAMPLE_ANCHOR, N); i++) {
    const cand = active[randomInt(N)];
    if (!best || cand.games < best.games) best = cand;
  }
  return best ?? active[randomInt(N)];
}

function chooseOpponent(anchor, active) {
  const N = active.length;
  const ids = active.map(it => it.id);
  const kset = new Set();
  while (kset.size < Math.min(SAMPLE_OPPONENT, N)) kset.add(ids[randomInt(N)]);
  let opponent = null, bestDiff = Infinity;
  for (const idx of kset) {
    if (idx === anchor.id) continue;
    const it = state.items[idx];
    const diff = Math.abs(it.elo - anchor.elo);
    if (diff < bestDiff) { opponent = it; bestDiff = diff; }
  }
  if (!opponent) {
    // fallback random among active that's not the anchor
    let idx = anchor.id;
    while (idx === anchor.id) idx = ids[randomInt(N)];
    opponent = state.items[idx];
  }
  // Avoid immediate repeats
  const pairKey = pairToKey(anchor.id, opponent.id);
  const recent = new Set(state.pairHistory.slice(-RECENT_WINDOW));
  if (recent.has(pairKey)) {
    for (let tries = 0; tries < 20; tries++) {
      const alt = state.items[ids[randomInt(N)]];
      if (!alt || alt.id === anchor.id) continue;
      const key = pairToKey(anchor.id, alt.id);
      if (!recent.has(key)) { opponent = alt; break; }
    }
  }
  return opponent;
}

function pickNextPair() {
  const active = getActiveItems();
  const N = active.length;
  if (N < 2) return null;
  const anchor = chooseAnchor(active);
  const opponent = chooseOpponent(anchor, active);
  const leftFirst = Math.random() < 0.5;
  const a = leftFirst ? anchor : opponent;
  const b = leftFirst ? opponent : anchor;
  return [a.id, b.id];
}

function pairToKey(a, b) { return a < b ? `${a}-${b}` : `${b}-${a}`; }

function showPair(ids) {
  state.currentPair = ids;
  const [idL, idR] = ids;
  const L = state.items[idL];
  const R = state.items[idR];
  renderPair(L, R);
}

function renderPair(L, R) {
  // clear transient classes
  el.left.card.classList.remove('chosen','faded','removed');
  el.right.card.classList.remove('chosen','faded','removed');
  el.left.name.textContent = L.name;
  el.right.name.textContent = R.name;
  el.left.sex.textContent = L.sex ?? '—';
  el.right.sex.textContent = R.sex ?? '—';
  el.left.rank.textContent = L.rank != null && isFinite(L.rank) ? `#${L.rank}` : '—';
  el.right.rank.textContent = R.rank != null && isFinite(R.rank) ? `#${R.rank}` : '—';
  el.left.year.textContent = L.year != null && isFinite(L.year) ? L.year : '—';
  el.right.year.textContent = R.year != null && isFinite(R.year) ? R.year : '—';
  el.left.median.textContent = L.median != null && isFinite(L.median) ? `${L.median.toFixed(1)}%` : '—';
  el.right.median.textContent = R.median != null && isFinite(R.median) ? `${R.median.toFixed(1)}%` : '—';
  el.left.elo.textContent = Math.round(L.elo);
  el.right.elo.textContent = Math.round(R.elo);
}

function next() {
  const pair = pickNextPair();
  if (!pair) {
    el.left.card.classList.remove('chosen','faded');
    el.right.card.classList.remove('chosen','faded');
    el.left.name.textContent = 'Not enough active names';
    el.right.name.textContent = '—';
    el.left.sex.textContent = '—';
    el.right.sex.textContent = '—';
    el.left.rank.textContent = '—';
    el.right.rank.textContent = '—';
    el.left.year.textContent = '—';
    el.right.year.textContent = '—';
    el.left.median.textContent = '—';
    el.right.median.textContent = '—';
    el.left.elo.textContent = '—';
    el.right.elo.textContent = '—';
    state.currentPair = null;
    if (state.items.length === 0) {
      setArenaMessage('Adjust filters and click Apply to start.');
    } else {
      setArenaMessage('Not enough active names. Reset or change filters.');
    }
    return;
  }
  setArenaMessage('');
  recordPair(pair[0], pair[1]);
  showPair(pair);
}

function recordPair(a, b) {
  state.pairHistory.push(pairToKey(a, b));
  if (state.pairHistory.length > HISTORY_LIMIT) state.pairHistory.splice(0, state.pairHistory.length - HISTORY_LIMIT);
}

function onPick(side) {
  if (state.busy) return; // ignore inputs during feedback
  const [idL, idR] = state.currentPair || [];
  if (idL == null || idR == null) return;
  // If either side is inactive, ignore picks until both are active
  const L = state.items[idL];
  const R = state.items[idR];
  if (L.active === false || R.active === false) return;
  const winner = side === 'left' ? idL : idR;
  const loser = side === 'left' ? idR : idL;
  // Visual feedback: highlight chosen card briefly
  state.busy = true;
  const chosenEl = side === 'left' ? el.left.card : el.right.card;
  const otherEl = side === 'left' ? el.right.card : el.left.card;
  chosenEl.classList.add('chosen');
  otherEl.classList.add('faded');

  // Perform ELO update immediately, then advance after animation
  updateElo(winner, loser);
  renderStatus();
  saveToLocalStorage();

  setTimeout(() => {
    chosenEl.classList.remove('chosen');
    otherEl.classList.remove('faded');
    next();
    state.busy = false;
  }, DURATION);
}

function renderResultsContent() {
  const container = el.resultsPanel.content;
  if (!container) return;
  if (!state.items.length) {
    container.innerHTML = '<p class="results-empty">Apply filters and play a few rounds to see live rankings.</p>';
    return;
  }
  const sorted = [...state.items].sort((a, b) => b.elo - a.elo || a.name.localeCompare(b.name));
  const rows = sorted.map((it, idx) => `
    <tr>
      <td>${idx + 1}</td>
      <td>${it.name}</td>
      <td>${it.sex ?? '–'}</td>
      <td>${it.rank != null ? `#${it.rank}` : '–'}</td>
      <td>${it.year ?? '–'}</td>
      <td>${it.percent != null ? `${it.percent.toFixed(1)}%` : '–'}</td>
      <td>${Math.round(it.elo)}</td>
      <td>${it.games}</td>
      <td>${it.wins}</td>
      <td>${it.losses}</td>
    </tr>
  `).join('');
  container.innerHTML = `
    <div class="results-meta">Total names: ${sorted.length} • Matches: ${state.totalMatches}</div>
    <table class="results-table">
      <thead>
        <tr>
          <th>#</th>
          <th>Name</th>
          <th>Sex</th>
          <th>Rank</th>
          <th>Year</th>
          <th>Percent</th>
          <th>ELO</th>
          <th>Games</th>
          <th>Wins</th>
          <th>Losses</th>
        </tr>
      </thead>
      <tbody>${rows}</tbody>
    </table>
  `;
}

function renderStatus() {
  el.matchCount.textContent = String(state.totalMatches);
}

function nextWithAnchor(anchorId, anchorSide) {
  const active = state.items.filter(it => it.active !== false && it.id !== anchorId);
  if (active.length === 0) { return; }
  // choose nearest ELO opponent among a random subset
  let opponent = chooseOpponent(state.items[anchorId], active);
  opponent = opponent || active[randomInt(active.length)];
  const ids = anchorSide === 'left' ? [anchorId, opponent.id] : [opponent.id, anchorId];
  recordPair(ids[0], ids[1]);
  showPair(ids);
}

function removeSide(side) {
  if (!state.currentPair) return;
  const [idL, idR] = state.currentPair;
  const targetId = side === 'left' ? idL : idR;
  const otherId = side === 'left' ? idR : idL;
  if (targetId == null) return;
  const target = state.items[targetId];
  if (!target || target.active === false) return;
  // mark inactive and visual style
  target.active = false;
  const card = side === 'left' ? el.left.card : el.right.card;
  card.classList.add('removed');
  saveToLocalStorage();
  // If both sides inactive, advance. Otherwise, keep the other visible and refill the removed side.
  const other = otherId != null ? state.items[otherId] : null;
  setTimeout(() => {
    if (!other || other.active === false) {
      next();
    } else {
      // Keep the other name on the same side; fill the removed side with a new opponent.
      nextWithAnchor(otherId, side === 'left' ? 'right' : 'left');
    }
  }, 200);
}

async function initializeDataset() {
  setArenaMessage('Loading dataset…');
  setLoadingVisible(true);
  updateLoadingProgress(0);
  try {
    const data = await fetchJsonWithProgress(DATA_URL);
    const normalized = data.map(normalizeRecord).filter(rec => rec.name);
    state.rawRecords = normalized;
    state.datasetStats = computeDatasetStats(normalized);
    applyStatsToInputs();
    el.datasetLabel.textContent = `Dataset ready: ${normalized.length} names`;
    setArenaMessage('Adjust filters and click Apply to start.');
    showFilterPanel();
  } catch (e) {
    console.error('Failed to load dataset', e);
    const extra = location.protocol === 'file:' ? 'Open via a local server (e.g. `npx serve`) rather than file:// to allow loading.' : 'Check your connection and try again.';
    setArenaMessage(`Failed to load dataset. ${extra}`);
    el.datasetLabel.textContent = 'Dataset: load failed';
  } finally {
    setLoadingVisible(false);
    updateLoadingProgress(1);
  }
}

function describeFilters(filters) {
  if (!filters) return 'filtered';
  const parts = [];
  if (filters.sex === 'F') parts.push('Female');
  else if (filters.sex === 'M') parts.push('Male');
  const fmt = (val, decimals = 0) => {
    if (val == null) return 'any';
    return decimals === 0 ? String(val) : Number(val).toFixed(decimals);
  };
  const addRange = (label, min, max, decimals = 0) => {
    if (min == null && max == null) return;
    parts.push(`${label} ${fmt(min, decimals)}–${fmt(max, decimals)}`);
  };
  addRange('Rank', filters.rankMin, filters.rankMax);
  addRange('Year', filters.yearMin, filters.yearMax);
  return parts.length ? parts.join(', ') : 'All names';
}

function dedupeByName(records) {
  const map = new Map();
  for (const rec of records) {
    if (!rec.name) continue;
    const key = rec.sex ? `${rec.name}__${rec.sex}` : rec.name;
    const existing = map.get(key);
    if (!existing) {
      map.set(key, rec);
      continue;
    }
    const existingRank = existing.rank ?? Infinity;
    const candidateRank = rec.rank ?? Infinity;
    if (candidateRank < existingRank) {
      map.set(key, rec);
    }
  }
  return Array.from(map.values());
}

async function applyFiltersAndStart() {
  if (!state.rawRecords.length) return false;
  const filters = readFilterValues();
  const filtered = filterRecords(state.rawRecords, filters);
  const uniqueRecords = dedupeByName(filtered);
  state.filters = filters;
  state.totalMatches = 0;
  state.pairHistory = [];
  state.currentPair = null;
  state.items = [];
  if (uniqueRecords.length < 2) {
    state.datasetKey = null;
    el.datasetLabel.textContent = `Dataset: ${uniqueRecords.length} matching names`;
    setArenaMessage('Not enough names match these filters. Adjust and try again.');
    renderStatus();
    return false;
  }
  const items = buildItems(uniqueRecords);
  const filterSignature = `${filters.sex}|${filters.rankMin}|${filters.rankMax}|${filters.yearMin}|${filters.yearMax}`;
  state.datasetKey = await hashDatasetKey(items.map(x => x.name).concat([filterSignature]));
  state.items = items;
  el.datasetLabel.textContent = `Dataset: ${items.length} names (${describeFilters(filters)})`;
  loadFromLocalStorage(state.datasetKey, state.items);
  renderStatus();
  setArenaMessage('');
  next();
  return true;
}

function resetElo() {
  for (const it of state.items) {
    it.elo = 1500;
    it.games = 0;
    it.wins = 0;
    it.losses = 0;
    it.active = true; // also re-enable any removed names
  }
  state.totalMatches = 0;
  state.pairHistory = []; // clear recent-pair history too
  saveToLocalStorage();
  renderStatus();
  if (state.items.length >= 2) next();
}

// Event wiring
el.kFactor.addEventListener('change', () => {
  const v = parseInt(el.kFactor.value, 10);
  if (isFinite(v) && v >= 4 && v <= 64) state.k = v;
});
if (el.resultsBtn) {
  el.resultsBtn.addEventListener('click', showResultsPanel);
}
if (el.filterBtn) {
  el.filterBtn.addEventListener('click', showFilterPanel);
}
if (el.filters.closeBtn) {
  el.filters.closeBtn.addEventListener('click', hideFilterPanel);
}
if (el.filters.panel) {
  el.filters.panel.addEventListener('click', (e) => {
    if (e.target === el.filters.panel) hideFilterPanel();
  });
}
if (el.resultsPanel.closeBtn) {
  el.resultsPanel.closeBtn.addEventListener('click', hideResultsPanel);
}
if (el.resultsPanel.panel) {
  el.resultsPanel.panel.addEventListener('click', (e) => {
    if (e.target === el.resultsPanel.panel) hideResultsPanel();
  });
}
if (el.filters.applyBtn) {
  el.filters.applyBtn.addEventListener('click', async () => {
    if (!state.rawRecords.length) return;
    const btn = el.filters.applyBtn;
    const prev = btn.textContent;
    btn.disabled = true;
    btn.textContent = 'Applying…';
    let applied = false;
    try {
      applied = await applyFiltersAndStart();
    } catch (e) {
      console.error('Failed to apply filters', e);
      alert('Failed to apply filters. Please try again.');
    } finally {
      btn.disabled = false;
      btn.textContent = prev;
    }
    if (applied) hideFilterPanel();
  });
}

// Card click selections
el.left.card.addEventListener('click', () => onPick('left'));
el.right.card.addEventListener('click', () => onPick('right'));
if (el.left.removeBtn) {
  el.left.removeBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    removeSide('left');
  });
}
if (el.right.removeBtn) {
  el.right.removeBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    removeSide('right');
  });
}

// Keyboard controls
window.addEventListener('keydown', (e) => {
  if (e.key === 'ArrowLeft') { e.preventDefault(); onPick('left'); }
  else if (e.key === 'ArrowRight') { e.preventDefault(); onPick('right'); }
  else if (e.key === 'x' || e.key === 'X') { e.preventDefault(); removeSide('left'); }
  else if (e.key === 'c' || e.key === 'C') { e.preventDefault(); removeSide('right'); }
});

window.addEventListener('load', () => {
  initializeDataset().catch((e) => {
    console.error('Failed to initialize dataset', e);
  });
});
