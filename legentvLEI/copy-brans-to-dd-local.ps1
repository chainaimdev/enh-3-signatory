# ============================================================================
#  copy-brans-to-dd-local.ps1
#  PHASE A.3 ONLY — THROWAWAY BRIDGE SCRIPT. DELETE IN PHASE B (B.6.3).
#
#  In Phase B, manage-agent.sh replaces this with an automatic dual-write at
#  BRAN-generation time. Do NOT build anything that depends on this script
#  long-term — it exists purely so KramSigner (A.4/A.5) has a BRAN to read
#  during Phase A.
#
#  What it does:
#    Reads the agent BRANs the vLEI 4D pipeline produced in .\task-data\ and
#    copies the buyer + seller BRANs into the DD agents' local .secret\ folders
#    as agent-bran.txt, then locks the file ACL down to the current user only
#    (Windows equivalent of chmod 600).
#
#  Source of truth:
#    .\task-data\agent-brans.json  (written by generate-unique-agent-brans.sh)
#    Each agent entry has: alias, role (buyer|seller|unknown), bran, ...
#    Only role=buyer and role=seller are copied. role=unknown (e.g. Acme) is
#    skipped — it has no negotiation agent on the DD side.
#
#  Idempotent:
#    If the destination already byte-matches the source, the file is left
#    untouched and reported as "unchanged". Safe to run repeatedly.
#
#  No silent fallback:
#    Missing agent-brans.json, missing BRAN file, or missing DD agent folder
#    throws and exits non-zero — never copies a guessed/empty value.
# ============================================================================

[CmdletBinding()]
param(
    # Root of the vLEI project (where task-data\ lives). Defaults to this
    # script's own folder.
    [string]$VleiRoot = $PSScriptRoot,

    # DD agents directory (contains buyer-agent\, seller-agent\, ...).
    # Phase-A-only path coupling — removed in B.6.3. Overridable via the
    # DD_AGENTS_DIR environment variable so nothing is hardcoded in stone.
    [string]$DdAgentsDir = $(
        if ($env:DD_AGENTS_DIR) { $env:DD_AGENTS_DIR }
        else { 'C:\SATHYA\CHAINAIM3003\mcp-servers\DynDiscounting\DynDisc4-ent1\A2A\js\src\agents' }
    )
)

$ErrorActionPreference = 'Stop'

function Fail([string]$msg) {
    Write-Host "ERROR: $msg" -ForegroundColor Red
    exit 1
}

Write-Host "PHASE A.3 — copy vLEI BRANs to DD-local .secret\ (throwaway bridge)" -ForegroundColor Cyan
Write-Host "  vLEI root : $VleiRoot"
Write-Host "  DD agents : $DdAgentsDir"
Write-Host ""

$taskData  = Join-Path $VleiRoot 'task-data'
$bransJson = Join-Path $taskData 'agent-brans.json'

if (-not (Test-Path $bransJson)) {
    Fail "agent-brans.json not found at: $bransJson`n       Run the 4D pipeline first (it calls generate-unique-agent-brans.sh)`n       so the BRANs exist before copying."
}
if (-not (Test-Path $DdAgentsDir)) {
    Fail "DD agents directory not found: $DdAgentsDir`n       Set DD_AGENTS_DIR or pass -DdAgentsDir to point at the real path."
}

try {
    $manifest = Get-Content $bransJson -Raw | ConvertFrom-Json
}
catch {
    Fail "Could not parse $bransJson as JSON: $($_.Exception.Message)"
}

if (-not $manifest.agents) {
    Fail "$bransJson has no 'agents' array — pipeline output looks malformed."
}

$copied    = 0
$unchanged = 0

foreach ($agent in $manifest.agents) {
    $aliasLc = "$($agent.alias)".ToLower()

    # Map to DD agent folder by alias substring. The JSON "role" field is NOT
    # reliable: upstream get_agent_role matches "Jupiter"/"Tommy"
    # case-sensitively against UPPERCASE org names, so it always writes
    # "unknown". The alias is canonical (jupiterSellerAgent / tommyBuyerAgent).
    if     ($aliasLc -like '*seller*') { $role = 'seller' }
    elseif ($aliasLc -like '*buyer*')  { $role = 'buyer'  }
    else {
        Write-Host "  - skip $($agent.alias) (no buyer/seller in alias, no DD agent)" -ForegroundColor DarkGray
        continue
    }

    $srcBran = Join-Path $taskData ("{0}-bran.txt" -f $agent.alias)
    if (-not (Test-Path $srcBran)) {
        Fail "BRAN file missing for $($agent.alias): $srcBran`n       Re-run the 4D pipeline — agent-brans.json references a BRAN that isn't on disk."
    }

    $destDir  = Join-Path $DdAgentsDir ("{0}-agent\.secret" -f $role)
    $destBran = Join-Path $destDir 'agent-bran.txt'

    # Idempotency: byte-for-byte compare via hash. If equal, leave it alone.
    if (Test-Path $destBran) {
        $srcHash  = (Get-FileHash $srcBran  -Algorithm SHA256).Hash
        $destHash = (Get-FileHash $destBran -Algorithm SHA256).Hash
        if ($srcHash -eq $destHash) {
            Write-Host "  = $role-agent: unchanged (already byte-equal)" -ForegroundColor DarkGreen
            $unchanged++
            continue
        }
    }

    if (-not (Test-Path $destDir)) {
        New-Item -ItemType Directory -Path $destDir -Force | Out-Null
    }

    Copy-Item -Path $srcBran -Destination $destBran -Force

    # Lock down ACL: remove inheritance, grant ONLY the current user.
    # Windows equivalent of chmod 600.
    $me = "$env:USERDOMAIN\$env:USERNAME"
    icacls $destBran /inheritance:r /grant:r "${me}:(F)" | Out-Null
    if ($LASTEXITCODE -ne 0) {
        Fail "icacls failed to lock permissions on $destBran (exit $LASTEXITCODE)."
    }

    Write-Host "  + $role-agent: copied <- $($agent.alias)-bran.txt (ACL locked to $me)" -ForegroundColor Green
    $copied++
}

Write-Host ""
if ($copied -eq 0) {
    Write-Host "no changes needed" -ForegroundColor Green
} else {
    Write-Host "Done: $copied copied, $unchanged unchanged." -ForegroundColor Green
}
exit 0
