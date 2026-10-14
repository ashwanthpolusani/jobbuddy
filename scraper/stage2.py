import os
import sys
import json
import time
import re
import urllib.request
from datetime import datetime, timezone

# Fix Windows console encoding
if sys.stdout.encoding and sys.stdout.encoding.lower() != 'utf-8':
    try:
        sys.stdout.reconfigure(encoding='utf-8')
    except AttributeError:
        pass

from dotenv import load_dotenv
from pymongo import MongoClient
from google import genai
import certifi
from playwright.sync_api import sync_playwright

load_dotenv(os.path.join(os.path.dirname(__file__), '.env'))
load_dotenv()

# -- Configuration
GEMINI_API_KEY  = os.getenv("GEMINI_API_KEY")
MONGODB_URI     = os.getenv("MONGODB_URI")
GEMINI_MODELS   = ["gemini-3.5-flash-lite", "gemini-3.1-flash-lite"]
RPM_LIMIT       = 15
BATCH_SIZE      = 150

EXP_SAFE     = "SAFE"
EXP_POSSIBLE = "POSSIBLE"
EXP_BLOCKED  = "BLOCKED"

from safe_ats import is_eligible_for_jobbuddy
from main import ModelPool, get_db, now_iso

# -- JD Fetcher
def fetch_jd_http(url):
    try:
        req = urllib.request.Request(url, headers={'User-Agent': 'Mozilla/5.0', 'Accept': 'text/html,*/*;q=0.8'})
        with urllib.request.urlopen(req, timeout=10) as resp:
            html = resp.read().decode('utf-8', errors='ignore')
            if len(html) > 500:
                return html
    except Exception:
        pass
    return ""

def fetch_jd_playwright(url):
    try:
        with sync_playwright() as p:
            browser = p.chromium.launch(headless=True)
            page = browser.new_page()
            page.goto(url, wait_until="domcontentloaded", timeout=30000)
            time.sleep(2)
            html = page.content()
            browser.close()
            return html
    except Exception as e:
        print(f"    [Playwright Error] {e}")
        return ""

def extract_text_from_html(html):
    html = re.sub(r'<script.*?</script>', '', html, flags=re.DOTALL | re.IGNORECASE)
    html = re.sub(r'<style.*?</style>', '', html, flags=re.DOTALL | re.IGNORECASE)
    html = re.sub(r'<svg.*?</svg>', '', html, flags=re.DOTALL | re.IGNORECASE)
    html = re.sub(r'<[^>]+>', ' ', html)
    html = re.sub(r'\s{3,}', '\n\n', html)
    return html.strip()[:8000]

def fetch_workday_jd(url):
    """Fetches job description directly from Workday CXS JSON API."""
    try:
        match = re.search(r'https://([a-zA-Z0-9\-]+)\.([^/]+myworkdayjobs\.com)/(?:[a-zA-Z]{2}-[a-zA-Z]{2}/)?([^/]+)/job/(.+)', url)
        if match:
            tenant = match.group(1)
            domain = f"{tenant}.{match.group(2)}"
            site = match.group(3)
            job_path = match.group(4)
            api_url = f"https://{domain}/wday/cxs/{tenant}/{site}/job/{job_path}"
            headers = {
                'Accept': 'application/json',
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
            }
            req = urllib.request.Request(api_url, headers=headers)
            with urllib.request.urlopen(req, timeout=10) as resp:
                data = json.loads(resp.read().decode('utf-8'))
                jd_html = data.get('jobPostingInfo', {}).get('jobDescription', '')
                if jd_html:
                    return extract_text_from_html(jd_html)
    except Exception:
        pass
    return ""

def fetch_job_description(url):
    if "myworkdayjobs.com" in url:
        wd_text = fetch_workday_jd(url)
        if wd_text:
            return wd_text
    html = fetch_jd_http(url)
    if not html:
        html = fetch_jd_playwright(url)
    if not html:
        return ""
    return extract_text_from_html(html)

# -- Stage 2 Gemini Prompt
STAGE2_PROMPT = '''
You are an expert job eligibility screener. The candidate is a COMPLETELY FRESH GRADUATE with
0 years of experience and 0 internships. Your job is to verify experience requirements and extract the core tech stack.

JOB DESCRIPTION:
{job_description}

Return a JSON object with exactly these keys:

1. "experience_verdict": one of: "SAFE", "POSSIBLE", or "BLOCKED"
   - SAFE     = JD explicitly says fresher/entry-level/0 years/new grad/trainee/0-1 years
   - POSSIBLE = JD is silent or vague about experience (candidate should apply anyway)
   - BLOCKED  = JD requires 1+ years experience, or any number of prior internships REQUIRED

   HARD RULES:
   - "0-1 years" -> SAFE
   - "1+ years" or "2 years" or "3 years" etc. -> BLOCKED, no exceptions
   - "experience preferred but not required" -> POSSIBLE
   - No mention of experience at all -> POSSIBLE

2. "verdict_reason": 1 sentence explaining the experience verdict and quoting any specific experience requirements found.

3. "core_requirements": 1-2 factual sentences summarizing ONLY the required tech stack, programming languages, degree, or critical technical skills (e.g., 'Python, React, SQL, and a Bachelor's degree in CS').
   DO NOT include explanations of the experience verdict here.

Return ONLY valid JSON. No markdown.
'''

