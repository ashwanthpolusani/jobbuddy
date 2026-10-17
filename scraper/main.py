import os
import sys
import json
import time
import re
import hashlib
from datetime import datetime, timezone
import urllib.parse

# Fix Windows console encoding issues for printing unicode box-drawing characters
if sys.stdout.encoding and sys.stdout.encoding.lower() != 'utf-8':
    try:
        sys.stdout.reconfigure(encoding='utf-8')
    except AttributeError:
        pass

from dotenv import load_dotenv
from pymongo import MongoClient
from google import genai
import certifi

from safe_ats import process_ats_url, pre_filter_jobs, is_eligible_for_jobbuddy, normalize_job_classification

load_dotenv(os.path.join(os.path.dirname(__file__), '.env'))
load_dotenv()

# ── Configuration ──────────────────────────────────────────────────────────────
GEMINI_API_KEY = os.getenv("GEMINI_API_KEY")
MONGODB_URI    = os.getenv("MONGODB_URI")
URLS_FILE      = os.path.join(os.path.dirname(__file__), "urls.txt")

# Both models share the same free-tier limits: 15 RPM, 500 RPD, 250K TPM
GEMINI_MODELS = [
    "gemini-3.5-flash-lite",   # Model A (primary)
    "gemini-3.1-flash-lite",   # Model B (fallback)
]
RPM_LIMIT = 15          # Per-model per-minute limit
RPD_LIMIT = 500         # Per-model per-day limit
GEMINI_CHUNK_SIZE   = 50  # Max jobs per Gemini API call (prevents Payload Too Large)
MAX_CHUNKS_PER_SITE = 4   # Max 4 chunks (200 jobs) per site to prevent runner bottlenecks


# ── Helpers ────────────────────────────────────────────────────────────────────
def get_target_urls():
    if not os.path.exists(URLS_FILE):
        return []
    
    with open(URLS_FILE, 'r', encoding='utf-8') as f:
        urls = [line.strip() for line in f if line.strip() and not line.startswith('#')]
    
    # Modulo Sharding for GH Actions Matrix Scaling
    chunk_index = int(os.getenv("CHUNK_INDEX", "0"))
    total_chunks = int(os.getenv("TOTAL_CHUNKS", "1"))
    
    if total_chunks > 1:
        sharded_urls = [u for i, u in enumerate(urls) if i % total_chunks == chunk_index]
        print(f"  [Matrix] Sharding enabled: Processing chunk {chunk_index+1}/{total_chunks}")
        return sharded_urls
        
    return urls


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
                        continue
                    else:
                        raise

            # Both models are exhausted — wait for minute to reset
            print(f"  ⏳ Both models rate limited. Sleeping 65s… (attempt {global_attempt+1}/{max_global_retries})")
            time.sleep(65)
            for m in self.models:
                self._stats[m]["minute_count"] = 0
                self._stats[m]["minute_start"] = time.time()

        raise RuntimeError("All models exhausted after max retries.")


def make_job_id(company: str, title: str, link: str) -> str:
    """Stable unique ID for deduplication via upsert."""
    clean_company = re.sub(r'[\s\-_]+', ' ', company.lower()).strip()
    clean_title = re.sub(r'[\s\-_]+', ' ', title.lower()).strip()
    clean_link = str(link or '').strip().rstrip('/')
    if clean_link and clean_link != '#':
        raw = f"{clean_company}|{clean_link}"
    else:
        raw = f"{clean_company}|{clean_title}"
    return hashlib.sha256(raw.encode()).hexdigest()

def now_iso():
    return datetime.now(timezone.utc).isoformat()


