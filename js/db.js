// Accesso ai dati: Supabase se configurato, altrimenti localStorage (modalità demo).
// Aggiungendo ?demo all'indirizzo si forza la modalità demo, utile per provare
// modifiche senza toccare i dati veri (es. http://localhost:8080/?demo).
import { createClient } from 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.117.2/+esm';
import { SUPABASE_URL, SUPABASE_KEY } from './config.js';

export const isDemo = !SUPABASE_URL || !SUPABASE_KEY
  || new URLSearchParams(location.search).has('demo');

const supabase = isDemo ? null : createClient(SUPABASE_URL, SUPABASE_KEY);

const DEMO_KEY = 'libreria-demo-books';
const DEMO_PROFILE_KEY = 'libreria-demo-profile';
const DEMO_CLUB_KEY = 'libreria-demo-club';   // libri condivisi da colleghi di esempio
const DEMO_LOANS_KEY = 'libreria-demo-loans';
const DEMO_GOALS_KEY = 'libreria-demo-goals';
const OFFLINE_KEY = 'libreria-offline';       // ultima copia dei tuoi libri, per l'uso senza rete
const DUPLICATE_MESSAGE = 'Questo ISBN è già nella tua libreria.';

// ---- Autenticazione ----

export async function getUser() {
  if (isDemo) return { id: 'demo', email: 'demo' };
  const { data } = await supabase.auth.getSession();
  return data.session?.user ?? null;
}

export function onAuthChange(callback) {
  if (isDemo) return;
  // setTimeout: Supabase sconsiglia di chiamare altre sue funzioni dentro questo callback.
  supabase.auth.onAuthStateChange((_event, session) => {
    setTimeout(() => callback(session?.user ?? null), 0);
  });
}

export async function signIn(email, password) {
  const { error } = await supabase.auth.signInWithPassword({ email, password });
  if (error) {
    throw new Error(error.message === 'Invalid login credentials'
      ? 'Email o password non corretti.'
      : error.message);
  }
}

export async function signOut() {
  clearOfflineCopy();
  if (!isDemo) await supabase.auth.signOut();
}

export async function changePassword(password) {
  if (isDemo) throw new Error("In modalità demo non c'è nessuna password da cambiare.");
  const { error } = await supabase.auth.updateUser({ password });
  if (!error) return;
  if (error.code === 'same_password') throw new Error('La nuova password deve essere diversa da quella attuale.');
  if (error.code === 'weak_password') throw new Error('Password troppo debole: usane una più lunga.');
  throw new Error(error.message);
}

// ---- Profilo (nome visibile nel club) ----

export async function getProfile() {
  if (isDemo) return readJson(DEMO_PROFILE_KEY, null);
  const { data, error } = await supabase.from('profiles').select('display_name').maybeSingle();
  if (error) throw error;
  return data;
}

export async function saveProfile(displayName) {
  if (isDemo) {
    writeJson(DEMO_PROFILE_KEY, { display_name: displayName });
    return;
  }
  const user = await getUser();
  const { error } = await supabase.from('profiles').upsert({ id: user.id, display_name: displayName });
  if (error) throw error;
}

// ---- Libri ----

export async function listBooks() {
  if (isDemo) return readDemo();
  const { data, error } = await supabase
    .from('books')
    .select('*')
    .order('created_at', { ascending: false });
  if (error) throw error;
  return data;
}

export async function createBook(book) {
  if (isDemo) {
    const books = readDemo();
    if (book.isbn && books.some((b) => b.isbn === book.isbn)) throw new Error(DUPLICATE_MESSAGE);
    const now = new Date().toISOString();
    const created = applyDemoRules(null, { ...book, id: crypto.randomUUID(), created_at: now, updated_at: now });
    writeDemo([created, ...books]);
    return created;
  }
  const { data, error } = await supabase.from('books').insert(book).select().single();
  if (error) throw friendlyError(error);
  return data;
}

export async function updateBook(id, changes) {
  if (isDemo) {
    const books = readDemo();
    if (changes.isbn && books.some((b) => b.isbn === changes.isbn && b.id !== id)) {
      throw new Error(DUPLICATE_MESSAGE);
    }
    const old = books.find((b) => b.id === id);
    const updated = applyDemoRules(old, { ...old, ...changes, updated_at: new Date().toISOString() });
    writeDemo(books.map((b) => (b.id === id ? updated : b)));
    return updated;
  }
  const { data, error } = await supabase.from('books').update(changes).eq('id', id).select().single();
  if (error) throw friendlyError(error);
  return data;
}

