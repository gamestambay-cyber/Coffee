-- Maple's Bean Firebase + PHP/MySQL role schema
-- Firebase UID should be stored in users.firebase_uid.

ALTER TABLE users
  MODIFY role ENUM('customer','staff','seller','admin','superadmin')
  DEFAULT 'customer';

ALTER TABLE users
  ADD COLUMN IF NOT EXISTS firebase_uid VARCHAR(128) NULL UNIQUE;

CREATE TABLE IF NOT EXISTS inventory_audit (
  id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  product_id BIGINT UNSIGNED NOT NULL,
  changed_by VARCHAR(128) NULL,
  delta INT NOT NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS sales_sync (
  id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  firebase_uid VARCHAR(128) NULL,
  order_id VARCHAR(128) NOT NULL,
  total DECIMAL(12,2) NOT NULL DEFAULT 0,
  source ENUM('pos','online') NOT NULL DEFAULT 'online',
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uq_order_id(order_id)
);
