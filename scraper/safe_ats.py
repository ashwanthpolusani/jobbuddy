import re
import json
import urllib.request
import urllib.parse
from urllib.error import URLError, HTTPError

def extract_slug(url: str, ats: str) -> str | None:
    """Extracts the company slug from a known ATS url."""
    try:
        if ats == "greenhouse":
            # Check for direct API links first
            api_match = re.search(r'boards-api\.greenhouse\.io/v1/boards/([^/?#]+)', url)
            if api_match:
                return api_match.group(1)
            # Check for standard links
            match = re.search(r'greenhouse\.io/([^/?#]+)', url)
            if match:
                slug = match.group(1)
                # Sometimes the url is greenhouse.io/embed/job_board?for=company
                if slug == 'embed':
                    qs = urllib.parse.parse_qs(urllib.parse.urlparse(url).query)
                    return qs.get('for', [None])[0]
                return slug
        elif ats == "lever":
            api_match = re.search(r'api\.lever\.co/v0/postings/([^/?#]+)', url)
            if api_match:
                return api_match.group(1)
            match = re.search(r'lever\.co/([^/?#]+)', url)
            if match:
                return match.group(1)
        elif ats == "ashby":
            api_match = re.search(r'api\.ashbyhq\.com/posting-api/job-board/([^/?#]+)', url)
            if api_match:
                return api_match.group(1)
            match = re.search(r'ashbyhq\.com/([^/?#]+)', url)
            if match:
                return match.group(1)
        elif ats == "smartrecruiters":
            match = re.search(r'smartrecruiters\.com/(?:v1/companies/)?([^/?#]+)', url)
            if match:
                token = match.group(1)
                if token not in ('v1', 'companies', 'jobs', 'postings'):
                    return token
        elif ats == "workable":
            m1 = re.search(r'([a-zA-Z0-9\-]+)\.workable\.com', url)
            if m1 and m1.group(1) not in ('apply', 'www', 'jobs', 'api'):
                return m1.group(1)
            m2 = re.search(r'workable\.com/(?:api/v\d+/widget/accounts/)?([a-zA-Z0-9\-]+)', url)
            if m2 and m2.group(1) not in ('api', 'widget', 'accounts', 'jobs'):
                return m2.group(1)
    except Exception:
        return None
    return None

def extract_workday_params(url: str) -> tuple[str, str, str] | None:
    """
    Extracts (tenant, domain, site_name) from a Workday URL.
    Returns None if not a valid workday URL.
    """
    # e.g., https://visa.wd5.myworkdayjobs.com/Visa -> domain: visa.wd5.myworkdayjobs.com, tenant: visa, site: Visa
    # e.g., https://visa.wd5.myworkdayjobs.com/en-US/Visa -> site: Visa
    match = re.search(r'https://([a-zA-Z0-9\-]+)\.([^/]+myworkdayjobs\.com)/(?:[a-zA-Z]{2}-[a-zA-Z]{2}/)?([^/]+)', url)
    if not match:
        return None
    tenant = match.group(1)
    domain = f"{tenant}.{match.group(2)}"
    site = match.group(3)
    # Ignore job-specific paths if present
    if site.startswith('job') or site.startswith('login'):
        return None
    return (tenant, domain, site)

def fetch_ashby_jobs(slug: str) -> list[dict] | None:
    """Fetches and normalizes Ashby jobs via their public API."""
    api_url = f"https://api.ashbyhq.com/posting-api/job-board/{slug}"
    try:
        req = urllib.request.Request(api_url, headers={'User-Agent': 'Mozilla/5.0'})
        with urllib.request.urlopen(req, timeout=10) as response:
            data = json.loads(response.read().decode('utf-8'))
            jobs = data.get('jobs', [])
            
            normalized = []
            for j in jobs:
                normalized.append({
                    "title": j.get('title', 'Unknown Title'),
                    "location": j.get('location', 'Unknown Location'),
                    "link": j.get('jobUrl', ''),
                    "content": j.get('descriptionPlain', '')
                })
            return normalized
    except HTTPError as e:
        print(f"    [Ashby API Blocked or Missing for {slug}] HTTP {e.code}")
        return None
    except Exception as e:
        print(f"    [Ashby API Error] {e}")
        return []