export async function deleteBook(id) {
  if (isDemo) {
    writeDemo(readDemo().filter((b) => b.id !== id));
    writeJson(DEMO_LOANS_KEY, readJson(DEMO_LOANS_KEY, []).filter((l) => l.book_id !== id));
    return;
  }
  const { error } = await supabase.from('books').delete().eq('id', id);
  if (error) throw error;
}

// ---- Club ----

// Libri condivisi da tutti i membri, senza i dati privati (note, date, a chi è prestato).
export async function listClubBooks() {
  if (isDemo) {
    const name = (await getProfile())?.display_name ?? 'Tu';
    const mine = readDemo()
      .filter((b) => b.shared)
      .map(({ notes, lent_to, lent_at, borrower_id, started_at, finished_at, user_id, ...book }) => ({
        ...book,
        owner_id: 'demo',
        owner_name: name,
        available: book.owned && !lent_to,
        lent_to_me: false,
        club_updated_at: book.club_updated_at ?? book.created_at,
      }));
    return [...mine, ...demoClub()]
      .sort((a, b) => b.club_updated_at.localeCompare(a.club_updated_at));
  }
  const { data, error } = await supabase.rpc('club_books');
  if (error) throw error;
  return data;
}

// ---- Prestiti tra membri ----

// Richieste ricevute e fatte, libri prestati e ricevuti tramite l'app.
export async function listLoans() {
  if (isDemo) return readJson(DEMO_LOANS_KEY, []);
  const { data, error } = await supabase.rpc('my_loans');
  if (error) throw error;
  return data;
}

export async function requestLoan(bookId) {
  if (isDemo) return demoRequestLoan(bookId);
  const { error } = await supabase.rpc('request_loan', { book: bookId });
  if (error) throw new Error(error.message);
}

export async function respondLoan(loanId, accept) {
  if (isDemo) return demoRespondLoan(loanId, accept);
  const { error } = await supabase.rpc('respond_loan', { loan: loanId, accept });
  if (error) throw new Error(error.message);
}

export async function cancelLoan(loanId) {
  if (isDemo) {
    writeJson(DEMO_LOANS_KEY, readJson(DEMO_LOANS_KEY, []).filter((l) => l.id !== loanId));
    return;
  }
  const { error } = await supabase.rpc('cancel_loan', { loan: loanId });
  if (error) throw new Error(error.message);
}

// ---- Obiettivo di lettura ----

export async function getGoal(year) {
  if (isDemo) return readJson(DEMO_GOALS_KEY, {})[year] ?? null;
  const { data, error } = await supabase.from('reading_goals').select('target').eq('year', year).maybeSingle();
  if (error) throw error;
  return data?.target ?? null;
}

// target vuoto o zero = nessun obiettivo
export async function saveGoal(year, target) {
  if (isDemo) {
    const goals = readJson(DEMO_GOALS_KEY, {});
    if (target) goals[year] = target;
    else delete goals[year];
    writeJson(DEMO_GOALS_KEY, goals);
    return;
  }
  const user = await getUser();
  const { error } = target
    ? await supabase.from('reading_goals').upsert({ user_id: user.id, year, target })
    : await supabase.from('reading_goals').delete().eq('year', year);
  if (error) throw error;
}

// ---- Copia per l'uso senza connessione ----

export function saveOfflineCopy(user, books) {
  try {
    writeJson(OFFLINE_KEY, { userId: user.id, email: user.email, savedAt: new Date().toISOString(), books });
  } catch {
    // Spazio esaurito o archivio non disponibile: si continua senza copia.
  }
}

export function readOfflineCopy() {
  return readJson(OFFLINE_KEY, null);
}

function clearOfflineCopy() {
  try {
    localStorage.removeItem(OFFLINE_KEY);
  } catch {
    // niente da fare
  }
}

// ---- Utilità ----

function friendlyError(error) {
  return error.code === '23505' ? new Error(DUPLICATE_MESSAGE) : error;
}

function readJson(key, fallback) {
  try {
    return JSON.parse(localStorage.getItem(key)) ?? fallback;
  } catch {
    return fallback;
  }
}

function writeJson(key, value) {
  localStorage.setItem(key, JSON.stringify(value));
}

// ---- Modalità demo ----
// Imita in piccolo le regole del database (vedi supabase/03-prestiti.sql),
// con alcuni colleghi di esempio per provare club e prestiti.

function readDemo() {
  return readJson(DEMO_KEY, []);
}

function writeDemo(books) {
  writeJson(DEMO_KEY, books);
}

