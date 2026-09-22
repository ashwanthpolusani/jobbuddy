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

load_dotenv()

# -- Configuration
GEMINI_API_KEY  = os.getenv("GEMINI_API_KEY")
MONGODB_URI     = os.getenv("MONGODB_URI")
PROFILE_PATH    = os.path.join(os.path.dirname(__file__), "profile.txt")
GEMINI_MODELS   = ["gemini-3.5-flash-lite", "gemini-3.1-flash-lite"]
RPM_LIMIT       = 15
BATCH_SIZE      = 150
SCORE_THRESHOLD = 40

EXP_SAFE     = "SAFE"
EXP_POSSIBLE = "POSSIBLE"
EXP_BLOCKED  = "BLOCKED"

# -- MongoDB Singleton
_mongo_client = None
_mongo_db     = None

def get_db():
    global _mongo_client, _mongo_db
    if _mongo_client is None:
        _mongo_client = MongoClient(MONGODB_URI, serverSelectionTimeoutMS=10000, maxPoolSize=5, tlsCAFile=certifi.where())
        _mongo_db = _mongo_client.job_aggregator
    return _mongo_db

def now_iso():
    return datetime.now(timezone.utc).isoformat()

def get_profile_text() -> str:
    if not os.path.exists(PROFILE_PATH):
        return ""
    with open(PROFILE_PATH, 'r') as f:
        return f.read()

# -- Model Pool
class ModelPool:
    def __init__(self, api_key, models):
        self.client = genai.Client(api_key=api_key)
        self.models = models
        self._current = 0
        self._stats = {m: {"minute_count": 0, "day_count": 0, "minute_start": time.time()} for m in models}

    def _is_available(self, model):
        s = self._stats[model]
        if time.time() - s["minute_start"] > 60:
            s["minute_count"] = 0
            s["minute_start"] = time.time()
        return s["minute_count"] < RPM_LIMIT and s["day_count"] < 500

    def _record_use(self, model):
        self._stats[model]["minute_count"] += 1
        self._stats[model]["day_count"]    += 1

    def _mark_limited(self, model):
        self._stats[model]["minute_count"] = RPM_LIMIT

    def generate(self, prompt):
        ordered = [self.models[(self._current + i) % len(self.models)] for i in range(len(self.models))]
        self._current = (self._current + 1) % len(self.models)
        for attempt in range(3):
            for model in ordered:
                if not self._is_available(model):
                    continue
                try:
                    response = self.client.models.generate_content(model=model, contents=prompt, config={"response_mime_type": "application/json"})
                    self._record_use(model)
                    print(f"  ok [{model}]")
                    return response.text
                except Exception as e:
                    err = str(e)
                    if '429' in err or 'Quota' in err or '503' in err:
                        self._mark_limited(model)
                        continue
                    else:
                        raise
            print(f"  Both models rate limited. Sleeping 65s...")
            time.sleep(65)
            for m in self.models:
                self._stats[m]["minute_count"] = 0
                self._stats[m]["minute_start"] = time.time()
        raise RuntimeError("All models exhausted.")

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

def fetch_job_description(url):
    html = fetch_jd_http(url)
    if not html:
        html = fetch_jd_playwright(url)
    if not html:
        return ""
    return extract_text_from_html(html)

# -- Stage 2 Gemini Prompt
STAGE2_PROMPT = '''
You are an expert job eligibility screener. The candidate is a COMPLETELY FRESH GRADUATE with
0 years of experience and 0 internships. Your #1 job is detecting experience requirements.

CANDIDATE PROFILE:
{profile_text}

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

2. "experience_required": exact quote from the JD about experience, or "Not stated"

3. "match_score": integer 0-100 on SKILLS match only (not experience):
   100 = every tech requirement matches candidate profile
   70+ = most requirements match
   40-69 = partial match
   0-39 = major skills mismatch

4. "match_reasoning": 2-3 sentences. First sentence must state the experience verdict and why.

5. "skill_gaps": list of specific tools/languages/frameworks the JD requires that the candidate lacks. [] if none.

Return ONLY valid JSON. No markdown.
'''

