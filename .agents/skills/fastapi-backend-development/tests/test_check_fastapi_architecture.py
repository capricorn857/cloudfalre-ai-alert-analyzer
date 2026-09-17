from __future__ import annotations

import subprocess
import sys
import tempfile
import textwrap
import unittest
from pathlib import Path


SKILL_ROOT = Path(__file__).resolve().parents[1]
CHECKER = SKILL_ROOT / "scripts" / "check_fastapi_architecture.py"


class ArchitectureCheckerTest(unittest.TestCase):
    def setUp(self) -> None:
        self.temp_dir = tempfile.TemporaryDirectory()
        self.project = Path(self.temp_dir.name)

    def tearDown(self) -> None:
        self.temp_dir.cleanup()

    def write(self, relative_path: str, content: str) -> None:
        target = self.project / relative_path
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text(textwrap.dedent(content).lstrip(), encoding="utf-8")

    def run_checker(self) -> subprocess.CompletedProcess[str]:
        return subprocess.run(
            [sys.executable, str(CHECKER), str(self.project)],
            capture_output=True,
            check=False,
            text=True,
        )

    def assert_rule(self, rule: str) -> str:
        result = self.run_checker()
        self.assertEqual(result.returncode, 1, result.stdout + result.stderr)
        self.assertIn(rule, result.stdout)
        return result.stdout

    def test_compliant_project_passes(self) -> None:
        self.write("pyproject.toml", '[project]\nrequires-python = ">=3.12"\n')
        self.write(
            "app/models/order.py",
            """
            from sqlalchemy.orm import mapped_column

            user_id = mapped_column(index=True)
            """,
        )
        self.write(
            "app/repositories/order_repository.py",
            """
            class OrderRepository:
                def __init__(self, session):
                    self.session = session

                async def add(self, order):
                    self.session.add(order)
                    await self.session.flush()
            """,
        )
        self.write(
            "app/api/routers/orders.py",
            """
            from fastapi import APIRouter, Depends
            from app.schemas.orders import OrderOut
            from app.services.order_service import OrderService

            router = APIRouter()

            @router.get('/orders/{order_id}', response_model=OrderOut)
            async def get_order(order_id: int, service: OrderService = Depends()):
                return await service.get(order_id)
            """,
        )

        result = self.run_checker()

        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertIn("FastAPI architecture check passed", result.stdout)

    def test_fapi001_rejects_foreign_key_and_import_alias(self) -> None:
        self.write("pyproject.toml", '[project]\nrequires-python = ">=3.12"\n')
        self.write(
            "app/models/order.py",
            """
            from sqlalchemy import ForeignKey as FK
            from sqlalchemy.orm import mapped_column

            user_id = mapped_column(FK('users.id'))
            """,
        )

        output = self.assert_rule("FAPI001")
        self.assertIn("app/models/order.py", output)

    def test_fapi002_and_fapi003_reject_repository_transaction_control(self) -> None:
        self.write("pyproject.toml", '[project]\nrequires-python = ">=3.12"\n')
        self.write(
            "app/repositories/user_repository.py",
            """
            class UserRepository:
                def __init__(self, session):
                    self.session = session

                async def save(self):
                    await self.session.commit()

                async def cancel(self):
                    await self.session.rollback()
            """,
        )

        result = self.run_checker()

        self.assertEqual(result.returncode, 1)
        self.assertIn("FAPI002", result.stdout)
        self.assertIn("FAPI003", result.stdout)

    def test_fapi004_rejects_router_repository_import(self) -> None:
        self.write("pyproject.toml", '[project]\nrequires-python = ">=3.12"\n')
        self.write(
            "app/api/routers/users.py",
            """
            from fastapi import APIRouter
            from app.repositories.user_repository import UserRepository

            router = APIRouter()

            @router.get('/users', response_model=list[dict])
            async def list_users():
                return []
            """,
        )

        self.assert_rule("FAPI004")

    def test_fapi005_rejects_direct_session_operation_in_router(self) -> None:
        self.write("pyproject.toml", '[project]\nrequires-python = ">=3.12"\n')
        self.write(
            "app/api/routers/users.py",
            """
            from fastapi import APIRouter
            from sqlalchemy.ext.asyncio import AsyncSession

            router = APIRouter()

            @router.get('/users', response_model=list[dict])
            async def list_users(session: AsyncSession):
                return await session.scalars('select users')
            """,
        )

        self.assert_rule("FAPI005")

    def test_fapi006_rejects_route_without_response_model(self) -> None:
        self.write("pyproject.toml", '[project]\nrequires-python = ">=3.12"\n')
        self.write(
            "app/api/routers/health.py",
            """
            from fastapi import APIRouter

            router = APIRouter()

            @router.get('/health')
            async def health():
                return {'status': 'ok'}
            """,
        )

        self.assert_rule("FAPI006")

    def test_fapi006_rejects_explicitly_disabled_response_model(self) -> None:
        self.write("pyproject.toml", '[project]\nrequires-python = ">=3.12"\n')
        self.write(
            "app/api/routers/health.py",
            """
            from fastapi import APIRouter

            router = APIRouter()

            @router.get('/health', response_model=None)
            async def health():
                return {'status': 'ok'}
            """,
        )

        self.assert_rule("FAPI006")

    def test_fapi007_rejects_python_311(self) -> None:
        self.write("pyproject.toml", '[project]\nrequires-python = ">=3.11"\n')

        self.assert_rule("FAPI007")

    def test_missing_pyproject_is_a_version_violation(self) -> None:
        self.write("app/main.py", "value = 1\n")

        self.assert_rule("FAPI007")

    def test_syntax_error_fails_closed(self) -> None:
        self.write("pyproject.toml", '[project]\nrequires-python = ">=3.12"\n')
        self.write("app/main.py", "def broken(:\n")

        self.assert_rule("FAPI000")

    def test_tests_and_virtual_environments_are_ignored(self) -> None:
        self.write("pyproject.toml", '[project]\nrequires-python = ">=3.12"\n')
        violating = "from sqlalchemy import ForeignKey\nvalue = ForeignKey('x.id')\n"
        self.write("tests/test_example.py", violating)
        self.write(".venv/lib/example.py", violating)

        result = self.run_checker()

        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)

    def test_valid_exception_suppresses_exact_rule_and_path(self) -> None:
        self.write(
            "pyproject.toml",
            """
            [project]
            requires-python = ">=3.12"

            [[tool.fastapi-guard.exceptions]]
            rule = "FAPI006"
            path = "app/api/routers/legacy.py"
            reason = "Legacy endpoint migration"
            owner = "backend-team"
            expires = "2999-12-31"
            """,
        )
        self.write(
            "app/api/routers/legacy.py",
            """
            from fastapi import APIRouter
            router = APIRouter()

            @router.get('/legacy')
            async def legacy():
                return {}
            """,
        )

        result = self.run_checker()

        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)

    def test_expired_exception_is_rejected_and_does_not_suppress(self) -> None:
        self.write(
            "pyproject.toml",
            """
            [project]
            requires-python = ">=3.12"

            [[tool.fastapi-guard.exceptions]]
            rule = "FAPI006"
            path = "app/api/routers/legacy.py"
            reason = "Legacy endpoint migration"
            owner = "backend-team"
            expires = "2000-01-01"
            """,
        )
        self.write(
            "app/api/routers/legacy.py",
            """
            from fastapi import APIRouter
            router = APIRouter()

            @router.get('/legacy')
            async def legacy():
                return {}
            """,
        )

        result = self.run_checker()

        self.assertEqual(result.returncode, 1)
        self.assertIn("FAPI006", result.stdout)
        self.assertIn("FAPI008", result.stdout)

    def test_stale_exception_without_matching_violation_is_rejected(self) -> None:
        self.write(
            "pyproject.toml",
            """
            [project]
            requires-python = ">=3.12"

            [[tool.fastapi-guard.exceptions]]
            rule = "FAPI006"
            path = "app/api/routers/legacy.py"
            reason = "Legacy endpoint migration"
            owner = "backend-team"
            expires = "2999-12-31"
            """,
        )
        self.write(
            "app/api/routers/legacy.py",
            """
            from fastapi import APIRouter
            router = APIRouter()

            @router.get('/legacy', response_model=dict)
            async def legacy():
                return {}
            """,
        )

        self.assert_rule("FAPI008")

    def test_foreign_key_rule_cannot_be_suppressed(self) -> None:
        self.write(
            "pyproject.toml",
            """
            [project]
            requires-python = ">=3.12"

            [[tool.fastapi-guard.exceptions]]
            rule = "FAPI001"
            path = "app/models/order.py"
            reason = "Legacy model"
            owner = "backend-team"
            expires = "2999-12-31"
            """,
        )
        self.write(
            "app/models/order.py",
            """
            from sqlalchemy import ForeignKey
            from sqlalchemy.orm import mapped_column

            user_id = mapped_column(ForeignKey('user.id'))
            """,
        )

        result = self.run_checker()

        self.assertEqual(result.returncode, 1)
        self.assertIn("FAPI001", result.stdout)
        self.assertIn("FAPI008", result.stdout)


if __name__ == "__main__":
    unittest.main()
