from pydantic_settings import BaseSettings, SettingsConfigDict
from server.core.paths import SERVER_DIR


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", extra="ignore")

    database_url: str = f"sqlite:///{SERVER_DIR / 'ftth.db'}"
    better_auth_secret: str
    storage_endpoint_url: str | None = "http://seaweedfs:8333"
    storage_access_key_id: str = "ftth-local"
    storage_secret_access_key: str = "ftth-local-secret"
    storage_bucket: str = "ftth-designs"
    storage_region: str = "us-east-1"
    storage_force_path_style: bool = True


settings = Settings()
