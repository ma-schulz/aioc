param([Parameter(Mandatory = $true)][string]$Path)
# Legt eine Bilddatei in die Zwischenablage des Daemon-Rechners (braucht einen STA-Thread: powershell -STA).
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
$img = [System.Drawing.Image]::FromFile($Path)
try { [System.Windows.Forms.Clipboard]::SetImage($img) } finally { $img.Dispose() }
