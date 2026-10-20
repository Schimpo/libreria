// Interfaccia dell'app: libreria, club, prestiti, scheda libro, scansione, statistiche.
import * as db from './db.js';
import { normalizeIsbn, lookupIsbn, searchBooks } from './lookup.js';
import { canScan, scanIsbn } from './scanner.js';
import {
  $, el, stars, coverElement, simplify, plural, sum, today, formatDate, since, ago, joinNames,
  errorMessage, toast, numberFormat, decimalFormat, toName, openDialog,
} from './ui.js';

const STATUS_LABELS = {
  to_read: 'Da leggere',
  reading: 'In lettura',
  read: 'Letto',
  abandoned: 'Abbandonato',
};

// "Voglio leggere": da leggere e non ancora tuo.
const isWish = (b) => !b.owned && b.status === 'to_read';

const FILTERS = {
  all: () => true,
  wishlist: isWish,
  owned: (b) => b.owned,
  read: (b) => b.status === 'read',
  reading: (b) => b.status === 'reading',
  to_read: (b) => b.status === 'to_read',
  lent: (b) => b.owned && b.lent_to,
  not_owned: (b) => !b.owned,
  shared: (b) => b.shared,
};

// Filtri del club: lavorano su gruppi (stesso libro condiviso da più membri).
const CLUB_FILTERS = {
  all: () => true,
  available: (group, me) => group.entries.some((e) => e.available && e.owner_id !== me),
  liked: (group) => group.entries.some((e) => e.rating >= 4),
  mine: (group, me) => group.entries.some((e) => e.owner_id === me),
};

const state = {
  user: null,        // { id, email } di chi ha fatto l'accesso
  viewUserId: undefined,
  loading: false,
  offline: false,    // true se stiamo mostrando la copia salvata senza connessione
  books: [],
  filter: 'all',
  query: '',
  sort: 'recent',
  editingId: null,   // id del libro aperto nella scheda, null se nuovo
  editingBook: null, // dati con cui è stata aperta la scheda
  view: 'library',   // 'library', 'club' oppure 'loans'
  profile: null,     // { display_name } oppure null se non ancora scelto
  loans: [],
  loansError: null,
  goal: null,
  readThisYear: 0,
  club: { books: [], error: null, filter: 'all', member: '', query: '', lastSeen: null, seenNow: null },
};

let scanController;

// ---------- Avvio e accesso ----------

async function init() {
  bindEvents();
  registerServiceWorker();
  $('#demo-banner').hidden = !db.isDemo;
  db.onAuthChange(showView);
  window.addEventListener('online', () => {
    if (state.offline) location.reload();
  });

  const user = await db.getUser();
  const copy = db.readOfflineCopy();
  if (!user && !navigator.onLine && copy) showOffline(copy);
  else showView(user);
}

async function showView(user) {
  if (state.offline && !user) return; // senza rete Supabase non riconosce la sessione: restiamo sulla copia
  const userId = user?.id ?? null;
  if (userId === state.viewUserId) return;
  state.viewUserId = userId;

  state.user = user ? { id: user.id, email: user.email } : null;
  state.offline = false;
  state.books = [];
  state.profile = null;
  state.loans = [];
  state.goal = null;
  state.club.books = [];
  state.club.lastSeen = readClubSeen();
  $('#login-view').hidden = Boolean(user);
  $('#app-view').hidden = !user;
  $('#offline-banner').hidden = true;
  if (!user) return;

  state.loading = true;
  switchView('library');
  await loadBooks();
  loadSocial();
  // Al primo accesso si chiede il nome da mostrare nel club.
  if (await loadProfile() && !state.profile && !db.isDemo) openProfile(true);
}

// Senza connessione mostra l'ultima copia salvata dei tuoi libri, in sola lettura.
function showOffline(copy) {
  state.offline = true;
  state.viewUserId = copy.userId;
  state.user = { id: copy.userId, email: copy.email };
  state.books = copy.books;
  $('#login-view').hidden = true;
  $('#app-view').hidden = false;
  $('#offline-banner').hidden = false;
  switchView('library');
}

async function loadBooks() {
  try {
    state.books = await db.listBooks();
    if (!db.isDemo) db.saveOfflineCopy(state.user, state.books);
  } catch (error) {
    const copy = db.readOfflineCopy();
    if (copy?.userId === state.user.id) {
      state.books = copy.books;
      state.offline = true;
      $('#offline-banner').hidden = false;
    } else {
      toast(`Impossibile caricare i libri: ${errorMessage(error)}`, true);
    }
  }
  state.loading = false;
  render();
}

// Club e prestiti servono anche nella libreria ("Chi ce l'ha?") e per i numeri sulle schede.
async function loadSocial() {
  await Promise.all([loadClub(), loadLoans()]);
  render();
}

async function handleLogin(event) {
  event.preventDefault();
  const form = event.currentTarget;
  const button = form.querySelector('button[type="submit"]');
  $('#login-error').textContent = '';
  button.disabled = true;
  try {
    await db.signIn(form.email.value.trim(), form.password.value);
    form.reset();
  } catch (error) {
    $('#login-error').textContent = errorMessage(error);
  } finally {
    button.disabled = false;
  }
}

function registerServiceWorker() {
  // In sviluppo (localhost) resta spento, così si vedono subito le modifiche; ?sw lo accende.
  const local = ['localhost', '127.0.0.1'].includes(location.hostname);
  if (!('serviceWorker' in navigator) || (local && !new URLSearchParams(location.search).has('sw'))) return;
  navigator.serviceWorker.register('sw.js').catch(() => {});
}

// ---------- Eventi ----------