// Stesse regole automatiche del trigger books_before_write.
function applyDemoRules(old, book) {
  const now = new Date().toISOString();
  if (!book.lent_to) {
    book.lent_at = null;
  } else if (!old || book.lent_to !== old.lent_to) {
    book.lent_at = new Date().toISOString().slice(0, 10);
  }
  if (old?.borrower_id && book.borrower_id === old.borrower_id && book.lent_to !== old.lent_to) {
    writeJson(DEMO_LOANS_KEY, readJson(DEMO_LOANS_KEY, [])
      .filter((l) => !(l.book_id === book.id && l.status === 'accepted')));
    book.borrower_id = null;
  }
  if (book.shared && (!old || !old.shared || book.club_comment !== old.club_comment
      || book.rating !== old.rating || book.status !== old.status)) {
    book.club_updated_at = now;
  }
  return book;
}

function demoClub() {
  let club = readJson(DEMO_CLUB_KEY, null);
  if (!club) {
    const daysAgo = (n) => new Date(Date.now() - n * 86400000).toISOString();
    const sample = (id, owner, title, authors, isbn, extra) => ({
      id, owner_id: owner === 'Marco' ? 'demo-marco' : 'demo-anna', owner_name: owner,
      title, authors, isbn, publisher: null, published_year: null, pages: null, genre: null,
      cover_url: null, owned: true, available: true, lent_to_me: false, status: 'read',
      rating: null, club_comment: null, created_at: daysAgo(30), club_updated_at: daysAgo(30), ...extra,
    });
    club = [
      sample('demo-1', 'Marco', 'Il barone rampante', 'Italo Calvino', null,
        { rating: 5, club_comment: 'Uno dei miei preferiti: leggero e profondo.', club_updated_at: daysAgo(2) }),
      sample('demo-2', 'Anna', 'Il barone rampante', 'Italo Calvino', null,
        { rating: 4, available: false }),
      sample('demo-3', 'Anna', 'La ragazza del treno', 'Paula Hawkins', null,
        { rating: 2, club_comment: 'Si legge in fretta, ma il finale non mi ha convinta.' }),
      sample('demo-4', 'Marco', 'Sapiens. Da animali a dèi', 'Yuval Noah Harari', null,
        { status: 'reading', club_updated_at: daysAgo(1) }),
    ];
    writeJson(DEMO_CLUB_KEY, club);
  }
  const lentToMe = new Set(readJson(DEMO_LOANS_KEY, [])
    .filter((l) => l.my_role === 'borrower' && l.status === 'accepted').map((l) => l.book_id));
  return club.map((b) => ({ ...b, lent_to_me: lentToMe.has(b.id) }));
}

function demoRequestLoan(bookId) {
  const book = demoClub().find((b) => b.id === bookId);
  if (!book) throw new Error('Libro non trovato nel club.');
  if (!book.available) throw new Error('Il libro non è disponibile in questo momento.');
  const loans = readJson(DEMO_LOANS_KEY, []);
  if (loans.some((l) => l.book_id === bookId && l.my_role === 'borrower' && l.status === 'requested')) {
    throw new Error('Hai già chiesto questo libro in prestito.');
  }
  loans.unshift({
    id: crypto.randomUUID(), book_id: bookId, status: 'requested', my_role: 'borrower',
    other_name: book.owner_name, title: book.title, authors: book.authors, cover_url: book.cover_url,
    isbn: book.isbn, requested_at: new Date().toISOString(), answered_at: null,
  });
  writeJson(DEMO_LOANS_KEY, loans);
}

function demoRespondLoan(loanId, accept) {
  const loans = readJson(DEMO_LOANS_KEY, []);
  const loan = loans.find((l) => l.id === loanId && l.my_role === 'owner' && l.status === 'requested');
  if (!loan) throw new Error('Richiesta non trovata.');
  const now = new Date().toISOString();
  if (accept) {
    const books = readDemo();
    const book = books.find((b) => b.id === loan.book_id);
    if (!book || book.lent_to || !book.owned) {
      throw new Error('Il libro risulta già in prestito: segnalo come restituito prima di accettare.');
    }
    Object.assign(book, { lent_to: loan.other_name, borrower_id: 'demo-other', lent_at: now.slice(0, 10) });
    writeDemo(books);
    for (const l of loans) {
      if (l.book_id === loan.book_id && l.status === 'requested' && l.my_role === 'owner') {
        Object.assign(l, { status: l === loan ? 'accepted' : 'declined', answered_at: now });
      }
    }
  } else {
    Object.assign(loan, { status: 'declined', answered_at: now });
  }
  // Come nel database, chi possiede il libro non vede più le richieste rifiutate.
  writeJson(DEMO_LOANS_KEY, loans.filter((l) => !(l.my_role === 'owner' && l.status === 'declined')));
}
