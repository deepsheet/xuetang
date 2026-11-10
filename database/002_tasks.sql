-- ============================================================
-- 学徒考勤系统 · 任务系统
-- ============================================================

USE apprentice_attendance;

CREATE TABLE IF NOT EXISTS xt_tasks (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  title VARCHAR(120) NOT NULL,
  description TEXT NULL,
  assigned_to BIGINT UNSIGNED NOT NULL,
  created_by BIGINT UNSIGNED NOT NULL,
  status ENUM('pending', 'in_progress', 'completed', 'cancelled') NOT NULL DEFAULT 'pending',
  priority ENUM('low', 'normal', 'high') NOT NULL DEFAULT 'normal',
  due_at DATETIME(3) NULL,
  started_at DATETIME(3) NULL,
  completed_at DATETIME(3) NULL,
  cancelled_at DATETIME(3) NULL,
  review_note VARCHAR(500) NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  KEY idx_tasks_assigned_status (assigned_to, status),
  KEY idx_tasks_due (due_at),
  KEY idx_tasks_created_by (created_by),
  CONSTRAINT fk_tasks_assigned_to FOREIGN KEY (assigned_to) REFERENCES xt_accounts (id)
    ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT fk_tasks_created_by FOREIGN KEY (created_by) REFERENCES xt_accounts (id)
    ON DELETE RESTRICT ON UPDATE RESTRICT
) ENGINE=InnoDB
  DEFAULT CHARSET=utf8mb4
  COLLATE=utf8mb4_0900_ai_ci;

INSERT INTO xt_schema_migrations (version, description)
VALUES (2, 'task management: tasks assigned to apprentices')
ON DUPLICATE KEY UPDATE description = VALUES(description);

SHOW TABLES;
SELECT version, description, applied_at FROM xt_schema_migrations ORDER BY version;
