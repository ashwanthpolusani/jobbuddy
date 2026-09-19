import re
import json
import urllib.request
from urllib.error import URLError, HTTPError

def extract_slug(url: str, platform: str) -> str | None:
    """Extracts the company slug from a Greenhouse or Lever URL."""
    try:
        if platform == "greenhouse":
            # e.g. https://boards.greenhouse.io/stripe/jobs/123 -> stripe
            match = re.search(r'boards\.greenhouse\.io/([^/]+)', url)
            return match.group(1) if match else None
        elif platform == "lever":
            # e.g. https://jobs.lever.co/netflix/123 -> netflix
            match = re.search(r'jobs\.lever\.co/([^/]+)', url)
            return match.group(1) if match else None
    except Exception:
        return None
    return None

def fetch_greenhouse_jobs(slug: str) -> list[dict]:
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
    except Exception as e:
        print(f"    [Greenhouse API Error] {e}")
        return []

def fetch_lever_jobs(slug: str) -> list[dict]:
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
    if "boards.greenhouse.io" in url:
        slug = extract_slug(url, "greenhouse")
        if slug:
            return True, fetch_greenhouse_jobs(slug), "Greenhouse"
            
    elif "jobs.lever.co" in url:
        slug = extract_slug(url, "lever")
        if slug:
            return True, fetch_lever_jobs(slug), "Lever"
            
    elif "/api/apply/v2/jobs" in url:
        return True, fetch_eightfold_jobs(url), "Eightfold"
            
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

    return False, [], "Unknown"

