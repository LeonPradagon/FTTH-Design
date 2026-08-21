from pathlib import Path


SERVER_DIR = Path(__file__).resolve().parents[1]
APP_DIR = SERVER_DIR.parent
PROJECT_DIR = APP_DIR.parent
SAMPLES_KML_DIR = PROJECT_DIR / "samples" / "kml"
DATA_DIR = SERVER_DIR / "data"
CACHE_DIR = SERVER_DIR / "cache"
