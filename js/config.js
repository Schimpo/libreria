// Configurazione dell'app.
//
// SUPABASE_URL e SUPABASE_KEY si trovano in Supabase → Project Settings → API Keys.
// Usa la chiave "publishable" (o "anon"): è pensata per stare nel browser ed è
// protetta dalle regole di sicurezza definite in supabase/schema.sql.
// Non inserire MAI qui la chiave "secret" / "service_role".
//
// Se SUPABASE_URL è vuoto l'app parte in modalità demo: i libri vengono salvati
// solo nel browser che stai usando.

export const SUPABASE_URL = 'https://msbgnnhpiengmobqsqcp.supabase.co';
export const SUPABASE_KEY = 'sb_publishable_GyQ3bQS2vB0U9BusLcn41w_f7a_3A49';

// Facoltativa: senza chiave Google Books a volte rifiuta le ricerche per quota
// esaurita (l'app usa comunque Open Library). Si crea gratis su
// https://console.cloud.google.com → API e servizi → Credenziali.
export const GOOGLE_BOOKS_API_KEY = 'AIzaSyCQN1NE4kK6_VJdu0oh17K4PQ_bX6FjC1w';
