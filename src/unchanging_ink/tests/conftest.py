import asyncio
import sys

import pytest

from unchanging_ink.crypto.merkle import (
    AbstractAsyncMerkleTree,
    DictCachingMerkleTree,
    MerkleNode,
)


class EmptyMerkleTreeUncached(AbstractAsyncMerkleTree):
    async def fetch_leaf_data(self, position: int) -> bytes:
        raise NotImplementedError()


class StandardMerkleTreeUncached(AbstractAsyncMerkleTree):
    async def fetch_leaf_data(self, position: int) -> bytes:
        return str(position).encode()


@pytest.fixture(scope="session")
def merkle_tree_7():
    return StandardMerkleTreeUncached(width=7)


@pytest.fixture
def merkle_tree_11() -> AbstractAsyncMerkleTree:
    return StandardMerkleTreeUncached(width=11)


@pytest.fixture(scope="session")
def event_loop():
    """
    Creates an instance of the default event loop for the test session.
    """
    if sys.platform.startswith("win") and sys.version_info[:2] >= (3, 8):
        # Avoid "RuntimeError: Event loop is closed" on Windows when tearing down tests
        # https://github.com/encode/httpx/issues/914
        asyncio.set_event_loop_policy(asyncio.WindowsSelectorEventLoopPolicy())

    loop = asyncio.new_event_loop()
    yield loop
    loop.close()


@pytest.fixture(scope="session")
def _database_url():
    # return "postgresql+asyncpg://postgres:masterkey@localhost/dbtest"
    return "sqlite+aiosqlite:///:memory:"


@pytest.fixture(scope="session")
def init_database():
    from unchanging_ink.models import metadata

    return metadata.create_all
