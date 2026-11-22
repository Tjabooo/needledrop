# Deploy Needledrop on a Windows host: pull, test, (re)start the boot task, check /api/health.
#   powershell -ExecutionPolicy Bypass -File scripts\windows\deploy.ps1             pull + restart
#   powershell -ExecutionPolicy Bypass -File scripts\windows\deploy.ps1 -SetupTask  (re)create the boot task first
param([switch]$SetupTask, [switch]$NoPull, [string]$TaskName = 'Needledrop')
$ErrorActionPreference = 'Stop'
$root = Resolve-Path (Join-Path $PSScriptRoot '..\..')
Set-Location $root
if (-not $NoPull) { git pull --ff-only; if ($LASTEXITCODE) { throw 'git pull failed' } }
node --test tests/game.test.mjs | Out-Null; if ($LASTEXITCODE) { throw 'tests failed: not restarting' }
if ($SetupTask -or -not (Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue)) {
  $action = New-ScheduledTaskAction -Execute 'cmd.exe' -Argument "/c `"$root\scripts\windows\start.cmd`"" -WorkingDirectory $root
  $trigger = New-ScheduledTaskTrigger -AtStartup
  $principal = New-ScheduledTaskPrincipal -UserId $env:USERNAME -LogonType S4U -RunLevel Limited
  $settings = New-ScheduledTaskSettingsSet -ExecutionTimeLimit 0 -RestartCount 5 -RestartInterval (New-TimeSpan -Minutes 1) -AllowStartIfOnBatteries
  Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger -Principal $principal -Settings $settings -Force | Out-Null
  Write-Host "[deploy] task $TaskName registered (S4U, $env:USERNAME)"
}
$port = 8150; if (Test-Path .env) { $m = Select-String -Path .env -Pattern '^PORT=(\d+)'; if ($m) { $port = $m.Matches[0].Groups[1].Value } }
Stop-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue | ForEach-Object {
  $p = Get-Process -Id $_.OwningProcess -ErrorAction SilentlyContinue
  if ($p -and $p.ProcessName -eq 'node') { Stop-Process -Id $p.Id -Force; Start-Sleep -Milliseconds 500 }
}
Start-ScheduledTask -TaskName $TaskName
for ($i = 0; $i -lt 20; $i++) { Start-Sleep -Milliseconds 500; try { if ((Invoke-RestMethod "http://127.0.0.1:$port/api/health").ok) { Write-Host "[deploy] live on port $port ($(git log --oneline -1))"; exit 0 } } catch {} }
throw "[deploy] not answering on port ${port}: see logs\server.log"
