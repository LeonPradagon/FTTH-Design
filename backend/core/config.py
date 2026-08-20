from pydantic_settings import BaseSettings

class Settings(BaseSettings):
    database_url: str = "sqlite:///./backend/ftth.db"
    better_auth_secret: str
    
    class Config:
        env_file = ".env"
        extra = "ignore"

settings = Settings()
