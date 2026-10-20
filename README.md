# La mia libreria

Web app personale per catalogare i libri che possiedi e quelli che hai letto.
Funziona su telefono (con scansione del codice a barre) e su PC.

- **Aggiunta rapida**: scansiona il codice a barre, scrivi l'ISBN o cerca per titolo;
  titolo, autore, editore e copertina si compilano da soli (Google Books + Open Library).
- **Posseduto e letto sono separati**: un libro può essere tuo ma da leggere, o letto ma preso in prestito.
- Stato di lettura, date, voto, note, a chi l'hai prestato.
- Ricerca, filtri, ordinamento, statistiche ed esportazione in CSV.
- **Lista "Voglio leggere"**: i libri che ti incuriosiscono e non hai ancora, con chi te li ha consigliati.
- **Club del libro**: ognuno sceglie quali libri condividere con i colleghi, con voto e commento;
  nella schermata *Club* si vede chi ha cosa, cosa è piaciuto e cosa ci si può far prestare.
- **"Chi ce l'ha?"**: se un libro che vuoi leggere (o che hai appena scansionato) ce l'ha un collega, l'app te lo dice.
- **Prestiti**: richieste dal Club, accettazione, elenco dei libri prestati e ricevuti, restituzione.
- **Obiettivo di lettura** annuale e **uso senza connessione** (consultazione della tua libreria).

