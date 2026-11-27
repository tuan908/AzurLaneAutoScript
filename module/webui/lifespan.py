"""
Startup and shutdown hooks for Starlette >= 1.0, which dropped `on_startup` and `on_shutdown`.
"""
import contextlib
import inspect
from typing import Callable, List


class Lifecycle:
    def __init__(self, on_startup=None, on_shutdown=None):
        self.on_startup: List[Callable] = list(on_startup or [])
        self.on_shutdown: List[Callable] = list(on_shutdown or [])

    @staticmethod
    async def _call(hooks):
        for hook in hooks:
            result = hook()
            if inspect.isawaitable(result):
                await result

    @contextlib.asynccontextmanager
    async def lifespan(self, app):
        await self._call(self.on_startup)
        try:
            yield
        finally:
            await self._call(self.on_shutdown)
