import logging
from server.core.paths import DATA_DIR

DATA_DIR.mkdir(parents=True, exist_ok=True)
logging.basicConfig(
    filename=DATA_DIR / 'app.log',
    level=logging.INFO,
    format='%(asctime)s - %(levelname)s - %(message)s'
)
logger = logging.getLogger("ftth_server")
