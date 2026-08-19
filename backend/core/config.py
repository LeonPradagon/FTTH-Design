from pydantic_settings import BaseSettings

class Settings(BaseSettings):
    openai_api_key: str | None = None
    openai_model: str = "gpt-4o-mini"
    better_auth_secret: str
    
    class Config:
        env_file = ".env"
        extra = "ignore"

settings = Settings()
