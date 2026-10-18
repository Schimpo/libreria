-- Lista "Voglio leggere", consigli, prestiti tra colleghi, novità del club e obiettivo di lettura.
-- Da eseguire una volta nel SQL Editor di Supabase, dopo 02-club.sql.

-- ---------- Nuovi campi sui libri ----------

alter table public.books
  add column if not exists recommended_by  text,        -- chi te l'ha consigliato
  add column if not exists lent_at         date,        -- da quando è in prestito
  add column if not exists borrower_id     uuid references auth.users (id) on delete set null,
  add column if not exists club_updated_at timestamptz; -- ultima novità visibile al club

-- Valori iniziali per i libri che già esistono.
update public.books set club_updated_at = created_at where shared and club_updated_at is null;
update public.books set lent_at = updated_at::date where lent_to is not null and lent_at is null;

-- ---------- Prestiti tra membri del club ----------

create table if not exists public.loans (
  id           uuid primary key default gen_random_uuid(),
  book_id      uuid not null references public.books (id) on delete cascade,
  owner_id     uuid not null references auth.users (id) on delete cascade,
  borrower_id  uuid not null references auth.users (id) on delete cascade,
  status       text not null default 'requested'
               check (status in ('requested', 'accepted', 'declined', 'returned', 'cancelled')),
  requested_at timestamptz not null default now(),
  answered_at  timestamptz,
  returned_at  timestamptz
);

-- Una sola richiesta aperta per libro e per persona.
create unique index if not exists loans_active_key
  on public.loans (book_id, borrower_id)
  where status in ('requested', 'accepted');
create index if not exists loans_owner_idx on public.loans (owner_id, status);
create index if not exists loans_borrower_idx on public.loans (borrower_id, status);

-- Nessuna policy: la tabella si legge e si modifica solo con le funzioni qui sotto,
-- che controllano chi può fare cosa.
alter table public.loans enable row level security;

-- ---------- Regole automatiche sui libri ----------

create or replace function public.books_before_write()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  -- La data del prestito si imposta da sola quando cambia "Prestato a".
  if new.lent_to is null then
    new.lent_at := null;
  elsif tg_op = 'INSERT' then
    new.lent_at := coalesce(new.lent_at, current_date);
  elsif new.lent_to is distinct from old.lent_to and new.lent_at is not distinct from old.lent_at then
    new.lent_at := current_date;
  end if;

  if tg_op = 'UPDATE' then
    -- Se il proprietario cambia o cancella a mano "Prestato a" di un prestito
    -- fatto con l'app (es. "Restituito"), quel prestito si chiude.
    if old.borrower_id is not null
       and new.borrower_id is not distinct from old.borrower_id
       and new.lent_to is distinct from old.lent_to then
      update public.loans set status = 'returned', returned_at = now()
        where book_id = new.id and status = 'accepted';
      new.borrower_id := null;
    end if;

    -- Novità per il club: condivisione appena attivata, oppure commento, voto o stato cambiati.
    if new.shared and (not old.shared
        or new.club_comment is distinct from old.club_comment
        or new.rating is distinct from old.rating
        or new.status is distinct from old.status) then
      new.club_updated_at := now();
    end if;
  elsif new.shared then
    new.club_updated_at := now();
  end if;

  return new;
end;
$$;

drop trigger if exists books_before_write on public.books;
create trigger books_before_write
  before insert or update on public.books
  for each row execute function public.books_before_write();

-- ---------- Funzioni per i prestiti ----------

