// Interfaccia dell'app: elenco, filtri, aggiunta, modifica, scansione, statistiche.
import * as db from './db.js';
import { normalizeIsbn, lookupIsbn, searchBooks } from './lookup.js';
import { canScan, scanIsbn } from './scanner.js';

const STATUS_LABELS = {
  to_read: 'Da leggere',
  reading: 'In lettura',
  read: 'Letto',
  abandoned: 'Abbandonato',
};

const FILTERS = {
  all: () => true,
  owned: (b) => b.owned,
  read: (b) => b.status === 'read',
  reading: (b) => b.status === 'reading',
  to_read: (b) => b.status === 'to_read',
  lent: (b) => b.owned && b.lent_to,
  not_owned: (b) => !b.owned,
};

// Colori delle copertine segnaposto (testo bianco leggibile su tutti).
const PLACEHOLDER_COLORS = ['#7b4b3a', '#4f6355', '#5a5f7a', '#8a6a3b', '#6b4f6e', '#3f5f6b'];

const numberFormat = new Intl.NumberFormat('it-IT');

const state = {
  books: [],
  filter: 'all',
  query: '',
  sort: 'recent',
  editingId: null, // id del libro aperto nella scheda, null se nuovo
};

let currentUserId;
let scanController;

const $ = (selector) => document.querySelector(selector);

// ---------- Avvio e accesso ----------

async function init() {
  bindEvents();
  $('#demo-banner').hidden = !db.isDemo;
  $('#logout-btn').hidden = db.isDemo;
  db.onAuthChange(showView);
  showView(await db.getUser());
}

async function showView(user) {
  const userId = user?.id ?? (user ? 'demo' : null);
  if (userId === currentUserId) return;
  currentUserId = userId;

  $('#login-view').hidden = Boolean(user);
  $('#app-view').hidden = !user;
  state.books = [];
  if (user) await loadBooks();
}

async function loadBooks() {
  try {
    state.books = await db.listBooks();
  } catch (error) {
    toast(`Impossibile caricare i libri: ${error.message}`, true);
  }
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
    $('#login-error').textContent = error.message;
  } finally {
    button.disabled = false;
  }
}

// ---------- Eventi ----------

function bindEvents() {
  $('#login-form').addEventListener('submit', handleLogin);
  $('#logout-btn').addEventListener('click', () => db.signOut());

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
    if (item) openBookForm(state.books.find((b) => b.id === item.dataset.id));
  });

  $('#add-btn').addEventListener('click', openAddDialog);
  $('#scan-btn').addEventListener('click', startScan);
  $('#add-scan-btn').addEventListener('click', startScan);
  $('#isbn-form').addEventListener('submit', handleIsbnSearch);
  $('#search-form').addEventListener('submit', handleTitleSearch);
  $('#manual-btn').addEventListener('click', () => openBookForm({}));

  $('#book-form').addEventListener('submit', handleSave);
  $('#book-form').addEventListener('change', (e) => {
    if (e.target.name === 'status') onStatusChange();
    if (e.target.name === 'owned') updateFormVisibility();
    if (e.target.name === 'cover_url' || e.target.name === 'title') updateCoverPreview();
  });
  $('#delete-btn').addEventListener('click', handleDelete);
  $('#rating').addEventListener('click', (e) => {
    const star = e.target.closest('[data-value]');
    if (!star) return;
    const input = $('#book-form').elements.rating;
    // Cliccando di nuovo la stessa stella il voto si cancella.
    input.value = input.value === star.dataset.value ? '' : star.dataset.value;
    renderRating();
  });

  $('#stats-btn').addEventListener('click', openStats);
  $('#export-btn').addEventListener('click', exportCsv);

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

// ---------- Elenco ----------

