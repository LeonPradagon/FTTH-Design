import os
from dotenv import load_dotenv
from pydantic_settings import BaseSettings, SettingsConfigDict
from server.core.paths import SERVER_DIR

# Pastikan environment variables masuk ke os.environ untuk Prisma
load_dotenv(dotenv_path=os.path.join(SERVER_DIR, "..", "..", ".env"))
load_dotenv(dotenv_path=os.path.join(SERVER_DIR, "..", ".env"))
load_dotenv(dotenv_path=os.path.join(SERVER_DIR, ".env"))

class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=(".env", "../.env", "../../.env"), extra="ignore")

    database_url: str = f"sqlite:///{SERVER_DIR / 'ftth.db'}"
    better_auth_secret: str
    storage_endpoint_url: str | None = "http://seaweedfs:8333"
    storage_access_key_id: str = "ftth-local"
    storage_secret_access_key: str = "ftth-local-secret"
    storage_bucket: str = "ftth-designs"
    storage_region: str = "us-east-1"
    storage_force_path_style: bool = True


settings = Settings()
