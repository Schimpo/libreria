# La mia libreria

App personale per catalogare i libri posseduti e letti, con un club del libro fra colleghi.
HTML, CSS e JavaScript senza build, pubblicata su GitHub Pages: ogni `git push` su `main`
aggiorna il sito. Supabase gestisce accessi e database. Il telefono serve per scansionare i
codici a barre, il PC per inserire e consultare.

## Come si avvia e si verifica

- Da questa cartella `python -m http.server 8080`, poi http://localhost:8080/?demo.
  **Le prove si fanno sempre con `?demo`**: i libri restano in quel browser e i dati veri non si
  toccano. Senza `?demo` l'app usa i dati veri su Supabase, come il sito pubblicato. In demo il
  club ha due colleghi d'esempio (Marco e Anna).
- Su localhost l'uso senza connessione è spento, per vedere subito le modifiche; si accende con `?sw`.
- La fotocamera funziona solo su localhost o su https.
- Non ci sono test automatici.

## Regole da non violare

- **Semplice e leggibile**: niente framework, niente build, niente strumenti nuovi. Chi la mantiene vuole
  poter modificare il codice da solo: modifiche piccole e commenti in italiano.
- **La sicurezza sta nelle regole RLS di Supabase** (`supabase/*.sql`): ogni utente vede solo i
  propri libri. Il club vede solo titolo, stato di lettura, voto, commento e disponibilità al
  prestito; note private, date di lettura e nome di chi ha il libro restano del proprietario.
  Una tabella o un campo nuovo arriva sempre con la sua regola.
- In `js/config.js` va solo la chiave **publishable** (o anon) di Supabase, pensata per stare nel
  codice pubblico. **Mai la chiave `secret` / `service_role`.**
- Le iscrizioni restano chiuse: gli utenti li crea l'amministratore dalla dashboard di Supabase.
- I passi nelle dashboard di Supabase e GitHub li fa l'amministratore: un agente li spiega, non li esegue.
- Le modifiche al database sono file numerati in `supabase/` (01, 02, 03…), eseguiti a mano
  nell'SQL Editor di Supabase, nell'ordine.

## Trappole note

- `sw.js` elenca in `APP_FILES` i file dell'app da tenere per l'uso offline: un file nuovo va
  aggiunto lì, o senza connessione non si apre.
- Dopo un aggiornamento del sito il telefono può mostrare la versione vecchia finché non si ricarica.
- Nel piano gratuito Supabase mette in pausa il progetto dopo 7 giorni senza uso (si riattiva con
  *Restore project*) e **non fa backup**: l'unica copia è l'Esporta in CSV dall'app.
- La ricerca dei libri usa Google Books (chiave facoltativa in `js/config.js`: senza, a volte
  rifiuta per quota) e Open Library.
