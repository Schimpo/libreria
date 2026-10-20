@AGENTS.md

# Specifico per Claude Code

- Le regole del progetto sono tutte in `AGENTS.md`, importato sopra: modificale lì, non qui, così valgono anche per le altre AI.
- Per provare l'app c'è il server `libreria` di `.claude/launch.json`: apri http://localhost:8080/?demo.
- Il plugin `supabase` è attivo solo in questo progetto: legge tabelle e regole prima di scrivere query o modifiche; la prima volta chiede di collegare l'account Supabase dell'amministratore.
- `gh` è autenticato come utente GitHub "Schimpo".
