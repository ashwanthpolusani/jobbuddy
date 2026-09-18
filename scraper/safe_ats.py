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

def pre_filter_jobs(jobs: list[dict]) -> list[dict]:
    """
    Filters a massive list of ATS jobs down to just software/fresher roles
    before we send them to Gemini (to save tokens/time).
    """
    good_roles = []
    # Broad keywords to catch tech roles
    tech_keywords = ['software', 'developer', 'engineer', 'data', 'analyst', 'security', 'cloud', 'sre', 'devops', 'product']
    # Keywords to catch early career (we don't strictly require these, but they are strong signals)
    fresher_keywords = ['intern', 'new grad', 'graduate', 'fresher', 'junior', 'entry']
    # Negative keywords
    senior_keywords = ['senior', 'staff', 'principal', 'lead', 'manager', 'director', 'vp', 'head', 'architect', 'II', 'III']

    for j in jobs:
        t = j['title'].lower()
        
        # Must be tech related
        if not any(k in t for k in tech_keywords):
            continue
            
        # Must NOT be senior
        if any(k in t for k in senior_keywords):
            continue
            
        good_roles.append(j)
        
        # Cap at 15 to avoid blowing up the Gemini prompt
        if len(good_roles) >= 15:
            break
            
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
            
    return False, [], "Unknown"