function render() {
  const books = visibleBooks();
  $('#book-list').replaceChildren(...books.map(bookItem));

  const total = state.books.length;
  $('#count').textContent = books.length === total
    ? plural(total, 'libro', 'libri')
    : `${books.length} di ${plural(total, 'libro', 'libri')}`;

  $('#empty').hidden = books.length > 0;
  $('#empty-title').textContent = total ? 'Nessun risultato' : 'La tua libreria è vuota';
  $('#empty-text').textContent = total
    ? 'Nessun libro corrisponde alla ricerca o al filtro scelto.'
    : 'Aggiungi il primo libro con “Aggiungi”, oppure inquadra il codice a barre con “Scansiona”.';
}

function visibleBooks() {
  const query = simplify(state.query.trim());
  const books = state.books.filter((b) => FILTERS[state.filter](b) && (!query || matches(b, query)));
  return books.sort(SORTERS[state.sort]);
}

function matches(book, query) {
  return [book.title, book.authors, book.isbn, book.publisher, book.genre]
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
  return parts.length > 1 ? `${parts.at(-1)} ${parts.slice(0, -1).join(' ')}` : first || '￿';
}

function bookItem(book) {
  const meta = el('span', { class: 'book-meta' },
    el('span', { class: `badge badge-${book.status}` }, STATUS_LABELS[book.status]),
    book.owned && !book.lent_to && el('span', { class: 'badge badge-owned' }, 'Posseduto'),
    book.owned && book.lent_to && el('span', { class: 'badge badge-lent' }, `Prestato a ${book.lent_to}`),
    book.rating && el('span', { class: 'stars', 'aria-label': `Voto ${book.rating} su 5` },
      '★'.repeat(book.rating) + '☆'.repeat(5 - book.rating)),
  );
  return el('li', {},
    el('button', { class: 'book', type: 'button', 'data-id': book.id },
      coverElement(book),
      el('span', { class: 'book-info' },
        el('span', { class: 'book-title' }, book.title),
        book.authors && el('span', { class: 'book-authors' }, book.authors),
        meta,
      ),
    ),
  );
}

function coverElement(book, extraClass = '') {
  const placeholder = () => el('span', {
    class: `cover cover-placeholder ${extraClass}`,
    style: `background:${placeholderColor(book.title ?? '')}`,
    'aria-hidden': 'true',
  }, book.title || '');

  if (!book.cover_url) return placeholder();
  const img = el('img', { class: `cover ${extraClass}`, src: book.cover_url, alt: '', loading: 'lazy' });
  img.addEventListener('error', () => img.replaceWith(placeholder()), { once: true });
  return img;
}

function placeholderColor(text) {
  let hash = 0;
  for (const ch of text) hash = (hash * 31 + ch.codePointAt(0)) >>> 0;
  return PLACEHOLDER_COLORS[hash % PLACEHOLDER_COLORS.length];
}

// ---------- Aggiunta ----------

function openAddDialog() {
  $('#isbn-form').reset();
  $('#search-form').reset();
  $('#isbn-error').textContent = '';
  $('#search-status').textContent = '';
  $('#search-results').replaceChildren();
  $('#add-dialog').showModal();
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
    openBookForm(existing, 'Questo libro è già nella tua libreria.');
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
    status.textContent = error.message;
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
  dialog.showModal();

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
  form.reset();

  const values = {
    owned: true,
    status: 'to_read',
    ...Object.fromEntries(Object.entries(book).filter(([, v]) => v != null)),
  };
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
  form.querySelector('details.more').open = isNew && !book.title;

  renderRating();
  updateFormVisibility();
  updateCoverPreview();

  $('#add-dialog').close();
  const dialog = $('#book-dialog');
  if (!dialog.open) dialog.showModal();
  form.scrollTop = 0;
}

function onStatusChange() {
  const form = $('#book-form');
  const status = form.elements.status.value;
  const today = new Date().toISOString().slice(0, 10);
  if (status === 'reading' && !form.elements.started_at.value) form.elements.started_at.value = today;
  if (status === 'read' && !form.elements.finished_at.value) form.elements.finished_at.value = today;
  updateFormVisibility();
}

