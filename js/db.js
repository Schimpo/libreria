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
    localStorage.setItem(DEMO_PROFILE_KEY, JSON.stringify({ display_name: displayName }));
    return;
  }
  const user = await getUser();
  const { error } = await supabase.from('profiles').upsert({ id: user.id, display_name: displayName });
  if (error) throw error;
}

// ---- Club ----

// Libri condivisi da tutti i membri, senza i dati privati (note, date, a chi è prestato).
export async function listClubBooks() {
  if (isDemo) {
    const name = (await getProfile())?.display_name ?? 'Tu';
    return readDemo()
      .filter((b) => b.shared)
      .map(({ notes, lent_to, started_at, finished_at, user_id, ...book }) => ({
        ...book,
        owner_id: 'demo',
        owner_name: name,
        available: book.owned && !lent_to,
      }));
  }
  const { data, error } = await supabase.rpc('club_books');
  if (error) throw error;
  return data;
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
    const created = { ...book, id: crypto.randomUUID(), created_at: now, updated_at: now };
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
    const updated = { ...books.find((b) => b.id === id), ...changes, updated_at: new Date().toISOString() };
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
    return;
  }
  const { error } = await supabase.from('books').delete().eq('id', id);
  if (error) throw error;
}

function friendlyError(error) {
  return error.code === '23505' ? new Error(DUPLICATE_MESSAGE) : error;
}

function readDemo() {
  return readJson(DEMO_KEY, []);
}

function readJson(key, fallback) {
  try {
    return JSON.parse(localStorage.getItem(key)) ?? fallback;
  } catch {
    return fallback;
  }
}

function writeDemo(books) {
  localStorage.setItem(DEMO_KEY, JSON.stringify(books));
}