-- Chiede in prestito un libro condiviso da un altro membro.
create or replace function public.request_loan(book uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  b public.books%rowtype;
begin
  select * into b from public.books where id = book;
  if not found or not b.shared then
    raise exception 'Libro non trovato nel club.';
  end if;
  if b.user_id = auth.uid() then
    raise exception 'Questo libro è già tuo.';
  end if;
  if not b.owned or b.lent_to is not null then
    raise exception 'Il libro non è disponibile in questo momento.';
  end if;
  insert into public.loans (book_id, owner_id, borrower_id) values (b.id, b.user_id, auth.uid());
exception
  when unique_violation then
    raise exception 'Hai già chiesto questo libro in prestito.';
end;
$$;

-- Il proprietario accetta o rifiuta una richiesta.
-- Accettando, il libro risulta prestato e le altre richieste per lo stesso libro vengono rifiutate.
create or replace function public.respond_loan(loan uuid, accept boolean)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  l public.loans%rowtype;
begin
  select * into l from public.loans where id = loan for update;
  if not found or l.owner_id is distinct from auth.uid() then
    raise exception 'Richiesta non trovata.';
  end if;
  if l.status <> 'requested' then
    raise exception 'Questa richiesta è già stata gestita.';
  end if;

  if not accept then
    update public.loans set status = 'declined', answered_at = now() where id = loan;
    return;
  end if;

  if exists (select 1 from public.books where id = l.book_id and (lent_to is not null or not owned)) then
    raise exception 'Il libro risulta già in prestito: segnalo come restituito prima di accettare.';
  end if;

  update public.loans set status = 'accepted', answered_at = now() where id = loan;
  update public.books
    set lent_to = coalesce((select display_name from public.profiles where id = l.borrower_id), 'Membro del club'),
        borrower_id = l.borrower_id,
        lent_at = current_date
    where id = l.book_id;
  update public.loans set status = 'declined', answered_at = now()
    where book_id = l.book_id and status = 'requested';
end;
$$;

-- Chi ha fatto una richiesta può annullarla finché non riceve risposta.
create or replace function public.cancel_loan(loan uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  update public.loans set status = 'cancelled', answered_at = now()
    where id = loan and borrower_id = auth.uid() and status = 'requested';
  if not found then
    raise exception 'Richiesta non trovata o già gestita.';
  end if;
end;
$$;

-- Prestiti che ti riguardano: richieste ricevute e fatte, libri prestati e ricevuti.
-- Le richieste rifiutate restano visibili a chi le ha fatte per 14 giorni.
create or replace function public.my_loans()
returns table (
  id           uuid,
  book_id      uuid,
  status       text,
  my_role      text,        -- 'owner' se il libro è tuo, 'borrower' se l'hai chiesto tu
  other_name   text,        -- l'altra persona coinvolta
  title        text,
  authors      text,
  cover_url    text,
  isbn         text,
  requested_at timestamptz,
  answered_at  timestamptz
)
language sql
stable
security definer
set search_path = ''
as $$
  select l.id, l.book_id, l.status,
         case when l.owner_id = auth.uid() then 'owner' else 'borrower' end,
         coalesce(p.display_name, 'Membro del club'),
         b.title, b.authors, b.cover_url, b.isbn,
         l.requested_at, l.answered_at
  from public.loans l
  join public.books b on b.id = l.book_id
  left join public.profiles p
    on p.id = case when l.owner_id = auth.uid() then l.borrower_id else l.owner_id end
  where (l.owner_id = auth.uid() or l.borrower_id = auth.uid())
    and (l.status in ('requested', 'accepted')
         or (l.status = 'declined' and l.borrower_id = auth.uid()
             and l.answered_at > now() - interval '14 days'))
  order by l.requested_at desc;
$$;

-- ---------- Libri del club (versione aggiornata) ----------

-- Rispetto a 02-club.sql aggiunge la data dell'ultima novità e "lent_to_me"
-- (il libro è in prestito a chi sta guardando), senza rivelare a chi è prestato.
drop function if exists public.club_books();
create function public.club_books()
returns table (
  id              uuid,
  owner_id        uuid,
  owner_name      text,
  isbn            text,
  title           text,
  authors         text,
  publisher       text,
  published_year  smallint,
  pages           integer,
  genre           text,
  cover_url       text,
  owned           boolean,
  available       boolean,
  lent_to_me      boolean,
  status          text,
  rating          smallint,
  club_comment    text,
  created_at      timestamptz,
  club_updated_at timestamptz
)
language sql
stable
security definer
set search_path = ''
as $$
  select b.id, b.user_id, coalesce(p.display_name, 'Membro del club'),
         b.isbn, b.title, b.authors, b.publisher, b.published_year, b.pages, b.genre, b.cover_url,
         b.owned, b.owned and b.lent_to is null, coalesce(b.borrower_id = auth.uid(), false),
         b.status, b.rating, b.club_comment, b.created_at,
         coalesce(b.club_updated_at, b.created_at)
  from public.books b
  left join public.profiles p on p.id = b.user_id
  where b.shared
  order by coalesce(b.club_updated_at, b.created_at) desc;
$$;

revoke all on function public.club_books() from public, anon;
revoke all on function public.request_loan(uuid) from public, anon;
revoke all on function public.respond_loan(uuid, boolean) from public, anon;
revoke all on function public.cancel_loan(uuid) from public, anon;
revoke all on function public.my_loans() from public, anon;
grant execute on function public.club_books() to authenticated;
grant execute on function public.request_loan(uuid) to authenticated;
grant execute on function public.respond_loan(uuid, boolean) to authenticated;
grant execute on function public.cancel_loan(uuid) to authenticated;
grant execute on function public.my_loans() to authenticated;

-- ---------- Obiettivo di lettura annuale ----------

create table if not exists public.reading_goals (
  user_id uuid not null default auth.uid() references auth.users (id) on delete cascade,
  year    smallint not null,
  target  smallint not null check (target between 1 and 1000),
  primary key (user_id, year)
);

alter table public.reading_goals enable row level security;

grant select, insert, update, delete on public.reading_goals to authenticated;

drop policy if exists "Gestisci i tuoi obiettivi" on public.reading_goals;
create policy "Gestisci i tuoi obiettivi" on public.reading_goals
  for all to authenticated
  using ((select auth.uid()) = user_id)
  with check ((select auth.uid()) = user_id);
