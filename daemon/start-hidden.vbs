' Startet den Aioc-Daemon unsichtbar (fuer den Autostart per geplanter Aufgabe).
Dim fso, dir
Set fso = CreateObject("Scripting.FileSystemObject")
dir = fso.GetParentFolderName(WScript.ScriptFullName)
CreateObject("WScript.Shell").Run "node """ & dir & "\daemon.js""", 0, False
