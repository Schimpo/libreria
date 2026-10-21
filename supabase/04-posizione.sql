-- Dove si trova ogni libro (casa, stanza, scaffale): lo vede solo il proprietario.
-- Da eseguire una volta nel SQL Editor di Supabase, dopo 03-prestiti.sql.
--
-- Le regole di 01-schema.sql valgono già per la colonna nuova: ognuno legge e modifica solo
-- i propri libri. club_books() (03-prestiti.sql) elenca i campi uno per uno e non la
-- include, quindi gli altri membri del club non la vedono.

alter table public.books
  add column if not exists location text
    check (char_length(location) <= 100);   -- es. "Casa al mare · Salotto · Scaffale 2"
