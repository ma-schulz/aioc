@echo off
rem Aioc starten - oeffnet das Fenster; der Daemon wird bei Bedarf automatisch gestartet.
start "" "%~dp0node_modules\.bin\electron.cmd" "%~dp0shell\main.js"
