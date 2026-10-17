-- ============================================================
-- Maple's Bean — MySQL Database (import in HeidiSQL)
-- Database: maplesbean
-- ============================================================

CREATE DATABASE IF NOT EXISTS `maplesbean`
  CHARACTER SET utf8mb4
  COLLATE utf8mb4_unicode_ci;

USE `maplesbean`;

-- ── Users ──────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS `users` (
  `id`            INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  `firebase_uid`  VARCHAR(128) NULL UNIQUE,
  `username`      VARCHAR(100) NOT NULL,
  `email`         VARCHAR(255) NOT NULL UNIQUE,
  `phone`         VARCHAR(30)  DEFAULT '',
  `password_hash` VARCHAR(255) NULL,
  `role`          ENUM('customer','staff','seller','admin','superadmin') DEFAULT 'customer',
  `loyalty_points` INT UNSIGNED DEFAULT 0,
  `created_at`    BIGINT UNSIGNED NOT NULL,
  INDEX `idx_users_role` (`role`)
) ENGINE=InnoDB;

-- ── Products ───────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS `products` (
  `id`           VARCHAR(32) PRIMARY KEY,
  `name`         VARCHAR(255) NOT NULL,
  `price`        DECIMAL(10,2) NOT NULL,
  `old_price`    DECIMAL(10,2) NULL,
  `stock`        INT NOT NULL DEFAULT 0,
  `category`     VARCHAR(50) NOT NULL,
  `sizes`        JSON NULL,
  `colors`       JSON NULL,
  `images`       JSON NULL,
  `description`  TEXT NULL,
  `featured`     TINYINT(1) DEFAULT 0,
  `sale`         TINYINT(1) DEFAULT 0,
  `avg_rating`   DECIMAL(3,1) DEFAULT 0,
  `review_count` INT UNSIGNED DEFAULT 0,
  `seller_uid`   VARCHAR(128) NULL,
  `supplier`     VARCHAR(255) NULL,
  `supplier_sku` VARCHAR(100) NULL,
  `supplier_contact` VARCHAR(255) NULL,
  `delivery_lead_days` INT UNSIGNED DEFAULT 3,
  `delivery_status` VARCHAR(40) DEFAULT 'ready',
  `delivery_date` BIGINT UNSIGNED NULL,
  `inventory_location` VARCHAR(255) DEFAULT 'Main warehouse',
  `reorder_level` INT UNSIGNED DEFAULT 5,
  `vat_rate` DECIMAL(5,2) DEFAULT 12.00,
  `vat_type` VARCHAR(20) DEFAULT 'standard',
  `vat_inclusive` TINYINT(1) DEFAULT 1,
  `price_ex_vat` DECIMAL(10,2) DEFAULT 0.00,
  `vat_amount` DECIMAL(10,2) DEFAULT 0.00,
  `created_at`   BIGINT UNSIGNED NOT NULL,
  INDEX `idx_products_category` (`category`),
  INDEX `idx_products_featured` (`featured`)
) ENGINE=InnoDB;

-- ── Orders ─────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS `orders` (
  `id`           VARCHAR(64) PRIMARY KEY,
  `user_id`      INT UNSIGNED NULL,
  `firebase_uid` VARCHAR(128) NULL,
  `email`        VARCHAR(255) NULL,
  `items`        JSON NOT NULL,
  `subtotal`     DECIMAL(10,2) NOT NULL,
  `total`        DECIMAL(10,2) NOT NULL,
  `pay_method`   VARCHAR(50) DEFAULT 'Cash on Delivery',
  `shipping`     JSON NULL,
  `vat`          JSON NULL,
  `delivery`     JSON NULL,
  `status`       ENUM('processing','fulfilled','shipped','delivered','cancelled','refunded') DEFAULT 'processing',
  `source`       VARCHAR(20) DEFAULT 'web',
  `created_at`   BIGINT UNSIGNED NOT NULL,
  INDEX `idx_orders_user` (`user_id`),
  INDEX `idx_orders_status` (`status`)
) ENGINE=InnoDB;


-- ── Suppliers ──────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS `suppliers` (
  `id` VARCHAR(64) PRIMARY KEY,
  `name` VARCHAR(255) NOT NULL,
  `contact` VARCHAR(255) DEFAULT '',
  `email` VARCHAR(255) DEFAULT '',
  `phone` VARCHAR(50) DEFAULT '',
  `address` TEXT NULL,
  `created_at` BIGINT UNSIGNED NOT NULL,
  INDEX `idx_suppliers_name` (`name`)
) ENGINE=InnoDB;

-- ── Product deliveries / receiving log ─────────────────────
CREATE TABLE IF NOT EXISTS `deliveries` (
  `id` VARCHAR(64) PRIMARY KEY,
  `product_id` VARCHAR(32) NULL,
  `supplier_id` VARCHAR(64) NULL,
  `supplier_name` VARCHAR(255) DEFAULT '',
  `quantity` INT NOT NULL DEFAULT 0,
  `status` VARCHAR(40) DEFAULT 'pending',
  `expected_at` BIGINT UNSIGNED NULL,
  `received_at` BIGINT UNSIGNED NULL,
  `notes` TEXT NULL,
  `created_at` BIGINT UNSIGNED NOT NULL,
  INDEX `idx_deliveries_product` (`product_id`),
  INDEX `idx_deliveries_status` (`status`)
) ENGINE=InnoDB;

