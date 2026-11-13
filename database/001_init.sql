-- ============================================================
-- 深表学堂考勤系统系统 · MySQL 8.4 初始表结构
-- 数据库：xueting
-- 说明：学号/工号由系统注册时分配，不使用班级/工种字段
-- ============================================================

CREATE DATABASE IF NOT EXISTS xueting
  CHARACTER SET utf8mb4
  COLLATE utf8mb4_0900_ai_ci;

USE xueting;

CREATE TABLE IF NOT EXISTS xt_schema_migrations (
  version INT UNSIGNED NOT NULL,
  description VARCHAR(255) NOT NULL,
  applied_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (version)
) ENGINE=InnoDB
  DEFAULT CHARSET=utf8mb4
  COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE IF NOT EXISTS xt_accounts (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  number VARCHAR(20) CHARACTER SET ascii COLLATE ascii_bin NOT NULL COMMENT '学号或工号，注册时分配',
  number_type ENUM('student', 'staff') NOT NULL COMMENT 'student=学号，staff=工号',
  display_name VARCHAR(50) NOT NULL,
  role ENUM('admin', 'apprentice') NOT NULL DEFAULT 'apprentice',
  password_hash VARCHAR(255) CHARACTER SET ascii COLLATE ascii_bin NOT NULL COMMENT 'scrypt 哈希',
  status ENUM('active', 'disabled') NOT NULL DEFAULT 'active',
  must_change_password TINYINT(1) NOT NULL DEFAULT 1,
  failed_login_count SMALLINT UNSIGNED NOT NULL DEFAULT 0,
  locked_until DATETIME(3) NULL,
  last_login_at DATETIME(3) NULL,
  password_changed_at DATETIME(3) NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  UNIQUE KEY uq_accounts_number (number),
  KEY idx_accounts_role_status (role, status),
  KEY idx_accounts_number_type (number_type),
  CONSTRAINT chk_accounts_role_number CHECK (
    (role = 'admin' AND number_type = 'staff') OR
    (role = 'apprentice' AND number_type = 'student')
  )
) ENGINE=InnoDB
  DEFAULT CHARSET=utf8mb4
  COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE IF NOT EXISTS xt_number_sequences (
  sequence_year SMALLINT UNSIGNED NOT NULL,
  number_type ENUM('student', 'staff') NOT NULL,
  next_value INT UNSIGNED NOT NULL DEFAULT 1,
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (sequence_year, number_type)
) ENGINE=InnoDB
  DEFAULT CHARSET=utf8mb4
  COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE IF NOT EXISTS xt_sessions (
  id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  account_id BIGINT UNSIGNED NOT NULL,
  token_hash CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  ip_address VARCHAR(45) CHARACTER SET ascii COLLATE ascii_bin NULL,
  user_agent VARCHAR(255) NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  last_seen_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  expires_at DATETIME(3) NOT NULL,
  revoked_at DATETIME(3) NULL,
  PRIMARY KEY (id),
  UNIQUE KEY uq_sessions_token_hash (token_hash),
  KEY idx_sessions_account (account_id),
  KEY idx_sessions_expires (expires_at),
  CONSTRAINT fk_sessions_account FOREIGN KEY (account_id) REFERENCES xt_accounts (id)
    ON DELETE CASCADE ON UPDATE RESTRICT
) ENGINE=InnoDB
  DEFAULT CHARSET=utf8mb4
  COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE IF NOT EXISTS xt_attendance_records (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  account_id BIGINT UNSIGNED NOT NULL,
  check_in_at DATETIME(3) NOT NULL,
  check_out_at DATETIME(3) NULL,
  check_in_lat DECIMAL(10, 7) NULL,
  check_in_lng DECIMAL(10, 7) NULL,
  check_in_accuracy DECIMAL(8, 2) NULL,
  check_in_address VARCHAR(255) NULL,
  check_out_lat DECIMAL(10, 7) NULL,
  check_out_lng DECIMAL(10, 7) NULL,
  check_out_accuracy DECIMAL(8, 2) NULL,
  check_out_address VARCHAR(255) NULL,
  duration_seconds INT UNSIGNED GENERATED ALWAYS AS (
    CASE
      WHEN check_out_at IS NULL THEN NULL
      ELSE TIMESTAMPDIFF(SECOND, check_in_at, check_out_at)
    END
  ) STORED,
  status ENUM('active', 'completed', 'voided') NOT NULL DEFAULT 'active',
  source ENUM('self', 'admin') NOT NULL DEFAULT 'self',
  created_by BIGINT UNSIGNED NULL,
  updated_by BIGINT UNSIGNED NULL,
  note VARCHAR(255) NULL,
  active_account_id BIGINT UNSIGNED GENERATED ALWAYS AS (
    CASE
      WHEN check_out_at IS NULL AND status = 'active' THEN account_id
      ELSE NULL
    END
  ) STORED,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  UNIQUE KEY uq_attendance_active_account (active_account_id),
  KEY idx_attendance_account_checkin (account_id, check_in_at),
  KEY idx_attendance_checkin (check_in_at),
  KEY idx_attendance_checkout (check_out_at),
  KEY idx_attendance_status (status),
  KEY idx_attendance_created_by (created_by),
  KEY idx_attendance_updated_by (updated_by),
  CONSTRAINT fk_attendance_account FOREIGN KEY (account_id) REFERENCES xt_accounts (id)
    ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT fk_attendance_created_by FOREIGN KEY (created_by) REFERENCES xt_accounts (id)
    ON DELETE SET NULL ON UPDATE RESTRICT,
  CONSTRAINT fk_attendance_updated_by FOREIGN KEY (updated_by) REFERENCES xt_accounts (id)
    ON DELETE SET NULL ON UPDATE RESTRICT,
  CONSTRAINT chk_attendance_checkout_after_checkin CHECK (
    check_out_at IS NULL OR check_out_at >= check_in_at
  ),
  CONSTRAINT chk_attendance_status_checkout CHECK (
    (status = 'active' AND check_out_at IS NULL) OR
    (status = 'completed' AND check_out_at IS NOT NULL) OR
    status = 'voided'
  ),
  CONSTRAINT chk_attendance_checkin_lat CHECK (
    check_in_lat IS NULL OR (check_in_lat >= -90 AND check_in_lat <= 90)
  ),
  CONSTRAINT chk_attendance_checkout_lat CHECK (
    check_out_lat IS NULL OR (check_out_lat >= -90 AND check_out_lat <= 90)
  ),
  CONSTRAINT chk_attendance_checkin_lng CHECK (
    check_in_lng IS NULL OR (check_in_lng >= -180 AND check_in_lng <= 180)
  ),
  CONSTRAINT chk_attendance_checkout_lng CHECK (
    check_out_lng IS NULL OR (check_out_lng >= -180 AND check_out_lng <= 180)
  ),
  CONSTRAINT chk_attendance_accuracy CHECK (
    (check_in_accuracy IS NULL OR check_in_accuracy >= 0) AND
    (check_out_accuracy IS NULL OR check_out_accuracy >= 0)
  )
) ENGINE=InnoDB
  DEFAULT CHARSET=utf8mb4
  COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE IF NOT EXISTS xt_audit_logs (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  actor_account_id BIGINT UNSIGNED NULL,
  action VARCHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  target_type VARCHAR(32) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  target_id BIGINT UNSIGNED NULL,
  detail JSON NULL,
  ip_address VARCHAR(45) CHARACTER SET ascii COLLATE ascii_bin NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  KEY idx_audit_created_at (created_at),
  KEY idx_audit_actor (actor_account_id),
  KEY idx_audit_target (target_type, target_id),
  CONSTRAINT fk_audit_actor FOREIGN KEY (actor_account_id) REFERENCES xt_accounts (id)
    ON DELETE SET NULL ON UPDATE RESTRICT
) ENGINE=InnoDB
  DEFAULT CHARSET=utf8mb4
  COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE IF NOT EXISTS xt_login_attempts (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  login_number VARCHAR(20) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  ip_address VARCHAR(45) CHARACTER SET ascii COLLATE ascii_bin NULL,
  user_agent VARCHAR(255) NULL,
  success TINYINT(1) NOT NULL DEFAULT 0,
  attempted_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  KEY idx_login_attempts_number_time (login_number, attempted_at),
  KEY idx_login_attempts_ip_time (ip_address, attempted_at)
) ENGINE=InnoDB
  DEFAULT CHARSET=utf8mb4
  COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE IF NOT EXISTS xt_app_settings (
  setting_key VARCHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  setting_value JSON NOT NULL,
  updated_by BIGINT UNSIGNED NULL,
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (setting_key),
  KEY idx_app_settings_updated_by (updated_by),
  CONSTRAINT fk_app_settings_updated_by FOREIGN KEY (updated_by) REFERENCES xt_accounts (id)
    ON DELETE SET NULL ON UPDATE RESTRICT
) ENGINE=InnoDB
  DEFAULT CHARSET=utf8mb4
  COLLATE=utf8mb4_0900_ai_ci;

INSERT IGNORE INTO xt_number_sequences (sequence_year, number_type, next_value)
VALUES (2026, 'student', 1), (2026, 'staff', 1);

INSERT IGNORE INTO xt_app_settings (setting_key, setting_value)
VALUES
  ('school_name', '"深表学堂考勤系统"'),
  ('timezone', '"Asia/Shanghai"'),
  ('attendance_radius_m', '300'),
  ('session_ttl_hours', '12');

INSERT INTO xt_schema_migrations (version, description)
VALUES (1, 'initial schema: accounts, attendance, sessions, audit, settings')
ON DUPLICATE KEY UPDATE description = VALUES(description);

-- 查看初始化结果（执行时会输出）
SHOW TABLES;
SELECT version, description, applied_at FROM xt_schema_migrations ORDER BY version;
