@echo off
rem Aioc starten - oeffnet das Fenster; der Daemon wird bei Bedarf automatisch gestartet.
start "Aioc" "%~dp0node_modules\electron\dist\electron.exe" "%~dp0shell\main.js"
