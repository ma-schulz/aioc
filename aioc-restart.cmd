@echo off
rem Aioc-Daemon neu starten (z. B. nach einem Update). Laufende Sessions kommen als
rem "vor Neustart" zurueck und lassen sich per Klick wiederherstellen; offene Fenster verbinden sich neu.
setlocal
if defined AIOC_HOME (set "AH=%AIOC_HOME%") else (set "AH=%USERPROFILE%\.aioc")
set DPID=
set DPORT=43117
for /f "tokens=1,2" %%p in ('powershell -NoProfile -Command "try { $d = Get-Content -Raw '%AH%\daemon.json' | ConvertFrom-Json; '' + $d.pid + ' ' + $d.port } catch { }"') do (set DPID=%%p& set DPORT=%%q)
if defined DPID taskkill /PID %DPID% /F >nul 2>&1
if defined DPID echo Alter Daemon PID %DPID% beendet.
ping -n 2 127.0.0.1 >nul
wscript.exe "%~dp0daemon\start-hidden.vbs"
ping -n 3 127.0.0.1 >nul
powershell -NoProfile -Command "try { $h = Invoke-RestMethod http://127.0.0.1:%DPORT%/health -TimeoutSec 3; 'Neuer Daemon laeuft: PID ' + $h.pid + ', ' + $h.sessions + ' Sessions, Port %DPORT%.' } catch { 'Daemon antwortet noch nicht - bitte kurz warten oder aioc.cmd starten.' }"
endlocal
