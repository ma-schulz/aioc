@echo off
rem Aioc-Fenster auf einem anderen PC: Verbindungslink aus der Titelleiste des Daemon-Rechners
rem in Anfuehrungszeichen uebergeben (er enthaelt Token und Zertifikats-Fingerprint).
if "%~1"=="" (
  echo Aufruf: aioc-remote.cmd "https://IP:43443/?token=...&fp=..."
  exit /b 1
)
start "Aioc" "%~dp0node_modules\electron\dist\electron.exe" "%~dp0shell\main.js" "%~1"
