from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from app.api import agent, designs, health, reference, voice
from app.config import get_settings
from app.persistence import repository_for


def create_app() -> FastAPI:
    settings = get_settings()
    repository_for(settings)  # fails fast on a misconfigured Supabase URL
    is_production = settings.app_env == "production"
    app = FastAPI(
        title="BanAI Wardrobe Designer API",
        version="0.1.0",
        docs_url=None if is_production else "/docs",
        redoc_url=None if is_production else "/redoc",
        openapi_url=None if is_production else "/openapi.json",
    )
    app.add_middleware(
        CORSMiddleware,
        allow_origins=settings.cors_origin_list,
        allow_methods=["GET", "POST", "PUT"],
        allow_headers=["Authorization", "Content-Type", "If-Match"],
    )
    app.include_router(health.router)
    app.include_router(reference.router)
    app.include_router(agent.router)
    app.include_router(voice.router)
    app.include_router(designs.router)
    return app


app = create_app()
