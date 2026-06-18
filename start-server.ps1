$ErrorActionPreference = "Stop"

$ProjectRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
$EnvPath = Join-Path $ProjectRoot ".env"
$Port = 3000

if (Test-Path -LiteralPath $EnvPath) {
  foreach ($Line in Get-Content -LiteralPath $EnvPath) {
    if ($Line -match "^\s*PORT\s*=\s*(\d+)\s*$") {
      $Port = [int]$Matches[1]
      break
    }
  }
}

try {
  Invoke-RestMethod -Uri "http://127.0.0.1:$Port/health" -TimeoutSec 2 | Out-Null
  exit 0
} catch {
  # Server is not responding, so continue and start it.
}

$LogDir = Join-Path $ProjectRoot "logs"
New-Item -ItemType Directory -Force -Path $LogDir | Out-Null

$LogFile = Join-Path $LogDir "server.log"
$StdoutLog = Join-Path $LogDir "server.stdout.log"
$StderrLog = Join-Path $LogDir "server.stderr.log"
$NodePath = (Get-Command node -ErrorAction Stop).Source

Set-Location -LiteralPath $ProjectRoot
$env:NODE_OPTIONS = (($env:NODE_OPTIONS, "--use-system-ca") | Where-Object { $_ } | Select-Object -Unique) -join " "

"[$(Get-Date -Format o)] Starting Mattermost GitHub issue callback on port $Port" | Out-File -FilePath $LogFile -Append -Encoding utf8
$Process = Start-Process `
  -FilePath $NodePath `
  -ArgumentList @((Join-Path $ProjectRoot "src/server.js")) `
  -WorkingDirectory $ProjectRoot `
  -WindowStyle Hidden `
  -RedirectStandardOutput $StdoutLog `
  -RedirectStandardError $StderrLog `
  -PassThru

"[$(Get-Date -Format o)] Started node process $($Process.Id)" | Out-File -FilePath $LogFile -Append -Encoding utf8

for ($Attempt = 0; $Attempt -lt 10; $Attempt++) {
  Start-Sleep -Seconds 1
  try {
    Invoke-RestMethod -Uri "http://127.0.0.1:$Port/health" -TimeoutSec 2 | Out-Null
    "[$(Get-Date -Format o)] Health check passed" | Out-File -FilePath $LogFile -Append -Encoding utf8
    exit 0
  } catch {
    if ($Process.HasExited) {
      "[$(Get-Date -Format o)] Node process exited early with code $($Process.ExitCode)" | Out-File -FilePath $LogFile -Append -Encoding utf8
      exit 1
    }
  }
}

"[$(Get-Date -Format o)] Health check failed after starting node process $($Process.Id)" | Out-File -FilePath $LogFile -Append -Encoding utf8
exit 1
