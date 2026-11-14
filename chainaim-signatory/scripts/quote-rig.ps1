# Quote test rig wrapper for Windows PowerShell: checks node and OutcomeAI, then runs the 10 rig scenarios (S01-S10).
#   $env:QUOTE_TOKEN_JUPITER = "<tenant token>"; .\scripts\quote-rig.ps1
#   .\scripts\quote-rig.ps1 --scenario S06 --bodies
# Every argument is passed to scripts/quote-rig.mjs (see --help).
$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot
$url = "http://127.0.0.1:8785"
for ($i = 0; $i -lt $args.Count; $i++) {
  if ($args[$i] -eq "--outcome-url" -and $i + 1 -lt $args.Count) { $url = $args[$i + 1] }
  elseif ($args[$i] -like "--outcome-url=*") { $url = $args[$i].Substring(14) }
}
if (-not (Get-Command node -ErrorAction SilentlyContinue)) { Write-Error "node 22+ is required"; exit 2 }
$major = [int]((node -v).TrimStart("v").Split(".")[0])
if ($major -lt 22) { Write-Error "node 22+ is required (found $(node -v))"; exit 2 }
try { $null = Invoke-RestMethod -Uri "$url/healthz" -TimeoutSec 5 }
catch { Write-Error "OutcomeAI is not answering at $url/healthz - start its quote-agents service first (or pass --outcome-url)."; exit 2 }
if (-not $env:QUOTE_TOKEN_JUPITER) { Write-Warning "QUOTE_TOKEN_JUPITER is not set (unless you pass --token-env, the run will stop)." }
Push-Location $root
try { node scripts/quote-rig.mjs @args; exit $LASTEXITCODE } finally { Pop-Location }
