# Aioc

Terminal-Manager für parallele Agenten-Sessions (Claude Code, Codex, Pi, pwsh) mit
Statusübersicht: links alle Sessions (läuft / wartet auf dich / fertig / beendet), rechts das
echte Terminal (ConPTY + xterm.js).

## Start

```
aioc.cmd            # öffnet das Fenster; startet den Daemon bei Bedarf mit
npm run daemon      # nur den Daemon starten (z. B. als Autostart)
npm run app         # nur das Fenster
```

Browser statt Electron: `http://127.0.0.1:43117/?token=<token>` — Token steht in `%USERPROFILE%\.aioc\daemon.json`.

## Architektur

- **Daemon** (`daemon/`) — besitzt die Sessions: PTYs (node-pty/ConPTY), Scrollback je Session
  (headless xterm + Serialize), Status-Engine, Persistenz unter `%USERPROFILE%\.aioc\`.
  Fenster schließen beendet **keine** Session.
- **Fenster** (`shell/` + `ui/`) — Electron lädt nur die vom Daemon ausgelieferte Web-UI.
- **Statusquellen** — pro Aufruf injizierte Hooks/Extensions, globale Configs bleiben unberührt:
  - Claude: `--settings %USERPROFILE%\.aioc\claude-settings.json` (Hooks laufen **zusätzlich**
    zu globalen/Projekt-Hooks; verifiziert 30.08.2026 mit Claude Code 2.1.251)
  - Codex: `-c "hooks.<Event>=[…]"` (TOML-Literale, Vorwärts-Slashes; verifiziert 30.08.2026
    mit codex-cli 0.151); Overlay-Wartezustand zusätzlich über den Terminaltitel „Action Required"
  - Pi: `-e daemon/hooks/aioc-pi-ext.ts` (braucht Pi ≥ 0.84.4 für `ui_prompt_*`)
  - pwsh: Heuristik (Ausgabe fließt / 3 s Ruhe / Exit)
- **Neustart-Wiederherstellung** — Sessionliste + Scrollback kommen immer zurück; die
  Agenten-Konversation per Klick über `claude --resume` / `codex resume` / `pi --session`
  (IDs stammen aus den Hook-Payloads).

## Hinweise

- Codex fragt beim ersten Start einer Aioc-Session einmalig, ob es den Aioc-Hook ausführen darf
  (Hook-Trust) — einmal bestätigen, wird persistiert.
- Der Daemon lauscht nur auf `127.0.0.1`. Für LAN-Zugriff (`host` in
  `%USERPROFILE%\.aioc\daemon.json`) gilt: Token bleibt Pflicht, von außerhalb nur per VPN —
  Terminal-Zugang ist Vollzugriff auf den PC.
- Tasten wie im Windows Terminal: Ctrl+C kopiert bei Auswahl (sonst Abbruch), Ctrl+V fügt ein,
  Ctrl+Shift+F sucht, Ctrl+1…9 wechselt die Session, Ctrl+Shift+N neue Session.
