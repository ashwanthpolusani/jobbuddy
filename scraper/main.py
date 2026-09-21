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
import safe_ats  # v3 Safe API Router

load_dotenv()

# ── Configuration ──────────────────────────────────────────────────────────────
GEMINI_API_KEY = os.getenv("GEMINI_API_KEY")
MONGODB_URI    = os.getenv("MONGODB_URI")
PROFILE_PATH   = os.path.join(os.path.dirname(__file__), "profile.txt")
URLS_FILE      = os.path.join(os.path.dirname(__file__), "urls.txt")

# Both models share the same free-tier limits: 15 RPM, 500 RPD, 250K TPM
# Note: All 4 GH Actions parallel runners share one API key, so real RPM is still
# 15/min total (each runner processes a shard of URLs, so contention is minimal).
GEMINI_MODELS = [
    "gemini-3.5-flash-lite",   # Model A (primary)
    "gemini-3.1-flash-lite",   # Model B (fallback)
]
RPM_LIMIT = 15          # Per-model per-minute limit
RPD_LIMIT = 500         # Per-model per-day limit
GEMINI_CHUNK_SIZE = 50  # Max jobs per Gemini API call (prevents Payload Too Large)


# ── Helpers ────────────────────────────────────────────────────────────────────
def get_target_urls():
    if not os.path.exists(URLS_FILE):
        return []
    
    # Read all valid URLs
    with open(URLS_FILE, 'r') as f:
        raw_urls = [line.strip() for line in f if line.strip() and not line.startswith('#')]
    
    # 1. Expand Pagination Templates
    # Example: https://site.com/jobs?from=[PAGE_OFFSET:0:90:10]
    urls = []
    pattern = re.compile(r'\[PAGE_OFFSET:(\d+):(\d+):(\d+)\]')
    for raw_url in raw_urls:
        match = pattern.search(raw_url)
        if match:
            start = int(match.group(1))
            end = int(match.group(2))
            step = int(match.group(3))
            if step <= 0: step = 10 # safety fallback
            for offset in range(start, end + 1, step):
                urls.append(pattern.sub(str(offset), raw_url))
        else:
            urls.append(raw_url)
    
    # 2. Modulo Sharding for GH Actions Matrix Scaling
    chunk_index = int(os.getenv("CHUNK_INDEX", "0"))
    total_chunks = int(os.getenv("TOTAL_CHUNKS", "1"))
    
    if total_chunks > 1:
        sharded_urls = [u for i, u in enumerate(urls) if i % total_chunks == chunk_index]
        print(f"  [Matrix] Sharding enabled: Processing chunk {chunk_index+1}/{total_chunks}")
        return sharded_urls
        
    return urls

def get_profile_text():
    """Reads the static profile.txt file to avoid PDF parsing overhead."""
    if not os.path.exists(PROFILE_PATH):
        print("[WARN] profile.txt not found. AI matching quality will be reduced.")
        return ""
    with open(PROFILE_PATH, 'r') as f:
        return f.read()

def clean_html(html):
    """Strip scripts, styles, SVG, comments to cut token count ~80%."""
    html = re.sub(r'<script.*?</script>', '', html, flags=re.DOTALL | re.IGNORECASE)
    html = re.sub(r'<style.*?</style>',  '', html, flags=re.DOTALL | re.IGNORECASE)
    html = re.sub(r'<svg.*?</svg>',      '', html, flags=re.DOTALL | re.IGNORECASE)
    html = re.sub(r'<!--.*?-->',         '', html, flags=re.DOTALL)
    return html

def extract_text_and_links(html: str) -> str:
    """Uses markdownify to convert HTML to Markdown, preserving structure and links while minimizing tokens."""
    try:
        import markdownify
        from bs4 import BeautifulSoup
        
        # First clean up unnecessary elements that bloat the output
        soup = BeautifulSoup(html, 'html.parser')
        for element in soup(["script", "style", "noscript", "svg"]):
            element.extract()
            
        clean_html_str = str(soup)
        
        # Convert to markdown: preserves headers (e.g. ### SOFTWARE ENGINEERING) and links [Job](url)
        md = markdownify.markdownify(clean_html_str, heading_style="ATX")
        
        # Clean up excessive blank lines to save tokens
        import re
        md = re.sub(r'\n{3,}', '\n\n', md).strip()
        
        return md if md else clean_html(html)
    except Exception as e:
        print(f"  ⚠ Markdown conversion error: {e}. Falling back to cleaned HTML.")
        return clean_html(html)

