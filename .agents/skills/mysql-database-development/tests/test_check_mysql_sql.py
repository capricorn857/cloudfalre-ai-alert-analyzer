from __future__ import annotations

import subprocess
import sys
import tempfile
import textwrap
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
CHECKER = ROOT / "scripts" / "check_mysql_sql.py"

VALID_TABLE = """
CREATE TABLE order_item (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT COMMENT '主键',
  inserttime DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP COMMENT '插入时间',
  updatetime DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP COMMENT '更新时间',
  isactive TINYINT UNSIGNED NOT NULL DEFAULT 1 COMMENT '逻辑删除(1:保留,0:删除)',
  name VARCHAR(64) NOT NULL DEFAULT '' COMMENT '名称',
  PRIMARY KEY (id),
  KEY idx_inserttime (inserttime),
  KEY idx_updatetime (updatetime),
  UNIQUE KEY uniq_name (name)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='订单项';
"""


class MySQLGuardTest(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory()
        self.project = Path(self.tmp.name)

    def tearDown(self) -> None:
        self.tmp.cleanup()

    def write(self, path: str, sql: str) -> Path:
        target = self.project / path
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text(textwrap.dedent(sql).lstrip(), encoding="utf-8")
        return target

    def run_checker(self, *args: str) -> subprocess.CompletedProcess[str]:
        return subprocess.run(
            [sys.executable, str(CHECKER), *args], text=True, capture_output=True
        )

    def assert_rule(self, rule: str, sql: str, *, code: int = 1) -> str:
        path = self.write("migrations/sql/001_test.sql", sql)
        result = self.run_checker(str(path))
        self.assertEqual(result.returncode, code, result.stdout + result.stderr)
        self.assertIn(rule, result.stdout)
        return result.stdout

    def test_valid_table_passes(self) -> None:
        result = self.run_checker(str(self.write("migrations/sql/001_valid.sql", VALID_TABLE)))
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertIn("passed", result.stdout.lower())

    def test_mysql001_identifier_rules(self) -> None:
        self.assert_rule("MYSQL001", VALID_TABLE.replace("order_item", "OrderItems", 1))

    def test_mysql002_table_options_and_comments(self) -> None:
        self.assert_rule("MYSQL002", VALID_TABLE.replace("ENGINE=InnoDB", "ENGINE=MyISAM"))

    def test_mysql002_rejects_empty_column_comment(self) -> None:
        self.assert_rule("MYSQL002", VALID_TABLE.replace("COMMENT '名称'", "COMMENT ''"))

    def test_mysql003_primary_key_shape(self) -> None:
        self.assert_rule("MYSQL003", VALID_TABLE.replace("BIGINT UNSIGNED", "INT", 1))

    def test_mysql004_required_columns(self) -> None:
        self.assert_rule("MYSQL004", VALID_TABLE.replace("isactive", "active", 1))

    def test_mysql004_rejects_wrong_isactive_default(self) -> None:
        self.assert_rule("MYSQL004", VALID_TABLE.replace("DEFAULT 1 COMMENT '逻辑删除", "DEFAULT 2 COMMENT '逻辑删除"))

    def test_mysql005_required_time_indexes(self) -> None:
        self.assert_rule("MYSQL005", VALID_TABLE.replace("idx_updatetime", "idx_updated"))

    def test_mysql005_rejects_required_index_on_wrong_column(self) -> None:
        self.assert_rule("MYSQL005", VALID_TABLE.replace("idx_updatetime (updatetime)", "idx_updatetime (name)"))

    def test_mysql006_index_rules(self) -> None:
        self.assert_rule("MYSQL006", VALID_TABLE.replace("uniq_name", "unique_name"))

    def test_mysql007_forbidden_schema_objects(self) -> None:
        self.assert_rule("MYSQL007", "CREATE VIEW active_order AS SELECT 1;")

    def test_mysql008_forbidden_types(self) -> None:
        self.assert_rule("MYSQL008", VALID_TABLE.replace("VARCHAR(64)", "DOUBLE"))

    def test_mysql009_too_many_large_columns(self) -> None:
        sql = VALID_TABLE.replace(
            "name VARCHAR(64) NOT NULL DEFAULT '' COMMENT '名称',",
            "a TEXT COMMENT 'a', b TEXT COMMENT 'b', c BLOB COMMENT 'c', d TEXT COMMENT 'd',",
        )
        self.assert_rule("MYSQL009", sql)

    def test_mysql101_warnings_do_not_fail(self) -> None:
        sql = VALID_TABLE.replace("name VARCHAR(64) NOT NULL DEFAULT ''", "name TEXT")
        self.assert_rule("MYSQL101", sql, code=0)

    def test_mysql102_boolean_shape_warning(self) -> None:
        sql = VALID_TABLE.replace(
            "name VARCHAR(64) NOT NULL DEFAULT '' COMMENT '名称'",
            "is_paid INT NOT NULL DEFAULT 2 COMMENT '已支付'",
        )
        self.assert_rule("MYSQL102", sql, code=0)

    def test_mysql010_destructive_and_unbounded_dml(self) -> None:
        self.assert_rule("MYSQL010", "UPDATE order_item SET isactive = 0;")

    def test_mysql011_left_wildcard(self) -> None:
        self.assert_rule("MYSQL011", "SELECT id FROM order_item WHERE name LIKE '%abc';")

    def test_mysql012_large_literal_in(self) -> None:
        values = ",".join(str(value) for value in range(1001))
        self.assert_rule("MYSQL012", f"SELECT id FROM order_item WHERE id IN ({values});")

    def test_mysql013_join_and_qualification(self) -> None:
        self.assert_rule(
            "MYSQL013",
            "SELECT id FROM a JOIN b ON a.id=b.id JOIN c ON b.id=c.id JOIN d ON c.id=d.id;",
        )

    def test_mysql014_repeated_alter(self) -> None:
        self.assert_rule(
            "MYSQL014",
            "ALTER TABLE order_item ADD COLUMN a INT; ALTER TABLE order_item ADD COLUMN b INT;",
        )

    def test_mysql015_alter_foreign_key(self) -> None:
        self.assert_rule(
            "MYSQL015", "ALTER TABLE order_item ADD FOREIGN KEY (user_id) REFERENCES user(id);"
        )

    def test_mysql103_change_column_warning(self) -> None:
        self.assert_rule(
            "MYSQL103", "ALTER TABLE order_item CHANGE COLUMN name title VARCHAR(64);", code=0
        )

    def test_mysql104_count_column_warning(self) -> None:
        self.assert_rule("MYSQL104", "SELECT COUNT(id) FROM order_item;", code=0)

    def test_mysql105_large_offset_warning(self) -> None:
        self.assert_rule("MYSQL105", "SELECT id FROM order_item LIMIT 20 OFFSET 100000;", code=0)

    def test_parse_error_fails_closed(self) -> None:
        self.assert_rule("MYSQL000", "SELECT FROM WHERE ;")

    def test_comments_and_literals_do_not_trigger_destructive_rules(self) -> None:
        sql = "SELECT 'DROP TABLE x' AS message; -- TRUNCATE TABLE y"
        result = self.run_checker(str(self.write("queries/read.sql", sql)))
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)

    def test_directory_discovery(self) -> None:
        self.write("migrations/sql/001_valid.sql", VALID_TABLE)
        result = self.run_checker(str(self.project / "migrations"))
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)

    def test_missing_path_is_usage_error(self) -> None:
        result = self.run_checker(str(self.project / "missing"))
        self.assertEqual(result.returncode, 2)

    def test_valid_exact_exception_suppresses_finding(self) -> None:
        path = self.write("migrations/sql/001_legacy.sql", "SELECT COUNT(id) FROM t;")
        config = self.project / ".mysql-guard.toml"
        config.write_text(
            '[[exceptions]]\nrule="MYSQL104"\npath="migrations/sql/001_legacy.sql"\n'
            'reason="legacy report"\nowner="database-team"\nexpires="2999-12-31"\n',
            encoding="utf-8",
        )
        result = self.run_checker("--config", str(config), str(path))
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertNotIn("MYSQL104", result.stdout)

    def test_expired_exception_fails_and_does_not_suppress(self) -> None:
        path = self.write("migrations/sql/001_legacy.sql", "SELECT COUNT(id) FROM t;")
        config = self.project / ".mysql-guard.toml"
        config.write_text(
            '[[exceptions]]\nrule="MYSQL104"\npath="migrations/sql/001_legacy.sql"\n'
            'reason="legacy report"\nowner="database-team"\nexpires="2000-01-01"\n',
            encoding="utf-8",
        )
        result = self.run_checker("--config", str(config), str(path))
        self.assertEqual(result.returncode, 1)
        self.assertIn("MYSQL900", result.stdout)
        self.assertIn("MYSQL104", result.stdout)

    def test_stale_exception_fails(self) -> None:
        path = self.write("migrations/sql/001_clean.sql", "SELECT COUNT(*) FROM t;")
        config = self.project / ".mysql-guard.toml"
        config.write_text(
            '[[exceptions]]\nrule="MYSQL104"\npath="migrations/sql/001_clean.sql"\n'
            'reason="legacy report"\nowner="database-team"\nexpires="2999-12-31"\n',
            encoding="utf-8",
        )
        result = self.run_checker("--config", str(config), str(path))
        self.assertEqual(result.returncode, 1)
        self.assertIn("MYSQL900", result.stdout)

    def test_changed_since_with_no_sql_changes_passes(self) -> None:
        subprocess.run(["git", "init"], cwd=self.project, check=True, capture_output=True)
        subprocess.run(["git", "config", "user.email", "test@example.com"], cwd=self.project, check=True)
        subprocess.run(["git", "config", "user.name", "Test"], cwd=self.project, check=True)
        self.write("README.md", "baseline\n")
        subprocess.run(["git", "add", "README.md"], cwd=self.project, check=True)
        subprocess.run(["git", "commit", "-m", "baseline"], cwd=self.project, check=True, capture_output=True)
        result = self.run_checker(
            "--project-root", str(self.project), "--changed-since", "HEAD"
        )
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)

    def test_non_suppressible_rules_reject_exceptions(self) -> None:
        cases = {
            "MYSQL007": "CREATE VIEW active_order AS SELECT 1;",
            "MYSQL010": "DROP TABLE order_item;",
            "MYSQL015": "ALTER TABLE order_item ADD FOREIGN KEY (user_id) REFERENCES user(id);",
        }
        for index, (rule, sql) in enumerate(cases.items(), 1):
            with self.subTest(rule=rule):
                relative = f"migrations/sql/{index:03d}_blocked.sql"
                path = self.write(relative, sql)
                config = self.project / f"guard-{index}.toml"
                config.write_text(
                    f'[[exceptions]]\nrule="{rule}"\npath="{relative}"\n'
                    'reason="Legacy SQL"\nowner="database-team"\nexpires="2999-12-31"\n',
                    encoding="utf-8",
                )
                result = self.run_checker("--config", str(config), str(path))
                self.assertEqual(result.returncode, 1)
                self.assertIn(rule, result.stdout)
                self.assertIn("MYSQL900", result.stdout)


if __name__ == "__main__":
    unittest.main()
