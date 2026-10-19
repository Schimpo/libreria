// Piccoli aiuti per costruire l'interfaccia, usati da app.js.

// Colori delle copertine segnaposto (testo bianco leggibile su tutti).
const PLACEHOLDER_COLORS = ['#7b4b3a', '#4f6355', '#5a5f7a', '#8a6a3b', '#6b4f6e', '#3f5f6b'];

export const numberFormat = new Intl.NumberFormat('it-IT');
export const decimalFormat = new Intl.NumberFormat('it-IT', { maximumFractionDigits: 1 });
const dateFormat = new Intl.DateTimeFormat('it-IT', { day: 'numeric', month: 'long', year: 'numeric' });

export const $ = (selector) => document.querySelector(selector);

// Crea un elemento DOM. I figli falsy vengono ignorati, le stringhe diventano testo.
export function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) node.setAttribute(key, value);
  node.append(...children.filter((c) => c || c === 0));
  return node;
}

export function stars(rating) {
  return el('span', { class: 'stars', 'aria-label': `Voto ${rating} su 5` },
    '★'.repeat(rating) + '☆'.repeat(5 - rating));
}

export function coverElement(book, extraClass = '') {
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

// Testo in minuscolo senza accenti, per le ricerche.
export function simplify(text) {
  return String(text).toLowerCase().normalize('NFD').replace(/\p{Diacritic}/gu, '');
}

export function plural(n, one, many) {
  return `${numberFormat.format(n)} ${n === 1 ? one : many}`;
}

export function sum(items, key) {
  return items.reduce((total, item) => total + (item[key] ?? 0), 0);
}

export function today() {
  return new Date().toISOString().slice(0, 10);
}

export function formatDate(value) {
  return value ? dateFormat.format(new Date(value)) : '';
}

// "da oggi", "da 5 giorni", "da 3 settimane", "da 2 mesi", "da 1 anno"
export function since(value) {
  const days = Math.floor((Date.now() - new Date(value).getTime()) / 86400000);
  if (days < 1) return 'da oggi';
  if (days < 14) return `da ${plural(days, 'giorno', 'giorni')}`;
  if (days < 60) return `da ${plural(Math.floor(days / 7), 'settimana', 'settimane')}`;
  if (days < 365) return `da ${plural(Math.floor(days / 30), 'mese', 'mesi')}`;
  return `da ${plural(Math.floor(days / 365), 'anno', 'anni')}`;
}

// "oggi", "ieri", "5 giorni fa", "3 settimane fa", "2 mesi fa"
export function ago(value) {
  const days = Math.floor((Date.now() - new Date(value).getTime()) / 86400000);
  if (days < 1) return 'oggi';
  if (days < 2) return 'ieri';
  if (days < 14) return `${days} giorni fa`;
  if (days < 60) return `${plural(Math.floor(days / 7), 'settimana', 'settimane')} fa`;
  return `${plural(Math.floor(days / 30), 'mese', 'mesi')} fa`;
}

// "a Marco", ma "ad Anna" (d eufonica davanti alla a).
export function toName(name) {
  return `${/^a/i.test(name) ? 'ad' : 'a'} ${name}`;
}

// Elenco di nomi in italiano: "Marco", "Marco e Anna", "Marco, Anna e Luca".
export function joinNames(names) {
  return names.length < 2 ? names.join('') : `${names.slice(0, -1).join(', ')} e ${names.at(-1)}`;
}

// Messaggio comprensibile quando manca la connessione.
export function errorMessage(error) {
  const offline = !navigator.onLine || /failed to fetch|networkerror|load failed/i.test(error?.message ?? '');
  return offline ? 'Sei offline: serve la connessione per questa operazione.' : error.message;
}

// Apre una finestra e sposta il fuoco sulla finestra stessa: così su iPhone/Safari
// non compare il bordo di selezione attorno al pulsante di chiusura.
export function openDialog(dialog) {
  if (!dialog.open) dialog.showModal();
  dialog.tabIndex = -1;
  dialog.focus({ preventScroll: true });
}

let toastTimer;
export function toast(message, isError = false) {
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
