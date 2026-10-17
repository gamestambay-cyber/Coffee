<?php
// Firebase is the source of truth. This endpoint only PULLS Firebase data
// and mirrors it into MySQL. The website never writes business data to MySQL.
require_once __DIR__ . '/bootstrap.php';

$method = $_SERVER['REQUEST_METHOD'];
if ($method !== 'POST' && $method !== 'GET') json_err('Method not allowed', 405);

try {
    // Sync is intentionally a pull operation. In production, protect this
    // endpoint with a server-only cron token or Firebase Admin verification.
    $result = firebaseMirrorAll(db());
    json_ok($result);
} catch (Throwable $e) {
    json_err($e->getMessage(), 500);
}

function firebaseGet(string $path): ?array {
    $cfg = require __DIR__ . '/../config/config.php';
    $base = rtrim($cfg['firebase']['database_url'], '/') . '/';
    $url = $base . ltrim($path, '/') . '.json';
    if (!empty($cfg['firebase']['auth_token'])) {
        $url .= '?auth=' . urlencode($cfg['firebase']['auth_token']);
    }

    $ch = curl_init($url);
    curl_setopt_array($ch, [
        CURLOPT_RETURNTRANSFER => true,
        CURLOPT_TIMEOUT => 15,
        CURLOPT_HTTPHEADER => ['Accept: application/json'],
    ]);
    $body = curl_exec($ch);
    $code = curl_getinfo($ch, CURLINFO_HTTP_CODE);
    $err = curl_error($ch);
    curl_close($ch);

    if ($body === false || $code >= 400) {
        throw new RuntimeException('Firebase read failed for ' . $path . ($err ? ': '.$err : ''));
    }
    if ($body === 'null' || $body === '') return null;
    $data = json_decode($body, true);
    return is_array($data) ? $data : null;
}

