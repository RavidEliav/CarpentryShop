from fastapi import APIRouter

from app.config import get_settings

router = APIRouter()


@router.get("/api/health")
def health() -> dict:
    settings = get_settings()
    return {
        "success": True,
        "data": {
            "status": "ok", "env": settings.app_env, "agent": settings.agent_enabled,
            "persistence": settings.persistence_enabled,
        },
    }
