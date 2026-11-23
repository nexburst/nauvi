# Installs nauvi on Windows from its GitHub release (#430):
#
#   irm https://raw.githubusercontent.com/nexburst/nauvi/main/install.ps1 | iex
#   & ([scriptblock]::Create((irm https://raw.githubusercontent.com/nexburst/nauvi/main/install.ps1))) -Cli
#
# (no option)  the desktop app: downloads the .msi and runs msiexec /passive.
# -Cli         only the command-line tool, as %LOCALAPPDATA%\nauvi\bin\nauvi.exe,
#              added to your user PATH.
# -Uninstall   removes what this script installs (not your settings).
#
# Every download is checked against the release's SHA256SUMS before it is
# used. Running it again upgrades in place.
#
# Environment:
#   NAUVI_VERSION        a release tag (v0.1.0) instead of the latest release
#   NAUVI_INSTALL_DIR    where the CLI goes (default %LOCALAPPDATA%\nauvi\bin)
#   NAUVI_CLI=1          the same as -Cli (for `irm ... | iex`)
#   NAUVI_DOWNLOAD_BASE  for tests only: the release's download URL, https://
#                        or file:// (a directory holding the assets and SHA256SUMS)
#
# The work is one function called on the last line, so a download cut short
# runs nothing.

param(
    [switch]$Cli,
    [switch]$Uninstall
)

