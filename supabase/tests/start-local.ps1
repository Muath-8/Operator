param([int]$Port=55439,[string]$PostgresBin='C:\Program Files\PostgreSQL\15\bin')
$ErrorActionPreference='Stop'
$stateRoot=[IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\.local'))
New-Item -ItemType Directory -Force $stateRoot | Out-Null
$dataPath=Join-Path $stateRoot 'pgdata'
if(-not(Test-Path -LiteralPath(Join-Path $dataPath 'PG_VERSION'))){ & (Join-Path $PostgresBin 'initdb.exe') -D $dataPath -A trust -U postgres --encoding=UTF8 --no-locale; if($LASTEXITCODE -ne 0){throw 'initdb failed'} }
& (Join-Path $PostgresBin 'pg_ctl.exe') -D $dataPath status | Out-Null
if($LASTEXITCODE -ne 0){ & (Join-Path $PostgresBin 'pg_ctl.exe') -D $dataPath -l (Join-Path $stateRoot 'postgres.log') -o "-p $Port -h 127.0.0.1" start; if($LASTEXITCODE -ne 0){throw 'PostgreSQL failed to start'} }
Write-Output "Isolated local PostgreSQL available on loopback port $Port. Set LO_DATABASE_URL for a different test cluster."
