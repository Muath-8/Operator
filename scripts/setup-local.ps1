$ErrorActionPreference='Stop'
& (Join-Path $PSScriptRoot '..\supabase\tests\start-local.ps1')
if($LASTEXITCODE -ne 0){throw 'Local PostgreSQL could not start'}
pnpm exec tsx (Join-Path $PSScriptRoot 'setup-local.ts')
if($LASTEXITCODE -ne 0){throw 'Local setup failed'}
