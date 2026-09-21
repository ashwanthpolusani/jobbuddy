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
            api_match = re.search(r'boards-api\.greenhouse\.io/v1/boards/([^/]+)', url)
            if api_match:
                return api_match.group(1)
            # Check for standard links
            match = re.search(r'greenhouse\.io/([^/]+)', url)
            if match:
                slug = match.group(1)
                # Sometimes the url is greenhouse.io/embed/job_board?for=company
                if slug == 'embed':
                    qs = urllib.parse.parse_qs(urllib.parse.urlparse(url).query)
                    return qs.get('for', [None])[0]
                return slug
        elif ats == "lever":
            api_match = re.search(r'api\.lever\.co/v0/postings/([^/]+)', url)
            if api_match:
                return api_match.group(1)
            match = re.search(r'lever\.co/([^/]+)', url)
            if match:
                return match.group(1)
        elif ats == "ashby":
            api_match = re.search(r'api\.ashbyhq\.com/posting-api/job-board/([^/]+)', url)
            if api_match:
                return api_match.group(1)
            match = re.search(r'ashbyhq\.com/([^/]+)', url)
            if match:
                return match.group(1)
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
    """Fetches all jobs from Greenhouse public API."""
    url = f"https://boards-api.greenhouse.io/v1/boards/{slug}/jobs?content=true"
    try:
        req = urllib.request.Request(url, headers={'User-Agent': 'Mozilla/5.0'})
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
        print(f"    [Greenhouse API Blocked or Missing for {slug}] HTTP {e.code}")
        return None
    except Exception as e:
        print(f"    [Greenhouse API Error] {e}")
        return []

def fetch_lever_jobs(slug: str) -> list[dict] | None:
    """Fetches all jobs from Lever public API."""
    url = f"https://api.lever.co/v0/postings/{slug}?mode=json"
    try:
        req = urllib.request.Request(url, headers={'User-Agent': 'Mozilla/5.0'})
        with urllib.request.urlopen(req, timeout=10) as response:
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
    
    try:
        while True:
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

def pre_filter_jobs(jobs: list[dict]) -> list[dict]:
    """
    Filters a massive list of ATS jobs down to just software/fresher roles
    before we send them to Gemini (to save tokens/time).
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
    # Keywords to catch early career (we don't strictly require these, but they are strong signals)
    fresher_keywords = ['intern', 'new grad', 'graduate', 'fresher', 'junior', 'entry']
    # Negative keywords
    senior_keywords = ['senior', 'staff', 'principal', 'lead', 'manager', 'director', 'vp', 'head', 'architect']

    for j in jobs:
        t = j['title'].lower()
        
        # Must be tech related (using regex word boundaries to safely match acronyms like 'it', 'qa', 'swe')
        if not re.search(r'\b(?:' + '|'.join(map(re.escape, tech_keywords)) + r')\b', t):
            continue
            
        # Must NOT be senior
        if re.search(r'\b(?:' + '|'.join(map(re.escape, senior_keywords)) + r')\b', t):
            continue
            
        good_roles.append(j)
            
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
            
    return False, [], "Unknown"

def process_html_for_ats(html: str) -> tuple[bool, list[dict], str]:
    """
    Scans raw HTML (or Markdown) to detect embedded ATS links.
    Returns (is_supported, raw_jobs_list, ats_name)
    """
    # 1. Check for Greenhouse links embedded in HTML
    # Example matches: href="https://boards.greenhouse.io/robinhood/jobs/..."
    gh_match = re.search(r'boards\.greenhouse\.io/([^/\"\'\?\>]+)', html)
    if gh_match:
        slug = gh_match.group(1)
        if slug.lower() not in ('jobs', 'v1'): # safety check against generic paths
            return True, fetch_greenhouse_jobs(slug), "Greenhouse"

    # 2. Check for Lever links embedded in HTML
    # Example matches: href="https://jobs.lever.co/netflix/..."
    lv_match = re.search(r'jobs\.lever\.co/([^/\"\'\?\>]+)', html)
    if lv_match:
        slug = lv_match.group(1)
        return True, fetch_lever_jobs(slug), "Lever"
        
    # 3. Check for MyNextHire links
    mnh_match = re.search(r'(https://[^/\"\'\?\>]+\.mynexthire\.com)', html)
    if mnh_match:
        domain = mnh_match.group(1).replace('https://', '')
        return True, fetch_mynexthire_jobs(domain), "MyNextHire"
        
    # 4. Check for Workday links embedded in HTML
    wd_match = re.search(r'(https://[a-zA-Z0-9\-]+\.[^/]+myworkdayjobs\.com/(?:[a-zA-Z]{2}-[a-zA-Z]{2}/)?[^/\"\'\?\>]+)', html)
    if wd_match:
        wd_url = wd_match.group(1)
        if not wd_url.endswith('/login'):
            return True, fetch_workday_jobs(wd_url), "Workday"

    return False, [], "Unknown"

