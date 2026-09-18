import os
import json
import time
import re
from dotenv import load_dotenv
from pymongo import MongoClient
from google import genai
import certifi
from playwright.sync_api import sync_playwright
from pypdf import PdfReader

load_dotenv()

# Configuration
GEMINI_API_KEY = os.getenv("GEMINI_API_KEY")
MONGODB_URI = os.getenv("MONGODB_URI")
RESUME_PATH = os.path.join(os.path.dirname(os.path.dirname(__file__)), "ashwanth polusani.pdf")
URLS_FILE = os.path.join(os.path.dirname(__file__), "urls.txt")

def get_target_urls():
    if not os.path.exists(URLS_FILE):
        return []
    with open(URLS_FILE, 'r') as f:
        urls = [line.strip() for line in f if line.strip() and not line.startswith('#')]
    return urls

def get_resume_text():
    try:
        reader = PdfReader(RESUME_PATH)
        return "".join(page.extract_text() for page in reader.pages)
    except Exception as e:
        print(f"Error reading resume: {e}")
        return ""

def clean_html(html):
    """Removes scripts, styles, and SVGs to reduce token count drastically."""
    html = re.sub(r'<script.*?</script>', '', html, flags=re.DOTALL | re.IGNORECASE)
    html = re.sub(r'<style.*?</style>', '', html, flags=re.DOTALL | re.IGNORECASE)
    html = re.sub(r'<svg.*?</svg>', '', html, flags=re.DOTALL | re.IGNORECASE)
    html = re.sub(r'<!--.*?-->', '', html, flags=re.DOTALL)
    return html

def fetch_html_with_playwright(url):
    """Uses Playwright to open a browser, render JS, and get the raw HTML."""
    print(f"Fetching {url} with Playwright...")
    try:
        with sync_playwright() as p:
            browser = p.chromium.launch(headless=True)
            page = browser.new_page()
            # domcontentloaded is faster and less prone to timeout than networkidle
            page.goto(url, wait_until="domcontentloaded", timeout=45000)
            time.sleep(3)
            html = page.content()
            browser.close()
            return clean_html(html)
    except Exception as e:
        print(f"Error fetching {url}: {e}")
        return ""

def extract_jobs_with_gemini(raw_html, resume_text):
    """Uses Gemini to extract structured job data from HTML and evaluate it against resume."""
    print("Extracting and evaluating jobs with Gemini...")
    if not GEMINI_API_KEY or not raw_html:
        print("Missing GEMINI_API_KEY or HTML content is empty.")
        return []

    try:
        client = genai.Client(api_key=GEMINI_API_KEY)
        
        prompt = f"""
        You are an expert tech recruiter. Your task is to extract job listings from the provided HTML AND evaluate them against the candidate's resume and constraints.
        
        CANDIDATE CONSTRAINTS:
        - Fresher, 0 years experience, 0 formal internships.
        - Indian citizen from Hyderabad.
        - Willing to relocate anywhere in India.
        - Willing to relocate abroad ONLY IF the company explicitly sponsors visas.
        
        CANDIDATE RESUME:
        {resume_text}
        
        Extract all job listings from the HTML. Return ONLY a JSON array of objects. 
        Each object must have the following keys:
        - "title" (string)
        - "location" (string)
        - "requirements" (string)
        - "link" (string)
        - "is_match" (boolean): true if the candidate meets the constraints (e.g. it doesn't strictly require X years of experience, and it fits the visa constraints).
        - "match_reason" (string): A short 1-2 sentence explanation of why this job is or isn't a fit based on the resume.

        If you cannot find a specific field, leave it as an empty string. Ensure links are absolute URLs.
        
        HTML to process:
        {raw_html}
        """
        
        max_retries = 3
        for attempt in range(max_retries):
            try:
                response = client.models.generate_content(
                    model='gemini-3.5-flash-lite',
                    contents=prompt,
                    config={"response_mime_type": "application/json"}
                )
                return json.loads(response.text)
            except Exception as e:
                error_msg = str(e)
                if '429' in error_msg or 'Quota exceeded' in error_msg or '503' in error_msg:
                    print(f"Rate limit or Server Overload hit. Sleeping for 65 seconds... (Attempt {attempt+1}/{max_retries})")
                    time.sleep(65)
                else:
                    print(f"Gemini API Error: {error_msg}")
                    return []
        
        print("Max retries exceeded for Gemini API.")
        return []
    except Exception as e:
        print(f"Gemini Configuration Error: {e}")
        return []

def save_to_mongodb(jobs):
    """Saves the extracted jobs to MongoDB."""
    print(f"Saving {len(jobs)} jobs to MongoDB...")
    if not MONGODB_URI:
        print("MongoDB URI not found. Skipping DB insert.")
        return
    
    client = None
    try:
        client = MongoClient(MONGODB_URI, serverSelectionTimeoutMS=5000, tlsCAFile=certifi.where())
        db = client.job_aggregator
        collection = db.jobs
        
        if jobs:
            result = collection.insert_many(jobs)
            print(f"Successfully saved {len(result.inserted_ids)} jobs.")
    except Exception as e:
        print(f"Error saving to MongoDB: {e}")
    finally:
        if client:
            client.close()

def main():
    print("Starting Playwright Job Scraper with Resume Personalization...")
    resume_text = get_resume_text()
    if not resume_text:
        print("Warning: Could not extract resume text.")
    
    urls = get_target_urls()
    print(f"Loaded {len(urls)} target URLs.")
    
    for url in urls:
        html_content = fetch_html_with_playwright(url)
        if html_content:
            jobs = extract_jobs_with_gemini(html_content, resume_text)
            if jobs:
                # Keep only jobs where is_match is true
                matching_jobs = [job for job in jobs if str(job.get('is_match')).lower() == 'true']
                
                # Make sure to convert 'is_match' to a strict boolean for MongoDB
                for job in matching_jobs:
                    job['is_match'] = True
                    
                print(f"Found {len(matching_jobs)} matching jobs out of {len(jobs)} total scraped.")
                if matching_jobs:
                    save_to_mongodb(matching_jobs)
        
        # Adding a slightly longer sleep to ensure we stay well under Gemini rate limits
        time.sleep(10)
            
    print("Scraping run complete.")

if __name__ == "__main__":
    main()
