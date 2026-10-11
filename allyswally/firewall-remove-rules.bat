@echo off
rem AllySwally firewall: remove the rules (the counterpart of firewall-add-rules.bat).
rem
rem Deletes every inbound Windows Firewall rule tied to AllySwally.exe (the ones
rem Windows' own "allow access" prompt creates and the one AllySwally adds for
rem itself), plus the old port rule "AllySwally" that version 1.0 created. It
rem asks for elevation.
rem
rem This leaves AllySwally with no firewall rules, so a phone may not be able to
rem connect until they are added again. That is the point: use it to test the
rem automatic fix, or to switch the feature off. Note that AllySwally.exe adds
rem its rules back at the next start unless "firewallAutoRule" is false in
rem %USERPROFILE%\.allyswally\user-data\config.json.
rem
rem Usage:
rem   firewall-remove-rules.bat                  rules of the AllySwally.exe next to this file
rem   firewall-remove-rules.bat <path-to-exe>    rules of that copy instead
rem   firewall-remove-rules.bat check [path]     only list the matching rules, change nothing
rem
rem Rules are bound to the full path of the .exe, so only the copy you point it
rem at is affected.

setlocal
set "SELF=%~f0"
set "MODE=remove"
set "ARG=%~1"
if /i "%ARG%"=="check" (
    set "MODE=check"
    set "ARG=%~2"
)

rem --- Locate the executable ---
if defined ARG (
    for %%I in ("%ARG%") do set "EXE=%%~fI"
) else (
    set "EXE=%~dp0AllySwally.exe"
    if not exist "%~dp0AllySwally.exe" set "EXE=%~dp0target\release\AllySwally.exe"
)
rem The .exe does not have to exist to remove its rules (it may have been moved
rem or deleted), so only warn.
if not exist "%EXE%" echo Note: "%EXE%" does not exist; removing the rules for that path anyway.

echo AllySwally firewall: remove rules
echo Program: %EXE%
echo.

if /i "%MODE%"=="check" goto :check

rem --- Elevate if needed (relaunches this script as administrator) ---
net session >nul 2>&1
if errorlevel 1 goto :elevate

echo Removing inbound rules for this program...
powershell -NoProfile -ExecutionPolicy Bypass -Command "$r = @(Get-NetFirewallApplicationFilter | Where-Object { $_.Program -eq $env:EXE } | Get-NetFirewallRule | Where-Object Direction -eq Inbound); $r | ForEach-Object { '  removed: {0} ({1}, {2})' -f $_.DisplayName, $_.Action, $_.Profile }; $r | Remove-NetFirewallRule; if ($r.Count -eq 0) { '  none found' }"

echo Removing the old port rule "AllySwally"...
powershell -NoProfile -ExecutionPolicy Bypass -Command "$r = @(Get-NetFirewallRule -DisplayName 'AllySwally' -ErrorAction SilentlyContinue); $r | ForEach-Object { '  removed: {0} ({1}, {2})' -f $_.DisplayName, $_.Action, $_.Profile }; $r | Remove-NetFirewallRule; if ($r.Count -eq 0) { '  none found' }"

echo.
echo Done. AllySwally.exe now has no firewall rules.
goto :end

:check
powershell -NoProfile -ExecutionPolicy Bypass -Command "'Inbound rules for this program:'; $r = @(Get-NetFirewallApplicationFilter | Where-Object { $_.Program -eq $env:EXE } | Get-NetFirewallRule | Where-Object Direction -eq Inbound); if ($r.Count -eq 0) { '  none' } else { $r | Format-Table DisplayName, Enabled, Action, Profile -AutoSize | Out-String -Width 200 }; 'Old port rule AllySwally:'; $p = @(Get-NetFirewallRule -DisplayName 'AllySwally' -ErrorAction SilentlyContinue); if ($p.Count -eq 0) { '  none' } else { $p | Format-Table DisplayName, Enabled, Action, Profile -AutoSize | Out-String -Width 200 }"
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