function Install-Nauvi {
    param([bool]$Cli, [bool]$Uninstall)

    $ErrorActionPreference = 'Stop'
    $ProgressPreference = 'SilentlyContinue'
    $releases = 'https://github.com/nexburst/nauvi/releases'

    function Fail([string]$message) {
        throw "nauvi install: $message"
    }

    $binDir = $env:NAUVI_INSTALL_DIR
    if (-not $binDir) {
        if (-not $env:LOCALAPPDATA) { Fail 'LOCALAPPDATA is not set' }
        $binDir = Join-Path $env:LOCALAPPDATA 'nauvi\bin'
    }
    if (-not [System.IO.Path]::IsPathRooted($binDir)) {
        Fail "NAUVI_INSTALL_DIR must be an absolute path (got '$binDir')"
    }

    function Get-UserPath {
        $p = [Environment]::GetEnvironmentVariable('Path', 'User')
        if ($null -eq $p) { return @() }
        return @($p -split ';' | Where-Object { $_ -ne '' })
    }

    function Find-InstalledApp {
        $keys = @(
            'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\*',
            'HKLM:\Software\Microsoft\Windows\CurrentVersion\Uninstall\*',
            'HKLM:\Software\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall\*'
        )
        foreach ($k in $keys) {
            Get-ItemProperty -Path $k -ErrorAction SilentlyContinue |
                Where-Object { $_.PSObject.Properties['DisplayName'] -and $_.DisplayName -eq 'nauvi' -and $_.PSChildName -match '^\{[0-9A-Fa-f-]+\}$' }
        }
    }

    # --- uninstall --------------------------------------------------------
    if ($Uninstall) {
        $removed = $false
        $exe = Join-Path $binDir 'nauvi.exe'
        if (Test-Path -LiteralPath $exe) {
            Remove-Item -LiteralPath $exe -Force
            Write-Host "removed $exe"
            $removed = $true
        }
        if ((Test-Path -LiteralPath $binDir) -and -not (Get-ChildItem -LiteralPath $binDir -Force)) {
            Remove-Item -LiteralPath $binDir -Force
        }
        $userPath = Get-UserPath
        if ($userPath -contains $binDir) {
            $rest = $userPath | Where-Object { $_ -ne $binDir }
            [Environment]::SetEnvironmentVariable('Path', ($rest -join ';'), 'User')
            Write-Host "removed $binDir from your user PATH"
            $removed = $true
        }
        if (-not $Cli) {
            foreach ($app in @(Find-InstalledApp)) {
                Write-Host "Uninstalling the nauvi app $($app.DisplayVersion)"
                $p = Start-Process -FilePath 'msiexec.exe' -ArgumentList @('/x', $app.PSChildName, '/passive', '/norestart') -Wait -PassThru
                if ($p.ExitCode -ne 0 -and $p.ExitCode -ne 3010) { Fail "msiexec /x exited with $($p.ExitCode)" }
                $removed = $true
            }
        }
        if (-not $removed) { Write-Host 'nauvi is not installed by this script; nothing to remove' }
        Write-Host 'Your settings were kept.'
        return
    }

    # --- where to download from -------------------------------------------
    if ($env:NAUVI_DOWNLOAD_BASE) {
        $base = $env:NAUVI_DOWNLOAD_BASE.TrimEnd('/')
    } elseif ($env:NAUVI_VERSION) {
        $v = $env:NAUVI_VERSION
        if (-not $v.StartsWith('v')) { $v = "v$v" }
        # Only a release tag: it goes into the URL.
        if ($v -notmatch '^v[0-9]+\.[0-9]+\.[0-9]+(-[0-9]+)?$') {
            Fail "NAUVI_VERSION must look like v0.1.0 (got '$($env:NAUVI_VERSION)')"
        }
        $base = "$releases/download/$v"
    } else {
        $base = "$releases/latest/download"
    }
    $localBase = $null
    if ($base -like 'file:///*') {
        $localBase = ([Uri]$base).LocalPath
    } elseif ($base -notlike 'https://*') {
        Fail "refusing to download from '$base': only https:// is allowed"
    }
    if (-not $localBase) {
        # Windows PowerShell 5.1 may not offer TLS 1.2 by default.
        [Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12
    }

    $tmp = Join-Path ([System.IO.Path]::GetTempPath()) ("nauvi-install-" + [guid]::NewGuid().ToString('N'))
    New-Item -ItemType Directory -Path $tmp | Out-Null
    try {
        function Get-Asset([string]$name, [string]$out) {
            try {
                if ($localBase) {
                    Copy-Item -LiteralPath (Join-Path $localBase $name) -Destination $out
                } else {
                    Invoke-WebRequest -Uri "$base/$name" -OutFile $out -UseBasicParsing
                }
            } catch {
                Fail "could not download $base/$name ($($_.Exception.Message))"
            }
        }

        $sumsFile = Join-Path $tmp 'SHA256SUMS'
        Get-Asset 'SHA256SUMS' $sumsFile
        $sums = @{}
        foreach ($line in Get-Content -LiteralPath $sumsFile) {
            if ($line -match '^([0-9a-fA-F]{64}) [ *]?(\S+)$') { $sums[$Matches[2]] = $Matches[1].ToLowerInvariant() }
        }

        function Select-Asset([string]$pattern) {
            $names = @($sums.Keys | Where-Object { $_ -match $pattern })
            if ($names.Count -ne 1) { Fail "the release has $($names.Count) files matching $pattern, expected one (see $releases)" }
            $n = $names[0]
            if ($n -match '[\\/]' -or $n.StartsWith('.')) { Fail "unexpected file name in SHA256SUMS: $n" }
            return $n
        }

        function Get-CheckedAsset([string]$name) {
            Write-Host "Downloading $name"
            $out = Join-Path $tmp $name
            Get-Asset $name $out
            $got = (Get-FileHash -LiteralPath $out -Algorithm SHA256).Hash.ToLowerInvariant()
            if ($got -ne $sums[$name]) {
                Remove-Item -LiteralPath $out -Force
                Fail "checksum mismatch for $name (expected $($sums[$name]), got $got); nothing was installed"
            }
            return $out
        }

        $arch = $env:PROCESSOR_ARCHITECTURE
        if ($env:PROCESSOR_ARCHITEW6432) { $arch = $env:PROCESSOR_ARCHITEW6432 }
        if ($arch -ne 'AMD64') {
            Fail "there is no nauvi build for Windows $arch yet; see $releases"
        }

        # --- the CLI -------------------------------------------------------
        if ($Cli) {
            $name = Select-Asset '^nauvi-cli-v[0-9][0-9.-]*-x86_64-pc-windows-msvc\.zip$'
            $zip = Get-CheckedAsset $name
            $unpacked = Join-Path $tmp 'cli'
            Expand-Archive -LiteralPath $zip -DestinationPath $unpacked
            $exe = Join-Path (Join-Path $unpacked ($name -replace '\.zip$', '')) 'nauvi.exe'
            if (-not (Test-Path -LiteralPath $exe)) { Fail "$name has no nauvi.exe inside" }
            New-Item -ItemType Directory -Force -Path $binDir | Out-Null
            $dest = Join-Path $binDir 'nauvi.exe'
            # A running nauvi.exe can be renamed but not overwritten.
            if (Test-Path -LiteralPath $dest) {
                $old = "$dest.old"
                Remove-Item -LiteralPath $old -Force -ErrorAction SilentlyContinue
                Move-Item -LiteralPath $dest -Destination $old -Force
            }
            Copy-Item -LiteralPath $exe -Destination $dest
            Remove-Item -LiteralPath "$dest.old" -Force -ErrorAction SilentlyContinue
            Write-Host "Installed the nauvi CLI ($($name -replace '-x86_64-pc-windows-msvc\.zip$', '')) to $dest"

            $userPath = Get-UserPath
            if ($userPath -notcontains $binDir) {
                [Environment]::SetEnvironmentVariable('Path', ((@($userPath) + $binDir) -join ';'), 'User')
                Write-Host "Added $binDir to your user PATH; open a new terminal to use nauvi."
            }
            if (($env:Path -split ';') -notcontains $binDir) { $env:Path = "$env:Path;$binDir" }
            return
        }

        # --- the desktop app -----------------------------------------------
        $name = Select-Asset '^[^ ]+_x64_en-US\.msi$'
        $msi = Get-CheckedAsset $name
        Write-Host "Installing $name (Windows may ask for permission)"
        $log = Join-Path $tmp 'msiexec.log'
        $p = Start-Process -FilePath 'msiexec.exe' -ArgumentList @('/i', "`"$msi`"", '/passive', '/norestart', '/l*v', "`"$log`"") -Wait -PassThru
        if ($p.ExitCode -eq 3010) {
            Write-Host 'Installed nauvi; Windows asks for a restart to finish.'
        } elseif ($p.ExitCode -ne 0) {
            Fail "msiexec exited with $($p.ExitCode) (1602: cancelled)"
        } else {
            Write-Host 'Installed nauvi. Start it from the Start menu; it updates itself.'
        }
        Write-Host 'The CLI is separate: run this script again with -Cli.'
    } finally {
        Remove-Item -LiteralPath $tmp -Recurse -Force -ErrorAction SilentlyContinue
    }
}

Install-Nauvi -Cli ($Cli.IsPresent -or $env:NAUVI_CLI -eq '1') -Uninstall $Uninstall.IsPresent
