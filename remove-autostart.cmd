@echo off
rem Entfernt den Aioc-Daemon-Autostart wieder.
schtasks /Delete /F /TN "Aioc Daemon"
