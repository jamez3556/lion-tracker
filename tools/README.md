# ASYCUDA shortcut

Opens ASYCUDAWorld straight at

    File > Document Library > ASYCUDA > Goods Clearance > Declaration >
    Detailed Declaration > Detailed Declaration > Find

instead of clicking through six menus every time.

## Setup (once, on the Windows PC)

1. Copy this `tools` folder anywhere on the PC — Desktop is fine.
2. Right-click **ASYCUDA Find Declaration.bat** → **Send to** → **Desktop (create shortcut)**.
3. Optional, so it looks right: right-click the new shortcut → **Properties** →
   **Change Icon** → pick the ASYCUDAWorld icon. Then **Pin to taskbar** if you want it
   one click away.

**ASYCUDA New Declaration.bat** does the same but lands on **New** instead of **Find**.

## Using it

Start ASYCUDAWorld and log in as usual. Once you are at the empty ASYCUDA desktop,
click the shortcut — it brings the window forward and walks the menu for you.

It cannot log in for you: that needs your password, and no script here should be
holding it.

## If it does not land in the right place

The script types the menu path (`Alt+F`, `Down`, then one `Right` per level). Two
things can throw it off:

- **A slow submenu.** If the app is lagging, a keystroke can arrive before the next
  menu has drawn. Open `asycuda-open.ps1` and raise `$KeyDelay` from `250` to `400`.
- **Customs changed the menu.** If an upgrade adds or removes a level, change `$Steps`
  in the same file — it is simply the number of levels below *Document Library*
  (currently 6: ASYCUDA, Goods Clearance, Declaration, Detailed Declaration,
  Detailed Declaration, Find).

Nothing else in the script needs editing.