def fetch_greenhouse_jobs(slug: str) -> list[dict] | None:
    """Fetches all jobs from Greenhouse public API, with EU endpoint fallback."""
    urls = [
        f"https://boards-api.greenhouse.io/v1/boards/{slug}/jobs?content=true",
        f"https://job-boards.eu.greenhouse.io/{slug}/jobs"
    ]
    for url in urls:
        try:
            req = urllib.request.Request(url, headers={'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)'})
            with urllib.request.urlopen(req, timeout=10) as response:
                data = json.loads(response.read().decode('utf-8'))
                jobs = data.get('jobs', [])
                
                # Normalize to a common format
                normalized = []
                for j in jobs:
                    loc = j.get('location', {}).get('name', '')
                    title = j.get('title', '')
                    normalized.append({
                        "title": title,
                        "location": loc,
                        "link": j.get('absolute_url', ''),
                        "content": j.get('content', '') # raw html of job
                    })
                return normalized
        except HTTPError as e:
            if e.code == 404:
                continue
            print(f"    [Greenhouse API Blocked or Missing for {slug}] HTTP {e.code}")
            return None
        except Exception as e:
            print(f"    [Greenhouse API Error] {e}")
            return []
    return None

def fetch_lever_jobs(slug: str) -> list[dict] | None:
    """Fetches all jobs from Lever public API."""
    url = f"https://api.lever.co/v0/postings/{slug}?mode=json"
    headers = {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'application/json, text/plain, */*'
    }
    try:
        req = urllib.request.Request(url, headers=headers)
        with urllib.request.urlopen(req, timeout=12) as response:
            jobs = json.loads(response.read().decode('utf-8'))
            
            normalized = []
            for j in jobs:
                loc = j.get('categories', {}).get('location', '')
                title = j.get('text', '')
                normalized.append({
                    "title": title,
                    "location": loc,
                    "link": j.get('hostedUrl', ''),
                    "content": j.get('descriptionPlain', '')
                })
            return normalized
    except Exception as e:
        print(f"    [Lever API Error] {e}")
        return []

def fetch_eightfold_jobs(base_url: str) -> list[dict]:
    """Fetches all jobs from Eightfold API by automatically looping through pages."""
    # Strip any user-provided pagination to be safe
    base_url = re.sub(r'[?&]start=[^&]+', '', base_url)
    base_url = re.sub(r'[?&]num=[^&]+', '', base_url)
    
    separator = '&' if '?' in base_url else '?'
    
    all_jobs = []
    start = 0
    num = 10
    max_pages = 100  # Safety cap: ~1000 jobs max
    page = 0
    
    try:
        while page < max_pages:
            fetch_url = f"{base_url}{separator}start={start}&num={num}"
            req = urllib.request.Request(fetch_url, headers={'User-Agent': 'Mozilla/5.0'})
            with urllib.request.urlopen(req, timeout=10) as response:
                data = json.loads(response.read().decode('utf-8'))
                
                positions = data.get('positions', [])
                if not positions:
                    break
                    
                for p in positions:
                    all_jobs.append({
                        "title": p.get('name', ''),
                        "location": p.get('location', ''),
                        "link": p.get('canonicalPositionUrl', ''),
                        "content": "" # Eightfold list API doesn't include full descriptions
                    })
                
                start += num
                page += 1
                if start >= data.get('count', 0):
                    break
    except Exception as e:
        print(f"    [Eightfold API Error] {e}")
        
    return all_jobs

