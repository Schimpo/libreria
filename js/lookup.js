// Ricerca dei dati di un libro su Google Books e Open Library.
import { GOOGLE_BOOKS_API_KEY } from './config.js';

const TIMEOUT_MS = 8000;

// ---- ISBN ----

// Restituisce l'ISBN-13 (solo cifre) oppure null se il codice non è un ISBN valido.
// Gli ISBN-10 vengono convertiti in ISBN-13, così lo stesso libro ha sempre lo stesso codice.
export function normalizeIsbn(raw) {
  const s = String(raw ?? '').toUpperCase().replace(/[^0-9X]/g, '');
  if (/^97[89]\d{10}$/.test(s) && isbn13CheckDigit(s) === s[12]) return s;
  if (/^\d{9}[\dX]$/.test(s) && isValidIsbn10(s)) {
    const core = '978' + s.slice(0, 9);
    return core + isbn13CheckDigit(core);
  }
  return null;
}

function isbn13CheckDigit(s) {
  let sum = 0;
  for (let i = 0; i < 12; i++) sum += Number(s[i]) * (i % 2 ? 3 : 1);
  return String((10 - (sum % 10)) % 10);
}

function isValidIsbn10(s) {
  let sum = 0;
  for (let i = 0; i < 10; i++) sum += (10 - i) * (s[i] === 'X' ? 10 : Number(s[i]));
  return sum % 11 === 0;
}

// ---- Ricerca per ISBN ----

// Interroga entrambe le fonti in parallelo e unisce i risultati.
// Restituisce null se nessuna delle due conosce il libro.
export async function lookupIsbn(isbn) {
  const [google, openLibrary] = await Promise.allSettled([
    searchGoogle(`isbn:${isbn}`).then((items) => items[0] ?? null),
    lookupOpenLibrary(isbn),
  ]);
  const g = google.status === 'fulfilled' ? google.value : null;
  const o = openLibrary.status === 'fulfilled' ? openLibrary.value : null;
  if (!g && !o) return null;

  // Google ha di solito nomi degli autori e generi migliori,
  // Open Library copertine più grandi.
  const book = { ...o, ...stripEmpty(g), isbn };
  if (o?.cover_url) book.cover_url = o.cover_url;
  return book;
}

// ---- Ricerca per titolo / autore ----

export async function searchBooks(query) {
  const [google, openLibrary] = await Promise.allSettled([
    searchGoogle(query),
    searchOpenLibrary(query),
  ]);
  if (google.status === 'fulfilled' && google.value.length) return google.value;
  if (openLibrary.status === 'fulfilled') return openLibrary.value;
  throw new Error('Ricerca non disponibile al momento. Riprova più tardi.');
}

// ---- Google Books ----

async function searchGoogle(q) {
  const params = new URLSearchParams({ q, maxResults: '12', printType: 'books' });
  if (GOOGLE_BOOKS_API_KEY) params.set('key', GOOGLE_BOOKS_API_KEY);
  const data = await getJson(`https://www.googleapis.com/books/v1/volumes?${params}`);
  return (data.items ?? []).map(({ volumeInfo: v }) => ({
    isbn: pickGoogleIsbn(v.industryIdentifiers),
    title: v.title,
    authors: v.authors?.join(', ') ?? null,
    publisher: v.publisher ?? null,
    published_year: parseYear(v.publishedDate),
    pages: v.pageCount || null,
    genre: v.categories?.[0] ?? null,
    language: v.language ?? null,
    cover_url: googleCover(v.imageLinks),
  }));
}

function pickGoogleIsbn(identifiers = []) {
  const byType = (type) => identifiers.find((id) => id.type === type)?.identifier;
  return normalizeIsbn(byType('ISBN_13') ?? byType('ISBN_10'));
}

function googleCover(links) {
  const url = links?.thumbnail ?? links?.smallThumbnail;
  return url ? url.replace(/^http:/, 'https:').replace('&edge=curl', '') : null;
}

// ---- Open Library ----

async function lookupOpenLibrary(isbn) {
  const data = await getJson(
    `https://openlibrary.org/api/books?bibkeys=ISBN:${isbn}&format=json&jscmd=data`,
  );
  const d = data[`ISBN:${isbn}`];
  if (!d) return null;
  return {
    isbn,
    title: d.title,
    authors: d.authors?.map((a) => a.name).join(', ') || null,
    publisher: d.publishers?.[0]?.name ?? null,
    published_year: parseYear(d.publish_date),
    pages: d.number_of_pages ?? null,
    genre: d.subjects?.[0]?.name ?? null,
    language: null,
    cover_url: d.cover?.medium ?? d.cover?.large ?? null,
  };
}

async function searchOpenLibrary(q) {
  const params = new URLSearchParams({
    q,
    limit: '12',
    fields: 'title,author_name,cover_i,first_publish_year,number_of_pages_median,publisher',
  });
  const data = await getJson(`https://openlibrary.org/search.json?${params}`);
  // I risultati di Open Library sono "opere" con molte edizioni: l'ISBN
  // potrebbe non essere quello della tua copia, quindi non lo compiliamo.
  return (data.docs ?? []).map((d) => ({
    isbn: null,
    title: d.title,
    authors: d.author_name?.join(', ') ?? null,
    publisher: d.publisher?.[0] ?? null,
    published_year: d.first_publish_year ?? null,
    pages: d.number_of_pages_median ?? null,
    genre: null,
    language: null,
    cover_url: d.cover_i ? `https://covers.openlibrary.org/b/id/${d.cover_i}-M.jpg` : null,
  }));
}

// ---- Utilità ----

async function getJson(url) {
  // AbortSignal.timeout manca su iPhone con iOS precedenti al 16.
  const res = await fetch(url, { signal: AbortSignal.timeout?.(TIMEOUT_MS) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

function parseYear(value) {
  const match = String(value ?? '').match(/\d{4}/);
  return match ? Number(match[0]) : null;
}

function stripEmpty(obj) {
  if (!obj) return {};
  return Object.fromEntries(Object.entries(obj).filter(([, v]) => v != null && v !== ''));
}
