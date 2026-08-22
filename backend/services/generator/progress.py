"""Progress tracking manager for generation jobs."""

import json
from typing import Dict, Any, Optional
import redis
import os

class ProgressManager:
    """Redis-backed state store for progress tracking.
    
    Uses synchronous Redis client so it can be called cleanly from 
    both synchronous generator threads and the async FastAPI API.
    """
    
    def __init__(self):
        redis_url = os.getenv("REDIS_URL", "redis://localhost:6379/0")
        self.redis = redis.from_url(redis_url, decode_responses=True)
        
    def create_job(self, job_id: str):
        state = {
            "stage": "STARTING",
            "message": "Initializing...",
            "percent": 0,
            "done": False,
        }
        self.redis.setex(f"job_progress:{job_id}", 3600, json.dumps(state))
        
    def update(self, job_id: str, stage: str, message: str, percent: int, done: bool = False, result: Optional[Dict[str, Any]] = None):
        state = {
            "stage": stage,
            "message": message,
            "percent": percent,
            "done": done,
        }
        if result is not None:
            state["result"] = result
        self.redis.setex(f"job_progress:{job_id}", 3600, json.dumps(state))
            
    def get_status(self, job_id: str) -> Optional[Dict[str, Any]]:
        val = self.redis.get(f"job_progress:{job_id}")
        if val:
            return json.loads(val)
        return None
        
    def complete(self, job_id: str, result: Optional[Dict[str, Any]] = None):
        self.update(job_id, "COMPLETED", "Generation finished successfully.", 100, done=True, result=result)
        
    def error(self, job_id: str, error_msg: str):
        self.update(job_id, "ERROR", error_msg, 100, done=True)
        
    def cleanup(self, job_id: str):
        self.redis.delete(f"job_progress:{job_id}")

# Global instance
progress_manager = ProgressManager()
