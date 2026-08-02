# Opens ASYCUDAWorld straight at
#   File > Document Library > ASYCUDA > Goods Clearance > Declaration >
#   Detailed Declaration > Detailed Declaration > Find (or New)
#
# ASYCUDAWorld is a Java (Swing) desktop app with no command line for this, so the
# only way in is the keyboard: Swing menus walk with Alt+F, Down and Right, and each
# Right opens a submenu and lands on its first item. That is exactly the path above.
#
# ASYCUDAWorld must already be OPEN and LOGGED IN — the login needs your password, and
# no script should be holding that. Run this once you are at the empty ASYCUDA desktop.
#
#   powershell -ExecutionPolicy Bypass -File asycuda-open.ps1            -> Find
#   powershell -ExecutionPolicy Bypass -File asycuda-open.ps1 -Action New -> New
#
# If the menu ever moves (a customs upgrade adds or removes a level), change $Steps —
# it is one Right per level below "Document Library", nothing else needs touching.

param(
  [ValidateSet('Find','New')] [string]$Action = 'Find',
  [int]$KeyDelay = 250,   # ms between keys — raise if a submenu is slow to appear
  [int]$Steps    = 6      # menu levels below "Document Library"
)

Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName Microsoft.VisualBasic

function Fail($msg) {
  [System.Windows.Forms.MessageBox]::Show($msg, 'ASYCUDA shortcut') | Out-Null
  exit 1
}

# The main window is titled like "ASYCUDAWorld - B5025-C". Ignore the login window and
# any already-open declaration, so keys never go to the wrong place.
$win = Get-Process |
  Where-Object { $_.MainWindowTitle -like 'ASYCUDAWorld*' -and $_.MainWindowHandle -ne 0 } |
  Select-Object -First 1

if (-not $win) {
  Fail("ASYCUDAWorld is not open.`n`nStart it and log in first, then run this shortcut again.")
}

[Microsoft.VisualBasic.Interaction]::AppActivate($win.Id)
Start-Sleep -Milliseconds 500

$send = {
  param($keys)
  [System.Windows.Forms.SendKeys]::SendWait($keys)
  Start-Sleep -Milliseconds $KeyDelay
}

# Clear any half-open menu first, so the walk always starts from the same place.
& $send '{ESC}'
& $send '{ESC}'

& $send '%f'      # File
& $send '{DOWN}'  # Document Library
for ($i = 0; $i -lt $Steps; $i++) { & $send '{RIGHT}' }   # ...down to Find

if ($Action -eq 'New') { & $send '{DOWN}' }               # Find -> New

& $send '{ENTER}'