function bindEvents() {
  $('#login-form').addEventListener('submit', handleLogin);
  $('#logout-btn').addEventListener('click', () => {
    $('#profile-dialog').close();
    db.signOut();
  });
  $('#tabs').addEventListener('click', (e) => {
    const tab = e.target.closest('[data-view]');
    if (tab) switchView(tab.dataset.view);
  });

  // Libreria
  $('#search').addEventListener('input', (e) => {
    state.query = e.target.value;
    render();
  });
  $('#filters').addEventListener('click', (e) => {
    const button = e.target.closest('[data-filter]');
    if (!button) return;
    state.filter = button.dataset.filter;
    for (const b of $('#filters').children) b.setAttribute('aria-pressed', b === button);
    render();
  });
  $('#sort').addEventListener('change', (e) => {
    state.sort = e.target.value;
    render();
  });
  $('#book-list').addEventListener('click', (e) => {
    const item = e.target.closest('[data-id]');
    if (item) openBookForm(findBook(item.dataset.id));
  });

  // Club
  $('#club-search').addEventListener('input', (e) => {
    state.club.query = e.target.value;
    renderClub();
  });
  $('#club-filters').addEventListener('click', (e) => {
    const button = e.target.closest('[data-filter]');
    if (!button) return;
    state.club.filter = button.dataset.filter;
    for (const b of $('#club-filters').children) b.setAttribute('aria-pressed', b === button);
    renderClub();
  });
  $('#club-member').addEventListener('change', (e) => {
    state.club.member = e.target.value;
    renderClub();
  });
  $('#club-list').addEventListener('click', (e) => {
    const target = e.target.closest('[data-id], [data-want], [data-request], [data-cancel]');
    if (!target) return;
    if (target.dataset.id) openBookForm(findBook(target.dataset.id));
    if (target.dataset.want) addToWishlist(target.dataset.want, target);
    if (target.dataset.request) askToBorrow(target.dataset.request, target);
    if (target.dataset.cancel) cancelRequest(target.dataset.cancel, target);
  });

  // Prestiti
  $('#loans-sections').addEventListener('click', (e) => {
    const target = e.target.closest('[data-accept], [data-decline], [data-returned], [data-cancel]');
    if (!target) return;
    if (target.dataset.accept) answerRequest(target.dataset.accept, true, target);
    if (target.dataset.decline) answerRequest(target.dataset.decline, false, target);
    if (target.dataset.returned) markReturned(target.dataset.returned, target);
    if (target.dataset.cancel) cancelRequest(target.dataset.cancel, target);
  });

  // Aggiunta e scansione
  $('#add-btn').addEventListener('click', openAddDialog);
  $('#scan-btn').addEventListener('click', startScan);
  $('#add-scan-btn').addEventListener('click', startScan);
  $('#isbn-form').addEventListener('submit', handleIsbnSearch);
  $('#search-form').addEventListener('submit', handleTitleSearch);
  $('#manual-btn').addEventListener('click', () => openBookForm({}));

  // Scheda libro
  $('#book-form').addEventListener('submit', handleSave);
  $('#book-form').addEventListener('change', (e) => {
    const name = e.target.name;
    if (name === 'status') onStatusChange();
    if (name === 'intent') onIntentChange();
    if (name === 'owned') syncIntent();
    if (name === 'owned' || name === 'shared' || name === 'lent_to') updateFormVisibility();
    if (name === 'cover_url' || name === 'title') updateCoverPreview();
  });
  $('#delete-btn').addEventListener('click', handleDelete);
  $('#returned-btn').addEventListener('click', handleReturnedInForm);
  $('#book-whohas-btn').addEventListener('click', (e) => {
    askToBorrow(e.currentTarget.dataset.entry, e.currentTarget);
  });
  $('#rating').addEventListener('click', (e) => {
    const star = e.target.closest('[data-value]');
    if (!star) return;
    const input = $('#book-form').elements.rating;
    // Cliccando di nuovo la stessa stella il voto si cancella.
    input.value = input.value === star.dataset.value ? '' : star.dataset.value;
    renderRating();
  });

  // Statistiche e profilo
  $('#stats-btn').addEventListener('click', openStats);
  $('#export-btn').addEventListener('click', exportCsv);
  $('#goal-form').addEventListener('submit', handleGoalSave);
  $('#profile-btn').addEventListener('click', () => openProfile());
  $('#profile-form').addEventListener('submit', handleProfileSave);
  $('#password-form').addEventListener('submit', handlePasswordChange);

  $('#scan-dialog').addEventListener('close', () => scanController?.abort());
  $('#scan-video').addEventListener('playing', () => {
    $('#scan-status').textContent = 'Inquadra il codice a barre sul retro del libro';
  });

  // Pulsanti "chiudi" e clic sullo sfondo scuro
  for (const dialog of document.querySelectorAll('dialog')) {
    dialog.addEventListener('click', (e) => {
      if (e.target.closest('[data-close]')) dialog.close();
      else if (e.target === dialog && dialog.id !== 'book-dialog') dialog.close();
    });
  }
}

function switchView(view) {
  // Uscendo dal club, le novità appena viste smettono di essere "nuove".
  if (state.view === 'club' && view !== 'club' && state.club.seenNow) state.club.lastSeen = state.club.seenNow;
  state.view = view;
  for (const tab of $('#tabs').children) tab.setAttribute('aria-selected', tab.dataset.view === view);
  $('#library-view').hidden = view !== 'library';
  $('#club-view').hidden = view !== 'club';
  $('#loans-view').hidden = view !== 'loans';
  $('.fab-group').hidden = state.offline;
  if (view === 'library') render();
  if (view === 'club') loadClub();
  if (view === 'loans') loadLoans();
  updateBadges();
}

function updateBadges() {
  const news = state.view === 'club' ? 0 : clubNewsCount();
  const requests = state.loans.filter((l) => l.my_role === 'owner' && l.status === 'requested').length;
  setBadge('#club-badge', news, `${news} novità`);
  setBadge('#loans-badge', requests, plural(requests, 'richiesta da approvare', 'richieste da approvare'));
}

function setBadge(selector, count, label) {
  const badge = $(selector);
  badge.hidden = !count;
  badge.textContent = count > 9 ? '9+' : String(count);
  badge.setAttribute('aria-label', label);
}

// ---------- Libreria ----------

function render() {
  const books = visibleBooks();
  $('#book-list').replaceChildren(...books.map(bookItem));

  const total = state.books.length;
  if (state.loading) {
    $('#count').textContent = 'Carico i tuoi libri…';
    $('#empty').hidden = true;
    return;
  }
  $('#count').textContent = books.length === total
    ? plural(total, 'libro', 'libri')
    : `${books.length} di ${plural(total, 'libro', 'libri')}`;

  $('#empty').hidden = books.length > 0;
  if (!total) {
    $('#empty-title').textContent = 'La tua libreria è vuota';
    $('#empty-text').textContent = 'Aggiungi il primo libro con “Aggiungi”, oppure inquadra il codice a barre con “Scansiona”.';
  } else if (state.filter === 'wishlist' && !state.query.trim()) {
    $('#empty-title').textContent = 'Nessun libro da leggere in lista';
    $('#empty-text').textContent = 'Quando aggiungi un libro scegli “Voglio leggerlo”, '
      + 'oppure premi “Voglio leggerlo” su un libro consigliato nel Club.';
  } else {
    $('#empty-title').textContent = 'Nessun risultato';
    $('#empty-text').textContent = 'Nessun libro corrisponde alla ricerca o al filtro scelto.';
  }
}