def fetch_workday_jobs(url: str) -> list[dict]:
    """Fetches all jobs from Workday public API by automatically looping through pages."""
    params = extract_workday_params(url)
    if not params:
        return []
        
    tenant, domain, site = params
    api_url = f"https://{domain}/wday/cxs/{tenant}/{site}/jobs"
    
    headers = {
        'Accept': 'application/json',
        'Content-Type': 'application/json',
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
    }
    
    all_jobs = []
    offset = 0
    limit = 20
    max_pages = 50  # Safety cap: ~1000 jobs max
    page = 0
    
    try:
        while page < max_pages:
            data = json.dumps({'limit': limit, 'offset': offset}).encode('utf-8')
            req = urllib.request.Request(api_url, data=data, headers=headers, method='POST')
            
            with urllib.request.urlopen(req, timeout=15) as response:
                resp_data = json.loads(response.read().decode('utf-8'))
                postings = resp_data.get('jobPostings', [])
                
                if not postings:
                    break
                    
                for p in postings:
                    title = p.get('title', '')
                    loc = p.get('locationsText', '')
                    ext_path = p.get('externalPath', '')
                    full_link = f"https://{domain}/en-US/{site}{ext_path}"
                    
                    all_jobs.append({
                        "title": title,
                        "location": loc,
                        "link": full_link,
                        "content": "" # Workday list API doesn't include full descriptions
                    })
                
                offset += limit
                page += 1

    except Exception as e:
        print(f"    [Workday API Error] {e}")
        
    return all_jobs

def fetch_mynexthire_jobs(domain: str) -> list[dict]:
    """Fetches all jobs from MyNextHire (e.g. Swiggy) public API."""
    api_url = f"https://{domain}/employer/careers/reqlist/get"
    
    headers = {
        'Accept': 'application/json, text/plain, */*',
        'Content-Type': 'application/json;charset=UTF-8',
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
    }
    
    # MyNextHire returns all jobs in a single request with this payload
    payload = {"source": "careers", "code": "", "filterByBuId": -1}
    data = json.dumps(payload).encode('utf-8')
    
    all_jobs = []
    try:
        req = urllib.request.Request(api_url, data=data, headers=headers, method='POST')
        with urllib.request.urlopen(req, timeout=15) as response:
            resp_data = json.loads(response.read().decode('utf-8'))
            jobs_list = resp_data.get('reqDetailsBOList', [])
            
            for j in jobs_list:
                all_jobs.append({
                    "title": j.get('reqTitle', ''),
                    "location": j.get('location', ''),
                    # Reconstruct the direct apply link based on typical MyNextHire routing
                    "link": f"https://{domain}/employer/jobs/careers?category={j.get('reqId', '')}",
                    "content": ""
                })
    except Exception as e:
        print(f"    [MyNextHire API Error] {e}")
        
    return all_jobs

def fetch_workable_jobs(slug: str) -> list[dict] | None:
    """Fetches jobs from Workable public widget API."""
    url = f"https://apply.workable.com/api/v1/widget/accounts/{slug}"
    try:
        req = urllib.request.Request(url, headers={'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)'})
        with urllib.request.urlopen(req, timeout=12) as response:
            data = json.loads(response.read().decode('utf-8'))
            jobs = data.get('jobs', [])
            normalized = []
            for j in jobs:
                loc_parts = [p for p in [j.get('city', ''), j.get('country', '')] if p]
                loc = ', '.join(loc_parts) if loc_parts else 'Unknown'
                normalized.append({
                    "title": j.get('title', 'Unknown Title'),
                    "location": loc,
                    "link": j.get('url', ''),
                    "content": j.get('description', '')
                })
            return normalized
    except HTTPError as e:
        print(f"    [Workable API Blocked or Missing for {slug}] HTTP {e.code}")
        return None
    except Exception as e:
        print(f"    [Workable API Error for {slug}] {e}")
        return []

