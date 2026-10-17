USE maplesbean;

ALTER TABLE reviews
  ADD COLUMN IF NOT EXISTS firebase_review_id VARCHAR(128) NULL UNIQUE;

ALTER TABLE users
  MODIFY role ENUM('customer','staff','seller','admin','superadmin') DEFAULT 'customer';

-- Firebase is authoritative. These tables are mirrors only.

-- Operations upgrade: product suppliers, receiving/delivery, inventory locations, and PH VAT.
ALTER TABLE products
  ADD COLUMN IF NOT EXISTS supplier VARCHAR(255) NULL,
  ADD COLUMN IF NOT EXISTS supplier_sku VARCHAR(100) NULL,
  ADD COLUMN IF NOT EXISTS supplier_contact VARCHAR(255) NULL,
  ADD COLUMN IF NOT EXISTS delivery_lead_days INT UNSIGNED DEFAULT 3,
  ADD COLUMN IF NOT EXISTS delivery_status VARCHAR(40) DEFAULT 'ready',
  ADD COLUMN IF NOT EXISTS delivery_date BIGINT UNSIGNED NULL,
  ADD COLUMN IF NOT EXISTS inventory_location VARCHAR(255) DEFAULT 'Main warehouse',
  ADD COLUMN IF NOT EXISTS reorder_level INT UNSIGNED DEFAULT 5,
  ADD COLUMN IF NOT EXISTS vat_rate DECIMAL(5,2) DEFAULT 12.00,
  ADD COLUMN IF NOT EXISTS vat_type VARCHAR(20) DEFAULT 'standard',
  ADD COLUMN IF NOT EXISTS vat_inclusive TINYINT(1) DEFAULT 1,
  ADD COLUMN IF NOT EXISTS price_ex_vat DECIMAL(10,2) DEFAULT 0.00,
  ADD COLUMN IF NOT EXISTS vat_amount DECIMAL(10,2) DEFAULT 0.00;

ALTER TABLE orders
  ADD COLUMN IF NOT EXISTS vat JSON NULL,
  ADD COLUMN IF NOT EXISTS delivery JSON NULL;

CREATE TABLE IF NOT EXISTS suppliers (
  id VARCHAR(64) PRIMARY KEY,
  name VARCHAR(255) NOT NULL,
  contact VARCHAR(255) DEFAULT '',
  email VARCHAR(255) DEFAULT '',
  phone VARCHAR(50) DEFAULT '',
  address TEXT NULL,
  created_at BIGINT UNSIGNED NOT NULL
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS deliveries (
  id VARCHAR(64) PRIMARY KEY,
  product_id VARCHAR(32) NULL,
  supplier_id VARCHAR(64) NULL,
  supplier_name VARCHAR(255) DEFAULT '',
  quantity INT NOT NULL DEFAULT 0,
  status VARCHAR(40) DEFAULT 'pending',
  expected_at BIGINT UNSIGNED NULL,
  received_at BIGINT UNSIGNED NULL,
  notes TEXT NULL,
  created_at BIGINT UNSIGNED NOT NULL,
  INDEX idx_deliveries_product (product_id),
  INDEX idx_deliveries_status (status)
) ENGINE=InnoDB;