function visibleBooks() {
  const query = simplify(state.query.trim());
  const books = state.books.filter((b) => FILTERS[state.filter](b) && (!query || matches(b, query)));
  return books.sort(SORTERS[state.sort]);
}

function matches(book, query) {
  return [book.title, book.authors, book.isbn, book.publisher, book.genre, book.recommended_by]
    .some((value) => value && simplify(value).includes(query));
}

const byTitle = (a, b) => a.title.localeCompare(b.title, 'it', { sensitivity: 'base' });
const SORTERS = {
  recent: (a, b) => b.created_at.localeCompare(a.created_at),
  title: byTitle,
  author: (a, b) => authorKey(a).localeCompare(authorKey(b), 'it', { sensitivity: 'base' }) || byTitle(a, b),
  finished: (a, b) => (b.finished_at ?? '').localeCompare(a.finished_at ?? '') || byTitle(a, b),
  rating: (a, b) => (b.rating ?? 0) - (a.rating ?? 0) || byTitle(a, b),
};

// Ordina per cognome del primo autore ("Umberto Eco" → "Eco Umberto").
function authorKey(book) {
  const first = (book.authors ?? '').split(',')[0].trim();
  const parts = first.split(/\s+/);
  return parts.length > 1 ? `${parts.at(-1)} ${parts.slice(0, -1).join(' ')}` : first || '\uffff';
}

function bookItem(book) {
  const holders = isWish(book) ? whoHas(book) : [];
  const meta = el('span', { class: 'book-meta' },
    isWish(book)
      ? el('span', { class: 'badge badge-wish' }, 'Voglio leggerlo')
      : el('span', { class: `badge badge-${book.status}` }, STATUS_LABELS[book.status]),
    book.owned && !book.lent_to && el('span', { class: 'badge badge-owned' }, 'Posseduto'),
    book.owned && book.lent_to && el('span', { class: 'badge badge-lent' },
      `Prestato ${toName(book.lent_to)}${book.lent_at ? ` ${since(book.lent_at)}` : ''}`),
    book.shared && el('span', { class: 'badge badge-shared' }, 'Condiviso'),
    book.rating && stars(book.rating),
    holders.length > 0 && el('span', { class: 'badge badge-available' }, holdersLabel(holders)),
  );
  return el('li', {},
    el('button', { class: 'book', type: 'button', 'data-id': book.id },
      coverElement(book),
      el('span', { class: 'book-info' },
        el('span', { class: 'book-title' }, book.title),
        book.authors && el('span', { class: 'book-authors' }, book.authors),
        book.recommended_by && el('span', { class: 'book-reco' }, `Consigliato da ${book.recommended_by}`),
        meta,
      ),
    ),
  );
}

function findBook(id) {
  return state.books.find((b) => b.id === id);
}

// Due libri sono "lo stesso" se hanno lo stesso ISBN, oppure stesso titolo e cognome del
// primo autore. Così si riconoscono edizioni e fonti diverse dello stesso libro, anche quando
// scrivono l'autore in modo diverso ("J. R. R. Tolkien" e "J.R.R. Tolkien").
function titleKey(book) {
  const firstAuthor = (book.authors ?? '').split(',')[0].trim();
  const surname = firstAuthor.split(/\s+/).at(-1);
  return simplify(`${book.title ?? ''}|${surname}`);
}

function sameBook(a, b) {
  return Boolean(a.isbn && a.isbn === b.isbn) || titleKey(a) === titleKey(b);
}

function findInLibrary(book) {
  return state.books.find((b) => sameBook(b, book));
}

// "Chi ce l'ha?": colleghi che possiedono questo libro e l'hanno condiviso.
function whoHas(book) {
  return state.club.books.filter((e) => e.owner_id !== state.user?.id && e.owned && sameBook(e, book));
}

function holdersLabel(holders) {
  const available = holders.filter((h) => h.available);
  const list = available.length ? available : holders;
  const names = joinNames([...new Set(list.map((h) => h.owner_name))]);
  const verb = list.length > 1 ? "Ce l'hanno" : "Ce l'ha";
  return `${verb} ${names}${available.length ? '' : ' (in prestito)'}`;
}

// ---------- Club ----------

async function loadClub() {
  if (state.offline) {
    state.club.error = 'Il club non è disponibile senza connessione.';
  } else {
    if (state.view === 'club') $('#club-count').textContent = 'Carico i libri del club…';
    try {
      state.club.books = await db.listClubBooks();
      state.club.error = null;
    } catch (error) {
      state.club.books = [];
      state.club.error = error.code === 'PGRST202'
        ? 'La sezione club non è ancora attiva: esegui supabase/02-club.sql nel SQL Editor di Supabase.'
        : `Impossibile caricare il club: ${errorMessage(error)}`;
    }
  }
  if (state.view === 'club') {
    renderClub();
    markClubSeen();
  }
  updateBadges();
}

function clubSeenKey() {
  return `libreria-club-visto-${state.user?.id}`;
}

function readClubSeen() {
  try {
    return localStorage.getItem(clubSeenKey());
  } catch {
    return null;
  }
}

// Le novità restano evidenziate finché resti nel club; il numero sulla scheda si azzera.
function markClubSeen() {
  state.club.seenNow = new Date().toISOString();
  try {
    localStorage.setItem(clubSeenKey(), state.club.seenNow);
  } catch {
    // archivio non disponibile: le novità verranno ricontate alla prossima visita
  }
}

function isNewEntry(entry) {
  const changed = entry.club_updated_at ?? entry.created_at;
  return entry.owner_id !== state.user?.id && (!state.club.lastSeen || changed > state.club.lastSeen);
}

function clubNewsCount() {
  return groupClubBooks(state.club.books).filter((g) => g.entries.some(isNewEntry)).length;
}

