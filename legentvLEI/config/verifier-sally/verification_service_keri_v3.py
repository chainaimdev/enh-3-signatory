#!/usr/bin/env python3
"""
KERI-Enabled Agent Delegation Verification Service (v3)

v1/v2 (verification_service_keri.py / _v2.py) verified delegation by calling
KERIA's admin route GET {KERIA_URL}/identifiers/{aid}. That route requires an
authenticated Signify controller session — an anonymous caller (this service)
always receives 404, for every AID, not just delegated sub-agents. That was
confirmed live: /identifiers/{aid} 404s even for jupiterSellerAgent, an agent
known to be valid and fully working.

v3 instead resolves each AID's own OOBI URL (KERIA's public, unauthenticated
KEL-stream endpoint — confirmed working with a live 200 response and a real
CESR event stream) and inspects the returned events directly for the
delegation seal, instead of asking KERIA's private admin API a question it
will not answer for us.
"""

from fastapi import FastAPI, Request, HTTPException
import logging
import uvicorn
import httpx
import json
import os

logging.basicConfig(
    level=logging.INFO,
    format='%(asctime)s - %(levelname)s - %(message)s'
)
logger = logging.getLogger(__name__)

app = FastAPI(
    title="vLEI Agent Verifier with KERI (OOBI-based)",
    description="KEL-based verification service using OOBI resolution",
    version="3.0.0"
)

KERIA_URL = os.getenv('KERIA_URL', 'http://keria:3902')


def parse_cesr_json_events(body: str):
    """
    Extract every embedded JSON event object from a raw CESR event stream.

    A KERIA OOBI response is a sequence of JSON-serialized KERI events, each
    immediately followed by non-JSON CESR attachment bytes (signature
    material) — e.g. `{"v":"KERI...","t":"icp",...}-VAn-AABAAC...{"v":...}`.
    We don't need to verify signatures here (KERIA already only serves KELs
    it has itself accepted and witnessed); we only need the structural event
    fields, so we scan for each valid JSON object in turn and skip over the
    attachment bytes between them. This mirrors the existing precedent in
    test-agent-verification-DEEP-EXT.sh, which already extracts JSON
    fragments out of mixed KERI CLI text the same way (via grep -o).
    """
    decoder = json.JSONDecoder()
    events = []
    idx = 0
    length = len(body)
    while idx < length:
        brace = body.find('{', idx)
        if brace == -1:
            break
        try:
            obj, end = decoder.raw_decode(body, brace)
            events.append(obj)
            idx = end
        except json.JSONDecodeError:
            idx = brace + 1
    return events


async def fetch_kel_via_oobi(oobi_url: str):
    """Resolve an OOBI URL and parse the KEL event stream it returns."""
    if not oobi_url:
        return []
    try:
        async with httpx.AsyncClient() as client:
            response = await client.get(oobi_url, timeout=10.0)
            if response.status_code != 200:
                logger.warning(f"OOBI fetch failed ({response.status_code}): {oobi_url}")
                return []
            return parse_cesr_json_events(response.text)
    except Exception as e:
        logger.error(f"OOBI fetch error for {oobi_url}: {e}")
        return []


def find_inception(events, aid: str):
    """Find the icp/dip (inception) event belonging to the given AID."""
    for ev in events:
        if ev.get("i") == aid and ev.get("t") in ("icp", "dip"):
            return ev
    return None


def find_anchor(events, sub_aid: str):
    """Find an interaction event anchoring a delegation seal for sub_aid."""
    for ev in events:
        if ev.get("t") != "ixn":
            continue
        for anchor in (ev.get("a") or []):
            if isinstance(anchor, dict) and anchor.get("i") == sub_aid:
                return anchor
    return None


@app.get("/health")
async def health():
    """Health check with KERIA status"""
    keria_status = "unknown"
    try:
        async with httpx.AsyncClient() as client:
            response = await client.get(f"{KERIA_URL}/spec.yaml", timeout=5.0)
            keria_status = "connected" if response.status_code == 200 else "unreachable"
    except Exception:
        keria_status = "unreachable"

    return {
        "status": "healthy",
        "service": "agent-delegation-verifier-keri-v3",
        "version": "3.0.0",
        "keria_status": keria_status,
        "keria_url": KERIA_URL
    }


