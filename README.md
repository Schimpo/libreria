# La mia libreria

Web app personale per catalogare i libri che possiedi e quelli che hai letto.
Funziona su telefono (con scansione del codice a barre) e su PC.

- **Aggiunta rapida**: scansiona il codice a barre, scrivi l'ISBN o cerca per titolo;
  titolo, autore, editore e copertina si compilano da soli (Google Books + Open Library).
- **Posseduto e letto sono separati**: un libro può essere tuo ma da leggere, o letto ma preso in prestito.
- Stato di lettura, date, voto, note, a chi l'hai prestato.
- Ricerca, filtri, ordinamento, statistiche ed esportazione in CSV.
- **Club del libro**: ognuno sceglie quali libri condividere con i colleghi, con voto e commento;
  nella schermata *Club* si vede chi ha cosa, cosa è piaciuto e cosa si può farsi prestare.

È fatta con HTML, CSS e JavaScript senza strumenti di build: modifichi un file, ricarichi la pagina e vedi il risultato.
I dati stanno su [Supabase](https://supabase.com) (database gratuito) e il sito su GitHub Pages (gratuito).

---

## Configurazione (una volta sola)

### 1. Database su Supabase

1. Crea un account su <https://supabase.com> e poi un nuovo progetto
   (regione consigliata: *Central EU (Frankfurt)*). Annota la password del database in un posto sicuro.
2. Apri **SQL Editor → New query**, incolla tutto il contenuto di [`supabase/01-schema.sql`](supabase/01-schema.sql) e premi **Run**.
   Crea la tabella `books` e le regole di sicurezza, così ogni utente vede solo i propri libri.
   Ripeti con [`supabase/02-club.sql`](supabase/02-club.sql), che aggiunge il club del libro.
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

## Ricerca dei libri

Per ogni ISBN l'app interroga insieme Google Books e Open Library e unisce i risultati.
Senza chiave Google Books a volte risponde "quota esaurita": in quel caso restano i dati di Open Library,
che per i libri italiani possono essere incompleti. Per risultati migliori puoi creare una chiave gratuita
([Google Cloud Console](https://console.cloud.google.com) → API e servizi → abilita *Books API* → Credenziali → Crea chiave API,
limitandola al tuo sito) e inserirla in `GOOGLE_BOOKS_API_KEY` dentro `js/config.js`.

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

## Struttura dei file

| File | Cosa contiene |
|---|---|
| `index.html` | La pagina: elenco, club, finestre di aggiunta, scheda libro, profilo, scansione, statistiche |
| `css/style.css` | Grafica (colori in cima al file, sia chiari che scuri) |
| `js/app.js` | Logica dell'interfaccia |
| `js/db.js` | Lettura e salvataggio di libri, profilo e club (Supabase o modalità demo) |
| `js/lookup.js` | Ricerca dei dati per ISBN o titolo, controllo degli ISBN |
| `js/scanner.js` | Lettura del codice a barre con la fotocamera |
| `js/config.js` | Indirizzo e chiave di Supabase, chiave di Google Books |
| `supabase/01-schema.sql` | Tabella dei libri e regole di sicurezza |
| `supabase/02-club.sql` | Profili, condivisione dei libri e funzione che elenca i libri del club |
| `manifest.webmanifest`, `icons/` | Nome e icona quando l'app è aggiunta alla schermata Home |

### Aggiungere un campo

Esempio: un campo "Collocazione" (su quale scaffale si trova il libro).

1. In Supabase, **SQL Editor**: `alter table public.books add column shelf text;`
2. In `index.html`, dentro `#book-form`, aggiungi un campo con lo stesso nome della colonna:
   `<label class="field"><span>Collocazione</span><input name="shelf"></label>`
3. In `js/app.js`, nella funzione `readForm()`, aggiungi `shelf: text('shelf'),`.
