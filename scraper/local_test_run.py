import os
import sys
import json
import time
from dotenv import load_dotenv

# Ensure we can import our modules
sys.path.append(os.path.dirname(__file__))

import safe_ats
from main import (
    ModelPool, 
    GEMINI_API_KEY, 
    GEMINI_MODELS, 
    fetch_html_with_playwright,
    GEMINI_PROMPT_TEMPLATE,
    now_iso,
    extract_jobs_with_gemini,
    GEMINI_CHUNK_SIZE,
    is_eligible_for_jobbuddy
)

load_dotenv()

def run_local_test(url: str):
    print("═" * 60)
    print(f"  JobBuddy LOCAL TEST RUN (No DB inserts)")
    print(f"  Target URL: {url}")
    print("═" * 60)

    pool = ModelPool(api_key=GEMINI_API_KEY, models=GEMINI_MODELS)
    scratch_dir = os.path.join(os.path.dirname(__file__), "..", "scratch")
    os.makedirs(scratch_dir, exist_ok=True)

    # 1. ATS API ROUTER
    is_api, api_jobs, ats_name = safe_ats.process_ats_url(url)
    filtered = None  # Will be set if we go through ATS path
    html = None      # Will be set if we go through Playwright path
    final_url = url

    if is_api:
        print(f"  ⚡ ATS Detected: {ats_name} API (bypassing Playwright)")
        if not api_jobs:
            print(f"  → 0 total open roles found via {ats_name} API.")
            return
            
        filtered = safe_ats.pre_filter_jobs(api_jobs)
        print(f"  → API returned {len(api_jobs)} jobs. Pre-filtered to {len(filtered)} tech/junior roles.")
        
        if not filtered:
            return

    # 2. PLAYWRIGHT FALLBACK
    else:
        print(f"  ↳ Fetching via Playwright (HTML fallback)...")
        html, final_url, fetch_time_ms, fetch_error = fetch_html_with_playwright(url)
        
        if not html:
            print(f"  ✗ Fetch failed: {fetch_error}")
            return

        # ATS Auto-Detection in HTML
        detected_is_api, detected_api_jobs, detected_ats_name = safe_ats.process_html_for_ats(html)
        if detected_is_api and detected_api_jobs:
            print(f"  ⚡ Auto-Detected {detected_ats_name} inside webpage! Switching to API.")
            filtered = safe_ats.pre_filter_jobs(detected_api_jobs)
            print(f"  → {detected_ats_name} API returned {len(detected_api_jobs)} jobs. Pre-filtered to {len(filtered)} roles.")
            if not filtered:
                return

    # 3. GEMINI EXTRACTION WITH TRANSPARENCY
    print(f"  🧠 Sending to Gemini (Chunked if needed)...")
    try:
        # If filtered is set, we are in ATS mode (chunked).
        # If filtered is None, we are in plain HTML mode (single call with raw html).
        if filtered is not None:
            jobs = []
            for j in range(0, len(filtered), GEMINI_CHUNK_SIZE):
                chunk = filtered[j:j + GEMINI_CHUNK_SIZE]
                raw_chunk_data = json.dumps(chunk, indent=2)
                
                # Save just the first chunk's prompt for inspection
                if j == 0:
                    prompt = GEMINI_PROMPT_TEMPLATE.format(raw_data=raw_chunk_data)
                    with open(os.path.join(scratch_dir, "test_prompt.txt"), "w", encoding="utf-8") as f:
                        f.write(prompt)
                    print(f"  📝 Saved chunk 1 prompt to: scratch/test_prompt.txt")
                
                chunk_jobs = extract_jobs_with_gemini(raw_chunk_data, url, pool)
                jobs.extend(chunk_jobs)
        else:
            # Plain HTML path
            prompt = GEMINI_PROMPT_TEMPLATE.format(raw_data=html)
            with open(os.path.join(scratch_dir, "test_prompt.txt"), "w", encoding="utf-8") as f:
                f.write(prompt)
            print(f"  📝 Saved prompt to: scratch/test_prompt.txt")
            jobs = extract_jobs_with_gemini(html, url, pool, base_url=final_url)

        with open(os.path.join(scratch_dir, "test_response.json"), "w", encoding="utf-8") as f:
            json.dump(jobs, f, indent=2)
        print(f"  📝 Saved aggregated response to: scratch/test_response.json")

        if jobs and "error_type" in jobs[0]:
            print(f"  ⚠ Gemini detected site issue: {jobs[0].get('error_type')}")
        else:
            real_jobs = [j for j in jobs if "error_type" not in j]
            # Apply JobBuddy eligibility filter
            eligible = []
            for rj in real_jobs:
                ok, reason = is_eligible_for_jobbuddy(rj)
                if ok:
                    eligible.append(rj)
                else:
                    print(f"  ⊘ Filtered out '{rj.get('title')}' ({rj.get('location')}): {reason}")

            print(f"  ✓ Extracted {len(eligible)} eligible jobs (out of {len(real_jobs)} raw candidates)!")
            if eligible:
                first = eligible[0]
                print(f"  First job: '{first.get('title')}' at '{first.get('company_name')}' ({first.get('location')})")
                print(f"  Verdict: {first.get('experience_verdict')} | Type: {first.get('link_type')}")
                print(f"  Core Requirements: {first.get('core_requirements')}")

    except Exception as e:
        print(f"  ✗ Error during Gemini extraction: {e}")

if __name__ == "__main__":
    test_url = sys.argv[1] if len(sys.argv) > 1 else "https://careers.robinhood.com/"
    run_local_test(test_url)