function renderClub() {
  const me = state.user?.id;
  const { books, filter, error } = state.club;
  const query = simplify(state.club.query.trim());

  // Menu dei membri, ricostruito ogni volta mantenendo la scelta fatta.
  const members = new Map(books.map((b) => [b.owner_id, b.owner_id === me ? 'Tu' : b.owner_name]));
  const select = $('#club-member');
  select.replaceChildren(
    el('option', { value: '' }, 'tutti i membri'),
    ...[...members]
      .sort(([, a], [, b]) => a.localeCompare(b, 'it'))
      .map(([id, name]) => el('option', { value: id }, name)),
  );
  select.value = members.has(state.club.member) ? state.club.member : '';
  state.club.member = select.value;

  const groups = groupClubBooks(books);
  const visible = groups.filter((g) => CLUB_FILTERS[filter](g, me)
    && (!state.club.member || g.entries.some((e) => e.owner_id === state.club.member))
    && (!query || matches(g, query) || g.entries.some((e) => simplify(e.owner_name).includes(query))));

  $('#club-list').replaceChildren(...visible.map(clubItem));
  $('#club-count').textContent = error ? '' : visible.length === groups.length
    ? plural(groups.length, 'libro', 'libri')
    : `${visible.length} di ${plural(groups.length, 'libro', 'libri')}`;

  $('#club-empty').hidden = visible.length > 0;
  if (error) {
    $('#club-empty-title').textContent = 'Club non disponibile';
    $('#club-empty-text').textContent = error;
  } else if (groups.length) {
    $('#club-empty-title').textContent = 'Nessun risultato';
    $('#club-empty-text').textContent = 'Nessun libro corrisponde alla ricerca o al filtro scelto.';
  } else {
    $('#club-empty-title').textContent = 'Nessun libro condiviso';
    $('#club-empty-text').textContent = 'Apri un libro della tua libreria e attiva “Condividi con il club”: '
      + 'lo vedranno tutti i membri, insieme al tuo voto e al tuo commento.';
  }
}

// Riunisce in una sola scheda lo stesso libro condiviso da più membri.
// L'ordine è quello delle novità più recenti.
function groupClubBooks(books) {
  const groups = new Map();
  for (const book of books) {
    const key = titleKey(book);
    if (!groups.has(key)) groups.set(key, { ...book, key, entries: [] });
    const group = groups.get(key);
    group.cover_url ??= book.cover_url;
    group.isbn ??= book.isbn;
    group.entries.push(book);
  }
  return [...groups.values()];
}

function clubItem(group) {
  const ratings = group.entries.map((e) => e.rating).filter(Boolean);
  const average = ratings.length ? ratings.reduce((a, b) => a + b, 0) / ratings.length : 0;
  const isNew = group.entries.some(isNewEntry);
  const mine = findInLibrary(group);

  let action;
  if (!mine) {
    action = el('button', { class: 'btn btn-secondary btn-small', type: 'button', 'data-want': group.key }, 'Voglio leggerlo');
  } else if (isWish(mine)) {
    action = el('span', { class: 'badge badge-wish' }, 'Nella tua lista');
  } else {
    action = el('span', { class: 'badge badge-owned' }, 'Nella tua libreria');
  }

  return el('li', { class: `club-card${isNew ? ' is-new' : ''}` },
    el('div', { class: 'club-head' },
      coverElement(group),
      el('div', { class: 'book-info' },
        el('span', { class: 'book-title' }, group.title),
        group.authors && el('span', { class: 'book-authors' }, group.authors),
        ratings.length > 0 && el('span', { class: 'club-avg' },
          el('span', { class: 'stars', 'aria-hidden': 'true' }, '★'),
          `${decimalFormat.format(average)} su 5 · ${plural(ratings.length, 'voto', 'voti')}`),
        el('span', { class: 'club-actions' },
          isNew && el('span', { class: 'badge badge-new' }, 'Novità'),
          action,
        ),
      ),
    ),
    el('ul', { class: 'club-entries' }, ...group.entries.map(clubEntry)),
  );
}

function clubEntry(entry) {
  const mine = entry.owner_id === state.user?.id;
  const request = activeRequest(entry.id);
  let availability;
  if (entry.lent_to_me) availability = el('span', { class: 'badge badge-available' }, "Ce l'hai tu in prestito");
  else if (!entry.owned) availability = el('span', { class: 'badge badge-owned' }, 'Non lo possiede');
  else if (entry.available) availability = el('span', { class: 'badge badge-available' }, 'Disponibile');
  else availability = el('span', { class: 'badge badge-lent' }, 'In prestito');

  let action = null;
  if (mine) {
    action = el('button', { class: 'link-btn', type: 'button', 'data-id': entry.id }, 'Modifica');
  } else if (request) {
    action = el('span', { class: 'entry-request' }, 'Richiesta inviata · ',
      el('button', { class: 'link-btn', type: 'button', 'data-cancel': request.id }, 'Annulla'));
  } else if (entry.owned && entry.available) {
    action = el('button', { class: 'link-btn', type: 'button', 'data-request': entry.id }, 'Chiedi in prestito');
  }

  return el('li', {},
    el('div', { class: 'club-entry-head' },
      el('span', { class: 'club-owner' }, mine ? 'Tu' : entry.owner_name),
      el('span', { class: `badge badge-${entry.status}` }, STATUS_LABELS[entry.status]),
      entry.rating && stars(entry.rating),
      availability,
      action,
    ),
    entry.club_comment && el('p', { class: 'club-comment' }, entry.club_comment),
  );
}

// Aggiunge alla lista "Voglio leggere" un libro visto nel club, ricordando chi lo consiglia.
async function addToWishlist(key, button) {
  const group = groupClubBooks(state.club.books).find((g) => g.key === key);
  if (!group) return;
  const others = group.entries.filter((e) => e.owner_id !== state.user?.id);
  const fans = others.filter((e) => e.rating >= 4);
  const names = [...new Set((fans.length ? fans : others).map((e) => e.owner_name))];
  const pick = (field) => group.entries.find((e) => e[field] != null)?.[field] ?? null;

  button.disabled = true;
  try {
    const created = await db.createBook({
      title: group.title,
      authors: group.authors ?? null,
      isbn: pick('isbn'),
      publisher: pick('publisher'),
      published_year: pick('published_year'),
      pages: pick('pages'),
      genre: pick('genre'),
      cover_url: pick('cover_url'),
      owned: false,
      status: 'to_read',
      recommended_by: names.length ? joinNames(names) : null,
    });
    state.books = [created, ...state.books];
    render();
    renderClub();
    toast('Aggiunto alla lista “Voglio leggere”.');
  } catch (error) {
    button.disabled = false;
    toast(errorMessage(error), true);
  }
}

// ---------- Prestiti ----------

async function loadLoans() {
  if (state.offline) {
    state.loansError = 'I prestiti non sono disponibili senza connessione.';
  } else {
    try {
      state.loans = await db.listLoans();
      state.loansError = null;
    } catch (error) {
      state.loans = [];
      state.loansError = error.code === 'PGRST202'
        ? 'La sezione prestiti non è ancora attiva: esegui supabase/03-prestiti.sql nel SQL Editor di Supabase.'
        : `Impossibile caricare i prestiti: ${errorMessage(error)}`;
    }
  }
  updateBadges();
  if (state.view === 'loans') renderLoans();
  if (state.view === 'club') renderClub();
}

