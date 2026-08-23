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
        
    def create_job(self, job_id: str, user_id: str | None = None, batch_id: str | None = None):
        state = {
            "stage": "STARTING",
            "message": "Initializing...",
            "percent": 0,
            "done": False,
        }
        if user_id:
            state["user_id"] = user_id
        if batch_id:
            state["batch_id"] = batch_id
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

    def create_batch(self, batch_id: str, jobs: list[dict], project_id: str | None = None,
                     user_id: str | None = None):
        public_fields = {
            "job_id", "item_id", "boundary_name", "design_name", "status",
            "error", "output_kmz_name", "output_kml_name", "output_csv_name",
        }
        public_jobs = [{key: value for key, value in job.items() if key in public_fields} for job in jobs]
        state = {
            "batch_id": batch_id,
            "project_id": project_id,
            "user_id": user_id,
            "status": "QUEUED",
            "total": len(jobs),
            "completed": 0,
            "failed": 0,
            "jobs": public_jobs,
        }
        self.redis.setex(f"batch_progress:{batch_id}", 86400, json.dumps(state))

    def get_batch(self, batch_id: str) -> Optional[Dict[str, Any]]:
        value = self.redis.get(f"batch_progress:{batch_id}")
        return json.loads(value) if value else None

    def update_batch_job(self, batch_id: str, job_id: str, **updates):
        state = self.get_batch(batch_id)
        if not state:
            return
        for job in state.get("jobs", []):
            if job.get("job_id") == job_id:
                job.update(updates)
                break
        jobs = state.get("jobs", [])
        state["completed"] = sum(j.get("status") == "COMPLETED" for j in jobs)
        state["failed"] = sum(j.get("status") in {"FAILED", "SKIPPED"} for j in jobs)
        active = sum(j.get("status") in {"QUEUED", "RUNNING"} for j in jobs)
        state["status"] = "COMPLETED" if active == 0 else ("RUNNING" if state["completed"] or state["failed"] else "QUEUED")
        self.redis.setex(f"batch_progress:{batch_id}", 86400, json.dumps(state))

# Global instance
progress_manager = ProgressManager()
