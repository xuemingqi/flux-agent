#Requires -Version 5.1

$ErrorActionPreference = 'Stop'
$Installer = Join-Path $PSScriptRoot '..\install.ps1'
$OriginalPath = $env:Path

# Keep installation and registry writes simulated; the real script runs in a child scope.
function Get-Command {
    param($Name, $CommandType, $ErrorAction)
    if ($Name -eq 'node.exe' -and -not $global:FluxInstallerTestState.Version) { return }
    if ($Name -eq $global:FluxInstallerTestState.MissingCommand) { return }
    return @{ Name = $Name }
}

function node.exe {
    $global:LASTEXITCODE = 0
    $global:FluxInstallerTestState.Version
}

function winget.exe {
    $global:FluxInstallerTestState.Calls.Add(@('winget') + $args)
    $global:LASTEXITCODE = $global:FluxInstallerTestState.WingetExit
    $global:FluxInstallerTestState.Version = $global:FluxInstallerTestState.InstalledVersion
}

function npm.cmd {
    $global:LASTEXITCODE = 0
    if ($args[0] -eq '--version') { return '11.0.0' }
    $global:FluxInstallerTestState.Calls.Add(@('npm') + $args)
    $global:LASTEXITCODE = $global:FluxInstallerTestState.NpmExit
}

function npx.cmd {
    $global:FluxInstallerTestState.Calls.Add(@('npx') + $args)
    $global:LASTEXITCODE = $global:FluxInstallerTestState.NpxExit
}

$Cases = @(
    @{ Name = 'reuse Node 24'; Version = 'v24.0.0' },
    @{ Name = 'reuse newer Node'; Version = 'v26.8.2' },
    @{ Name = 'install missing Node'; Version = $null; Install = $true },
    @{ Name = 'upgrade old Node'; Version = 'v22.0.0'; Install = $true },
    @{ Name = 'replace invalid Node'; Version = 'invalid'; Install = $true },
    @{ Name = 'missing WinGet'; Version = $null; MissingCommand = 'winget.exe'; Error = 'WinGet is missing' },
    @{ Name = 'failed WinGet'; Version = $null; WingetExit = 1; Error = 'WinGet failed' },
    @{ Name = 'old Node after install'; Version = 'v22.0.0'; InstalledVersion = 'v22.0.0'; Error = 'still unavailable' },
    @{ Name = 'missing npm'; MissingCommand = 'npm.cmd'; Error = 'npm.cmd is missing' },
    @{ Name = 'missing npx'; MissingCommand = 'npx.cmd'; Error = 'npx.cmd is missing' },
    @{ Name = 'failed registry write'; NpmExit = 13; Error = 'Could not configure' },
    @{ Name = 'failed app'; NpxExit = 7; Error = 'Flux Agent exited with code 7' }
)

try {
    foreach ($Case in $Cases) {
        $global:FluxInstallerTestState = @{
            Version = 'v24.1.0'
            InstalledVersion = 'v24.2.0'
            MissingCommand = ''
            WingetExit = 0
            NpmExit = 0
            NpxExit = 0
            Calls = [Collections.Generic.List[object]]::new()
        }
        foreach ($Key in $Case.Keys) { $global:FluxInstallerTestState[$Key] = $Case[$Key] }
        $Failure = $null
        try {
            & $Installer --port 3100 --workspace 'C:\My Project'
        }
        catch {
            $Failure = $_.Exception.Message
        }
        if ($Case.Error) {
            if (-not $Failure -or -not $Failure.Contains($Case.Error)) {
                throw "$($Case.Name): expected '$($Case.Error)', got '$Failure'"
            }
            if (-not $Case.NpxExit -and @($global:FluxInstallerTestState.Calls | Where-Object { $_[0] -eq 'npx' }).Count) {
                throw "$($Case.Name): Flux Agent launched after a preparation failure"
            }
        }
        else {
            if ($Failure) { throw "$($Case.Name): $Failure" }
            $Expected = [Collections.Generic.List[object]]::new()
            if ($Case.Install) {
                $Expected.Add(@('winget', 'install', '--id', 'OpenJS.NodeJS.LTS', '--exact', '--source', 'winget',
                    '--accept-package-agreements', '--accept-source-agreements'))
            }
            $Expected.Add(@('npm', 'config', 'set', '@yonyeyy:registry',
                'https://npm.cnb.cool/yonyeyy/flux-agent/-/packages/', '--location=user'))
            $Expected.Add(@('npx', '--yes', '@yonyeyy/flux-agent@latest', 'web', '--port', 3100,
                '--workspace', 'C:\My Project'))
            if ((ConvertTo-Json -InputObject $Expected -Compress) -ne
                (ConvertTo-Json -InputObject $global:FluxInstallerTestState.Calls -Compress)) {
                throw "$($Case.Name): unexpected command arguments"
            }
        }
        $env:Path = $OriginalPath
        Write-Host "PASS: $($Case.Name)"
    }
}
finally {
    $env:Path = $OriginalPath
}

Write-Host "$($Cases.Count) PowerShell installer checks passed."