# ── Gemini Extraction ──────────────────────────────────────────────────────────
GEMINI_PROMPT_TEMPLATE = """
You are a strict job-listing extractor. Your sole purpose is to identify
genuine entry-level / no-experience-required tech job openings.

──────────────────────────────────────────
TASK: Extract qualifying job listings from the raw data below.

STRICT RULES — follow exactly:

1. EXPERIENCE GATE — the most important rule:
   REJECT any job that requires work experience, internships, or any years on the job.
   This includes "1+ year preferred", "some experience helpful", "junior with 2 years", etc.
   ONLY include jobs that are explicitly labelled OR clearly intended for:
     fresher | entry-level | new grad | trainee | associate | graduate hire
     | 0 years | 0–1 years | no experience required | campus hire
   When in doubt about experience requirements → EXCLUDE the job.

2. WORK AUTHORIZATION & CITIZENSHIP GATE:
   REJECT any job that requires active government security clearance, domestic citizenship (e.g., US/UK citizen only),
   or explicitly states "no visa sponsorship", "must be authorized without sponsorship", or "permanent right to work required".
   Do NOT include jobs that foreign candidates cannot legally apply to.

3. SKIP generic career homepages: If a link goes to a root careers page with no
   role/department filter → do NOT include it.

4. Assign experience_verdict for each included job:
   - "SAFE"     — the posting explicitly and unambiguously states no experience required
                  (e.g., "Freshers only", "0 years", "Entry-level, no prior exp needed")
   - "POSSIBLE" — the posting is likely entry-level but does not explicitly say so
                  (e.g., title is "Junior Developer" with no stated requirements)

5. For each valid job, determine link_type:
   - "direct_apply":  URL leads directly to ONE specific individual job requisition (e.g. 'Associate Software Engineer', 'Junior QA Analyst').
   - "filtered_list": URL leads to a company program, university cohort, talent network, or early-careers portal (e.g. 'Emerging Talent Program', 'Graduate Cohort', 'Campus Hiring 2026', 'Early Talent Program', or pre-filtered listings page).

6. Assign category (pick ONE):
   software_engineering | data_ml | devops_cloud | cybersecurity | product_design | other
   CRITICAL: Do NOT assign 'early_careers' — all jobs on JobBuddy are already early careers!
   Always categorize by the functional technical discipline:
   - 'Software Engineer Intern' or 'QA Trainee' -> software_engineering
   - 'Data Analyst Intern' or 'AI Trainee' -> data_ml
   - 'Cloud Associate' or 'SRE Trainee' -> devops_cloud
   - 'Security Analyst Intern' -> cybersecurity
   - 'Product Design Intern' or 'UI/UX Trainee' -> product_design
   - General company portals/programs with no single tech focus -> other

7. Extract company_name accurately.

8. Return ONLY a valid JSON array. Each element must have exactly these keys:
   "title", "company_name", "location", "core_requirements", "link",
   "link_type", "category", "experience_verdict"

   - "core_requirements": 1 short factual sentence listing the required tech stack, programming languages, 
                          degree, or critical technical skills (e.g., 'Python, React, SQL, and B.Tech in CS'). 
                          DO NOT include reasoning or explanations of the experience verdict here.
                          Use empty string if the posting states no specific technical requirements.
   - All links must be absolute URLs.
   - If no valid jobs found → return []
   - IF the raw data appears to be a CAPTCHA, Cloudflare challenge, Access Denied, or a generic
     homepage/video page instead of a careers portal, return EXACTLY:
     [{{"error_type": "site_blocked_or_invalid"}}]

RAW DATA TO EVALUATE:
{raw_data}
"""

def extract_jobs_with_gemini(raw_data: str, url: str, pool: ModelPool, base_url: str = "") -> list[dict]:
    """Extract 0-experience jobs using Gemini. Purely experience-gated."""
    if not GEMINI_API_KEY or not raw_data:
        return []

    prompt = GEMINI_PROMPT_TEMPLATE.format(raw_data=raw_data)
    
    try:
        text = pool.generate(prompt)
        jobs = json.loads(text)
        if not isinstance(jobs, list):
            return []
        jobs = [job for job in jobs if isinstance(job, dict)]
        resolve_url = base_url or url

        for job in jobs:
            job['source_url'] = url
            job['scraped_at'] = now_iso()
            if not job.get('company_name'):
                job['company_name'] = slug_to_company(url)

            # Deterministic normalization of link_type and category on the scraper side
            normalize_job_classification(job)

            job.setdefault('experience_verdict', 'POSSIBLE')
            job.setdefault('core_requirements', '')
            job.setdefault('location', '')

            if 'link' in job and job['link'] and not job['link'].startswith('http'):
                job['link'] = urllib.parse.urljoin(resolve_url, job['link'])
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
_mongo_client = None
_mongo_db     = None

def get_db():
    global _mongo_client, _mongo_db
    if _mongo_client is None:
        _mongo_client = MongoClient(
            MONGODB_URI,
            serverSelectionTimeoutMS=10000,
            socketTimeoutMS=30000,
            connectTimeoutMS=20000,
            maxIdleTimeMS=45000,
            maxPoolSize=5,
            tlsCAFile=certifi.where()
        )
        _mongo_db = _mongo_client.job_aggregator
    return _mongo_db

def create_indexes():
    """Ensure optimal indexes exist. Safe to call on every startup (idempotent)."""
    try:
        db = get_db()
        db.jobs.create_index("job_id",      unique=True,  background=True)
        db.jobs.create_index("category",                 background=True)
        db.jobs.create_index("company_name",             background=True)
        db.jobs.create_index("ats_name",                 background=True)
        db.site_stats.create_index("url",                background=True)
        db.jobs.create_index("scraped_at", expireAfterSeconds=2592000, background=True)
        db.site_stats.create_index("run_date", expireAfterSeconds=1209600, background=True)
        print("  ✓ MongoDB indexes (with TTL) verified.")
    except Exception as e:
        print(f"  ⚠ Index creation warning: {e}")

