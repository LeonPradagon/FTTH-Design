import logging
import os

os.makedirs("dashboard/public/data", exist_ok=True)
logging.basicConfig(
    filename='dashboard/public/data/app.log',
    level=logging.INFO,
    format='%(asctime)s - %(levelname)s - %(message)s'
)
logger = logging.getLogger("ftth_backend")