def score_job_with_gemini(jd_text, pool):
    if not jd_text:
        return None
    prompt = STAGE2_PROMPT.format(job_description=jd_text)
    try:
        text = pool.generate(prompt)
        result = json.loads(text)
        if isinstance(result, dict) and "experience_verdict" in result:
            return result
    except Exception as e:
        print(f"    [Stage 2 Gemini Error] {e}")
    return None

# -- Main
def main():
    print("=" * 60)
    print("  JobBuddy Stage 2 — Experience-Level Verification")
    print("=" * 60)

    if not GEMINI_API_KEY:
        print("  FATAL: GEMINI_API_KEY not set.")
        return
    if not MONGODB_URI:
        print("  FATAL: MONGODB_URI not set.")
        return

    db           = get_db()
    pool         = ModelPool(api_key=GEMINI_API_KEY, models=GEMINI_MODELS)

    pending = list(
        db.jobs.find(
            {"stage2_processed_at": {"$exists": False}, "link_type": "direct_apply", "link": {"$exists": True, "$ne": ""}},
            {"_id": 1, "title": 1, "company_name": 1, "link": 1, "location": 1, "core_requirements": 1}
        )
        .sort("scraped_at", -1)
        .limit(BATCH_SIZE)
    )

    print(f"  Found {len(pending)} jobs pending Stage 2 (batch: {BATCH_SIZE})\n")

    if not pending:
        print("  All jobs already processed. Nothing to do.")
        return

    safe_count = possible_count = blocked_count = error_count = 0
    start_time = time.time()
    MAX_RUNTIME_SECONDS = 80 * 60  # 80 minutes fail-safe

    for i, job in enumerate(pending, 1):
        if time.time() - start_time > MAX_RUNTIME_SECONDS:
            print("  [FAIL-SAFE] Approaching global time limit (80 minutes). Shutting down gracefully to prevent GitHub Actions cancellation...")
            break
            
        title   = job.get("title", "?")
        company = job.get("company_name", "?")
        link    = job.get("link", "")
        loc     = job.get("location", "")
        job_id  = job.get("_id")

        # 1. Location & Visa Gate check
        ok, reason = is_eligible_for_jobbuddy(job)
        if not ok:
            print(f"[{i}/{len(pending)}] [Deleted] Ineligible for Indian freshers: {title} ({loc}) -> {reason}")
            db.jobs.delete_one({"_id": job_id})
            continue

        print(f"[{i}/{len(pending)}] {title} @ {company} ({loc})")
        print(f"  -> {link}")

        jd_text = fetch_job_description(link)
        if not jd_text:
            print(f"  Could not fetch JD")
            db.jobs.update_one({"_id": job_id}, {"$set": {"stage2_processed_at": now_iso(), "experience_verdict": EXP_POSSIBLE}})
            error_count += 1
            continue

        # 2. Check full JD text for hidden clearance / domestic-only restrictions
        ok, reason = is_eligible_for_jobbuddy({"title": title, "location": loc, "core_requirements": jd_text})
        if not ok:
            print(f"  [Deleted] Ineligible from JD content: {reason}")
            db.jobs.delete_one({"_id": job_id})
            continue

        result = score_job_with_gemini(jd_text, pool)
        if not result:
            print(f"  Gemini scoring failed")
            error_count += 1
            continue

        verdict      = result.get("experience_verdict", EXP_POSSIBLE)
        verdict_reason = result.get("verdict_reason", "")
        tech_reqs    = (result.get("core_requirements") or "").strip() or job.get("core_requirements", "")

        icons = {"SAFE": "[OK]", "POSSIBLE": "[?]", "BLOCKED": "[X]"}
        print(f"  {icons.get(verdict,'?')} Experience: {verdict}")
        if verdict_reason:
            print(f"  Reason: {verdict_reason}")
        print(f"  Tech Requirements: {tech_reqs}")

        if verdict == EXP_SAFE:      safe_count += 1
        elif verdict == EXP_POSSIBLE: possible_count += 1
        else:                          blocked_count += 1

        try:
            if verdict == EXP_BLOCKED:
                db.jobs.delete_one({"_id": job_id})
                print(f"  [Deleted] Removed from database to save space (BLOCKED)")
            else:
                db.jobs.update_one(
                    {"_id": job_id},
                    {
                        "$set": {
                            "stage2_processed_at": now_iso(),
                            "experience_verdict": verdict,
                            "verdict_reason": verdict_reason,
                            "core_requirements": tech_reqs
                        }
                    }
                )
        except Exception as e:
            print(f"  [Error] Failed to update MongoDB for {job_id}: {e}")

        time.sleep(4)

    print(f"\n{'='*60}")
    print(f"  Stage 2 Complete.")
    print(f"  [OK] SAFE (apply now):          {safe_count}")
    print(f"  [?]  POSSIBLE (take a chance):  {possible_count}")
    print(f"  [X]  BLOCKED (needs exp):        {blocked_count}")
    print(f"  Errors / unfetchable:            {error_count}")
    print(f"{'='*60}")

if __name__ == "__main__":
    main()