-- ── Reviews ────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS `reviews` (
  `id`         INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  `product_id` VARCHAR(32) NOT NULL,
  `user_id`    INT UNSIGNED NULL,
  `username`   VARCHAR(100) DEFAULT 'Anonymous',
  `rating`     TINYINT UNSIGNED NOT NULL DEFAULT 5,
  `text`       TEXT NOT NULL,
  `created_at` BIGINT UNSIGNED NOT NULL,
  `firebase_review_id` VARCHAR(128) NULL UNIQUE,
  INDEX `idx_reviews_product` (`product_id`),
  FOREIGN KEY (`product_id`) REFERENCES `products`(`id`) ON DELETE CASCADE
) ENGINE=InnoDB;

-- ── Sellers ────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS `sellers` (
  `user_id`    INT UNSIGNED PRIMARY KEY,
  `username`   VARCHAR(100) NOT NULL,
  `email`      VARCHAR(255) NOT NULL,
  `approved`   TINYINT(1) DEFAULT 0,
  `applied_at` BIGINT UNSIGNED NOT NULL,
  FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON DELETE CASCADE
) ENGINE=InnoDB;

-- ── Carts (abandoned cart recovery) ────────────────────────
CREATE TABLE IF NOT EXISTS `carts` (
  `user_id`    INT UNSIGNED PRIMARY KEY,
  `items`      JSON NOT NULL,
  `email`      VARCHAR(255) NULL,
  `updated_at` BIGINT UNSIGNED NOT NULL,
  FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON DELETE CASCADE
) ENGINE=InnoDB;

-- ── Newsletter ─────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS `newsletter` (
  `id`         INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  `email`      VARCHAR(255) NOT NULL UNIQUE,
  `created_at` BIGINT UNSIGNED NOT NULL
) ENGINE=InnoDB;

-- ── Default admin (password: password) ─────────────────────
INSERT INTO `users` (`username`, `email`, `phone`, `password_hash`, `role`, `loyalty_points`, `created_at`)
VALUES (
  'Admin',
  'admin@maplesbean.com',
  '',
  '$2y$10$92IXUNpkjO0rOQ5byMi.Ye4oKoEa3Ro9llC/.og/at2.uheWG/igi',
  'admin',
  0,
  UNIX_TIMESTAMP() * 1000
) ON DUPLICATE KEY UPDATE `username` = `username`;

-- ── Seed products ──────────────────────────────────────────
INSERT INTO `products` (`id`,`name`,`price`,`old_price`,`stock`,`category`,`sizes`,`colors`,`images`,`description`,`featured`,`sale`,`created_at`) VALUES
('mb001','Aglio E Olio',190.00,200.00,28,'pasta','["200g"]','[]','["c:\Users\Carla O\OneDrive\Pictures\Screenshots\Screenshot 2026-10-14 032854.png","c:\Users\Carla O\OneDrive\Pictures\Screenshots\Screenshot 2026-10-14 032854.png"]','c:\Users\Carla O\OneDrive\Pictures\Screenshots\Screenshot 2026-10-14 032854.png.',1,1,UNIX_TIMESTAMP()*1000-100000),
('mb002','Benguet Arabica — Light Roast',750.00,NULL,14,'beans','["250g","500g","1kg"]','[]','["https://images.unsplash.com/photo-1524350876685-274059332603?w=900&q=80","https://images.unsplash.com/photo-1442550528053-c431ecb55509?w=900&q=80"]','Bright and floral single-origin from the Cordillera highlands.',1,0,UNIX_TIMESTAMP()*1000-50000),
('mb003','Midnight Espresso Blend',820.00,NULL,0,'beans','["250g","500g","1kg"]','[]','["https://images.unsplash.com/photo-1610889556528-9a770e32642f?w=900&q=80"]','Dark roast espresso blend built for crema.',0,0,UNIX_TIMESTAMP()*1000-200000),
('mb004','Butter Croissant (Box of 4)',380.00,NULL,24,'pastries','["OS"]','[]','["https://images.unsplash.com/photo-1555507036-ab1f4038808a?w=900&q=80"]','Laminated all-butter croissants, baked fresh every morning.',1,0,UNIX_TIMESTAMP()*1000-300000),
('mb005','Cinnamon Roll — Single',150.00,180.00,15,'pastries','["OS"]','[]','["https://images.unsplash.com/photo-1509365465985-25d11c17e812?w=900&q=80"]','Soft brioche swirl with cinnamon sugar and cream cheese glaze.',0,1,UNIX_TIMESTAMP()*1000-10000),
('mb006','Maple''s Bean Ceramic Mug',520.00,NULL,18,'drinkware','["12oz"]','["#1a1a1a","#dcdcdc","#5a4a3a"]','["https://images.unsplash.com/photo-1517256064527-09c73fc73e38?w=900&q=80"]','Matte-glazed stoneware mug with the Maple''s Bean mark.',1,0,UNIX_TIMESTAMP()*1000-20000),
('mb007','Insulated Travel Tumbler',980.00,NULL,9,'drinkware','["16oz","20oz"]','["#1a1a1a","#5a5040"]','["https://images.unsplash.com/photo-1602243483516-1b0b0e0e7f2b?w=900&q=80"]','Double-walled stainless steel tumbler.',0,0,UNIX_TIMESTAMP()*1000-40000),
('mb008','Roaster''s Logo Tote Bag',450.00,NULL,20,'merch','["OS"]','["#dcdcdc","#1a1a1a"]','["https://images.unsplash.com/photo-1591561954557-26941169b49e?w=900&q=80"]','Heavy canvas tote with the roaster''s mark.',1,0,UNIX_TIMESTAMP()*1000-15000)
ON DUPLICATE KEY UPDATE `name` = VALUES(`name`);


-- Role upgrade for existing installations:
-- ALTER TABLE users MODIFY role ENUM('customer','staff','seller','admin','superadmin') DEFAULT 'customer';


-- Existing-installation upgrade (run once if your database predates these fields)
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
