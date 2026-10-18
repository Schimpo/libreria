-- Club del libro: profili dei membri e condivisione di alcuni libri.
-- Da eseguire una volta nel SQL Editor di Supabase, dopo 01-schema.sql.
--
-- Tutti gli utenti dell'app fanno parte dello stesso club. Le iscrizioni sono
-- chiuse, quindi i membri sono solo gli account creati dalla dashboard.

-- Nuovi campi sui libri: condivisione e commento visibile al club.
alter table public.books
  add column if not exists shared boolean not null default false,
  add column if not exists club_comment text;

create index if not exists books_shared_idx
  on public.books (created_at desc)
  where shared;

-- Profili: il nome con cui ciascuno compare nel club.
create table if not exists public.profiles (
  id           uuid primary key default auth.uid() references auth.users (id) on delete cascade,
  display_name text not null check (char_length(display_name) between 1 and 40),
  created_at   timestamptz not null default now()
);

alter table public.profiles enable row level security;

grant select, insert, update on public.profiles to authenticated;

drop policy if exists "Leggi il tuo profilo" on public.profiles;
create policy "Leggi il tuo profilo" on public.profiles
  for select to authenticated
  using ((select auth.uid()) = id);

drop policy if exists "Crea il tuo profilo" on public.profiles;
create policy "Crea il tuo profilo" on public.profiles
  for insert to authenticated
  with check ((select auth.uid()) = id);

drop policy if exists "Modifica il tuo profilo" on public.profiles;
create policy "Modifica il tuo profilo" on public.profiles
  for update to authenticated
  using ((select auth.uid()) = id)
  with check ((select auth.uid()) = id);

-- Libri condivisi da tutti i membri, solo con i campi pubblici.
-- Le note private, le date di lettura e il nome di chi ha il libro in prestito
-- restano visibili solo al proprietario: gli altri vedono soltanto se è disponibile.
-- La funzione è "security definer" perché le regole della tabella books
-- permettono a ciascuno di leggere solo i propri libri.
create or replace function public.club_books()
returns table (
  id             uuid,
  owner_id       uuid,
  owner_name     text,
  isbn           text,
  title          text,
  authors        text,
  publisher      text,
  published_year smallint,
  pages          integer,
  genre          text,
  cover_url      text,
  owned          boolean,
  available      boolean,
  status         text,
  rating         smallint,
  club_comment   text,
  created_at     timestamptz
)
language sql
stable
security definer
set search_path = ''
as $$
  select b.id, b.user_id, coalesce(p.display_name, 'Membro del club'),
         b.isbn, b.title, b.authors, b.publisher, b.published_year, b.pages, b.genre, b.cover_url,
         b.owned, b.owned and b.lent_to is null,
         b.status, b.rating, b.club_comment, b.created_at
  from public.books b
  left join public.profiles p on p.id = b.user_id
  where b.shared
  order by b.created_at desc;
$$;

revoke all on function public.club_books() from public, anon;
grant execute on function public.club_books() to authenticated;
