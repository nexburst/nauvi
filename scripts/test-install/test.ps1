# Runs install.ps1 -Cli against fake releases (#430): install, upgrade, a
# tampered release (must fail and change nothing), a refused URL and
# -Uninstall. The CLI goes into a temporary directory; the user PATH entry
# it adds is removed again by -Uninstall.
#
#   pwsh scripts/test-install/test.ps1
$ErrorActionPreference = 'Stop'

$root = Resolve-Path (Join-Path $PSScriptRoot '..\..')
$installer = Join-Path $root 'install.ps1'
$work = Join-Path ([System.IO.Path]::GetTempPath()) ("nauvi-test-" + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $work | Out-Null
$failures = 0

function Write-Fixture([string]$dir, [string]$tag, [bool]$tamper) {
    $ver = $tag.TrimStart('v')
    $name = "nauvi-cli-$tag-x86_64-pc-windows-msvc"
    $src = Join-Path $work "src-$tag\$name"
    New-Item -ItemType Directory -Force -Path $src, $dir | Out-Null
    Set-Content -LiteralPath (Join-Path $src 'nauvi.exe') -Value "fake nauvi.exe $ver"
    Compress-Archive -Path $src -DestinationPath (Join-Path $dir "$name.zip") -Force
    Set-Content -LiteralPath (Join-Path $dir "nauvi_${ver}_x64_en-US.msi") -Value "fake msi $ver"
    $lines = Get-ChildItem -LiteralPath $dir -File | ForEach-Object {
        "$((Get-FileHash -LiteralPath $_.FullName -Algorithm SHA256).Hash.ToLowerInvariant())  $($_.Name)"
    }
    # LF line endings, like sha256sum writes them.
    [System.IO.File]::WriteAllText((Join-Path $dir 'SHA256SUMS'), (($lines -join "`n") + "`n"))
    if ($tamper) {
        Get-ChildItem -LiteralPath $dir -File | Where-Object { $_.Name -ne 'SHA256SUMS' } |
            ForEach-Object { Add-Content -LiteralPath $_.FullName -Value 'tampered' }
    }
}

function Check([string]$what, [bool]$ok) {
    if ($ok) { Write-Host "ok    $what" } else { Write-Host "FAIL  $what"; $script:failures++ }
}

# Runs install.ps1 in a child pwsh; returns its exit code.
function Invoke-Installer([string]$base, [string[]]$installArgs) {
    $env:NAUVI_DOWNLOAD_BASE = $base
    $shell = (Get-Process -Id $PID).Path
    & $shell -NoProfile -NonInteractive -File $installer @installArgs *> (Join-Path $work 'out.txt')
    $code = $LASTEXITCODE
    Get-Content (Join-Path $work 'out.txt') | Write-Host
    return $code
}

function Get-Url([string]$dir) {
    $p = Join-Path $work $dir
    # pwsh on Linux (for trying this locally) takes /tmp/... as a relative URI.
    if ($p.StartsWith('/')) { return "file://$p" }
    return ([Uri]$p).AbsoluteUri
}

# The last run's output on one line (PowerShell wraps error messages).
function Get-Out { return ((Get-Content (Join-Path $work 'out.txt') -Raw) -replace '\s+\|\s+', ' ' -replace '\s+', ' ') }

function Get-Exe { return Get-Content -LiteralPath $exe -ErrorAction SilentlyContinue }

try {
    Write-Fixture (Join-Path $work 'v1') 'v0.0.1' $false
    Write-Fixture (Join-Path $work 'v2') 'v0.0.2' $false
    Write-Fixture (Join-Path $work 'bad') 'v0.0.3' $true

    $bin = Join-Path $work 'bin'
    $env:NAUVI_INSTALL_DIR = $bin
    $exe = Join-Path $bin 'nauvi.exe'
    $pathBefore = [Environment]::GetEnvironmentVariable('Path', 'User')

    # The way the one-liner runs it: irm ... | iex, with NAUVI_CLI=1.
    $env:NAUVI_DOWNLOAD_BASE = Get-Url 'v1'
    $env:NAUVI_CLI = '1'
    $shell = (Get-Process -Id $PID).Path
    & $shell -NoProfile -NonInteractive -Command "Get-Content -Raw -LiteralPath '$installer' | Invoke-Expression"
    Check 'cli install from v1 (| iex, NAUVI_CLI=1)' ($LASTEXITCODE -eq 0)
    Remove-Item Env:NAUVI_CLI
    Check 'cli is v1' ((Get-Exe) -eq 'fake nauvi.exe 0.0.1')
    Check 'bin dir on the user PATH' ((([Environment]::GetEnvironmentVariable('Path', 'User')) -split ';') -contains $bin)

    # The documented form with an option: & ([scriptblock]::Create((irm ...))) -Cli
    $env:NAUVI_DOWNLOAD_BASE = Get-Url 'v2'
    & $shell -NoProfile -NonInteractive -Command "& ([scriptblock]::Create((Get-Content -Raw -LiteralPath '$installer'))) -Cli"
    Check 'cli upgrade to v2 (scriptblock -Cli)' ($LASTEXITCODE -eq 0)
    Check 'cli is v2' ((Get-Exe) -eq 'fake nauvi.exe 0.0.2')
    $entries = @(([Environment]::GetEnvironmentVariable('Path', 'User')) -split ';' | Where-Object { $_ -eq $bin })
    Check 'PATH entry added once' ($entries.Count -eq 1)

    Check 'tampered cli release fails' ((Invoke-Installer (Get-Url 'bad') @('-Cli')) -ne 0)
    Check 'tampered: says checksum mismatch' ((Get-Out) -match 'checksum mismatch')
    Check 'tampered: cli still v2' ((Get-Exe) -eq 'fake nauvi.exe 0.0.2')
    Check 'tampered app (msi) release fails' ((Invoke-Installer (Get-Url 'bad') @()) -ne 0)
    Check 'tampered app: says checksum mismatch' ((Get-Out) -match 'checksum mismatch')

    Check 'http:// refused' ((Invoke-Installer 'http://example.invalid' @('-Cli')) -ne 0)
    Check 'http:// refused: says why' ((Get-Out) -match 'only https:// is allowed')

    Check 'uninstall' ((Invoke-Installer '' @('-Uninstall', '-Cli')) -eq 0)
    Check 'uninstall: cli gone' (-not (Test-Path -LiteralPath $exe))
    Check 'uninstall: PATH entry gone' (-not ((([Environment]::GetEnvironmentVariable('Path', 'User')) -split ';') -contains $bin))
    Check 'uninstall: user PATH as before' ([Environment]::GetEnvironmentVariable('Path', 'User') -eq $pathBefore)
} finally {
    Remove-Item -LiteralPath $work -Recurse -Force -ErrorAction SilentlyContinue
}

if ($failures -ne 0) {
    Write-Host "$failures check(s) failed"
    exit 1
}
Write-Host 'all install.ps1 checks passed'