def fetch_smartrecruiters_jobs(token: str, country: str = "in") -> list[dict]:
    """
    Fetches jobs from SmartRecruiters public API.
    Handles pagination and filters by country if applicable.
    Quirk: SmartRecruiters returns HTTP 200 with totalFound: 0 on invalid company tokens.
    """
    headers = {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        'Accept': 'application/json'
    }
    all_jobs = []
    limit = 100
    offset = 0
    max_pages = 20  # Safety cap: ~2000 jobs max
    page = 0
    
    try:
        while page < max_pages:
            query_suffix = f"&country={country}" if country else ""
            api_url = f"https://api.smartrecruiters.com/v1/companies/{token}/postings?limit={limit}&offset={offset}{query_suffix}"
            req = urllib.request.Request(api_url, headers=headers)
            with urllib.request.urlopen(req, timeout=12) as response:
                data = json.loads(response.read().decode('utf-8'))
                total_found = data.get('totalFound', 0)
                
                # Quirk fix: if 0 jobs found with country filter, retry once without country filter
                if total_found == 0 and offset == 0 and country:
                    fallback_url = f"https://api.smartrecruiters.com/v1/companies/{token}/postings?limit={limit}&offset={offset}"
                    fallback_req = urllib.request.Request(fallback_url, headers=headers)
                    with urllib.request.urlopen(fallback_req, timeout=12) as fallback_resp:
                        data = json.loads(fallback_resp.read().decode('utf-8'))
                        total_found = data.get('totalFound', 0)
                        if total_found == 0:
                            break
                elif total_found == 0:
                    break
                    
                postings = data.get('content', [])
                if not postings:
                    break
                    
                for p in postings:
                    loc = p.get('location', {})
                    city = loc.get('city', '')
                    c_code = loc.get('country', '')
                    region = loc.get('region', '')
                    loc_parts = [part for part in [city, region, c_code] if part]
                    loc_str = ', '.join(loc_parts) if loc_parts else 'Unknown'
                    
                    job_id = p.get('id', '')
                    full_link = f"https://jobs.smartrecruiters.com/{token}/{job_id}"
                    
                    all_jobs.append({
                        "title": p.get('name', 'Unknown Title'),
                        "location": loc_str,
                        "link": full_link,
                        "content": ""  # SmartRecruiters list API returns summary metadata
                    })
                    
                offset += limit
                page += 1
                if offset >= total_found:
                    break
    except Exception as e:
        print(f"    [SmartRecruiters API Error for {token}] {e}")
        
    return all_jobs

