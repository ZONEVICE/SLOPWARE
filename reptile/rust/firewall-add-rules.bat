@echo off
rem Reptile firewall: add the rules (the counterpart of firewall-remove-rules.bat).
rem
rem The first time a program listens on the network without a firewall rule,
rem Windows shows its "allow access" prompt and creates per-program rules on its
rem own: usually ALLOW on Private and BLOCK on Public (and, when the prompt is
rem dismissed or never shown, BLOCK rules named "Query User{...}reptile.exe" for
rem TCP and UDP). A block rule always wins over an allow rule, so on a network
rem classified Public (common for home Wi-Fi) no other computer can reach
rem Reptile and the sync never starts.
rem
rem This script removes every inbound rule tied to reptile.exe and adds a single
rem ALLOW rule (any protocol) on all profiles. It asks for elevation.
rem
rem Usage:
rem   firewall-add-rules.bat                  add the rules for the reptile.exe next to this file
rem   firewall-add-rules.bat <path-to-exe>    add them for that copy instead
rem   firewall-add-rules.bat check [path]     only list the matching rules, change nothing
rem
rem Rules are bound to the full path of the .exe: run it again after moving or
rem renaming reptile.exe. Use firewall-remove-rules.bat to undo it.

setlocal
set "SELF=%~f0"
set "MODE=fix"
set "ARG=%~1"
if /i "%ARG%"=="check" (
    set "MODE=check"
    set "ARG=%~2"
)

rem --- Locate the executable ---
if defined ARG (
    for %%I in ("%ARG%") do set "EXE=%%~fI"
) else (
    set "EXE=%~dp0reptile.exe"
    if not exist "%~dp0reptile.exe" set "EXE=%~dp0target\release\reptile.exe"
    if not exist "%~dp0target\release\reptile.exe" if not exist "%~dp0reptile.exe" set "EXE=%~dp0target\x86_64-pc-windows-gnu\release\reptile.exe"
)
if not exist "%EXE%" (
    echo reptile.exe not found: "%EXE%"
    echo Put this script next to reptile.exe or pass its path as an argument.
    goto :end
)

echo Reptile firewall: add rules
echo Program: %EXE%
echo.

if /i "%MODE%"=="check" goto :check

rem --- Elevate if needed (relaunches this script as administrator) ---
net session >nul 2>&1
if errorlevel 1 goto :elevate

echo Removing existing inbound rules for this program...
powershell -NoProfile -ExecutionPolicy Bypass -Command "$r = @(Get-NetFirewallApplicationFilter | Where-Object { $_.Program -eq $env:EXE } | Get-NetFirewallRule | Where-Object Direction -eq Inbound); $r | ForEach-Object { '  removed: {0} ({1}, {2})' -f $_.DisplayName, $_.Action, $_.Profile }; $r | Remove-NetFirewallRule; if ($r.Count -eq 0) { '  none found' }"

echo Adding inbound allow rule on all profiles...
netsh advfirewall firewall add rule name="Reptile (program)" dir=in action=allow program="%EXE%" enable=yes profile=any
if errorlevel 1 (
    echo FAILED to add the rule.
    goto :end
)
echo.
echo Done. Restart reptile.exe so other computers can reach it.
goto :end

:check
powershell -NoProfile -ExecutionPolicy Bypass -Command "'Inbound rules for this program:'; $r = @(Get-NetFirewallApplicationFilter | Where-Object { $_.Program -eq $env:EXE } | Get-NetFirewallRule | Where-Object Direction -eq Inbound); if ($r.Count -eq 0) { '  none' } else { $r | Format-Table DisplayName, Enabled, Action, Profile -AutoSize | Out-String -Width 200 }; 'Network profiles:'; Get-NetConnectionProfile | Format-Table InterfaceAlias, Name, NetworkCategory -AutoSize | Out-String -Width 200"
goto :end

:elevate
echo Requesting administrator rights...
powershell -NoProfile -ExecutionPolicy Bypass -Command "Start-Process -FilePath $env:SELF -ArgumentList ([char]34 + $env:EXE + [char]34) -Verb RunAs"
endlocal
exit /b

:end
echo.
pause
endlocal
