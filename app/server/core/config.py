from pydantic_settings import BaseSettings
from server.core.paths import SERVER_DIR

class Settings(BaseSettings):
    database_url: str = f"sqlite:///{SERVER_DIR / 'ftth.db'}"
    better_auth_secret: str
    
    class Config:
        env_file = ".env"
        extra = "ignore"

settings = Settings()