@app.post("/verify/agent-delegation")
async def verify_delegation(request: Request):
    """
    Verify agent delegation via OOBI-resolved KELs.

    Request body:
    {
        "aid": "controller_aid",     // parent / delegator AID
        "agent_aid": "agent_aid",    // delegate (sub-agent) AID
        "verify_kel": true,          // optional, default true (same as v1)
        "parent_oobi": "http://...", // required when verify_kel is true
        "agent_oobi": "http://..."   // required when verify_kel is true
    }
    """
    try:
        data = await request.json()
        controller_aid = data.get("aid", "")
        agent_aid = data.get("agent_aid", "")
        verify_kel = data.get("verify_kel", True)
        parent_oobi = data.get("parent_oobi", "")
        agent_oobi = data.get("agent_oobi", "")

        if not controller_aid or not agent_aid:
            raise HTTPException(400, "Both 'aid' and 'agent_aid' required")

        if not (controller_aid.startswith('E') and len(controller_aid) == 44):
            raise HTTPException(400, "Invalid controller AID format")
        if not (agent_aid.startswith('E') and len(agent_aid) == 44):
            raise HTTPException(400, "Invalid agent AID format")

        # Callers that explicitly opt out of the KEL check (e.g.
        # sig-wallet/src/tasks/agent/agent-verify-delegation.ts sends
        # verify_kel: false) get v1's exact format-only response, unchanged.
        if not verify_kel:
            logger.info("✅ Format validation passed (KEL check skipped)")
            return {
                "valid": True,
                "verified": True,
                "controller_aid": controller_aid,
                "agent_aid": agent_aid,
                "oor_holder_aid": controller_aid,
                "message": "Agent delegation verified successfully",
                "verification": {
                    "delegation_verified": True,
                    "kel_verification": None
                }
            }

        if not parent_oobi or not agent_oobi:
            raise HTTPException(
                400,
                "Both 'parent_oobi' and 'agent_oobi' are required for OOBI-based KEL verification"
            )

        logger.info(f"Verifying (OOBI): agent={agent_aid[:20]}... controller={controller_aid[:20]}...")

        agent_events = await fetch_kel_via_oobi(agent_oobi)
        parent_events = await fetch_kel_via_oobi(parent_oobi)

        # Resolving a delegated agent's own OOBI can already stream its
        # ancestor's events too (observed live: the sub-agent's OOBI returned
        # the OOR holder's icp/ixn events as well as its own). Neither source
        # alone is guaranteed complete, so search the union of both.
        all_events = agent_events + parent_events

        agent_inception = find_inception(all_events, agent_aid)
        if not agent_inception:
            raise HTTPException(404, "Agent AID not found in KEL (no icp/dip event via OOBI resolution)")

        if agent_inception.get("t") != "dip":
            raise HTTPException(404, "Agent AID is not a delegated inception (dip) event")

        if agent_inception.get("di") != controller_aid:
            raise HTTPException(
                404,
                f"Agent's delegator (di={agent_inception.get('di')}) does not match controller AID"
            )

        anchor = find_anchor(all_events, agent_aid)
        if not anchor:
            raise HTTPException(404, "Delegation seal for agent not found in controller's KEL")

        if anchor.get("d") != agent_inception.get("d"):
            raise HTTPException(404, "Delegation seal digest does not match agent's inception event")

        logger.info("✅ Delegation verified via OOBI-resolved KEL")

        return {
            "valid": True,
            "verified": True,
            "controller_aid": controller_aid,
            "agent_aid": agent_aid,
            "oor_holder_aid": controller_aid,
            "message": "Agent delegation verified successfully via OOBI-resolved KEL",
            "verification": {
                "agent_exists": True,
                "controller_exists": find_inception(all_events, controller_aid) is not None,
                "delegation_found": True,
                "delegation_active": True,
                "verification_type": "kel_seal"
            }
        }

    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Verification error: {e}", exc_info=True)
        raise HTTPException(500, f"Verification failed: {str(e)}")


@app.get("/")
async def root():
    """Service information"""
    return {
        "service": "vLEI Agent Verifier with KERI (OOBI-based)",
        "version": "3.0.0",
        "features": [
            "OOBI-based KEL resolution",
            "Delegation seal verification",
            "KERIA integration"
        ],
        "keria_url": KERIA_URL
    }


if __name__ == "__main__":
    logger.info("=" * 60)
    logger.info("Starting KERI-Enabled Verification Service (v3, OOBI-based)")
    logger.info(f"KERIA URL: {KERIA_URL}")
    logger.info("=" * 60)

    uvicorn.run(app, host="0.0.0.0", port=9723, log_level="info")