def slug_to_company(url: str) -> str:
    """Best-effort company name from an ATS API URL or path."""
    m = re.search(r'/boards/([^/]+)/jobs', url)
    if m: return m.group(1).replace('-', ' ').title()
    m = re.search(r'/postings/([^/?]+)', url)
    if m: return m.group(1).replace('-', ' ').title()
    m = re.search(r'/job-board/([^/?]+)', url)
    if m: return m.group(1).replace('-', ' ').title()
    m = re.search(r'smartrecruiters\.com/(?:careers/|v1/companies/)?([^/?#]+)', url)
    if m: return m.group(1).replace('-', ' ').title()
    m = re.search(r'https://([a-zA-Z0-9\-]+)\.[^/]+myworkdayjobs\.com', url)
    if m: return m.group(1).replace('-', ' ').title()
    m = re.search(r'https?://(?:www\.)?([a-zA-Z0-9-]+)\.', url)
    if m: return m.group(1).replace('-', ' ').title()
    return ''

def upsert_jobs(jobs: list[dict], ats_name: str = '') -> int:
    """Upsert jobs — update existing, insert new. Returns count saved."""
    if not jobs or not MONGODB_URI:
        return 0
    saved = 0
    try:
        db = get_db()
        collection = db.jobs
        for job in jobs:
            ok, reason = is_eligible_for_jobbuddy(job)
            if not ok:
                continue
            normalize_job_classification(job)
            company = job.get('company_name', '')
            title   = job.get('title', '')
            link    = str(job.get('link', '') or '').strip()
            job_id  = make_job_id(company, title, link)
            job['job_id']  = job_id
            job['ats_name'] = ats_name

            # Canonical deduplication: match on unique URL if present, or job_id
            existing = None
            if link and link != '#':
                existing = collection.find_one({"link": link})
            if not existing:
                existing = collection.find_one({"job_id": job_id})

            if existing:
                collection.update_one(
                    {"_id": existing["_id"]},
                    {"$set": {k: v for k, v in job.items() if k != 'first_seen'}}
                )
                saved += 1
            else:
                job['first_seen'] = now_iso()
                collection.insert_one(job)
                saved += 1
    except Exception as e:
        print(f"  ✗ MongoDB upsert error: {e}")
    return saved

def record_site_stats(url: str, fetch_success: bool, fetch_time_ms: int,
                      jobs: list[dict], error: str | None,
                      ats_name: str = 'ATS API',
                      jobs_seen: int = 0,
                      jobs_prefiltered: int = 0,
                      jobs_gemini_kept: int = 0):
    """Write rich performance metrics per URL visit to site_stats collection."""
    if not MONGODB_URI:
        return
    link_types = {}
    for j in jobs:
        lt = j.get('link_type', 'unknown')
        link_types[lt] = link_types.get(lt, 0) + 1

    stat = {
        "url":                  url,
        "company_name":         slug_to_company(url),
        "ats_name":             ats_name,
        "run_date":             now_iso(),
        "fetch_success":        fetch_success,
        "fetch_time_ms":        fetch_time_ms,
        "jobs_seen":            jobs_seen,
        "jobs_prefiltered":     jobs_prefiltered,
        "jobs_gemini_kept":     jobs_gemini_kept,
        "quality_jobs_saved":   len(jobs),
        "link_types":           link_types,
        "error":                error,
    }
    try:
        db = get_db()
        db.site_stats.insert_one(stat)
    except Exception as e:
        print(f"  ⚠ Could not write site_stats: {e}")


