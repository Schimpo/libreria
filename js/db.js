// Accesso ai dati: Supabase se configurato, altrimenti localStorage (modalità demo).
import { createClient } from 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.117.2/+esm';
import { SUPABASE_URL, SUPABASE_KEY } from './config.js';

export const isDemo = !SUPABASE_URL || !SUPABASE_KEY;

const supabase = isDemo ? null : createClient(SUPABASE_URL, SUPABASE_KEY);

const DEMO_KEY = 'libreria-demo-books';
const DUPLICATE_MESSAGE = 'Questo ISBN è già nella tua libreria.';

// ---- Autenticazione ----

export async function getUser() {
  if (isDemo) return { email: 'demo' };
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
  try {
    return JSON.parse(localStorage.getItem(DEMO_KEY)) ?? [];
  } catch {
    return [];
  }
}

function writeDemo(books) {
  localStorage.setItem(DEMO_KEY, JSON.stringify(books));
}