// Richiesta ancora aperta (in attesa di risposta) fatta da te per questo libro del club.
function activeRequest(bookId) {
  return state.loans.find((l) => l.book_id === bookId && l.my_role === 'borrower' && l.status === 'requested');
}

function renderLoans() {
  const loans = state.loans;
  const incoming = loans.filter((l) => l.my_role === 'owner' && l.status === 'requested');
  const borrowed = loans.filter((l) => l.my_role === 'borrower' && l.status === 'accepted');
  const lent = state.books.filter((b) => b.owned && b.lent_to);
  const outgoing = loans.filter((l) => l.my_role === 'borrower' && ['requested', 'declined'].includes(l.status));

  const smallBtn = (label, attr, id, primary = false) => el('button', {
    class: `btn btn-small ${primary ? 'btn-primary' : 'btn-secondary'}`, type: 'button', [attr]: id,
  }, label);

  const sections = [
    ['Richieste da approvare', incoming.map((l) => loanRow(l,
      `${l.other_name} vorrebbe prenderlo in prestito`,
      `Richiesta di ${ago(l.requested_at)}`,
      smallBtn('Accetta', 'data-accept', l.id, true),
      smallBtn('Rifiuta', 'data-decline', l.id)))],
    ['Ho in prestito', borrowed.map((l) => loanRow(l,
      `Prestato da ${l.other_name} ${since(l.answered_at ?? l.requested_at)}`,
      `Quando lo restituisci, ${l.other_name} lo segnerà come restituito.`))],
    ['Ho prestato', lent.map((b) => loanRow(b,
      `Prestato ${toName(b.lent_to)}${b.lent_at ? ` ${since(b.lent_at)}` : ''}`,
      b.borrower_id ? 'Prestito fatto tramite il club' : null,
      smallBtn('Restituito', 'data-returned', b.id)))],
    ['Le mie richieste', outgoing.map((l) => (l.status === 'declined'
      ? loanRow(l, `${l.other_name} non può prestarlo ora`, `Risposta di ${ago(l.answered_at ?? l.requested_at)}`)
      : loanRow(l, `Chiesto ${toName(l.other_name)}, in attesa di risposta`, `Richiesta di ${ago(l.requested_at)}`,
        smallBtn('Annulla', 'data-cancel', l.id))))],
  ].filter(([, rows]) => rows.length);

  $('#loans-sections').replaceChildren(...sections.map(([title, rows]) => el('section', { class: 'loan-section' },
    el('h2', { class: 'section-title' }, title),
    el('ul', { class: 'loan-list' }, ...rows),
  )));

  $('#loans-empty').hidden = sections.length > 0;
  $('#loans-empty-title').textContent = state.loansError ? 'Prestiti non disponibili' : 'Nessun prestito in corso';
  $('#loans-empty-text').textContent = state.loansError
    ?? 'Nel Club puoi chiedere in prestito i libri disponibili dei colleghi. Qui vedrai le richieste '
      + 'ricevute e fatte, i libri che hai prestato e quelli che hai in prestito.';
}

function loanRow(book, text, detail, ...actions) {
  return el('li', { class: 'loan-row' },
    coverElement(book),
    el('div', { class: 'loan-info' },
      el('span', { class: 'loan-title' }, book.title),
      el('span', { class: 'loan-text' }, text),
      detail && el('span', { class: 'loan-detail' }, detail),
    ),
    actions.length > 0 && el('div', { class: 'loan-actions' }, ...actions),
  );
}

async function askToBorrow(clubBookId, button) {
  const entry = state.club.books.find((b) => b.id === clubBookId);
  button.disabled = true;
  try {
    await db.requestLoan(clubBookId);
    toast(`Richiesta inviata ${entry ? toName(entry.owner_name) : 'a chi possiede il libro'}.`);
    await loadLoans();
    if ($('#book-dialog').open) updateWhoHas();
  } catch (error) {
    toast(errorMessage(error), true);
  } finally {
    button.disabled = false;
  }
}

async function cancelRequest(loanId, button) {
  button.disabled = true;
  try {
    await db.cancelLoan(loanId);
    toast('Richiesta annullata.');
    await loadLoans();
  } catch (error) {
    button.disabled = false;
    toast(errorMessage(error), true);
  }
}

async function answerRequest(loanId, accept, button) {
  const loan = state.loans.find((l) => l.id === loanId);
  button.disabled = true;
  try {
    await db.respondLoan(loanId, accept);
    toast(accept
      ? `Fatto: “${loan?.title}” risulta prestato ${toName(loan?.other_name ?? '')}.`
      : 'Richiesta rifiutata.');
    if (accept) await loadBooks(); // il libro ora risulta prestato
    await loadLoans();
  } catch (error) {
    button.disabled = false;
    toast(errorMessage(error), true);
  }
}

async function markReturned(bookId, button) {
  button.disabled = true;
  try {
    const updated = await db.updateBook(bookId, { lent_to: null });
    state.books = state.books.map((b) => (b.id === updated.id ? updated : b));
    render();
    toast('Segnato come restituito.');
    await loadLoans(); // un prestito fatto tramite il club si chiude da solo
  } catch (error) {
    button.disabled = false;
    toast(errorMessage(error), true);
  }
}

// ---------- Aggiunta ----------

function openAddDialog() {
  $('#isbn-form').reset();
  $('#search-form').reset();
  $('#isbn-error').textContent = '';
  $('#search-status').textContent = '';
  $('#search-results').replaceChildren();
  openDialog($('#add-dialog'));
}

async function handleIsbnSearch(event) {
  event.preventDefault();
  const raw = $('#isbn-input').value;
  const isbn = normalizeIsbn(raw);
  if (!isbn) {
    $('#isbn-error').textContent = raw.trim()
      ? 'Questo non sembra un ISBN valido: controlla le cifre.'
      : 'Scrivi un codice ISBN (lo trovi sul retro, sopra il codice a barre).';
    return;
  }
  const button = event.currentTarget.querySelector('[type="submit"]');
  button.disabled = true;
  button.textContent = 'Cerco…';
  await openIsbn(isbn);
  button.disabled = false;
  button.textContent = 'Cerca';
}

// Apre la scheda del libro con questo ISBN: quella esistente se è già in
// libreria, altrimenti una nuova compilata con i dati trovati online.
async function openIsbn(isbn) {
  const existing = state.books.find((b) => b.isbn === isbn);
  if (existing) {
    openBookForm(existing, isWish(existing)
      ? 'Questo libro è già nella tua lista “Voglio leggere”.'
      : 'Questo libro è già nella tua libreria.');
    return;
  }
  const found = await lookupIsbn(isbn).catch(() => null);
  if (found) {
    openBookForm(found, 'Dati trovati online: controllali e salva.');
  } else {
    openBookForm({ isbn }, `Nessun dato trovato per l'ISBN ${isbn}: inseriscili a mano.`);
  }
}

