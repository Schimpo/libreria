// Ricerca dei dati di un libro: OPAC SBN (catalogo delle biblioteche italiane),
// Google Books e Open Library.
import { GOOGLE_BOOKS_API_KEY } from './config.js';
import { lookupSbn } from './db.js';
import { simplify } from './ui.js';

const TIMEOUT_MS = 8000;

// Da ottobre 2026 Google Books ha un guasto: le ricerche per ISBN tornano vuote e spesso
// risponde 503 ("backendFailed"). Per gli ISBN si fanno 2 tentativi, per i titoli uno solo.
const GOOGLE_ISBN_ATTEMPTS = 2;

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

// Chiede a tutte le fonti insieme (così si aspetta solo la più lenta) e sceglie in
// ordine di priorità: 1. OPAC SBN, 2. Google Books, 3. Open Library.
// Restituisce null se nessuna fonte conosce il libro.
export async function lookupIsbn(isbn) {
  const [sbn, google, openLibrary] = (await Promise.allSettled([
    lookupSbn(isbn),
    searchGoogle(`isbn:${isbn}`, GOOGLE_ISBN_ATTEMPTS).then((items) => items[0] ?? null),
    lookupOpenLibrary(isbn),
  ])).map((result) => (result.status === 'fulfilled' ? result.value : null));

  // Senza SBN, se Google e Open Library non concordano sul titolo si dà ragione a Open Library:
  // nelle prove il catalogo di Google collegava 2 ISBN su 5 al libro sbagliato.
  const disagree = !sbn && google && openLibrary && !sameTitle(google.title, openLibrary.title);
  const book = mergeBooks(disagree ? [openLibrary, google] : [sbn, google, openLibrary]);
  if (!book) return null;
  // Copertina: Open Library ha immagini più grandi, SBN non ne ha.
  const withCover = [openLibrary, google].find((b) => b?.cover_url && sameTitle(b.title, book.title));
  book.cover_url = withCover?.cover_url ?? null;
  book.isbn = isbn;
  return book;
}

// La prima fonte che conosce il libro (con un titolo) vince; le altre completano solo i campi
// mancanti, e solo se il titolo coincide: il catalogo di Google collega alcuni ISBN a libri sbagliati.
function mergeBooks(sources) {
  const [main, ...others] = sources.filter((source) => source?.title);
  if (!main) return null;
  const book = { ...main };
  for (const other of others) {
    if (!sameTitle(other.title, main.title)) continue;
    for (const [key, value] of Object.entries(other)) {
      if (book[key] == null && value != null && value !== '') book[key] = value;
    }
  }
  return book;
}

// Titoli uguali a meno di maiuscole, accenti, punteggiatura e sottotitolo finale
// ("Il signore degli anelli" = "Il signore degli anelli. Trilogia"). Un titolo di una sola
// parola deve coincidere del tutto, per non confondere "Dune" con "Dune messiah".
function sameTitle(a, b) {
  const words = (title) => simplify(title ?? '').split(/[^\p{L}\p{N}]+/u).filter(Boolean);
  const [short, long] = [words(a), words(b)].sort((x, y) => x.length - y.length);
  if (!short.length || (short.length === 1 && long.length > 1)) return false;
  return short.every((word, i) => word === long[i]);
}

// ---- Genere ----

// Le fonti danno voci in inglese o spagnolo, spesso argomenti e non generi ("futurology",
// "Auschwitz (Concentration camp)"). Si cerca fra tutte le voci la prima regola che corrisponde,
// in quest'ordine: i generi più precisi prima di Narrativa e Saggistica. Se nessuna regola
// corrisponde il genere resta vuoto. Può sbagliare: chi aggiunge il libro lo corregge.
// I nomi devono restare uguali a quelli suggeriti nella scheda (GENRES in app.js).
const GENRE_RULES = [
  ['Fantascienza', /science.?fiction|sci.?fi|ciencia.?ficcion|fantascienza/],
  ['Fantasy', /fantasy/],
  ['Giallo/Thriller', /myster|detective|thriller|crime|suspense|misterio|policiac|giallo|noir/],
  ['Ragazzi', /juvenile|children|young adult|ragazzi|infantil/],
  ['Fumetti', /comic|graphic novel|manga|fumett/],
  ['Poesia', /poetry|poems|poesia|poesie/],
  ['Biografia', /biograph|personal narratives|memoir|biografi/],
  ['Storia', /^(history|storia|historia)\b(?!.*critic)/],
  ['Classici', /classic/],
  ['Saggistica', /saggistica|essays|saggi|philosoph|filosofi|psycholog|economics|political science/],
  ['Narrativa', /fiction|novel|novela|\broman|narrativa|racconti/],
];

function toGenre(labels = []) {
  // "Nonfiction" contiene "fiction": prima lo si traduce, così non diventa Narrativa.
  const texts = labels.map((label) => simplify(label ?? '').replace(/non.?fiction/g, 'saggistica'));
  return GENRE_RULES.find(([, rule]) => texts.some((text) => rule.test(text)))?.[0] ?? null;
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

async function searchGoogle(q, attempts = 1) {
  const params = new URLSearchParams({ q, maxResults: '12', printType: 'books' });
  if (GOOGLE_BOOKS_API_KEY) params.set('key', GOOGLE_BOOKS_API_KEY);
  const url = `https://www.googleapis.com/books/v1/volumes?${params}`;
  // Un solo limite di tempo per tutti i tentativi, così la ricerca non aspetta più di TIMEOUT_MS.
  const signal = AbortSignal.timeout?.(TIMEOUT_MS);
  let data;
  for (let attempt = 1; ; attempt++) {
    try {
      data = await getJson(url, signal);
      break;
    } catch (error) {
      if (error.status !== 503 || attempt >= attempts) throw error;
    }
  }
  return (data.items ?? []).map(({ volumeInfo: v }) => ({
    isbn: pickGoogleIsbn(v.industryIdentifiers),
    title: v.title,
    authors: v.authors?.join(', ') ?? null,
    publisher: v.publisher ?? null,
    published_year: parseYear(v.publishedDate),
    pages: v.pageCount || null,
    genre: toGenre(v.categories),
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
    genre: toGenre(d.subjects?.map((s) => s.name)),
    language: null,
    cover_url: d.cover?.medium ?? d.cover?.large ?? null,
  };
}

async function searchOpenLibrary(q) {
  const params = new URLSearchParams({
    q,
    limit: '12',
    fields: 'title,author_name,cover_i,first_publish_year,number_of_pages_median,publisher,subject',
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
    genre: toGenre(d.subject),
    language: null,
    cover_url: d.cover_i ? `https://covers.openlibrary.org/b/id/${d.cover_i}-M.jpg` : null,
  }));
}

// ---- Utilità ----

// AbortSignal.timeout manca su iPhone con iOS precedenti al 16: lì si aspetta senza limite.
async function getJson(url, signal = AbortSignal.timeout?.(TIMEOUT_MS)) {
  const res = await fetch(url, { signal });
  if (!res.ok) throw Object.assign(new Error(`HTTP ${res.status}`), { status: res.status });
  return res.json();
}

function parseYear(value) {
  const match = String(value ?? '').match(/\d{4}/);
  return match ? Number(match[0]) : null;
}
