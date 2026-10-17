-- Schema del database per "La mia libreria".
-- Da eseguire una volta nel SQL Editor di Supabase (Dashboard → SQL Editor → New query → Run).

create table if not exists public.books (
  id             uuid primary key default gen_random_uuid(),
  user_id        uuid not null default auth.uid() references auth.users (id) on delete cascade,

  -- Dati bibliografici
  isbn           text,
  title          text not null,
  authors        text,                 -- più autori separati da virgola
  publisher      text,
  published_year smallint,
  pages          integer check (pages > 0),
  genre          text,
  language       text,
  cover_url      text,

  -- Dati personali
  owned          boolean not null default true,
  status         text not null default 'to_read'
                 check (status in ('to_read', 'reading', 'read', 'abandoned')),
  rating         smallint check (rating between 1 and 5),
  started_at     date,
  finished_at    date,
  lent_to        text,                 -- a chi l'hai prestato (vuoto = in casa)
  notes          text,

  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now()
);

-- Un ISBN può comparire una sola volta nella libreria di ciascun utente.
create unique index if not exists books_user_isbn_key
  on public.books (user_id, isbn)
  where isbn is not null;

create index if not exists books_user_created_idx
  on public.books (user_id, created_at desc);

-- Aggiorna updated_at a ogni modifica.
create or replace function public.set_updated_at()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists books_set_updated_at on public.books;
create trigger books_set_updated_at
  before update on public.books
  for each row execute function public.set_updated_at();

-- Sicurezza: ogni utente vede e modifica solo i propri libri.
alter table public.books enable row level security;

drop policy if exists "Leggi i tuoi libri" on public.books;
create policy "Leggi i tuoi libri" on public.books
  for select to authenticated
  using ((select auth.uid()) = user_id);

drop policy if exists "Aggiungi i tuoi libri" on public.books;
create policy "Aggiungi i tuoi libri" on public.books
  for insert to authenticated
  with check ((select auth.uid()) = user_id);

drop policy if exists "Modifica i tuoi libri" on public.books;
create policy "Modifica i tuoi libri" on public.books
  for update to authenticated
  using ((select auth.uid()) = user_id)
  with check ((select auth.uid()) = user_id);

drop policy if exists "Elimina i tuoi libri" on public.books;
create policy "Elimina i tuoi libri" on public.books
  for delete to authenticated
  using ((select auth.uid()) = user_id);
