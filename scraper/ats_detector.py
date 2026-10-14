#!/usr/bin/env python3
"""
ATS Auto-Detector for Scrapperbuddy
Inspired by Babak-hasani/company-career-scraper.

Automatically discovers which ATS platform a company uses (Greenhouse, Lever,
Ashby, SmartRecruiters) by generating slug permutations and querying public APIs.
"""

import sys
import os
import re
import json
import socket
import argparse
import urllib.request
import urllib.parse
from urllib.error import HTTPError, URLError

# Set socket timeout so slow/unresponsive servers don't hang
socket.setdefaulttimeout(4)

USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
HEADERS = {'User-Agent': USER_AGENT, 'Accept': 'application/json, */*'}

# Top Indian tech companies, unicorns, and major tech employers
DEFAULT_TOP_INDIA_COMPANIES = [
    # Fintech & Payments
    "Razorpay", "CRED", "Groww", "PhonePe", "Paytm", "Pine Labs", "Slice", "Jupiter",
    "Navi", "Zerodha", "BharatPe", "CoinSwitch", "CoinDCX", "Digit Insurance",
    # E-commerce, Quick-Commerce & Logistics
    "Meesho", "Swiggy", "Zomato", "Zepto", "Blinkit", "Flipkart", "Urban Company",
    "Delhivery", "Shadowfax", "Porter", "Lenskart", "Nykaa", "Cars24", "Spinny",
    # SaaS, Enterprise & Dev Tools
    "Postman", "BrowserStack", "Hasura", "InMobi", "Druva", "Chargebee", "CleverTap",
    "Freshworks", "Icertis", "Gupshup", "Darwinbox", "Whatfix", "LeadSquared",
    "MoEngage", "WebEngage", "Harness", "Keka", "SignEasy", "Innovaccer",
    # Edtech, Gaming & Mobility
    "Ola", "Rapido", "Dream11", "Games24x7", "Mobile Premier League",
    # Global Tech with Large India Centers
    "Uber", "Agoda", "Atlassian", "Stripe", "Databricks", "Snowflake", "Twilio",
    "GitLab", "MongoDB", "Cloudflare", "Coinbase", "Grab", "GoTo", "Directi"
]

def generate_slug_candidates(name: str) -> list[str]:
    """Generates ~12 slug permutations for a given company name."""
    clean = re.sub(r'[^a-zA-Z0-9\s\-]', '', name).strip()
    words = clean.split()
    if not words:
        return []

    base = ''.join(words).lower()
    hyphen = '-'.join(words).lower()
    first_word = words[0].lower()

    candidates = [
        base,
        hyphen,
        first_word,
        f"{base}india",
        f"{base}-india",
        f"{base}tech",
        f"{base}technologies",
        f"{base}software",
        f"{base}hq",
        f"{base}labs",
        f"{base}inc",
        f"{first_word}india"
    ]

    # Preserve casing candidate for Ashby (case-sensitive)
    if len(words) == 1:
        candidates.append(name)
        candidates.append(name.capitalize())

    # Deduplicate while preserving order
    seen = set()
    unique = []
    for c in candidates:
        if c and c not in seen:
            seen.add(c)
            unique.append(c)
    return unique

def check_greenhouse(slug: str) -> dict | None:
    """Checks Greenhouse API (US and EU endpoints)."""
    endpoints = [
        ("Greenhouse", f"https://boards-api.greenhouse.io/v1/boards/{slug}/jobs?content=true"),
        ("Greenhouse (EU)", f"https://job-boards.eu.greenhouse.io/{slug}/jobs")
    ]
    for ats_label, url in endpoints:
        try:
            req = urllib.request.Request(url, headers=HEADERS)
            with urllib.request.urlopen(req, timeout=3) as resp:
                data = json.loads(resp.read().decode('utf-8'))
                jobs = data.get('jobs', [])
                if jobs:
                    return {
                        "ats": ats_label,
                        "token": slug,
                        "url": url,
                        "api_url": url,
                        "job_count": len(jobs),
                        "sample_title": jobs[0].get('title', '')
                    }
        except Exception:
            pass
    return None

def check_lever(slug: str) -> dict | None:
    """Checks Lever API."""
    url = f"https://api.lever.co/v0/postings/{slug}?mode=json"
    try:
        req = urllib.request.Request(url, headers=HEADERS)
        with urllib.request.urlopen(req, timeout=3) as resp:
            data = json.loads(resp.read().decode('utf-8'))
            if isinstance(data, list) and len(data) > 0:
                return {
                    "ats": "Lever",
                    "token": slug,
                    "url": f"https://jobs.lever.co/{slug}",
                    "api_url": url,
                    "job_count": len(data),
                    "sample_title": data[0].get('text', '')
                }
    except Exception:
        pass
    return None

