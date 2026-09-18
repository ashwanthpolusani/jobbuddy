import os
import json
import time
import re
import hashlib
from datetime import datetime, timezone
from dotenv import load_dotenv
from pymongo import MongoClient
from google import genai
import certifi
from playwright.sync_api import sync_playwright
from pypdf import PdfReader

load_dotenv()

# ── Configuration ──────────────────────────────────────────────────────────────
GEMINI_API_KEY = os.getenv("GEMINI_API_KEY")
MONGODB_URI    = os.getenv("MONGODB_URI")
RESUME_PATH    = os.path.join(os.path.dirname(os.path.dirname(__file__)), "ashwanth polusani.pdf")
URLS_FILE      = os.path.join(os.path.dirname(__file__), "urls.txt")

# ── Helpers ────────────────────────────────────────────────────────────────────
def get_target_urls():
    if not os.path.exists(URLS_FILE):
        return []
    with open(URLS_FILE, 'r') as f:
        return [line.strip() for line in f if line.strip() and not line.startswith('#')]

def get_resume_text():
    try:
        reader = PdfReader(RESUME_PATH)
        return "".join(page.extract_text() for page in reader.pages)
    except Exception as e:
        print(f"[WARN] Could not read resume: {e}")
        return ""

def clean_html(html):
    """Strip scripts, styles, SVG, comments to cut token count ~80%."""
    html = re.sub(r'<script.*?</script>', '', html, flags=re.DOTALL | re.IGNORECASE)
    html = re.sub(r'<style.*?</style>',  '', html, flags=re.DOTALL | re.IGNORECASE)
    html = re.sub(r'<svg.*?</svg>',      '', html, flags=re.DOTALL | re.IGNORECASE)
    html = re.sub(r'<!--.*?-->',         '', html, flags=re.DOTALL)
    return html

def make_job_id(company: str, title: str, link: str) -> str:
    """Stable unique ID for deduplication via upsert."""
    raw = f"{company.lower().strip()}|{title.lower().strip()}|{link.strip()}"
    return hashlib.sha256(raw.encode()).hexdigest()

def now_iso():
    return datetime.now(timezone.utc).isoformat()

# ── Playwright ─────────────────────────────────────────────────────────────────
def fetch_html_with_playwright(url: str) -> tuple[str, int, str | None]:
    """
    Returns (html, fetch_time_ms, error_message).
    html is empty string on failure.
    """
    print(f"  ↳ Fetching {url} …")
    start = time.time()
    try:
        with sync_playwright() as p:
            browser = p.chromium.launch(headless=True)
            page = browser.new_page()
            page.goto(url, wait_until="domcontentloaded", timeout=45000)
            time.sleep(3)
            html = clean_html(page.content())
            browser.close()
        elapsed = int((time.time() - start) * 1000)
        return html, elapsed, None
    except Exception as e:
        elapsed = int((time.time() - start) * 1000)
        return "", elapsed, str(e)

# ── Gemini ─────────────────────────────────────────────────────────────────────
GEMINI_PROMPT_TEMPLATE = """
You are a strict job-listing extractor helping a FRESHER (0 years experience, 0 internships) from Hyderabad, India.

CANDIDATE PROFILE:
- B.Tech Computer Science graduate (2026), Hyderabad, India
- Skills from projects: Python, React, Flask, Node.js, MongoDB, ML/NLP, full-stack web dev
- 0 years work experience, 0 internships — COMPLETELY FRESH graduate
- Open to: any city in India, or abroad ONLY if company explicitly sponsors visa
- NOT eligible for: any role requiring 1+ years experience, or work authorization the candidate doesn't have

CANDIDATE RESUME:
{resume_text}

──────────────────────────────────────────
TASK: Extract job listings from the HTML below.

STRICT RULES — follow exactly:

1. SKIP generic pages: If the page only shows a "Browse Jobs" / "View Openings" button
   with no actual specific job titles listed → return an empty array [].

2. REJECT any job that requires any work experience, any internships, or any years on the job.
   This includes "1+ year preferred", "some experience", etc.
   ONLY include jobs explicitly labeled: fresher, entry-level, new grad, trainee,
   associate, 0–1 years, or no experience required.
   When in doubt about experience requirements → EXCLUDE the job.

3. SKIP link_type "career_homepage": If a link goes to a generic careers homepage
   (not filtered to specific roles or a specific department) → do NOT include it.

4. For each valid job, determine link_type:
   - "direct_apply": URL leads directly to one specific job application form
   - "filtered_list": URL leads to a pre-filtered list (e.g., by city, department, or team)
   Do NOT include "career_homepage" type — skip those entirely.

5. Assign category (pick ONE):
   software_engineering | data_ml | devops_cloud | cybersecurity | early_careers | product_design | other

6. Assign quality (integer 1–5):
   5 = Specific title + real requirements stated + direct apply link + strong skills match
   4 = Specific title + some requirements + good match
   3 = Specific title + filtered list link + limited info
   2 = Vague title + filtered list + partial info
   1 = Do not include (skip)

7. Extract company_name from page content, not from URL.

8. Return ONLY a valid JSON array. Each element must have exactly these keys:
   "title", "company_name", "location", "requirements", "link",
   "link_type", "category", "quality", "match_reason"

   - "requirements": brief summary of what the job needs (empty string if truly unknown)
   - "match_reason": 1–2 sentences explaining WHY this is a good fit for the candidate
   - All links must be absolute URLs
   - If no valid jobs found → return []

HTML:
{raw_html}
"""