# ── Dual-Model Pool ────────────────────────────────────────────────────────────
class ModelPool:
    """
    Manages two Gemini models with round-robin load balancing and
    instant failover. Only sleeps when BOTH models are rate-limited.
    """
    def __init__(self, api_key: str, models: list[str]):
        self.client = genai.Client(api_key=api_key)
        self.models = models
        self._current = 0  # index for round-robin
        # Per-model tracking
        self._stats = {
            m: {"minute_count": 0, "day_count": 0, "minute_start": time.time()}
            for m in models
        }

    def _refresh_minute(self, model: str):
        s = self._stats[model]
        if time.time() - s["minute_start"] >= 60:
            s["minute_count"] = 0
            s["minute_start"] = time.time()

    def _is_available(self, model: str) -> bool:
        self._refresh_minute(model)
        s = self._stats[model]
        return s["minute_count"] < RPM_LIMIT and s["day_count"] < RPD_LIMIT

    def _record_use(self, model: str):
        self._stats[model]["minute_count"] += 1
        self._stats[model]["day_count"] += 1

    def _mark_limited(self, model: str):
        """Force the model to appear maxed out for this minute."""
        self._stats[model]["minute_count"] = RPM_LIMIT

    def generate(self, prompt: str) -> str:
        """
        Try models in round-robin order.
        Instant failover on 429/503. Sleep only when both exhausted.
        Returns the response text or raises RuntimeError.
        """
        # Build ordered list starting from current round-robin index
        ordered = [self.models[(self._current + i) % len(self.models)]
                   for i in range(len(self.models))]
        self._current = (self._current + 1) % len(self.models)

        max_global_retries = 3
        for global_attempt in range(max_global_retries):
            for model in ordered:
                if not self._is_available(model):
                    print(f"  ⟳ {model} quota reached — skipping to next model")
                    continue
                try:
                    response = self.client.models.generate_content(
                        model=model,
                        contents=prompt,
                        config={"response_mime_type": "application/json"}
                    )
                    self._record_use(model)
                    print(f"  ✓ [{model}] responded")
                    return response.text
                except Exception as e:
                    err = str(e)
                    if '429' in err or 'Quota' in err or '503' in err:
                        print(f"  ⚠ [{model}] rate limited — trying next model instantly")
                        self._mark_limited(model)
                        continue  # immediately try next model
                    else:
                        raise  # non-rate-limit error: propagate up

            # Both models are exhausted — wait for minute to reset
            print(f"  ⏳ Both models rate limited. Sleeping 65s… (attempt {global_attempt+1}/{max_global_retries})")
            time.sleep(65)
            # Reset tracking so we retry fresh
            for m in self.models:
                self._stats[m]["minute_count"] = 0
                self._stats[m]["minute_start"] = time.time()

        raise RuntimeError("All models exhausted after max retries.")


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
            raw_html = page.content()
            html = extract_text_and_links(raw_html)
            browser.close()
        elapsed = int((time.time() - start) * 1000)
        return html, elapsed, None
    except Exception as e:
        elapsed = int((time.time() - start) * 1000)
        return "", elapsed, str(e)

# ── Gemini ─────────────────────────────────────────────────────────────────────
GEMINI_PROMPT_TEMPLATE = """
You are a strict job-listing extractor helping a candidate find jobs.

{profile_text}

──────────────────────────────────────────
TASK: Extract and evaluate job listings from the raw data below.

STRICT RULES — follow exactly:

1. REJECT any job that requires any work experience, any internships, or any years on the job.
   This includes "1+ year preferred", "some experience", etc.
   ONLY include jobs explicitly labeled: fresher, entry-level, new grad, trainee,
   associate, 0–1 years, or no experience required.
   When in doubt about experience requirements → EXCLUDE the job.

2. SKIP link_type "career_homepage": If a link goes to a generic careers homepage
   (not filtered to specific roles or a specific department) → do NOT include it.

3. For each valid job, determine link_type:
   - "direct_apply": URL leads directly to one specific job application form
   - "filtered_list": URL leads to a pre-filtered list (e.g., by city, department, or team)

4. Assign category (pick ONE):
   software_engineering | data_ml | devops_cloud | cybersecurity | early_careers | product_design | other

5. Assign quality (integer 1–5):
   5 = Specific title + real requirements stated + direct apply link + strong skills match
   4 = Specific title + some requirements + good match
   3 = Specific title + filtered list link + limited info
   2 = Vague title + filtered list + partial info
   1 = Do not include (skip)

6. Extract company_name accurately.

7. Return ONLY a valid JSON array. Each element must have exactly these keys:
   "title", "company_name", "location", "requirements", "link",
   "link_type", "category", "quality", "match_reason"

   - "requirements": brief summary of what the job needs (empty string if truly unknown)
   - "match_reason": 1–2 sentences explaining WHY this is a good fit for the candidate
   - All links must be absolute URLs
   - If no valid jobs found → return []
   - IF the raw data appears to be a Captcha, Cloudflare challenge, Access Denied, or a generic homepage/video page instead of a careers portal, return EXACTLY this: [{{"error_type": "site_blocked_or_invalid"}}]

RAW DATA TO EVALUATE:
{raw_data}
"""