async function handleTitleSearch(event) {
  event.preventDefault();
  const query = $('#search-input').value.trim();
  if (!query) return;
  const status = $('#search-status');
  const list = $('#search-results');
  status.textContent = 'Cerco…';
  list.replaceChildren();
  try {
    const results = await searchBooks(query);
    status.textContent = results.length
      ? 'Scegli il libro giusto:'
      : 'Nessun risultato. Prova con altre parole o inseriscilo a mano.';
    list.replaceChildren(...results.map((book) => {
      const sub = [book.authors, book.publisher, book.published_year].filter(Boolean).join(' · ');
      const button = el('button', { class: 'result', type: 'button' },
        coverElement(book),
        el('span', {},
          el('span', { class: 'result-title' }, book.title),
          sub && el('span', { class: 'result-sub' }, sub),
        ),
      );
      button.addEventListener('click', () => {
        const existing = book.isbn && state.books.find((b) => b.isbn === book.isbn);
        if (existing) openBookForm(existing, 'Questo libro è già nella tua libreria.');
        else openBookForm(book, 'Controlla i dati e salva.');
      });
      return el('li', {}, button);
    }));
  } catch (error) {
    status.textContent = errorMessage(error);
  }
}

// ---------- Scansione ----------

async function startScan() {
  if (!canScan()) {
    toast('La fotocamera non è disponibile su questo browser (serve una connessione https).', true);
    return;
  }
  $('#add-dialog').close();
  const dialog = $('#scan-dialog');
  scanController = new AbortController();
  $('#scan-status').textContent = 'Avvio la fotocamera…';
  openDialog(dialog);

  let isbn;
  try {
    isbn = await scanIsbn($('#scan-video'), scanController.signal);
  } catch (error) {
    if (error.name === 'AbortError') return;
    dialog.close();
    toast(error.name === 'NotAllowedError'
      ? 'Permesso per la fotocamera negato: abilitalo nelle impostazioni del browser.'
      : `Impossibile usare la fotocamera: ${error.message}`, true);
    return;
  }
  navigator.vibrate?.(80);
  dialog.close();
  toast(`ISBN ${isbn}: cerco il libro…`);
  await openIsbn(isbn);
}

// ---------- Scheda libro ----------

function openBookForm(book, notice = '') {
  const form = $('#book-form');
  const isNew = !book.id;
  state.editingId = book.id ?? null;
  state.editingBook = book;
  form.reset();

  const values = {
    owned: true,
    status: 'to_read',
    ...Object.fromEntries(Object.entries(book).filter(([, v]) => v != null)),
  };
  values.intent = values.owned ? 'have' : 'want';
  for (const input of form.elements) {
    if (!input.name) continue;
    if (input.type === 'checkbox') input.checked = Boolean(values[input.name]);
    else if (input.type === 'radio') input.checked = input.value === values[input.name];
    else input.value = values[input.name] ?? '';
  }

  $('#book-dialog-title').textContent = isNew ? 'Nuovo libro' : 'Scheda del libro';
  $('#book-notice').textContent = notice;
  $('#book-notice').hidden = !notice;
  $('#book-error').textContent = '';
  $('#delete-btn').hidden = isNew;
  $('#intent-field').hidden = !isNew;
  form.querySelector('details.more').open = isNew && !book.title;

  renderRating();
  updateFormVisibility();
  updateCoverPreview();
  updateWhoHas();

  $('#add-dialog').close();
  const dialog = $('#book-dialog');
  openDialog(dialog);
  form.scrollTop = 0;
}

// Nella scheda di un libro che non hai, dice chi del club ce l'ha e permette di chiederlo.
function updateWhoHas() {
  const book = state.editingBook;
  const form = $('#book-form').elements;
  const holders = book && !form.owned.checked ? whoHas({ ...book, title: form.title.value, authors: form.authors.value }) : [];
  $('#book-whohas').hidden = holders.length === 0;
  if (!holders.length) return;

  const requested = holders.find((h) => activeRequest(h.id));
  const available = holders.find((h) => h.available && !h.lent_to_me);
  const button = $('#book-whohas-btn');
  $('#book-whohas-text').textContent = `${holdersLabel(holders)}${requested ? ' · richiesta inviata' : ''}.`;
  button.hidden = Boolean(requested || !available || state.offline);
  if (available) {
    button.dataset.entry = available.id;
    button.textContent = `Chiedi in prestito ${toName(available.owner_name)}`;
  }
}

function onStatusChange() {
  const form = $('#book-form');
  const status = form.elements.status.value;
  if (status === 'reading' && !form.elements.started_at.value) form.elements.started_at.value = today();
  if (status === 'read' && !form.elements.finished_at.value) form.elements.finished_at.value = today();
  updateFormVisibility();
}

// Scelta rapida per i libri nuovi: "Ce l'ho" o "Voglio leggerlo".
function onIntentChange() {
  const form = $('#book-form').elements;
  const want = form.intent.value === 'want';
  form.owned.checked = !want;
  if (want) {
    for (const radio of form.status) radio.checked = radio.value === 'to_read';
  }
  updateFormVisibility();
}

function syncIntent() {
  const form = $('#book-form').elements;
  for (const radio of form.intent) radio.checked = radio.value === (form.owned.checked ? 'have' : 'want');
}

function updateFormVisibility() {
  const form = $('#book-form').elements;
  const status = form.status.value;
  const book = state.editingBook ?? {};
  $('#started-field').hidden = status === 'to_read';
  $('#finished-field').hidden = !['read', 'abandoned'].includes(status);
  $('#lent-field').hidden = !form.owned.checked;
  $('#club-comment-field').hidden = !form.shared.checked;

  // "Restituito" e data del prestito, solo per un prestito già salvato.
  const savedLoan = state.editingId && book.lent_to && form.lent_to.value === book.lent_to;
  $('#returned-btn').hidden = !savedLoan;
  $('#lent-hint').textContent = savedLoan && book.lent_at
    ? `In prestito ${since(book.lent_at)} (dal ${formatDate(book.lent_at)})`
      + (book.borrower_id ? ' · prestito fatto tramite il club.' : '.')
    : '';
  updateWhoHas();
}