function updateFormVisibility() {
  const form = $('#book-form');
  const status = form.elements.status.value;
  $('#started-field').hidden = status === 'to_read';
  $('#finished-field').hidden = !['read', 'abandoned'].includes(status);
  $('#lent-field').hidden = !form.elements.owned.checked;
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
    toast('Libro salvato.');
  } catch (error) {
    $('#book-error').textContent = error.message;
  } finally {
    button.disabled = false;
  }
}

async function handleDelete() {
  const book = state.books.find((b) => b.id === state.editingId);
  if (!book || !confirm(`Eliminare “${book.title}” dalla libreria?`)) return;
  try {
    await db.deleteBook(book.id);
    state.books = state.books.filter((b) => b.id !== book.id);
    $('#book-dialog').close();
    render();
    toast('Libro eliminato.');
  } catch (error) {
    $('#book-error').textContent = error.message;
  }
}

// ---------- Statistiche ----------

function openStats() {
  const books = state.books;
  const year = new Date().getFullYear();
  const read = books.filter((b) => b.status === 'read');
  const readThisYear = read.filter((b) => b.finished_at?.startsWith(String(year)));

  const tiles = [
    ['Libri in libreria', books.length],
    ['Posseduti', books.filter((b) => b.owned).length],
    ['Letti', read.length],
    [`Letti nel ${year}`, readThisYear.length],
    [`Pagine lette nel ${year}`, sum(readThisYear, 'pages')],
    ['In prestito', books.filter(FILTERS.lent).length],
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

  $('#stats-dialog').showModal();
}

// ---------- Esportazione CSV ----------

function exportCsv() {
  const columns = [
    ['title', 'Titolo'], ['authors', 'Autori'], ['isbn', 'ISBN'], ['publisher', 'Editore'],
    ['published_year', 'Anno'], ['pages', 'Pagine'], ['genre', 'Genere'], ['language', 'Lingua'],
    ['owned', 'Posseduto'], ['lent_to', 'Prestato a'], ['status', 'Stato'], ['rating', 'Voto'],
    ['started_at', 'Iniziato il'], ['finished_at', 'Finito il'], ['notes', 'Note'],
    ['cover_url', 'Copertina'], ['created_at', 'Aggiunto il'],
  ];
  const format = (key, value) => {
    if (key === 'owned') return value ? 'sì' : 'no';
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
  const blob = new Blob(['﻿' + lines.join('\r\n')], { type: 'text/csv;charset=utf-8' });
  const link = el('a', {
    href: URL.createObjectURL(blob),
    download: `libreria-${new Date().toISOString().slice(0, 10)}.csv`,
  });
  link.click();
  setTimeout(() => URL.revokeObjectURL(link.href), 1000);
}

// ---------- Utilità ----------

// Crea un elemento DOM. I figli falsy vengono ignorati, le stringhe diventano testo.
function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) node.setAttribute(key, value);
  node.append(...children.filter((c) => c || c === 0));
  return node;
}

function simplify(text) {
  return String(text).toLowerCase().normalize('NFD').replace(/\p{Diacritic}/gu, '');
}

function plural(n, one, many) {
  return `${numberFormat.format(n)} ${n === 1 ? one : many}`;
}

function sum(books, key) {
  return books.reduce((total, b) => total + (b[key] ?? 0), 0);
}

let toastTimer;
function toast(message, isError = false) {
  const node = $('#toast');
  node.textContent = message;
  node.classList.toggle('error', isError);
  // Come popover l'avviso resta visibile anche sopra le finestre aperte.
  if (node.showPopover && !node.matches(':popover-open')) node.showPopover();
  node.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    node.classList.remove('show');
    toastTimer = setTimeout(() => node.hidePopover?.(), 200);
  }, isError ? 5000 : 2500);
}

init();