function firebaseMirrorAll(PDO $pdo): array {
    $stats = ['users'=>0,'products'=>0,'orders'=>0,'reviews'=>0,'sellers'=>0,'carts'=>0];

    $users = firebaseGet('users') ?? [];
    foreach ($users as $uid => $u) {
        if (!is_array($u)) continue;
        $username = trim((string)($u['username'] ?? $u['name'] ?? 'Firebase User'));
        $email = trim((string)($u['email'] ?? ''));
        if ($email === '') $email = $uid . '@firebase.local';
        $role = normalizeRole($u['role'] ?? 'customer');
        $created = (int)($u['createdAt'] ?? round(microtime(true)*1000));
        $phone = (string)($u['phone'] ?? '');
        $points = (int)($u['loyaltyPoints'] ?? 0);

        $stmt = $pdo->prepare('SELECT id FROM users WHERE firebase_uid = ? LIMIT 1');
        $stmt->execute([$uid]);
        $id = $stmt->fetchColumn();
        if ($id) {
            $pdo->prepare('UPDATE users SET username=?,email=?,phone=?,role=?,loyalty_points=?,created_at=? WHERE id=?')
                ->execute([$username,$email,$phone,$role,$points,$created,$id]);
        } else {
            // Email can already exist from an older MySQL record.
            $stmt = $pdo->prepare('SELECT id FROM users WHERE email=? LIMIT 1');
            $stmt->execute([$email]);
            $existing = $stmt->fetchColumn();
            if ($existing) {
                $pdo->prepare('UPDATE users SET firebase_uid=?,username=?,phone=?,role=?,loyalty_points=?,created_at=? WHERE id=?')
                    ->execute([$uid,$username,$phone,$role,$points,$created,$existing]);
            } else {
                $pdo->prepare('INSERT INTO users(firebase_uid,username,email,phone,role,loyalty_points,created_at) VALUES(?,?,?,?,?,?,?)')
                    ->execute([$uid,$username,$email,$phone,$role,$points,$created]);
            }
        }
        $stats['users']++;
    }

    $products = firebaseGet('mb_products') ?? [];
    foreach ($products as $id => $p) {
        if (!is_array($p)) continue;
        $id = (string)($p['id'] ?? $id);
        $sizes = json_encode($p['sizes'] ?? [], JSON_UNESCAPED_UNICODE);
        $colors = json_encode($p['colors'] ?? [], JSON_UNESCAPED_UNICODE);
        $images = json_encode($p['images'] ?? [], JSON_UNESCAPED_UNICODE);
        $stmt = $pdo->prepare('SELECT id FROM products WHERE id=?');
        $stmt->execute([$id]);
        $exists = $stmt->fetchColumn();
        $vals = [
            (string)($p['name'] ?? ''), (float)($p['price'] ?? 0),
            isset($p['oldPrice']) ? (float)$p['oldPrice'] : null,
            (int)($p['stock'] ?? 0), (string)($p['category'] ?? 'beans'),
            $sizes,$colors,$images,(string)($p['desc'] ?? $p['description'] ?? ''),
            !empty($p['featured']) ? 1 : 0,!empty($p['sale']) ? 1 : 0,
            (float)($p['avgRating'] ?? 0),(int)($p['reviewCount'] ?? 0),
            $p['sellerUid'] ?? null,(string)($p['supplier'] ?? ''),(string)($p['supplierSku'] ?? ''),(string)($p['supplierContact'] ?? ''),
            (int)($p['deliveryLeadDays'] ?? 3),(string)($p['deliveryStatus'] ?? 'ready'),!empty($p['deliveryDate'])?(int)$p['deliveryDate']:null,
            (string)($p['inventoryLocation'] ?? 'Main warehouse'),(int)($p['reorderLevel'] ?? 5),(float)($p['vatRate'] ?? 12),
            (string)($p['vatType'] ?? 'standard'),array_key_exists('vatInclusive',$p)?(!empty($p['vatInclusive'])?1:0):1,
            (float)($p['priceExVat'] ?? 0),(float)($p['vatAmount'] ?? 0),(int)($p['createdAt'] ?? round(microtime(true)*1000)),$id
        ];
        if ($exists) {
            $pdo->prepare('UPDATE products SET name=?,price=?,old_price=?,stock=?,category=?,sizes=?,colors=?,images=?,description=?,featured=?,sale=?,avg_rating=?,review_count=?,seller_uid=?,supplier=?,supplier_sku=?,supplier_contact=?,delivery_lead_days=?,delivery_status=?,delivery_date=?,inventory_location=?,reorder_level=?,vat_rate=?,vat_type=?,vat_inclusive=?,price_ex_vat=?,vat_amount=?,created_at=? WHERE id=?')->execute($vals);
        } else {
            $pdo->prepare('INSERT INTO products(name,price,old_price,stock,category,sizes,colors,images,description,featured,sale,avg_rating,review_count,seller_uid,supplier,supplier_sku,supplier_contact,delivery_lead_days,delivery_status,delivery_date,inventory_location,reorder_level,vat_rate,vat_type,vat_inclusive,price_ex_vat,vat_amount,created_at,id) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)')->execute($vals);
        }
        $stats['products']++;
    }

    $orders = firebaseGet('orders') ?? [];
    foreach ($orders as $orderId => $o) {
        if (!is_array($o)) continue;
        $uid = (string)($o['user'] ?? $o['firebaseUid'] ?? '');
        $userId = null;
        if ($uid !== '') {
            $stmt=$pdo->prepare('SELECT id FROM users WHERE firebase_uid=? LIMIT 1');
            $stmt->execute([$uid]); $userId=$stmt->fetchColumn() ?: null;
        }
        $items=json_encode($o['items'] ?? [], JSON_UNESCAPED_UNICODE);
        $shipping=json_encode($o['shipping'] ?? [], JSON_UNESCAPED_UNICODE);
        $subtotal=(float)($o['sub'] ?? $o['subtotal'] ?? $o['total'] ?? 0);
        $total=(float)($o['total'] ?? 0);
        $created=(int)($o['createdAt'] ?? round(microtime(true)*1000));
        $vat=json_encode($o['vat'] ?? [], JSON_UNESCAPED_UNICODE);
        $delivery=json_encode($o['delivery'] ?? [], JSON_UNESCAPED_UNICODE);
        $stmt=$pdo->prepare('INSERT INTO orders(id,user_id,firebase_uid,email,items,subtotal,total,pay_method,shipping,vat,delivery,status,source,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?) ON DUPLICATE KEY UPDATE user_id=VALUES(user_id),firebase_uid=VALUES(firebase_uid),email=VALUES(email),items=VALUES(items),subtotal=VALUES(subtotal),total=VALUES(total),pay_method=VALUES(pay_method),shipping=VALUES(shipping),vat=VALUES(vat),delivery=VALUES(delivery),status=VALUES(status),source=VALUES(source),created_at=VALUES(created_at)');
        $stmt->execute([(string)$orderId,$userId,$uid ?: null,(string)($o['email'] ?? ''),$items,$subtotal,$total,(string)($o['payMethod'] ?? 'Cash on Delivery'),$shipping,$vat,$delivery,(string)($o['status'] ?? 'processing'),(string)($o['source'] ?? 'web'),$created]);
        $stats['orders']++;
    }

    $reviews = firebaseGet('reviews') ?? [];
    foreach ($reviews as $productId => $productReviews) {
        if (!is_array($productReviews)) continue;
        foreach ($productReviews as $reviewId => $r) {
            if (!is_array($r)) continue;
            $stmt=$pdo->prepare('SELECT id FROM reviews WHERE firebase_review_id=? LIMIT 1');
            $stmt->execute([(string)$reviewId]);
            $exists=$stmt->fetchColumn();
            $vals=[(string)$productId,null,(string)($r['username'] ?? 'Anonymous'),max(1,min(5,(int)($r['rating'] ?? 5))),(string)($r['text'] ?? ''),(int)($r['createdAt'] ?? round(microtime(true)*1000)),(string)$reviewId];
            if ($exists) $pdo->prepare('UPDATE reviews SET product_id=?,username=?,rating=?,text=?,created_at=? WHERE id=?')->execute([$vals[0],$vals[2],$vals[3],$vals[4],$vals[5],$exists]);
            else $pdo->prepare('INSERT INTO reviews(product_id,user_id,username,rating,text,created_at,firebase_review_id) VALUES(?,?,?,?,?,?,?)')->execute($vals);
            $stats['reviews']++;
        }
    }

    $sellers = firebaseGet('sellers') ?? [];
    foreach ($sellers as $uid => $s) {
        if (!is_array($s)) continue;
        $stmt=$pdo->prepare('SELECT id FROM users WHERE firebase_uid=? LIMIT 1');
        $stmt->execute([(string)$uid]); $userId=$stmt->fetchColumn();
        if (!$userId) continue;
        $pdo->prepare('INSERT INTO sellers(user_id,username,email,approved,applied_at) VALUES(?,?,?,?,?) ON DUPLICATE KEY UPDATE username=VALUES(username),email=VALUES(email),approved=VALUES(approved),applied_at=VALUES(applied_at)')
            ->execute([$userId,(string)($s['username'] ?? ''),(string)($s['email'] ?? ''),!empty($s['approved'])?1:0,(int)($s['appliedAt'] ?? round(microtime(true)*1000))]);
        $stats['sellers']++;
    }

    $carts = firebaseGet('carts') ?? [];
    foreach ($carts as $uid => $c) {
        if (!is_array($c)) continue;
        $stmt=$pdo->prepare('SELECT id FROM users WHERE firebase_uid=? LIMIT 1');
        $stmt->execute([(string)$uid]); $userId=$stmt->fetchColumn();
        if (!$userId) continue;
        $pdo->prepare('INSERT INTO carts(user_id,items,email,updated_at) VALUES(?,?,?,?) ON DUPLICATE KEY UPDATE items=VALUES(items),email=VALUES(email),updated_at=VALUES(updated_at)')
            ->execute([$userId,json_encode($c['items'] ?? [], JSON_UNESCAPED_UNICODE),(string)($c['email'] ?? ''),(int)($c['updatedAt'] ?? round(microtime(true)*1000))]);
        $stats['carts']++;
    }

    return $stats;
}

function normalizeRole($role): string {
    $r = strtolower(trim((string)$role));
    $r = str_replace([' ','-'], '_', $r);
    return match ($r) {
        'super_admin','superadmin' => 'superadmin',
        'admin' => 'admin',
        'staff' => 'staff',
        'seller' => 'seller',
        default => 'customer',
    };
}