# ── Main Engine ────────────────────────────────────────────────────────────────
def main():
    print("═" * 60)
    print("  JobBuddy Scraper v3 — High-Speed ATS Engine Starting")
    print("═" * 60)

    if not GEMINI_API_KEY:
        print("  ✗ FATAL: GEMINI_API_KEY is not set.")
        return
    if not MONGODB_URI:
        print("  ✗ FATAL: MONGODB_URI is not set.")
        return

    urls = get_target_urls()
    print(f"  Loaded {len(urls)} target URLs.")
    print(f"  Models: {GEMINI_MODELS[0]} (primary) + {GEMINI_MODELS[1]} (fallback)")
    print(f"  Rate limits: {RPM_LIMIT} RPM · {RPD_LIMIT} RPD per model\n")

    create_indexes()
    pool = ModelPool(api_key=GEMINI_API_KEY, models=GEMINI_MODELS)
    total_jobs_saved = 0
    start_time = time.time()
    MAX_RUNTIME_SECONDS = 80 * 60

    for i, url in enumerate(urls, 1):
        if time.time() - start_time > MAX_RUNTIME_SECONDS:
            print("  [FAIL-SAFE] Approaching time limit (80m). Shutting down gracefully...")
            break
            
        print(f"\n[{i}/{len(urls)}] {url}")

        # 1. ATS API ROUTER
        is_api, api_jobs, ats_name = process_ats_url(url)
        
        if not is_api:
            print(f"  ⚠ Unsupported URL format (no ATS router matched): {url}")
            record_site_stats(url, False, 0, [], "Unsupported URL format - no ATS API matched", ats_name="Unknown")
            continue

        print(f"  ⚡ ATS: {ats_name} API")
        fetch_start = time.time()
        jobs_seen = len(api_jobs)
        
        if not api_jobs:
            print(f"  → 0 total open roles found via {ats_name} API.")
            record_site_stats(url, True, int((time.time() - fetch_start) * 1000), [], None,
                              ats_name=ats_name, jobs_seen=0)
            continue
            
        filtered = pre_filter_jobs(api_jobs)
        fetch_time_ms = int((time.time() - fetch_start) * 1000)
        print(f"  → Fetched {jobs_seen} jobs in {fetch_time_ms}ms. Pre-filtered to {len(filtered)} tech/junior candidates.")
        
        if not filtered:
            record_site_stats(url, True, fetch_time_ms, [], None,
                              ats_name=ats_name, jobs_seen=jobs_seen, jobs_prefiltered=0)
            continue
            
        # 2. Strict Experience Evaluation with Gemini (Chunked)
        jobs = []
        chunks_processed = 0
        for j in range(0, len(filtered), GEMINI_CHUNK_SIZE):
            if chunks_processed >= MAX_CHUNKS_PER_SITE:
                print(f"  ℹ Reached max evaluation cap ({MAX_CHUNKS_PER_SITE * GEMINI_CHUNK_SIZE} jobs) for this site.")
                break
            chunk = filtered[j:j + GEMINI_CHUNK_SIZE]
            raw_data_for_gemini = json.dumps(chunk, indent=2)
            chunk_jobs = extract_jobs_with_gemini(raw_data_for_gemini, url, pool)
            jobs.extend(chunk_jobs)
            chunks_processed += 1

        # 3. Deterministic Eligibility Gate & Save
        error_jobs = [j for j in jobs if "error_type" in j]
        real_jobs  = [j for j in jobs if "error_type" not in j]

        eligible_jobs = []
        for rj in real_jobs:
            ok, reason = is_eligible_for_jobbuddy(rj)
            if ok:
                eligible_jobs.append(rj)
            else:
                print(f"  ⊘ Filtered out '{rj.get('title')}' ({rj.get('location')}): {reason}")

        jobs_gemini_kept = len(real_jobs)
        
        if error_jobs and not eligible_jobs:
            issue = error_jobs[0].get("error_type")
            print(f"  ⚠ Gemini returned site error: {issue}")
            record_site_stats(url, True, fetch_time_ms, [], error=f"Gemini: {issue}",
                              ats_name=ats_name, jobs_seen=jobs_seen,
                              jobs_prefiltered=len(filtered), jobs_gemini_kept=0)
        elif not eligible_jobs:
            print(f"  → 0 valid 0-experience jobs extracted (post-Gemini)")
            record_site_stats(url, True, fetch_time_ms, [], None,
                              ats_name=ats_name, jobs_seen=jobs_seen,
                              jobs_prefiltered=len(filtered), jobs_gemini_kept=0)
        else:
            saved = upsert_jobs(eligible_jobs, ats_name=ats_name)
            total_jobs_saved += saved
            print(f"  ✓ {len(eligible_jobs)} jobs eligible, {saved} upserted to DB")
            record_site_stats(url, True, fetch_time_ms, eligible_jobs, None,
                              ats_name=ats_name, jobs_seen=jobs_seen,
                              jobs_prefiltered=len(filtered), jobs_gemini_kept=jobs_gemini_kept)

        time.sleep(3)

    print(f"\n{'═'*60}")
    print(f"  Run complete. {total_jobs_saved} total jobs saved/updated.")
    print(f"  Model A ({GEMINI_MODELS[0]}) used: {pool._stats[GEMINI_MODELS[0]]['day_count']} requests")
    print(f"  Model B ({GEMINI_MODELS[1]}) used: {pool._stats[GEMINI_MODELS[1]]['day_count']} requests")
    print(f"{'═'*60}\n")

if __name__ == "__main__":
    main()
