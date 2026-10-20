// Funzione Supabase (Edge Function) "sbn": cerca un libro per ISBN nel catalogo delle
// biblioteche italiane (OPAC SBN) e restituisce i dati già puliti.
// Serve perché il browser non può leggere OPAC SBN direttamente: il loro server non dà
// il permesso (CORS) ai siti esterni.
//
// Come si pubblica: vedi la sezione "Ricerca dei libri" del README.
//
// Sicurezza:
// - "Verify JWT" deve restare attivo: Supabase lascia passare solo richieste con un accesso valido;
// - in più qui il token viene controllato dal servizio di accesso di Supabase, così la funzione
//   resta protetta anche se "Verify JWT" venisse spento per sbaglio;
// - la funzione chiama solo opac.sbn.it e solo con un ISBN di 13 cifre.
//
// Attenzione: opacmobilegw è l'indirizzo usato dall'app ufficiale OPAC SBN, non un servizio
// documentato. Se smette di funzionare, l'app usa da sola Google Books e Open Library.

const ALLOWED_ORIGINS = ['https://schimpo.github.io', 'http://localhost:8080', 'http://127.0.0.1:8080'];
const SBN_URL = 'https://opac.sbn.it/opacmobilegw';
const TIMEOUT_MS = 5000;

export async function handle(req: Request): Promise<Response> {
  const origin = req.headers.get('Origin') ?? '';
  const cors = {
    'Access-Control-Allow-Origin': ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0],
    'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, x-retry-count',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Vary': 'Origin',
  };
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  if (!(await isMember(req))) return reply({ error: "Serve l'accesso all'app." }, 401, cors);

  let isbn = '';
  try {
    isbn = String((await req.json()).isbn ?? '');
  } catch {
    // corpo mancante o non valido: lo segnala il controllo qui sotto
  }
  if (!/^97[89]\d{10}$/.test(isbn)) return reply({ error: 'ISBN non valido.' }, 400, cors);

  try {
    return reply({ book: await lookup(isbn) }, 200, cors);
  } catch {
    return reply({ error: 'Catalogo SBN non raggiungibile.' }, 502, cors);
  }
}

// Chiede al servizio di accesso di Supabase chi è il proprietario del token:
// un token falso o scaduto viene rifiutato, così come gli utenti anonimi.
async function isMember(req: Request): Promise<boolean> {
  const auth = req.headers.get('Authorization') ?? '';
  if (!/^Bearer\s+\S+$/i.test(auth)) return false;
  const key = projectKey();
  if (!key) {
    console.error('sbn: manca la chiave del progetto (SUPABASE_PUBLISHABLE_KEYS o SUPABASE_ANON_KEY)');
    return false;
  }
  try {
    const res = await fetch(`${Deno.env.get('SUPABASE_URL')}/auth/v1/user`, {
      headers: { Authorization: auth, apikey: key },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!res.ok) return false;
    const user = await res.json();
    return Boolean(user?.id) && user.is_anonymous !== true;
  } catch {
    return false;
  }
}

// Chiave publishable del progetto (o "anon" nei progetti più vecchi), fornita da Supabase.
function projectKey(): string {
  try {
    const keys = JSON.parse(Deno.env.get('SUPABASE_PUBLISHABLE_KEYS') ?? '{}');
    const first = Object.values(keys)[0];
    if (first) return String(first);
  } catch {
    // valore assente o non leggibile: si prova la chiave anon
  }
  return Deno.env.get('SUPABASE_ANON_KEY') ?? '';
}

async function lookup(isbn: string) {
  const search = await getJson(`${SBN_URL}/search.json?isbn=${isbn}`);
  // Solo una scheda con esattamente quell'ISBN (nel catalogo è scritto con i trattini,
  // e nelle schede più vecchie in forma a 10 cifre).
  const record = search.briefRecords?.find((r: { isbn?: string }) => toIsbn13(r.isbn) === isbn);
  if (!record) return null;
  // La scheda completa ha in più il numero di pagine e la lingua.
  const full = await getJson(`${SBN_URL}/full.json?bid=${encodeURIComponent(record.codiceIdentificativo)}`)
    .catch(() => ({}));
  const publication = String(record.pubblicazione ?? full.pubblicazione ?? '');
  return {
    isbn,
    title: cleanTitle(record.titolo ?? full.titolo ?? ''),
    authors: cleanAuthor(record.autorePrincipale ?? full.autorePrincipale),
    publisher: cleanPublisher(publication),
    published_year: Number(publication.match(/(\d{4})\D*$/)?.[1]) || null,   // anche "[2014]"
    pages: mainPages(full.descrizioneFisica),
    language: full.linguaPubblicazione === 'ITALIANO' ? 'it' : null,
  };
}

// "88-452-1066-9" → "9788845210662"; un ISBN a 13 cifre resta com'è.
// È una copia di normalizeIsbn in js/lookup.js: la funzione si incolla nella dashboard
// come file unico e non può importare il codice dell'app. Se cambi una, cambia anche l'altra.
function toIsbn13(raw?: string): string | null {
  const digits = (raw ?? '').toUpperCase().replace(/[^0-9X]/g, '');
  if (digits.length === 13) return digits;
  if (digits.length !== 10) return null;
  const core = '978' + digits.slice(0, 9);
  let sum = 0;
  for (let i = 0; i < 12; i++) sum += Number(core[i]) * (i % 2 ? 3 : 1);
  return core + ((10 - (sum % 10)) % 10);
}

// "Il signore degli anelli : trilogia / John Ronald Reuel Tolkien ; …" → "Il signore degli anelli"
function cleanTitle(title: string): string {
  // I caratteri 0x88 e 0x89 e l'asterisco iniziale sono segni del catalogo per l'ordinamento.
  return title.replace(/[\x88\x89]/g, '').replace(/^\*\s*/, '').split(' / ')[0].split(' : ')[0].trim();
}

// "Tolkien, J. R. R." → "J. R. R. Tolkien"; "Levi, Primo <1919-1987>" → "Primo Levi"
function cleanAuthor(author?: string): string | null {
  if (!author) return null;
  const [surname, name] = author.replace(/<[^>]*>/g, '').split(',').map((s) => s.trim());
  return name ? `${name} ${surname}` : surname;
}

// "Milano : Bompiani, 1990" → "Bompiani". "[s.n.]" (editore sconosciuto) → null.
function cleanPublisher(publication: string): string | null {
  const publisher = publication.match(/:\s*([^,]+),/)?.[1].trim().replace(/^\[|\]$/g, '');
  return publisher && !/^s\.\s*n\.?$/i.test(publisher) ? publisher : null;
}

// "552 p. ; 20 cm" → 552; "[8] p. di tav., 533 p." → 533 (il numero più grande).
function mainPages(description?: string): number | null {
  const counts = [...String(description ?? '').matchAll(/(\d+)\s*p\./g)].map((m) => Number(m[1]));
  return counts.length ? Math.max(...counts) : null;
}

async function getJson(url: string) {
  const res = await fetch(url, { signal: AbortSignal.timeout(TIMEOUT_MS) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

function reply(body: unknown, status: number, headers: Record<string, string>): Response {
  return new Response(JSON.stringify(body), { status, headers: { ...headers, 'Content-Type': 'application/json' } });
}

Deno.serve(handle);