def check_ashby(slug: str) -> dict | None:
    """Checks Ashby API (Note: tokens are case-sensitive)."""
    url = f"https://api.ashbyhq.com/posting-api/job-board/{slug}"
    try:
        req = urllib.request.Request(url, headers=HEADERS)
        with urllib.request.urlopen(req, timeout=3) as resp:
            data = json.loads(resp.read().decode('utf-8'))
            jobs = data.get('jobs', [])
            if jobs:
                return {
                    "ats": "Ashby",
                    "token": slug,
                    "url": f"https://jobs.ashbyhq.com/{slug}",
                    "api_url": url,
                    "job_count": len(jobs),
                    "sample_title": jobs[0].get('title', '')
                }
    except Exception:
        pass
    return None

def check_smartrecruiters(slug: str) -> dict | None:
    """Checks SmartRecruiters API (Requires totalFound > 0)."""
    url = f"https://api.smartrecruiters.com/v1/companies/{slug}/postings?limit=5"
    try:
        req = urllib.request.Request(url, headers=HEADERS)
        with urllib.request.urlopen(req, timeout=3) as resp:
            data = json.loads(resp.read().decode('utf-8'))
            total = data.get('totalFound', 0)
            if total > 0:
                content = data.get('content', [])
                sample = content[0].get('name', '') if content else ''
                return {
                    "ats": "SmartRecruiters",
                    "token": slug,
                    "url": f"https://careers.smartrecruiters.com/{slug}",
                    "api_url": url,
                    "job_count": total,
                    "sample_title": sample
                }
    except Exception:
        pass
    return None

def detect_ats_for_company(company_name: str) -> dict | None:
    """Probes all ATS platforms for a company using candidate slugs."""
    slugs = generate_slug_candidates(company_name)
    
    # Check each candidate slug against all 4 ATS
    for slug in slugs:
        # 1. Greenhouse
        res = check_greenhouse(slug)
        if res:
            res['company'] = company_name
            return res

        # 2. Lever
        res = check_lever(slug)
        if res:
            res['company'] = company_name
            return res

        # 3. Ashby
        res = check_ashby(slug)
        if res:
            res['company'] = company_name
            return res

        # 4. SmartRecruiters
        res = check_smartrecruiters(slug)
        if res:
            res['company'] = company_name
            return res

    return None

def run_detection(companies: list[str], add_to_urls: bool = False) -> list[dict]:
    """Runs ATS detection over a list of companies and prints progress."""
    print(f"\n🔍 Probing {len(companies)} companies across Greenhouse, Lever, Ashby, and SmartRecruiters...")
    print("=" * 80)
    
    results = []
    urls_file = os.path.join(os.path.dirname(__file__), "urls.txt")
    existing_urls = set()
    if os.path.exists(urls_file):
        with open(urls_file, "r", encoding="utf-8") as f:
            existing_urls = {line.strip() for line in f if line.strip() and not line.strip().startswith("#")}

    found_count = 0
    for idx, company in enumerate(companies, 1):
        print(f"[{idx:02d}/{len(companies):02d}] Checking {company:<20} ... ", end="", flush=True)
        match = detect_ats_for_company(company)
        if match:
            found_count += 1
            print(f"✅ {match['ats']} ({match['job_count']} jobs) -> {match['url']}")
            results.append(match)
            
            if add_to_urls:
                target_url = match['url']
                if target_url not in existing_urls:
                    with open(urls_file, "a", encoding="utf-8") as f:
                        f.write(f"\n{target_url}")
                    existing_urls.add(target_url)
                    print(f"       ↳ Added to urls.txt!")
        else:
            print("❌ No direct ATS match")

    print("=" * 80)
    print(f"🎯 Detection Complete: Found {found_count}/{len(companies)} companies on public ATS APIs!")
    return results

def main():
    parser = argparse.ArgumentParser(description="Auto-detect ATS platform and working endpoints for companies.")
    parser.add_argument("--top-india", action="store_true", help="Scan top Indian tech startups & employers")
    parser.add_argument("--company", type=str, help="Single company name to detect")
    parser.add_argument("--input", type=str, help="Path to text or CSV file containing company names")
    parser.add_argument("--add-to-urls", action="store_true", help="Automatically append discovered URLs to scraper/urls.txt")
    parser.add_argument("--output", type=str, help="Optional output JSON file path for results")

    args = parser.parse_args()

    companies = []
    if args.company:
        companies = [args.company]
    elif args.input:
        if not os.path.exists(args.input):
            print(f"Error: Input file {args.input} does not exist.")
            sys.exit(1)
        with open(args.input, "r", encoding="utf-8") as f:
            companies = [line.strip() for line in f if line.strip()]
    elif args.top_india or len(sys.argv) == 1:
        companies = DEFAULT_TOP_INDIA_COMPANIES
    else:
        parser.print_help()
        sys.exit(0)

    results = run_detection(companies, add_to_urls=args.add_to_urls)

    if args.output:
        with open(args.output, "w", encoding="utf-8") as f:
            json.dump(results, f, indent=2)
        print(f"Results saved to {args.output}")

if __name__ == "__main__":
    main()
