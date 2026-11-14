# Sample queries for OutcomeAI quote-agents (tenant jupiter-knitting). Run from the enh-3-signatory folder:
#   $env:QUOTE_TOKEN_JUPITER = <loaded from your secrets file, never typed into chat>
#   .\quote-agents-probe.ps1                      # default http://127.0.0.1:8785
#   .\quote-agents-probe.ps1 -Base http://127.0.0.1:8785
param([string]$Base = "http://127.0.0.1:8785",
      [string]$Fixtures = ".\chainaim-signatory\services\test\fixtures\quote-agent-responses")
$ErrorActionPreference = "Stop"
if (-not $env:QUOTE_TOKEN_JUPITER) { Write-Error "Set QUOTE_TOKEN_JUPITER in this shell first (do not paste it into chat)."; exit 2 }
$T = "$Base/v1/tenants/jupiter-knitting"
function Ask($id, $alias, $path, $body, $expect) {
  $h = @{ Authorization = "Bearer $($env:QUOTE_TOKEN_JUPITER)"; "X-Agent-Alias" = $alias; "X-Agent-LEI" = "3358004DXAMRWRUIYJ05" }
  try {
    $r = Invoke-RestMethod -Method Post -Uri "$T/$path" -Headers $h -ContentType "application/json" -Body ($body | ConvertTo-Json -Depth 20) -TimeoutSec 60
    Write-Host "`n[$id] 200  $expect" -ForegroundColor Green
    $r | ConvertTo-Json -Depth 6 -Compress | Write-Host
  } catch {
    $code = $_.Exception.Response.StatusCode.value__
    Write-Host "`n[$id] $code  $expect" -ForegroundColor Yellow
    Write-Host $_.ErrorDetails.Message
  }
}
$M = @(0.15,0.135,0.12,0.11,0.10,0.09,0.08)
# ---- Inventory
Ask INV-1 JupiterInventoryAgent agents/inventory @{requestId="inv-1";sku="FAB-COT-180-A";qty=20000;shipBy="2026-11-30"} "free stock covers 20k (shortfall 0)"
Ask INV-2 JupiterInventoryAgent agents/inventory @{requestId="inv-2";sku="FAB-COT-180-A";qty=45000;shipBy="2026-11-25"} "short 22k; Tier-2 (Sales Officer +4%) and Tier-1 (CEO +8%) lots offered"
Ask INV-3 JupiterInventoryAgent agents/inventory @{requestId="inv-3";sku="FAB-COT-180-B";qty=10000;shipBy="2026-12-10"} "no Grade B; shortfall 10k; Grade A alternative"
Ask INV-4 JupiterInventoryAgent agents/inventory @{requestId="inv-4";sku="FAB-SILK-99";qty=100;shipBy="2026-12-10"} "expect 422 unknown_sku"
# ---- Logistics
$L1 = @{lot="L-180A-01";units=20000;readyDate="2026-11-16";warehouse="MADRAS-WH-1"}
Ask LOG-1 JupiterLogisticsAgent agents/logistics @{requestId="log-1";sku="FAB-COT-180-A";lots=@($L1);deadline="2027-01-08";allowAir=$false} "MSC standard, delivered 22 Dec, meets"
Ask LOG-2 JupiterLogisticsAgent agents/logistics @{requestId="log-2";sku="FAB-COT-180-A";lots=@($L1);deadline="2026-12-20";allowAir=$false} "misses (21 Dec); airOption reported"
Ask LOG-3 JupiterLogisticsAgent agents/logistics @{requestId="log-3";sku="FAB-COT-180-A";lots=@(@{lot="L-180A-02";units=12000;readyDate="2026-12-03";warehouse="MADRAS-WH-1"});deadline="2027-01-05";allowAir=$false} "only Maersk express makes it (4 Jan)"
Ask LOG-4 JupiterLogisticsAgent agents/logistics @{requestId="log-4";sku="FAB-COT-180-A";lots=@(@{lot="L-180A-01";units=4000;readyDate="2026-11-16";warehouse="MADRAS-WH-1"});deadline="2026-11-25";allowAir=$true} "4k by air (fits the 5k cap)"
# ---- Treasury
Ask TRE-1 JupiterTreasuryAgent agents/treasury @{requestId="tre-1";sku="FAB-COT-180-A";qty=20000;freightCents=420000;reallocUnits=@{TIER1=0;TIER2=0};termsDays=30;advancePct=0;margins=$M} "price ladder 415/408/401/.../384; no unit cost returned"
Ask TRE-2 JupiterTreasuryAgent agents/treasury @{requestId="tre-2";sku="FAB-COT-180-A";qty=45000;freightCents=1260000;reallocUnits=@{TIER1=12000;TIER2=10000};termsDays=30;advancePct=30;margins=$M} "realloc premium 10c; advance lever applies"
Ask TRE-3 JupiterTreasuryAgent agents/treasury @{requestId="tre-3";sku="FAB-COT-180-A";qty=80000;freightCents=1680000;reallocUnits=@{TIER1=0;TIER2=0};termsDays=90;advancePct=0;margins=$M} "credit ok=false (above Tommy's headroom)"
# ---- Seller synthesis (bodies from your recorded Signatory fixtures; requestId added)
function Syn($id, $file, $idx, $expect) {
  $calls = (Get-Content (Join-Path $Fixtures $file) -Raw | ConvertFrom-Json).calls | Where-Object { $_.path -eq "seller/synthesize" }
  $b = @($calls)[$idx].request; $b | Add-Member -NotePropertyName requestId -NotePropertyValue "$id" -Force
  Ask $id jupiterSellerAgent seller/synthesize $b $expect
}
Syn SYN-1 T02.json 1 "T02 round 2: COUNTER 411"
Syn SYN-2 T06.json 2 "T06 round 3: ESCALATE at the agent floor 415"
Syn SYN-3 T07.json 0 "T07 CEO brief"