def extract_jobs_with_gemini(raw_data: str, profile_text: str, url: str, pool: ModelPool) -> list[dict]:
    if not GEMINI_API_KEY or not raw_data:
        return []

    prompt = GEMINI_PROMPT_TEMPLATE.format(profile_text=profile_text, raw_data=raw_data)
    
    try:
        text = pool.generate(prompt)
        jobs = json.loads(text)
        if not isinstance(jobs, list):
            return []
        # Defensive: only keep actual dicts (guards against Gemini returning ["error_type"] strings)
        jobs = [job for job in jobs if isinstance(job, dict)]
        for job in jobs:
            job['source_url']  = url
            job['scraped_at']  = now_iso()
        return jobs
    except json.JSONDecodeError as e:
        print(f"  ✗ JSON parse error: {e}")
        return []
    except RuntimeError as e:
        print(f"  ✗ {e}")
        return []
    except Exception as e:
        print(f"  ✗ Gemini error: {e}")
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
                      jobs: list[dict], error: str | None, ats_replacement_url: str | None = None):
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
        "ats_replacement_url": ats_replacement_url
    }
    try:
        db = get_db()
        db.site_stats.insert_one(stat)
    except Exception as e:
        print(f"  ⚠ Could not write site_stats: {e}")

# ── Main ───────────────────────────────────────────────────────────────────────
def main():
    print("═" * 60)
    print("  JobBuddy Scraper v3 — Starting")
    print("═" * 60)

    # ── Guard: fail fast if required secrets are missing ──────────────
    if not GEMINI_API_KEY:
        print("  ✗ FATAL: GEMINI_API_KEY is not set. Add it to .env or GitHub Secrets.")
        return
    if not MONGODB_URI:
        print("  ✗ FATAL: MONGODB_URI is not set. Add it to .env or GitHub Secrets.")
        return

    profile_text = get_profile_text()

    urls = get_target_urls()
    print(f"  Loaded {len(urls)} target URLs.")
    print(f"  Models: {GEMINI_MODELS[0]} (primary) + {GEMINI_MODELS[1]} (fallback)")
    print(f"  Rate limits: {RPM_LIMIT} RPM · {RPD_LIMIT} RPD per model (shared API key)\n")

    pool = ModelPool(api_key=GEMINI_API_KEY, models=GEMINI_MODELS)
    total_jobs_saved = 0

    for i, url in enumerate(urls, 1):
        print(f"\n[{i}/{len(urls)}] {url}")
        api_link = None  # Reset per-URL to prevent leak across iterations

        # 1. ATS API ROUTER (The fast/safe path)
        is_api, api_jobs, ats_name = safe_ats.process_ats_url(url)
        
        if is_api:
            print(f"  ⚡ ATS Detected: {ats_name} API (bypassing Playwright)")
            start = time.time()
            if not api_jobs:
                print(f"  → 0 total open roles found via {ats_name} API.")
                record_site_stats(url, True, int((time.time()-start)*1000), [], None)
                continue
                
            filtered = safe_ats.pre_filter_jobs(api_jobs)
            print(f"  → API returned {len(api_jobs)} jobs. Pre-filtered to {len(filtered)} tech/junior roles.")
            
            if not filtered:
                record_site_stats(url, True, int((time.time()-start)*1000), [], None)
                continue
                
            # Send the JSON shortlist to Gemini to do the final strict experience-check (CHUNKED)
            jobs = []
            for j in range(0, len(filtered), GEMINI_CHUNK_SIZE):
                chunk = filtered[j:j + GEMINI_CHUNK_SIZE]
                raw_data_for_gemini = json.dumps(chunk, indent=2)
                chunk_jobs = extract_jobs_with_gemini(raw_data_for_gemini, profile_text, url, pool)
                jobs.extend(chunk_jobs)
            fetch_time_ms = int((time.time()-start)*1000)

        # 2. PLAYWRIGHT FALLBACK (The safe HTML path)
        else:
            html, fetch_time_ms, fetch_error = fetch_html_with_playwright(url)
            fetch_success = bool(html and not fetch_error)

            if not fetch_success:
                print(f"  ✗ Fetch failed ({fetch_time_ms}ms): {fetch_error}")
                record_site_stats(url, False, fetch_time_ms, [], fetch_error)
                time.sleep(2)
                continue

            # ATS Auto-Detection
            detected_is_api, detected_api_jobs, detected_ats_name = safe_ats.process_html_for_ats(html)
            if detected_is_api:
                print(f"  ⚡ Auto-Detected {detected_ats_name} inside webpage! Switching to API.")
                
                # Derive the replacement API link from the detected slug in the HTML
                if detected_ats_name == "Greenhouse" and safe_ats.extract_slug(url, "greenhouse"):
                    api_link = f"https://boards.greenhouse.io/{safe_ats.extract_slug(url, 'greenhouse')}"
                elif detected_ats_name == "Lever" and safe_ats.extract_slug(url, "lever"):
                    api_link = f"https://jobs.lever.co/{safe_ats.extract_slug(url, 'lever')}"
                elif detected_ats_name == "Workday" and safe_ats.extract_workday_params(url):
                    _, domain, site = safe_ats.extract_workday_params(url)
                    api_link = f"https://{domain}/en-US/{site}"
                elif detected_ats_name == "MyNextHire":
                    match = re.search(r'https://([^/]+\.mynexthire\.com)', url)
                    if match:
                        api_link = f"https://{match.group(1)}/employer/jobs/careers"
                elif detected_api_jobs:
                    # Last resort: try extracting slug from the first job's link
                    sample_link = detected_api_jobs[0].get('link', '')
                    if detected_ats_name == "Workday":
                        params = safe_ats.extract_workday_params(sample_link)
                        if params:
                            _, domain, site = params
                            api_link = f"https://{domain}/en-US/{site}"
                    elif detected_ats_name == "MyNextHire":
                        match = re.search(r'https://([^/]+\.mynexthire\.com)', sample_link)
                        if match:
                            api_link = f"https://{match.group(1)}/employer/jobs/careers"
                    else:
                        slug = safe_ats.extract_slug(sample_link, detected_ats_name.lower())
                        if slug:
                            api_link = f"https://boards.greenhouse.io/{slug}" if detected_ats_name == "Greenhouse" else f"https://jobs.lever.co/{slug}"

                
                # Log replacement recommendation
                log_path = os.path.join(os.path.dirname(__file__), "..", "scratch", "ats_replacements.log")
                os.makedirs(os.path.dirname(log_path), exist_ok=True)
                with open(log_path, "a") as f:
                    if api_link:
                         f.write(f"[{now_iso()}] {detected_ats_name} Detected: REPLACE {url} WITH {api_link}\n")
                    else:
                         f.write(f"[{now_iso()}] {detected_ats_name} Detected: Consider replacing {url} with direct ATS link in urls.txt for faster runs.\n")
                
                filtered = safe_ats.pre_filter_jobs(detected_api_jobs)
                print(f"  → {detected_ats_name} API returned {len(detected_api_jobs)} jobs. Pre-filtered to {len(filtered)} roles.")
                
                if not filtered:
                    record_site_stats(url, True, fetch_time_ms, [], None, ats_replacement_url=api_link)
                    continue
                
                jobs = []
                for j in range(0, len(filtered), GEMINI_CHUNK_SIZE):
                    chunk = filtered[j:j + GEMINI_CHUNK_SIZE]
                    raw_data_for_gemini = json.dumps(chunk, indent=2)
                    chunk_jobs = extract_jobs_with_gemini(raw_data_for_gemini, profile_text, url, pool)
                    jobs.extend(chunk_jobs)
            else:
                jobs = extract_jobs_with_gemini(html, profile_text, url, pool)

        # 3. SAVE RESULTS
        # Filter out any error_type sentinel objects that may have leaked through from any chunk
        error_jobs = [j for j in jobs if "error_type" in j]
        real_jobs  = [j for j in jobs if "error_type" not in j]
        
        if error_jobs and not real_jobs:
            issue = error_jobs[0].get("error_type")
            print(f"  ⚠ Gemini detected site issue: {issue}")
            record_site_stats(url, True, fetch_time_ms, [], error=f"Gemini Analysis: {issue}", ats_replacement_url=api_link)
        elif not real_jobs:
            print(f"  → 0 valid jobs extracted (post-Gemini)")
            record_site_stats(url, True, fetch_time_ms, [], None, ats_replacement_url=api_link)
        else:
            saved = upsert_jobs(real_jobs)
            total_jobs_saved += saved
            print(f"  ✓ {len(real_jobs)} jobs extracted, {saved} upserted to DB")
            record_site_stats(url, True, fetch_time_ms, real_jobs, None, ats_replacement_url=api_link)

        # Shorter delay now that we have 2x rate limit headroom
        time.sleep(6)

    print(f"\n{'═'*60}")
    print(f"  Run complete. {total_jobs_saved} total jobs saved/updated.")
    print(f"  Model A ({GEMINI_MODELS[0]}) used: {pool._stats[GEMINI_MODELS[0]]['day_count']} requests")
    print(f"  Model B ({GEMINI_MODELS[1]}) used: {pool._stats[GEMINI_MODELS[1]]['day_count']} requests")
    print(f"{'═'*60}\n")

if __name__ == "__main__":
    main()