È fatta con HTML, CSS e JavaScript senza strumenti di build: modifichi un file, ricarichi la pagina e vedi il risultato.
I dati stanno su [Supabase](https://supabase.com) (database gratuito) e il sito su GitHub Pages (gratuito).

---

## Configurazione (una volta sola)

### 1. Database su Supabase

1. Crea un account su <https://supabase.com> e poi un nuovo progetto
   (regione consigliata: *Central EU (Frankfurt)*). Annota la password del database in un posto sicuro.
2. Apri **SQL Editor → New query**, incolla tutto il contenuto di [`supabase/01-schema.sql`](supabase/01-schema.sql) e premi **Run**.
   Crea la tabella `books` e le regole di sicurezza, così ogni utente vede solo i propri libri.
   Ripeti, nell'ordine, con [`supabase/02-club.sql`](supabase/02-club.sql) (club del libro)
   e [`supabase/03-prestiti.sql`](supabase/03-prestiti.sql) (lista "Voglio leggere", prestiti, novità, obiettivo).
3. Crea il tuo utente: **Authentication → Users → Add user → Create new user**,
   inserisci email e password e spunta **Auto Confirm User**.
4. Chiudi le iscrizioni ad altri: **Authentication → Sign In / Providers**, disattiva
   **Allow new users to sign up** e salva.
5. Vai in **Project Settings → API Keys** e copia:
   - il **Project URL** (es. `https://abcdefgh.supabase.co`)
   - la chiave **publishable** (inizia con `sb_publishable_…`; nei progetti più vecchi si chiama *anon*).
6. Incollali in [`js/config.js`](js/config.js):

   ```js
   export const SUPABASE_URL = 'https://abcdefgh.supabase.co';
   export const SUPABASE_KEY = 'sb_publishable_...';
   ```

   La chiave publishable può stare nel codice pubblico: a proteggere i dati sono le regole del passo 2.
   **Non usare mai la chiave `secret` / `service_role`.**

> **Nota:** nel piano gratuito, se per 7 giorni nessuno usa l'app Supabase mette il progetto in pausa.
> I dati non si perdono: basta riattivarlo dalla dashboard (**Restore project**).

### 2. Pubblicazione su GitHub Pages

1. Crea un repository su GitHub (es. `libreria`) e carica questi file.
2. Nel repository: **Settings → Pages → Build and deployment → Source: Deploy from a branch**,
   scegli `main` e la cartella `/ (root)`, poi **Save**.
3. Dopo un minuto l'app è online su `https://<tuo-utente>.github.io/libreria/`.

Ogni volta che fai `git push` il sito si aggiorna da solo.

### 3. Sul telefono

Apri l'indirizzo del sito e accedi.
Poi aggiungi l'app alla schermata Home: su iPhone *Condividi → Aggiungi alla schermata Home*,
su Android *menu ⋮ → Aggiungi a schermata Home / Installa app*.
La prima volta che scansioni il browser chiede il permesso per la fotocamera.

---

## Provarla sul PC

Da questa cartella:

```bash
python -m http.server 8080
```

Poi apri <http://localhost:8080/?demo>: con `?demo` nell'indirizzo l'app parte in **modalità demo**
e salva i libri solo in quel browser, senza toccare i dati veri. È comoda per provare le modifiche.
Senza `?demo` usa i dati veri su Supabase, come il sito pubblicato.
Se `js/config.js` è vuoto, parte sempre in modalità demo.

La fotocamera funziona solo su `localhost` o su un sito `https` (come GitHub Pages).

In modalità demo il club contiene due colleghi di esempio (Marco e Anna), così si possono provare
la lista "Voglio leggere", "Chi ce l'ha?" e le richieste di prestito.
Su `localhost` l'uso senza connessione è spento, per vedere subito le modifiche: si accende aggiungendo `?sw`.

## Ricerca dei libri

Per ogni ISBN l'app chiede i dati a tre fonti insieme e sceglie in quest'ordine:

1. **OPAC SBN**, il catalogo delle biblioteche italiane: il più preciso per i libri italiani.
   Il browser non può leggerlo direttamente, quindi passa da una piccola funzione su Supabase
   (`supabase/functions/sbn/index.ts`) che risponde solo a chi ha fatto l'accesso.
2. **Google Books**: da ottobre 2026 ha un guasto (le ricerche per ISBN tornano vuote), ma resta in lista
   per quando tornerà a funzionare. La chiave facoltativa va in `GOOGLE_BOOKS_API_KEY` dentro `js/config.js`.
3. **Open Library**: riserva finale e fonte delle copertine.

Le fonti successive completano solo i campi mancanti, e solo se il titolo coincide.
La ricerca per titolo usa Google Books e Open Library. In modalità demo SBN non viene usato.

### Pubblicare la funzione `sbn` (una volta, e dopo ogni modifica al file)

1. Nella dashboard di Supabase apri **Edge Functions** → **Deploy a new function** → **Via Editor**.
2. **Prima di pubblicare**, nel campo del nome della funzione scrivi `sbn`. Il nome diventa l'indirizzo
   (`…/functions/v1/sbn`) e dopo non si può più cambiare: rinominarla cambia solo l'etichetta.
3. Cancella **tutto** il codice d'esempio (quello che risponde "Hello …") e incolla tutto il contenuto
   di [`supabase/functions/sbn/index.ts`](supabase/functions/sbn/index.ts).
4. Premi **Deploy function** e aspetta qualche secondo.
5. Nelle impostazioni della funzione controlla che la verifica del JWT (*Verify JWT*) sia **attiva**.
6. Controllo: nell'elenco **Edge Functions** l'indirizzo (colonna URL) deve finire con `/functions/v1/sbn`.

Per aggiornarla: apri la funzione, incolla il nuovo codice e premi **Deploy updates**.
Se la funzione non è pubblicata o non risponde, la ricerca continua con Google Books e Open Library.

## Club del libro

Tutti gli utenti dell'app fanno parte dello stesso club.
La libreria di ciascuno resta privata: nella scheda di un libro si attiva **Condividi con il club**
e si può aggiungere un **Commento per il club**.
Gli altri membri vedono solo titolo, stato di lettura, voto, commento e se il libro è disponibile per il prestito.
Le note private, le date di lettura e il nome di chi ha il libro in prestito restano visibili solo al proprietario.

### Aggiungere un collega

1. In Supabase: **Authentication → Users → Add user → Create new user**, inserisci la sua email
   e una password provvisoria, spunta **Auto Confirm User** e premi **Create user**.
2. Manda al collega l'indirizzo del sito, la sua email e la password provvisoria.
3. Al primo accesso l'app gli chiede il nome da mostrare nel club e gli permette di cambiare la password
   (anche più tardi, dal pulsante **Profilo**).

Le iscrizioni restano chiuse: entra solo chi ha un account creato da te.
Per togliere qualcuno dal club elimina il suo utente da **Authentication → Users**:
spariscono anche i suoi libri.
Ricorda ai colleghi quali dati vengono salvati (nome, email e i libri che inseriscono).

### Prestiti

Nel Club, accanto ai libri disponibili dei colleghi, c'è **Chiedi in prestito**.
Chi possiede il libro trova la richiesta nella scheda **Prestiti** (con un numero sulla scheda) e la accetta o rifiuta.
Accettando, il libro risulta prestato con la data, e le altre richieste per lo stesso libro vengono rifiutate.
Chi l'ha ricevuto lo vede in **Ho in prestito**; quando lo riporta, il proprietario preme **Restituito**.
Si possono ancora segnare a mano i prestiti a persone fuori dal club, scrivendo il nome in "Prestato a".

L'app non manda email o notifiche: richieste e novità si vedono quando la si apre.

## Senza connessione

Una volta aperta online, l'app si può aprire anche senza rete e mostra l'ultima copia salvata dei tuoi libri,
in sola lettura. Club, prestiti, aggiunte e modifiche richiedono la connessione.
La copia sta solo sul dispositivo e viene cancellata quando premi **Esci**.

Dopo un aggiornamento del sito, se il telefono mostra ancora la versione vecchia basta ricaricare la pagina.

## Backup

Il piano gratuito di Supabase **non fa backup automatici**.
Ogni tanto premi **Esporta** per scaricare il CSV della tua libreria (ognuno può farlo per i propri libri).

## Struttura dei file

| File | Cosa contiene |
|---|---|
| `index.html` | La pagina: libreria, club, prestiti, finestre di aggiunta, scheda libro, profilo, scansione, statistiche |
| `css/style.css` | Grafica (colori in cima al file, sia chiari che scuri) |
| `js/app.js` | Logica dell'interfaccia (diviso in sezioni: libreria, club, prestiti, scheda libro…) |
| `js/ui.js` | Piccoli aiuti per costruire la pagina (copertine, stelle, date, avvisi) |
| `js/db.js` | Lettura e salvataggio di libri, profilo, club, prestiti e obiettivo (Supabase o modalità demo) |
| `js/lookup.js` | Ricerca dei dati per ISBN o titolo, controllo degli ISBN |
| `js/scanner.js` | Lettura del codice a barre con la fotocamera |
| `js/config.js` | Indirizzo e chiave di Supabase, chiave di Google Books |
| `supabase/01-schema.sql` | Tabella dei libri e regole di sicurezza |
| `supabase/02-club.sql` | Profili, condivisione dei libri e funzione che elenca i libri del club |
| `supabase/03-prestiti.sql` | Prestiti, "Consigliato da", novità del club, obiettivo di lettura |
| `supabase/functions/sbn/index.ts` | Funzione Supabase che cerca un ISBN nel catalogo OPAC SBN |
| `sw.js` | Service worker: permette di aprire l'app senza connessione |
| `manifest.webmanifest`, `icons/` | Nome e icona quando l'app è aggiunta alla schermata Home |

### Aggiungere un campo

Esempio: un campo "Collocazione" (su quale scaffale si trova il libro).

1. In Supabase, **SQL Editor**: `alter table public.books add column shelf text;`
2. In `index.html`, dentro `#book-form`, aggiungi un campo con lo stesso nome della colonna:
   `<label class="field"><span>Collocazione</span><input name="shelf"></label>`
3. In `js/app.js`, nella funzione `readForm()`, aggiungi `shelf: text('shelf'),`.
