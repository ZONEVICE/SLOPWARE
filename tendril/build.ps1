# Builds Tendril on Windows: first the front end (esbuild bundles + gzip into
# web\dist), then tendril.exe. It builds with the MSVC toolchain when one is
# installed and falls back to GNU otherwise. .cargo\config.toml
# links the C runtime statically, so the .exe needs no extra DLLs. This
# script only builds; running Tendril needs nothing but the .exe.
#
#   .\build.ps1              release build -> dist\tendril-<version>-windows-x86_64.exe
#   .\build.ps1 -SkipWeb     reuse the existing web\dist (no Node.js needed;
#                            cargo warns when it is older than web\src)
#   .\build.ps1 -Test        also run the test suites (cargo test, npm test)
#
# Requirements: Rust via rustup. The MSVC toolchain is recommended (install
# "Desktop development with C++" / Visual Studio Build Tools); the script
# selects it automatically when present. A GNU toolchain works as a fallback,
# but some crates then need MinGW-w64 on PATH. Set RUSTUP_TOOLCHAIN to force a
# toolchain. Node.js 18+ with npm is needed unless -SkipWeb. If PowerShell
# refuses to run scripts:
#   powershell -ExecutionPolicy Bypass -File .\build.ps1
param(
    [switch]$SkipWeb,
    [switch]$Test
)
$ErrorActionPreference = 'Stop'
Set-Location $PSScriptRoot
$version = (Get-Content version.txt -Raw).Trim()

function Invoke-Step([string]$What, [scriptblock]$Command) {
    Write-Host "==> $What"
    & $Command
    if ($LASTEXITCODE -ne 0) { throw "$What failed (exit code $LASTEXITCODE)" }
}

# Pick a Rust toolchain that can build here. This script and .cargo\config.toml
# are written for MSVC (static CRT -> a self-contained .exe) and the MSVC target
# needs only the Visual Studio C++ build tools. The GNU target instead needs
# MinGW's dlltool (to build windows-sys) and often a MinGW gcc, which rustup
# does not add to PATH. So prefer an installed MSVC toolchain; otherwise use GNU
# and expose rustup's bundled dlltool. Set RUSTUP_TOOLCHAIN to force a choice.
function Select-Toolchain {
    if ($env:RUSTUP_TOOLCHAIN) {
        Write-Host "==> Rust toolchain: $env:RUSTUP_TOOLCHAIN (from RUSTUP_TOOLCHAIN)"
        return
    }
    if (-not (Get-Command rustup -ErrorAction SilentlyContinue)) { return }
    $names = @(rustup toolchain list) | ForEach-Object { ($_ -split '\s+')[0] } | Where-Object { $_ }
    $msvc = $names | Where-Object { $_ -like '*-pc-windows-msvc' } | Select-Object -First 1
    $gnu = $names | Where-Object { $_ -like '*-pc-windows-gnu' } | Select-Object -First 1
    if ($msvc) {
        $env:RUSTUP_TOOLCHAIN = $msvc
        Write-Host "==> Rust toolchain: $msvc"
        $vswhere = Join-Path ${env:ProgramFiles(x86)} 'Microsoft Visual Studio\Installer\vswhere.exe'
        $haveVc = (Test-Path $vswhere) -and (& $vswhere -latest -products * -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property installationPath 2>$null)
        if (-not $haveVc) {
            Write-Warning 'MSVC toolchain selected but Visual Studio C++ build tools were not detected; if linking fails, install "Desktop development with C++", or set $env:RUSTUP_TOOLCHAIN to a GNU toolchain.'
        }
    } elseif ($gnu) {
        $env:RUSTUP_TOOLCHAIN = $gnu
        Write-Host "==> Rust toolchain: $gnu"
        if (-not (Get-Command dlltool.exe -ErrorAction SilentlyContinue)) {
            $rustupHome = if ($env:RUSTUP_HOME) { $env:RUSTUP_HOME } else { Join-Path $env:USERPROFILE '.rustup' }
            $rustlib = Join-Path $rustupHome "toolchains\$gnu\lib\rustlib"
            $dll = if (Test-Path $rustlib) { Get-ChildItem $rustlib -Recurse -Filter dlltool.exe -ErrorAction SilentlyContinue | Select-Object -First 1 } else { $null }
            if ($dll) {
                $env:PATH = "$($dll.DirectoryName);$env:PATH"
                Write-Host "    using bundled dlltool: $($dll.FullName)"
            } else {
                Write-Warning 'GNU toolchain selected but dlltool.exe was not found; install MinGW-w64 (also provides the gcc some crates need), or install MSVC: rustup toolchain install stable-x86_64-pc-windows-msvc'
            }
        }
    }
}
Select-Toolchain

if (-not $SkipWeb) {
    if (Get-Command node -ErrorAction SilentlyContinue) {
        if (-not (Test-Path web\node_modules)) {
            Invoke-Step 'npm ci' { npm --prefix web ci --no-audit --no-fund }
        }
        Invoke-Step 'Front end' { node web\build.mjs }
    } elseif (Test-Path web\dist\index.html.gz) {
        Write-Host '==> Node.js not found: using the existing web\dist'
    } else {
        throw 'Node.js is required to build the front end (https://nodejs.org), or run with -SkipWeb after copying web\dist.'
    }
}

Invoke-Step 'Rust (release)' { cargo build --release }

if ($Test) {
    Invoke-Step 'cargo test' { cargo test }
    if (Get-Command node -ErrorAction SilentlyContinue) {
        Invoke-Step 'npm test' { npm --prefix web test }
    }
}

New-Item -ItemType Directory -Force dist | Out-Null
$out = "dist\tendril-$version-windows-x86_64.exe"
Copy-Item target\release\tendril.exe $out -Force
Get-Item $out | Format-Table Name, @{ Label = 'Size (MB)'; Expression = { [math]::Round($_.Length / 1MB, 2) } }