def extract_jobs_with_gemini(raw_html: str, resume_text: str, url: str) -> list[dict]:
    if not GEMINI_API_KEY or not raw_html:
        return []

    try:
        client = genai.Client(api_key=GEMINI_API_KEY)
        prompt = GEMINI_PROMPT_TEMPLATE.format(resume_text=resume_text, raw_html=raw_html)

        max_retries = 3
        for attempt in range(max_retries):
            try:
                response = client.models.generate_content(
                    model='gemini-2.0-flash-lite',
                    contents=prompt,
                    config={"response_mime_type": "application/json"}
                )
                jobs = json.loads(response.text)
                if not isinstance(jobs, list):
                    return []
                # Inject source_url and scraped_at
                for job in jobs:
                    job['source_url']  = url
                    job['scraped_at']  = now_iso()
                return jobs
            except Exception as e:
                err = str(e)
                if '429' in err or 'Quota' in err or '503' in err:
                    print(f"  ⚠ Rate limit/overload (attempt {attempt+1}/3). Sleeping 65s…")
                    time.sleep(65)
                else:
                    print(f"  ✗ Gemini error: {err}")
                    return []

        print("  ✗ Max retries exceeded for Gemini.")
        return []
    except Exception as e:
        print(f"  ✗ Gemini config error: {e}")
        return []

# ── MongoDB ────────────────────────────────────────────────────────────────────
def get_db():
    client = MongoClient(
        MONGODB_URI,
        serverSelectionTimeoutMS=10000,
        tlsCAFile=certifi.where()
    )
    return client.job_aggregator

def upsert_jobs(jobs: list[dict]) -> int:
    """Upsert jobs — update existing, insert new. Returns count saved."""
    if not jobs or not MONGODB_URI:
        return 0
    saved = 0
    try:
        db = get_db()
        collection = db.jobs
        for job in jobs:
            company = job.get('company_name', '')
            title   = job.get('title', '')
            link    = job.get('link', '')
            job_id  = make_job_id(company, title, link)
            job['job_id'] = job_id
            result = collection.update_one(
                {"job_id": job_id},
                {
                    "$set": {k: v for k, v in job.items() if k != 'first_seen'},
                    "$setOnInsert": {"first_seen": now_iso()}
                },
                upsert=True
            )
            if result.upserted_id or result.modified_count:
                saved += 1
    except Exception as e:
        print(f"  ✗ MongoDB upsert error: {e}")
    return saved

def record_site_stats(url: str, fetch_success: bool, fetch_time_ms: int,
                      jobs: list[dict], error: str | None):
    """Write one performance record per URL visit to site_stats collection."""
    if not MONGODB_URI:
        return
    link_types = {}
    qualities  = []
    for j in jobs:
        lt = j.get('link_type', 'unknown')
        link_types[lt] = link_types.get(lt, 0) + 1
        q = j.get('quality', 0)
        if q:
            qualities.append(q)

    stat = {
        "url":                url,
        "run_date":           now_iso(),
        "fetch_success":      fetch_success,
        "fetch_time_ms":      fetch_time_ms,
        "raw_jobs_extracted": len(jobs),
        "quality_jobs_saved": len([j for j in jobs if j.get('quality', 0) >= 3]),
        "link_types":         link_types,
        "avg_quality":        round(sum(qualities) / len(qualities), 2) if qualities else 0,
        "error":              error,
    }
    try:
        db = get_db()
        db.site_stats.insert_one(stat)
    except Exception as e:
        print(f"  ⚠ Could not write site_stats: {e}")

# ── Main ───────────────────────────────────────────────────────────────────────
def main():
    print("═" * 60)
    print("  JobBuddy Scraper v2 — Starting")
    print("═" * 60)

    resume_text = get_resume_text()
    if not resume_text:
        print("[WARN] Resume text empty — AI matching quality will be reduced.")

    urls = get_target_urls()
    print(f"  Loaded {len(urls)} target URLs.\n")

    total_jobs_saved = 0

    for i, url in enumerate(urls, 1):
        print(f"\n[{i}/{len(urls)}] {url}")

        html, fetch_time_ms, fetch_error = fetch_html_with_playwright(url)
        fetch_success = bool(html and not fetch_error)

        if not fetch_success:
            print(f"  ✗ Fetch failed ({fetch_time_ms}ms): {fetch_error}")
            record_site_stats(url, False, fetch_time_ms, [], fetch_error)
            time.sleep(2)
            continue

        jobs = extract_jobs_with_gemini(html, resume_text, url)

        if not jobs:
            print(f"  → 0 valid jobs extracted")
            record_site_stats(url, True, fetch_time_ms, [], None)
        else:
            saved = upsert_jobs(jobs)
            total_jobs_saved += saved
            print(f"  ✓ {len(jobs)} jobs extracted, {saved} upserted to DB")
            record_site_stats(url, True, fetch_time_ms, jobs, None)

        # Respectful delay to stay under Gemini free-tier limits
        time.sleep(12)

    print(f"\n{'═'*60}")
    print(f"  Run complete. {total_jobs_saved} total jobs saved/updated.")
    print(f"{'═'*60}\n")

if __name__ == "__main__":
    main()
