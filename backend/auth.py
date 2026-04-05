from fastapi import HTTPException, Security, status
from fastapi.security import HTTPBearer, HTTPAuthorizationCredentials
from .config import get_config

bearer = HTTPBearer(auto_error=False)


def require_auth(credentials: HTTPAuthorizationCredentials | None = Security(bearer)):
    cfg = get_config()
    if credentials is None or credentials.credentials != cfg.password:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Invalid or missing token",
            headers={"WWW-Authenticate": "Bearer"},
        )
    return True


def check_token(token: str | None) -> bool:
    cfg = get_config()
    return token == cfg.password