def fetch_uber_jobs(query: str = "location=Bengaluru") -> list[dict]:
    """
    Fetches jobs from Uber's public careers API (jobs.uber.com/api/jobs/search).
    Automatically loops through pages and normalizes into standard schema.
    """
    headers = {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': '*/*',
        'Referer': 'https://jobs.uber.com/en/jobs/',
    }
    all_jobs = []
    
    # Extract query params if a full URL was provided
    if '?' in query:
        query_string = query.split('?', 1)[1]
    elif '=' in query:
        query_string = query
    else:
        query_string = f"location={query}" if query else "location=Bengaluru"

    # Strip existing page param to control pagination loop
    query_string = re.sub(r'[?&]page=\d+', '', query_string).strip('&')
    
    page = 1
    max_pages = 10
    try:
        while page <= max_pages:
            api_url = f"https://jobs.uber.com/api/jobs/search/?{query_string}&page={page}"
            req = urllib.request.Request(api_url, headers=headers)
            with urllib.request.urlopen(req, timeout=12) as response:
                data = json.loads(response.read().decode('utf-8'))
                jobs = data.get('jobs', [])
                if not jobs:
                    break
                for j in jobs:
                    cities = [loc.get('City') for loc in j.get('Locations', []) if loc.get('City')]
                    country = (j.get('Locations', [{}])[0].get('Country')) if j.get('Locations') else ''
                    loc_parts = cities + ([country] if country else [])
                    loc_str = ', '.join(loc_parts) if loc_parts else 'India'
                    
                    job_path = j.get('Urls', [{}])[0].get('Url', f"/en/jobs/{j.get('Id')}/")
                    all_jobs.append({
                        "title": j.get('Title', 'Unknown Title'),
                        "location": loc_str,
                        "link": f"https://jobs.uber.com{job_path}",
                        "content": j.get('Description', ''),
                        "id": str(j.get('Id', ''))
                    })
                total_pages = data.get('totalPages', 1)
                if page >= total_pages:
                    break
                page += 1
    except Exception as e:
        print(f"    [Uber API Error] {e}")

    return all_jobs

# ── Location & Visa Gate (Indian Candidate Eligibility) ────────────────────────
INDIAN_LOCATIONS = [
    'india', 'bangalore', 'bengaluru', 'hyderabad','hyd','warangal', 'pune', 'chennai', 'mumbai',
    'gurgaon', 'gurugram', 'noida', 'delhi', 'new delhi', 'kolkata', 'ahmedabad',
    'kochi', 'coimbatore', 'trivandrum', 'thiruvananthapuram', 'indore', 'jaipur',
    'chandigarh', 'mysore', 'bhubaneswar', 'karnataka', 'maharashtra', 'telangana',
    'tamil nadu', 'haryana', 'uttar pradesh', 'delhi ncr', 'ncr', 'hyd', 'blr',
    'navi mumbai', 'thane', 'nagpur', 'vadodara', 'surat', 'visakhapatnam'
]

INDIAN_LOC_REGEX = re.compile(
    r'\b(?:' + '|'.join(map(re.escape, INDIAN_LOCATIONS)) + r')\b|' +
    r'\bIN\s*-\s*[a-zA-Z]+|\bIndia\b',
    re.IGNORECASE
)

SPONSOR_REGEX = re.compile(
    r'\b(?:visa sponsorship|visa support|relocation assistance|relocation support|relocation package|'
    r'international relocation|relocation to japan|relocation provided|will sponsor|sponsors? visa|'
    r'sponsorship available|sponsorship provided|work visa|visa assistance)\b',
    re.IGNORECASE
)

RESTRICTED_REMOTE_REGEX = re.compile(
    r'\b(?:us|u\.s\.|usa|united states|canada|can|latin america|latam|colombia|brazil|peru|mexico|argentina|chile|costa rica|cri|uk|united kingdom|emea|europe|germany|france|spain|portugal|australia|nz|japan|china)\b|' +
    r'eastern time|pacific time|central time|\best\b|\bpst\b|\bcst\b|\bmst\b',
    re.IGNORECASE
)

CLEARANCE_REGEX = re.compile(
    r'security clearance|secret clearance|top secret|ts/sci|\bitar\b|us citizen|u\.s\. citizen|us citizenship|uk citizen|us persons only|us government|uk government|aus government',
    re.IGNORECASE
)

NO_SPONSOR_REGEX = re.compile(
    r'without sponsorship|no visa sponsorship|will not sponsor|cannot sponsor|unable to sponsor|not able to sponsor|permanent right to work|must be authorized to work',
    re.IGNORECASE
)

# ── Classification Rules (Link Type & Category) ───────────────────────────────

PROGRAM_PORTAL_REGEX = re.compile(
    r'\b(?:program|cohort|talent network|talent community|emerging talent|university interns?|campus recruitment|campus hiring|fresher portal|career opportunities|entry-level careers|early talent|graduate program|internship program|leadership development|rotational program|student careers)\b',
    re.IGNORECASE
)

DATA_ML_REGEX = re.compile(
    r'\b(?:data|machine learning|ml|ai|artificial intelligence|deep learning|analytics|analyst|data scientist|data science|bi analyst|business intelligence|mle|nlp|computer vision|llm|gen ai|data engineer)\b',
    re.IGNORECASE
)

DEVOPS_CLOUD_REGEX = re.compile(
    r'\b(?:devops|cloud|sre|site reliability|infrastructure|platform|aws|azure|gcp|kubernetes|docker|sysadmin|systems administrator|network engineer)\b',
    re.IGNORECASE
)

CYBERSECURITY_REGEX = re.compile(
    r'\b(?:security|cyber|infosec|information security|soc|vulnerability|penetration|pentest|iam|threat|incident response)\b',
    re.IGNORECASE
)

PRODUCT_DESIGN_REGEX = re.compile(
    r'\b(?:product manager|associate product manager|\bapm\b|product design|ux designer|ui designer|ui/ux|user experience|user interface|interaction design|graphic design|\bdesigner\b|game design)\b',
    re.IGNORECASE
)

SWE_REGEX = re.compile(
    r'\b(?:software|developer|engineer|engineering|sde|swe|sdet|frontend|front-end|backend|back-end|fullstack|full-stack|web|android|ios|mobile|qa|quality assurance|test|testing|tester|automation|programmer|coding|coder|firmware|embedded|systems engineer|java|python|c\+\+|react|node|golang)\b',
    re.IGNORECASE
)

VALID_CATEGORIES = {
    'software_engineering',
    'data_ml',
    'devops_cloud',
    'cybersecurity',
    'product_design',
    'other'
}

def normalize_job_classification(job: dict) -> dict:
    """
    Deterministically normalizes link_type and category on the scraper side
    before jobs are saved to MongoDB.

    1. Programs, cohorts, talent networks, university portals -> 'filtered_list' (Fresher Portals)
       Individual vacancies -> 'direct_apply'
    2. 'early_careers' is eliminated; maps to functional technical tracks:
       software_engineering | data_ml | devops_cloud | cybersecurity | product_design | other
    """
    title = str(job.get('title', '') or '')
    link = str(job.get('link', '') or '')
    reqs = str(job.get('core_requirements', '') or '')

    # 1. Deterministic Link Type Partition
    if PROGRAM_PORTAL_REGEX.search(title) or PROGRAM_PORTAL_REGEX.search(link):
        job['link_type'] = 'filtered_list'
    elif job.get('link_type') in ('filtered_list', 'career_homepage'):
        job['link_type'] = 'filtered_list'
    else:
        job['link_type'] = 'direct_apply'

    # 2. Deterministic Technical Category Partition
    cat = str(job.get('category', '') or '').strip().lower()

    if cat not in VALID_CATEGORIES or cat == 'early_careers' or cat == 'other':
        if CYBERSECURITY_REGEX.search(title) or CYBERSECURITY_REGEX.search(reqs):
            job['category'] = 'cybersecurity'
        elif DEVOPS_CLOUD_REGEX.search(title) or DEVOPS_CLOUD_REGEX.search(reqs):
            job['category'] = 'devops_cloud'
        elif DATA_ML_REGEX.search(title) or DATA_ML_REGEX.search(reqs):
            job['category'] = 'data_ml'
        elif PRODUCT_DESIGN_REGEX.search(title) or PRODUCT_DESIGN_REGEX.search(reqs):
            job['category'] = 'product_design'
        elif SWE_REGEX.search(title) or SWE_REGEX.search(reqs):
            job['category'] = 'software_engineering'
        else:
            job['category'] = 'other'
    else:
        job['category'] = cat

    return job

def is_eligible_for_jobbuddy(job: dict) -> tuple[bool, str]:
    """
    Ensures jobs align with JobBuddy's mission: Indian candidates with Indian passports,
    no pre-existing foreign visas.
    Accepted:
    1. Roles located in India (Bangalore, Hyderabad, Pune, Gurugram, etc.).
    2. Roles explicitly providing international relocation assistance or visa sponsorship.
    3. Genuine worldwide / global remote roles (not restricted to US/EU/LATAM/Canada).

    Rejected:
    1. US/UK/Foreign domestic roles with no visa sponsorship.
    2. Roles requiring domestic citizenship, government defense clearance, or ITAR.
    3. Explicit 'No visa sponsorship' / 'Must be authorized without sponsorship' clauses.
    4. Region-locked remote roles (e.g., 'Colombia, Remote', 'US Remote').
    """
    loc = str(job.get('location', '') or '')
    title = str(job.get('title', '') or '')
    reqs = str(job.get('core_requirements', '') or '')
    combined = f"{title} {loc} {reqs}".lower()

    # 1. Hard Rejection: Security clearance, government defense, or domestic citizenship
    if CLEARANCE_REGEX.search(combined):
        return False, "Requires government/defense security clearance or domestic citizenship"

    # 2. Hard Rejection: Explicit no-visa sponsorship
    if NO_SPONSOR_REGEX.search(combined):
        return False, "Explicitly states no visa sponsorship or domestic right to work required"

    # 3. Acceptance: India-based location
    if INDIAN_LOC_REGEX.search(loc) or INDIAN_LOC_REGEX.search(title):
        return True, "India-based location"

    # 4. Acceptance: Explicit international relocation / visa sponsorship
    if SPONSOR_REGEX.search(combined):
        return True, "Explicit international relocation or visa sponsorship provided"

    # 4b. Acceptance / Hold for Stage 2: Japan tech roles pending JD evaluation
    # If a role is in Japan and we don't have the full JD text yet (pre-filter stage),
    # let it pass to Stage 2 so Stage 2 can inspect the full JD for visa sponsorship.
    if re.search(r'\b(?:japan|tokyo|kyoto|osaka|yokohama)\b', combined):
        if len(reqs) < 100:
            return True, "Japan tech role pending Stage 2 visa verification"

    # 5. Check Remote eligibility
    if 'remote' in loc.lower() or 'remote' in title.lower() or loc.strip().lower() in ['global', 'anywhere', 'worldwide']:
        if RESTRICTED_REMOTE_REGEX.search(loc):
            return False, f"Region-locked remote role ({loc})"
        return True, "Worldwide Remote"

    # 6. Default: Reject foreign domestic role without visa sponsorship
    return False, f"Foreign domestic role without verified visa sponsorship ({loc})"

def pre_filter_jobs(jobs: list[dict]) -> list[dict]:
    """
    Filters a massive list of ATS jobs down to tech and early-career candidate roles
    before sending them to Gemini (saving tokens and runtime).
    """
    good_roles = []
    # Broad keywords to catch tech roles
    tech_keywords = [
        'software', 'developer', 'engineer', 'engineering', 'data', 'analyst', 'security', 
        'cloud', 'sre', 'devops', 'product', 'frontend', 'backend', 'fullstack', 
        'machine learning', 'ml', 'ai', 'artificial intelligence', 'qa', 'test', 'tester', 
        'automation', 'it', 'systems', 'network', 'web', 'mobile', 'ios', 'android', 
        'ui', 'ux', 'design', 'research', 'programmer', 'coder', 'database',
        'sde', 'swe', 'sdet', 'mle', 'quant', 'quantitative', 'firmware', 'hardware', 'embedded',
        'security', 'cyber', 'infosec', 'data scientist', 'science', 'scientist'
    ]
    # Keywords to catch early career & campus hiring across global tech platforms
    fresher_keywords = [
        'intern', 'internship', 'new grad', 'graduate', 'fresher', 'junior', 'entry',
        'apprentice', 'apprenticeship', 'trainee', 'campus', 'early career', 'early talent',
        'rotational'
    ]
    # Explicit non-technical domain exclusions
    non_tech_pattern = (
        r'\b(?:hr|human resources|recruiter|recruiting|talent acquisition|payroll|'
        r'sales|account executive|\bbdr\b|\bsdr\b|business development representative|'
        r'legal|counsel|paralegal|compliance officer|accountant|accounting|'
        r'cashier|cook|warehouse|driver|janitor)\b'
    )
    # Senior / leadership exclusions (including levels III, IV, V, Level 3+)
    senior_pattern = (
        r'\b(?:senior|staff|principal|lead|manager|director|vp|head|architect|'
        r'level [3-9]|level iii|level iv|level v|\biii\b|\biv\b|\bv\b)\b'
    )
    senior_regex = re.compile(senior_pattern, re.IGNORECASE)
    tech_regex = re.compile(r'\b(?:' + '|'.join(map(re.escape, tech_keywords)) + r')\b', re.IGNORECASE)
    fresher_regex = re.compile(r'\b(?:' + '|'.join(map(re.escape, fresher_keywords)) + r')\b', re.IGNORECASE)
    non_tech_regex = re.compile(non_tech_pattern, re.IGNORECASE)

    for j in jobs:
        t = str(j.get('title') or '').lower()
        if not t:
            continue

        # Must NOT be senior or high-level
        if senior_regex.search(t):
            continue

        # Must NOT be a non-technical role unless it specifically includes technical keywords
        is_tech = bool(tech_regex.search(t))
        if non_tech_regex.search(t) and not is_tech:
            continue

        # Must be tech-related OR an explicit early-career/trainee/campus posting
        is_fresher = bool(fresher_regex.search(t))
        if not (is_tech or is_fresher):
            continue

        # Location & Visa Gate (Indian Candidate Eligibility)
        loc = str(j.get('location') or '').strip()
        if loc:
            check_job = dict(j)
            # Pass JD content sample to catch relocation or visa sponsorship in the description body
            if not check_job.get('core_requirements') and check_job.get('content'):
                check_job['core_requirements'] = check_job['content'][:2500]
            ok, _ = is_eligible_for_jobbuddy(check_job)
            if not ok:
                continue

        good_roles.append(j)

    # Sort early-career titles to the top so chunk-capped evaluations prioritize them
    good_roles.sort(key=lambda item: 0 if fresher_regex.search(item.get('title', '')) else 1)

    return good_roles

def process_ats_url(url: str) -> tuple[bool, list[dict], str]:
    """
    Determines if URL is a supported ATS. 
    Returns (is_supported, raw_jobs_list, ats_name)
    """
    if "greenhouse.io" in url:
        slug = extract_slug(url, "greenhouse")
        if slug:
            jobs = fetch_greenhouse_jobs(slug)
            if jobs is not None:
                return True, jobs, "Greenhouse"
            
    elif "lever.co" in url:
        slug = extract_slug(url, "lever")
        if slug:
            jobs = fetch_lever_jobs(slug)
            if jobs is not None:
                return True, jobs, "Lever"
                
    elif "ashbyhq.com" in url:
        slug = extract_slug(url, "ashby")
        if slug:
            jobs = fetch_ashby_jobs(slug)
            if jobs is not None:
                return True, jobs, "Ashby"
            
    elif "/api/apply/v2/jobs" in url:
        return True, fetch_eightfold_jobs(url), "Eightfold"

    elif ".mynexthire.com" in url:
        match = re.search(r'https://([^/]+\.mynexthire\.com)', url)
        if match:
            return True, fetch_mynexthire_jobs(match.group(1)), "MyNextHire"

    elif ".myworkdayjobs.com" in url:
        params = extract_workday_params(url)
        if params:
            return True, fetch_workday_jobs(url), "Workday"

    elif "smartrecruiters.com" in url:
        token = extract_slug(url, "smartrecruiters")
        if token:
            jobs = fetch_smartrecruiters_jobs(token)
            if jobs:
                return True, jobs, "SmartRecruiters"

    elif "jobs.uber.com" in url or "uber.com/api/jobs" in url:
        return True, fetch_uber_jobs(url), "Uber"

    elif "uber.com" in url:
        # Generic uber careers URL: fetch both Bengaluru and Hyderabad
        blr_jobs = fetch_uber_jobs("location=Bengaluru")
        hyd_jobs = fetch_uber_jobs("location=Hyderabad")
        seen = set()
        combined = []
        for j in blr_jobs + hyd_jobs:
            jid = j.get('id') or j.get('link')
            if jid not in seen:
                seen.add(jid)
                combined.append(j)
        return True, combined, "Uber"
            
    elif "workable.com" in url:
        slug = extract_slug(url, "workable")
        if slug:
            jobs = fetch_workable_jobs(slug)
            if jobs is not None:
                return True, jobs, "Workable"

    return False, [], "Unknown"

