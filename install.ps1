#Requires -Version 5.1

# A child scope also supports `irm ... | iex` without changing the caller's error policy.
& {
    $ErrorActionPreference = 'Stop'
    $MinNodeVersion = 24
    $Registry = 'https://npm.cnb.cool/yonyeyy/flux-agent/-/packages/'
    $Package = '@yonyeyy/flux-agent@latest'

    function Get-NodeMajorVersion {
        if (-not (Get-Command node.exe -CommandType Application -ErrorAction SilentlyContinue)) {
            return 0
        }
        try {
            $Version = & node.exe --version 2>$null
            if ($LASTEXITCODE -eq 0 -and $Version -match '^v(\d+)\.') {
                return [int]$Matches[1]
            }
        }
        catch {
            return 0
        }
        return 0
    }

    Write-Host 'Flux Agent Installer'

    if ((Get-NodeMajorVersion) -lt $MinNodeVersion) {
        Write-Host "Node.js ${MinNodeVersion}+ is required. Installing/upgrading Node.js LTS with WinGet..."
        if (-not (Get-Command winget.exe -CommandType Application -ErrorAction SilentlyContinue)) {
            throw 'WinGet is missing. Install App Installer from Microsoft Store, or Node.js 24+ from https://nodejs.org/, then run this script again.'
        }

        & winget.exe install --id OpenJS.NodeJS.LTS --exact --source winget `
            --accept-package-agreements --accept-source-agreements
        if ($LASTEXITCODE -ne 0) {
            throw "WinGet failed (exit code $LASTEXITCODE). Check its output and run this script again."
        }

        # Load the installed Node.js path while retaining paths set only in this terminal.
        $env:Path = [Environment]::GetEnvironmentVariable('Path', 'Machine') + ';' +
            [Environment]::GetEnvironmentVariable('Path', 'User') + ';' + $env:Path
    }

    if ((Get-NodeMajorVersion) -lt $MinNodeVersion) {
        throw 'Node.js 24+ is still unavailable. Open a new PowerShell window and retry; check PATH or your Node version manager if an older version is still selected.'
    }
    foreach ($Command in @('npm.cmd', 'npx.cmd')) {
        if (-not (Get-Command $Command -CommandType Application -ErrorAction SilentlyContinue)) {
            throw "$Command is missing. Reinstall Node.js with npm included, then try again."
        }
    }

    $NodeVersion = & node.exe --version
    $NpmVersion = & npm.cmd --version
    if ($LASTEXITCODE -ne 0) {
        throw "npm failed (exit code $LASTEXITCODE). Check your Node.js installation."
    }
    Write-Host "Node.js: $NodeVersion"
    Write-Host "npm: $NpmVersion"
    Write-Host 'Configuring the @yonyeyy registry in your user npm configuration...'
    # Use .cmd entry points to avoid npm.ps1/npx.ps1 execution-policy failures.
    & npm.cmd config set '@yonyeyy:registry' $Registry --location=user
    if ($LASTEXITCODE -ne 0) {
        throw "Could not configure the npm registry (exit code $LASTEXITCODE)."
    }

    Write-Host 'Starting Flux Agent. Press Ctrl+C to stop.'
    & npx.cmd --yes $Package web @args
    if ($LASTEXITCODE -ne 0) {
        throw "Flux Agent exited with code $LASTEXITCODE."
    }
} @args