async function handleReturnedInForm(event) {
  const button = event.currentTarget;
  button.disabled = true;
  try {
    const updated = await db.updateBook(state.editingId, { lent_to: null });
    state.books = state.books.map((b) => (b.id === updated.id ? updated : b));
    state.editingBook = updated;
    $('#book-form').elements.lent_to.value = '';
    updateFormVisibility();
    render();
    toast('Segnato come restituito.');
    loadLoans();
  } catch (error) {
    toast(errorMessage(error), true);
  } finally {
    button.disabled = false;
  }
}

function updateCoverPreview() {
  const form = $('#book-form');
  const cover = coverElement({
    title: form.elements.title.value,
    cover_url: form.elements.cover_url.value.trim(),
  }, 'cover-lg');
  cover.id = 'book-cover';
  $('#book-cover').replaceWith(cover);
}

function renderRating() {
  const value = Number($('#book-form').elements.rating.value) || 0;
  $('#rating').replaceChildren(...[1, 2, 3, 4, 5].map((n) => el('button', {
    type: 'button',
    class: n <= value ? 'on' : '',
    'data-value': n,
    'aria-label': `${n} ${n === 1 ? 'stella' : 'stelle'}`,
    'aria-pressed': n === value,
  }, '★')));
}

function readForm() {
  const f = $('#book-form').elements;
  const text = (name) => f[name].value.trim() || null;
  const int = (name) => (f[name].value ? Number.parseInt(f[name].value, 10) : null);

  const isbnRaw = text('isbn');
  const isbn = isbnRaw ? normalizeIsbn(isbnRaw) : null;
  if (isbnRaw && !isbn) throw new Error('L\'ISBN non è valido: correggilo o lascialo vuoto.');

  const title = text('title');
  if (!title) throw new Error('Il titolo è obbligatorio.');

  const status = f.status.value;
  const owned = f.owned.checked;
  return {
    title,
    authors: text('authors'),
    isbn,
    publisher: text('publisher'),
    published_year: int('published_year'),
    pages: int('pages'),
    genre: text('genre'),
    language: text('language'),
    cover_url: text('cover_url'),
    owned,
    lent_to: owned ? text('lent_to') : null,
    status,
    rating: int('rating'),
    started_at: status === 'to_read' ? null : text('started_at'),
    finished_at: ['read', 'abandoned'].includes(status) ? text('finished_at') : null,
    notes: text('notes'),
    recommended_by: text('recommended_by'),
    shared: f.shared.checked,
    club_comment: text('club_comment'),
  };
}

async function handleSave(event) {
  event.preventDefault();
  const button = event.currentTarget.querySelector('[type="submit"]');
  $('#book-error').textContent = '';
  try {
    const data = readForm();
    button.disabled = true;
    if (state.editingId) {
      const updated = await db.updateBook(state.editingId, data);
      state.books = state.books.map((b) => (b.id === updated.id ? updated : b));
    } else {
      state.books = [await db.createBook(data), ...state.books];
    }
    $('#book-dialog').close();
    render();
    if (state.view === 'club') loadClub();
    if (state.view === 'loans') renderLoans();
    toast(isWish(data) && !state.editingId ? 'Aggiunto alla lista “Voglio leggere”.' : 'Libro salvato.');
    // Chi condivide il primo libro senza aver scelto un nome lo sceglie ora.
    if (data.shared && !state.profile && await loadProfile() && !state.profile) openProfile(true);
  } catch (error) {
    $('#book-error').textContent = errorMessage(error);
  } finally {
    button.disabled = false;
  }
}

async function handleDelete() {
  const book = findBook(state.editingId);
  if (!book || !confirm(`Eliminare “${book.title}” dalla libreria?`)) return;
  try {
    await db.deleteBook(book.id);
    state.books = state.books.filter((b) => b.id !== book.id);
    $('#book-dialog').close();
    render();
    if (state.view === 'club') loadClub();
    if (state.view === 'loans') loadLoans();
    toast('Libro eliminato.');
  } catch (error) {
    $('#book-error').textContent = errorMessage(error);
  }
}

// ---------- Profilo ----------

// Restituisce false se il profilo non si può leggere (es. 02-club.sql non ancora eseguito).
async function loadProfile() {
  if (state.offline) return false;
  try {
    state.profile = await db.getProfile();
    return true;
  } catch {
    state.profile = null;
    return false;
  }
}

function openProfile(isWelcome = false) {
  $('#profile-form').elements.display_name.value = state.profile?.display_name ?? '';
  $('#profile-intro').hidden = !isWelcome;
  $('#profile-error').textContent = '';
  $('#password-error').textContent = '';
  $('#password-form').reset();
  $('#password-form').hidden = db.isDemo;
  $('#logout-btn').hidden = db.isDemo;
  $('#profile-email').textContent = db.isDemo ? 'demo' : state.user?.email ?? '';
  openDialog($('#profile-dialog'));
}

async function handleProfileSave(event) {
  event.preventDefault();
  const form = event.currentTarget;
  const button = form.querySelector('[type="submit"]');
  const name = form.elements.display_name.value.trim();
  $('#profile-error').textContent = '';
  if (!name) {
    $('#profile-error').textContent = 'Scrivi il nome che vedranno gli altri.';
    return;
  }
  button.disabled = true;
  try {
    await db.saveProfile(name);
    state.profile = { display_name: name };
    $('#profile-intro').hidden = true;
    toast('Nome salvato.');
    if (state.view === 'club') loadClub();
  } catch (error) {
    $('#profile-error').textContent = errorMessage(error);
  } finally {
    button.disabled = false;
  }
}

async function handlePasswordChange(event) {
  event.preventDefault();
  const form = event.currentTarget;
  const button = form.querySelector('[type="submit"]');
  const { password, confirm } = form.elements;
  const error = $('#password-error');
  error.textContent = '';
  if (password.value.length < 8) {
    error.textContent = 'La password deve avere almeno 8 caratteri.';
    return;
  }
  if (password.value !== confirm.value) {
    error.textContent = 'Le due password non coincidono.';
    return;
  }
  button.disabled = true;
  try {
    await db.changePassword(password.value);
    form.reset();
    toast('Password cambiata.');
  } catch (e) {
    error.textContent = errorMessage(e);
  } finally {
    button.disabled = false;
  }
}

// ---------- Statistiche e obiettivo ----------

