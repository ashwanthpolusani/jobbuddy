"""
Export MongoDB collections to local JSON files.

Usage:
    python scraper/export_mongodb.py [--output-dir mongodb_export]
"""

import os
import sys
import re
import json
import argparse
import subprocess
import urllib.parse
from datetime import datetime, date, timezone
from pathlib import Path
from dotenv import load_dotenv
from pymongo import MongoClient
import certifi
from bson import ObjectId

# Load environment variables from scraper/.env or current directory
env_path = Path(__file__).resolve().parent / ".env"
if env_path.exists():
    load_dotenv(env_path)
else:
    load_dotenv()


def serialize_mongo(obj):
    """Custom JSON serializer for MongoDB document fields."""
    if isinstance(obj, ObjectId):
        return str(obj)
    if isinstance(obj, (datetime, date)):
        return obj.isoformat()
    if isinstance(obj, bytes):
        return obj.decode("utf-8", errors="replace")
    raise TypeError(f"Type {type(obj)} not serializable")


def resolve_srv_direct(uri: str) -> str:
    """
    Fallback: Convert mongodb+srv:// to direct mongodb:// seedlist.
    Fixes Windows dnspython UDP 53 timeout issues by using OS-native DNS resolution.
    """
    m = re.match(r"^mongodb\+srv://([^:]+):([^@]+)@([^/?]+)(?:/([^?]*))?(?:\?(.*))?$", uri)
    if not m:
        return uri
    user, password, host, db_name, query_params = m.groups()
    db_name = db_name or ""

    hosts = []
    txt_options = ""

    # Attempt resolution via Windows native PowerShell DNS resolver
    try:
        cmd_srv = [
            "powershell", "-NoProfile", "-Command",
            f'(Resolve-DnsName -Name "_mongodb._tcp.{host}" -Type SRV).NameTarget'
        ]
        res_srv = subprocess.run(cmd_srv, capture_output=True, text=True, timeout=10)
        if res_srv.returncode == 0:
            hosts = [h.strip().rstrip(".") + ":27017" for h in res_srv.stdout.strip().splitlines() if h.strip()]

        cmd_txt = [
            "powershell", "-NoProfile", "-Command",
            f'(Resolve-DnsName -Name "{host}" -Type TXT).Strings'
        ]
        res_txt = subprocess.run(cmd_txt, capture_output=True, text=True, timeout=10)
        if res_txt.returncode == 0:
            txt_options = "&".join([t.strip() for t in res_txt.stdout.strip().splitlines() if t.strip()])
    except Exception:
        pass

    # Static fallback for this repository's MongoDB cluster if DNS SRV is blocked
    if not hosts and "cluster0.zwx8ade.mongodb.net" in host:
        hosts = [
            "ac-k9hz41i-shard-00-00.zwx8ade.mongodb.net:27017",
            "ac-k9hz41i-shard-00-01.zwx8ade.mongodb.net:27017",
            "ac-k9hz41i-shard-00-02.zwx8ade.mongodb.net:27017"
        ]
        if not txt_options:
            txt_options = "authSource=admin&replicaSet=atlas-cc1zr6-shard-0"

    if not hosts:
        return uri

    encoded_user = urllib.parse.quote_plus(user)
    encoded_pass = urllib.parse.quote_plus(password)
    seedlist = ",".join(hosts)

    opts = ["ssl=true"]
    if txt_options:
        opts.append(txt_options)
    if query_params:
        opts.append(query_params)

    return f"mongodb://{encoded_user}:{encoded_pass}@{seedlist}/{db_name}?" + "&".join(opts)


def connect_mongo(uri: str) -> MongoClient:
    """Connect to MongoDB with automatic fallback if dnspython SRV lookup fails."""
    try:
        client = MongoClient(uri, tlsCAFile=certifi.where(), serverSelectionTimeoutMS=8000)
        client.admin.command("ping")
        return client
    except Exception as e:
        err_msg = str(e)
        if "DNS" in err_msg or "timed out" in err_msg or "ConfigurationError" in type(e).__name__:
            print("  [Notice] dnspython SRV query timed out. Falling back to direct seedlist connection...")
            direct_uri = resolve_srv_direct(uri)
            if direct_uri != uri:
                client = MongoClient(direct_uri, tlsCAFile=certifi.where(), serverSelectionTimeoutMS=10000)
                client.admin.command("ping")
                print("  Connected successfully via direct replica set seedlist.")
                return client
        raise


def export_database(output_dir: Path):
    uri = os.getenv("MONGODB_URI")
    if not uri:
        print("Error: MONGODB_URI environment variable not found.", file=sys.stderr)
        print("Please check your scraper/.env file.", file=sys.stderr)
        sys.exit(1)

    output_dir.mkdir(parents=True, exist_ok=True)
    print("Connecting to MongoDB...")

    try:
        client = connect_mongo(uri)
        print("  Connected successfully.")
    except Exception as e:
        print(f"Failed to connect to MongoDB: {e}", file=sys.stderr)
        sys.exit(1)

    db_names = [d for d in client.list_database_names() if d not in ["admin", "local", "config"]]
    if not db_names:
        print("No user databases found.")
        return

    summary = {
        "exported_at": datetime.now(timezone.utc).isoformat(),
        "databases": {}
    }

    total_docs = 0

    for db_name in db_names:
        db = client[db_name]
        col_names = sorted(db.list_collection_names())
        print(f"\nProcessing database: '{db_name}' ({len(col_names)} collections)")
        summary["databases"][db_name] = {}

        for col_name in col_names:
            col = db[col_name]
            docs = list(col.find({}))
            doc_count = len(docs)
            total_docs += doc_count

            # Target JSON file
            filename = f"{col_name}.json" if len(db_names) == 1 else f"{db_name}_{col_name}.json"
            file_path = output_dir / filename

            print(f"  Fetching {col_name}... ({doc_count} documents)", end="", flush=True)

            with open(file_path, "w", encoding="utf-8") as f:
                json.dump(docs, f, default=serialize_mongo, indent=2, ensure_ascii=False)

            file_size_kb = file_path.stat().st_size / 1024
            print(f" -> Saved to {filename} ({file_size_kb:.1f} KB)")

            summary["databases"][db_name][col_name] = {
                "file": filename,
                "document_count": doc_count,
                "size_kb": round(file_size_kb, 2)
            }

    # Write summary metadata
    summary_path = output_dir / "summary.json"
    with open(summary_path, "w", encoding="utf-8") as f:
        json.dump(summary, f, indent=2)

    print(f"\n Export complete!")
    print(f"  Total documents exported: {total_docs}")
    print(f"  Destination directory: {output_dir.resolve()}")
    print(f"  Summary saved to: {summary_path.resolve()}\n")


def main():
    parser = argparse.ArgumentParser(description="Export MongoDB data to local JSON files.")
    parser.add_argument(
        "--output-dir",
        default="mongodb_export",
        help="Target folder path (relative to repo root or absolute, default: mongodb_export)"
    )
    args = parser.parse_args()

    repo_root = Path(__file__).resolve().parent.parent
    target_dir = Path(args.output_dir)
    if not target_dir.is_absolute():
        target_dir = repo_root / target_dir

    export_database(target_dir)


if __name__ == "__main__":
    main()
