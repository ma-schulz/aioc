@echo off
rem Aioc-Daemon beim Anmelden automatisch (unsichtbar) starten. Entfernen: remove-autostart.cmd
schtasks /Create /F /TN "Aioc Daemon" /SC ONLOGON /RL LIMITED /TR "wscript.exe \"%~dp0daemon\start-hidden.vbs\""
if %errorlevel%==0 echo Autostart eingerichtet: geplante Aufgabe "Aioc Daemon" (bei Anmeldung).