async function openStats() {
  const books = state.books;
  const year = new Date().getFullYear();
  const read = books.filter((b) => b.status === 'read');
  const readThisYear = read.filter((b) => b.finished_at?.startsWith(String(year)));
  state.readThisYear = readThisYear.length;

  const tiles = [
    ['Libri in libreria', books.length],
    ['Posseduti', books.filter((b) => b.owned).length],
    ['Letti', read.length],
    [`Letti nel ${year}`, readThisYear.length],
    [`Pagine lette nel ${year}`, sum(readThisYear, 'pages')],
    ['Voglio leggere', books.filter(isWish).length],
    ['In prestito', books.filter(FILTERS.lent).length],
    ['Condivisi con il club', books.filter(FILTERS.shared).length],
  ];
  $('#stat-tiles').replaceChildren(...tiles.map(([label, value]) => el('div', { class: 'stat' },
    el('div', { class: 'stat-label' }, label),
    el('div', { class: 'stat-value' }, numberFormat.format(value)),
  )));

  // Libri letti raggruppati per anno di fine lettura.
  const groups = new Map();
  for (const book of read) {
    const key = book.finished_at?.slice(0, 4) ?? 'Senza data';
    groups.set(key, [...(groups.get(key) ?? []), book]);
  }
  const rows = [...groups].sort(([a], [b]) => b.localeCompare(a)); // 'Senza data' resta in fondo
  const max = Math.max(1, ...rows.map(([, list]) => list.length));

  $('#year-chart').replaceChildren(...(rows.length ? rows.map(([key, list]) => {
    const pages = sum(list, 'pages');
    const description = `${key}: ${plural(list.length, 'libro', 'libri')}`
      + (pages ? ` · ${numberFormat.format(pages)} pagine` : '');
    return el('div', { class: 'year-row', tabindex: '0', 'aria-label': description },
      el('span', { class: 'year-label' }, key),
      el('span', { class: 'year-track' },
        el('span', { class: 'year-bar', style: `width:${(list.length / max) * 80}%` }),
        el('span', { class: 'year-value' }, String(list.length)),
      ),
      el('span', { class: 'year-tip', 'aria-hidden': 'true' }, description),
    );
  }) : [el('p', { class: 'muted' }, 'Quando segnerai un libro come “Letto” lo vedrai qui.')]));

  $('#goal-error').textContent = '';
  renderGoal();
  openDialog($('#stats-dialog'));

  $('#goal-form').hidden = state.offline;
  if (state.offline) return;
  try {
    state.goal = await db.getGoal(year);
  } catch (error) {
    state.goal = null;
    $('#goal-error').textContent = goalErrorMessage(error);
  }
  renderGoal();
}

function renderGoal() {
  const year = new Date().getFullYear();
  const goal = state.goal;
  const done = state.readThisYear;
  $('#goal-title').textContent = `Obiettivo ${year}`;
  $('#goal-input').value = goal ?? '';
  $('#goal-label').textContent = goal
    ? 'Cambia obiettivo (lascia vuoto per toglierlo)'
    : `Quanti libri vuoi leggere nel ${year}?`;
  if (!goal) {
    $('#goal-progress').replaceChildren();
    return;
  }
  const percent = Math.min(100, Math.round((done / goal) * 100));
  $('#goal-progress').replaceChildren(
    el('div', {
      class: 'meter', role: 'progressbar', 'aria-valuemin': 0, 'aria-valuemax': goal, 'aria-valuenow': Math.min(done, goal),
      'aria-label': `${done} libri letti su ${goal}`,
    }, el('span', { class: 'meter-fill', style: `width:${percent}%` })),
    el('p', { class: 'goal-text' }, done >= goal
      ? `Obiettivo raggiunto: ${plural(done, 'libro letto', 'libri letti')} su ${goal}!`
      : `${plural(done, 'libro letto', 'libri letti')} su ${goal} · ${percent}%`),
  );
}

async function handleGoalSave(event) {
  event.preventDefault();
  const button = event.currentTarget.querySelector('[type="submit"]');
  const raw = $('#goal-input').value;
  const target = raw ? Number.parseInt(raw, 10) : null;
  $('#goal-error').textContent = '';
  if (target !== null && !(target >= 1 && target <= 1000)) {
    $('#goal-error').textContent = 'Scrivi un numero tra 1 e 1000, oppure lascia vuoto.';
    return;
  }
  button.disabled = true;
  try {
    await db.saveGoal(new Date().getFullYear(), target);
    state.goal = target;
    renderGoal();
    toast(target ? 'Obiettivo salvato.' : 'Obiettivo tolto.');
  } catch (error) {
    $('#goal-error').textContent = goalErrorMessage(error);
  } finally {
    button.disabled = false;
  }
}

function goalErrorMessage(error) {
  return ['PGRST205', '42P01'].includes(error.code)
    ? "L'obiettivo non è ancora attivo: esegui supabase/03-prestiti.sql nel SQL Editor di Supabase."
    : errorMessage(error);
}

// ---------- Esportazione CSV ----------

function exportCsv() {
  const columns = [
    ['title', 'Titolo'], ['authors', 'Autori'], ['isbn', 'ISBN'], ['publisher', 'Editore'],
    ['published_year', 'Anno'], ['pages', 'Pagine'], ['genre', 'Genere'], ['language', 'Lingua'],
    ['owned', 'Posseduto'], ['lent_to', 'Prestato a'], ['lent_at', 'Prestato dal'],
    ['status', 'Stato'], ['rating', 'Voto'],
    ['started_at', 'Iniziato il'], ['finished_at', 'Finito il'], ['notes', 'Note private'],
    ['recommended_by', 'Consigliato da'],
    ['shared', 'Condiviso'], ['club_comment', 'Commento per il club'],
    ['cover_url', 'Copertina'], ['created_at', 'Aggiunto il'],
  ];
  const format = (key, value) => {
    if (key === 'owned' || key === 'shared') return value ? 'sì' : 'no';
    if (key === 'status') return STATUS_LABELS[value];
    if (key === 'created_at') return value.slice(0, 10);
    return value ?? '';
  };
  const escape = (value) => {
    const s = String(value);
    return /[;"\n\r]/.test(s) ? `"${s.replaceAll('"', '""')}"` : s;
  };
  // Punto e virgola + BOM: così Excel in italiano apre il file correttamente.
  const lines = [
    columns.map(([, label]) => label).join(';'),
    ...state.books.map((b) => columns.map(([key]) => escape(format(key, b[key]))).join(';')),
  ];
  const blob = new Blob(['\ufeff' + lines.join('\r\n')], { type: 'text/csv;charset=utf-8' });
  const link = el('a', {
    href: URL.createObjectURL(blob),
    download: `libreria-${today()}.csv`,
  });
  link.click();
  setTimeout(() => URL.revokeObjectURL(link.href), 1000);
}

init();