def score_job_with_gemini(jd_text, profile_text, pool):
    if not jd_text:
        return None
    prompt = STAGE2_PROMPT.format(profile_text=profile_text, job_description=jd_text)
    try:
        text = pool.generate(prompt)
        result = json.loads(text)
        if isinstance(result, dict) and "match_score" in result:
            return result
    except Exception as e:
        print(f"    [Stage 2 Gemini Error] {e}")
    return None

# -- Main
def main():
    print("=" * 60)
    print("  JobBuddy Stage 2 - Deep Resume Matching")
    print("=" * 60)

    if not GEMINI_API_KEY:
        print("  FATAL: GEMINI_API_KEY not set.")
        return
    if not MONGODB_URI:
        print("  FATAL: MONGODB_URI not set.")
        return

    profile_text = get_profile_text()
    db           = get_db()
    pool         = ModelPool(api_key=GEMINI_API_KEY, models=GEMINI_MODELS)

    pending = list(
        db.jobs.find(
            {"stage2_processed_at": {"$exists": False}, "link_type": "direct_apply", "link": {"$exists": True, "$ne": ""}},
            {"_id": 1, "title": 1, "company_name": 1, "link": 1, "quality": 1}
        )
        .sort("quality", -1)
        .limit(BATCH_SIZE)
    )

    print(f"  Found {len(pending)} jobs pending Stage 2 (batch: {BATCH_SIZE})\n")

    if not pending:
        print("  All jobs already processed. Nothing to do.")
        return

    safe_count = possible_count = blocked_count = error_count = 0

    for i, job in enumerate(pending, 1):
        title   = job.get("title", "?")
        company = job.get("company_name", "?")
        link    = job.get("link", "")
        job_id  = job.get("_id")

        print(f"[{i}/{len(pending)}] {title} @ {company}")
        print(f"  -> {link}")

        jd_text = fetch_job_description(link)
        if not jd_text:
            print(f"  Could not fetch JD")
            db.jobs.update_one({"_id": job_id}, {"$set": {"stage2_processed_at": now_iso(), "experience_verdict": EXP_POSSIBLE, "match_score": None, "match_reasoning": "Could not fetch job description page.", "skill_gaps": [], "experience_required": "Unknown"}})
            error_count += 1
            continue

        result = score_job_with_gemini(jd_text, profile_text, pool)
        if not result:
            print(f"  Gemini scoring failed")
            error_count += 1
            continue

        verdict      = result.get("experience_verdict", EXP_POSSIBLE)
        match_score  = result.get("match_score", 0)
        reasoning    = result.get("match_reasoning", "")
        skill_gaps   = result.get("skill_gaps", [])
        exp_required = result.get("experience_required", "Not stated")

        icons = {"SAFE": "[OK]", "POSSIBLE": "[?]", "BLOCKED": "[X]"}
        print(f"  {icons.get(verdict,'?')} Experience: {verdict} | Quote: {exp_required}")
        print(f"  Score: {match_score}/100 | Gaps: {', '.join(skill_gaps) if skill_gaps else 'None'}")

        if verdict == EXP_SAFE:      safe_count += 1
        elif verdict == EXP_POSSIBLE: possible_count += 1
        else:                          blocked_count += 1

        if verdict == EXP_BLOCKED:
            db.jobs.delete_one({"_id": job_id})
            print(f"  [Deleted] Removed from database to save space")
        else:
            db.jobs.update_one({"_id": job_id}, {"$set": {"stage2_processed_at": now_iso(), "experience_verdict": verdict, "experience_required": exp_required, "match_score": match_score, "match_reasoning": reasoning, "skill_gaps": skill_gaps}})

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
