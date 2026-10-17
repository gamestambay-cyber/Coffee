<?php
require_once __DIR__ . '/bootstrap.php';

$method = $_SERVER['REQUEST_METHOD'];
$pdo = db();

try {
    $user = require_management();

    if ($method === 'GET') {
        $products = $pdo->query('SELECT id,name,price,old_price,stock,category,featured,sale,images FROM products ORDER BY name ASC')->fetchAll();
        $orders = $pdo->query("SELECT id,user_id,email,items,subtotal,total,pay_method,status,source,created_at FROM orders ORDER BY created_at DESC LIMIT 500")->fetchAll();

        foreach ($products as &$p) {
            $p['price'] = (float)$p['price'];
            $p['oldPrice'] = $p['old_price'] !== null ? (float)$p['old_price'] : null;
            $p['stock'] = (int)$p['stock'];
            $p['featured'] = (bool)$p['featured'];
            $p['sale'] = (bool)$p['sale'];
            $p['images'] = json_decode($p['images'] ?? '[]', true) ?: [];
            unset($p['old_price']);
        }
        unset($p);

        foreach ($orders as &$o) {
            $o['items'] = json_decode($o['items'], true) ?: [];
            $o['total'] = (float)$o['total'];
            $o['subtotal'] = (float)$o['subtotal'];
            $o['createdAt'] = (int)$o['created_at'];
            unset($o['created_at']);
        }
        unset($o);

        $users = [];
        if (in_array($user['role'], ['admin','superadmin'], true)) {
            $users = $pdo->query('SELECT id,username,email,role,created_at FROM users ORDER BY created_at DESC')->fetchAll();
        }

        $revenue = (float)$pdo->query("SELECT COALESCE(SUM(total),0) FROM orders WHERE status NOT IN ('cancelled','refunded')")->fetchColumn();
        $todayStart = strtotime('today') * 1000;
        $todayRevenueStmt = $pdo->prepare("SELECT COALESCE(SUM(total),0) FROM orders WHERE created_at >= ? AND status NOT IN ('cancelled','refunded')");
        $todayRevenueStmt->execute([$todayStart]);
        $todayRevenue = (float)$todayRevenueStmt->fetchColumn();

        $lowStock = (int)$pdo->query("SELECT COUNT(*) FROM products WHERE stock < 5")->fetchColumn();
        $outStock = (int)$pdo->query("SELECT COUNT(*) FROM products WHERE stock <= 0")->fetchColumn();
        $orderCount = (int)$pdo->query("SELECT COUNT(*) FROM orders")->fetchColumn();

        json_ok([
            'role' => $user['role'],
            'products' => $products,
            'orders' => $orders,
            'users' => $users,
            'metrics' => [
                'revenue' => $revenue,
                'todayRevenue' => $todayRevenue,
                'orders' => $orderCount,
                'lowStock' => $lowStock,
                'outStock' => $outStock
            ]
        ]);
    }

    if ($method === 'POST') {
        $body = read_json_body();
        $action = $body['action'] ?? '';

        if ($action === 'sale') {
            $items = is_array($body['items'] ?? null) ? $body['items'] : [];
            if (!$items) json_err('Add at least one item.');

            $pdo->beginTransaction();
            try {
                $normalized = [];
                $subtotal = 0.0;

                foreach ($items as $item) {
                    $id = trim((string)($item['id'] ?? ''));
                    $qty = max(1, (int)($item['qty'] ?? 1));
                    if (!$id) json_err('A sale item is missing its product.', 400);

                    $stmt = $pdo->prepare('SELECT id,name,price,stock,images FROM products WHERE id=? FOR UPDATE');
                    $stmt->execute([$id]);
                    $product = $stmt->fetch();
                    if (!$product) json_err('Product not found: '.$id, 404);
                    if ((int)$product['stock'] < $qty) json_err($product['name'].' has insufficient stock.', 409);

                    $line = (float)$product['price'] * $qty;
                    $subtotal += $line;
                    $normalized[] = [
                        'id' => $product['id'],
                        'name' => $product['name'],
                        'price' => (float)$product['price'],
                        'qty' => $qty,
                        'image' => (json_decode($product['images'] ?? '[]', true)[0] ?? '')
                    ];

                    $pdo->prepare('UPDATE products SET stock = stock - ? WHERE id=?')->execute([$qty, $id]);
                }

                $discount = max(0, (float)($body['discount'] ?? 0));
                $tax = max(0, (float)($body['tax'] ?? 0));
                $total = max(0, $subtotal - $discount + $tax);
                $now = (int)(microtime(true) * 1000);
                $orderId = generateOrderId();

                $pdo->prepare('
                    INSERT INTO orders
                    (id,user_id,firebase_uid,email,items,subtotal,total,pay_method,shipping,status,source,created_at)
                    VALUES (?,?,?,?,?,?,?,?,?,?,?,?)
                ')->execute([
                    $orderId,
                    $user['id'],
                    $user['uid'] ?? null,
                    $body['email'] ?? ($user['email'] ?? ''),
                    json_encode($normalized),
                    $subtotal,
                    $total,
                    $body['payMethod'] ?? 'Cash',
                    json_encode(['customer' => trim((string)($body['customer'] ?? 'Walk-in'))]),
                    'fulfilled',
                    'POS',
                    $now
                ]);

                $points = (int)floor($total / 100);
                if ($points > 0) {
                    $pdo->prepare('UPDATE users SET loyalty_points = loyalty_points + ? WHERE id=?')->execute([$points, $user['id']]);
                }

                $pdo->commit();
                json_ok([
                    'orderId' => $orderId,
                    'subtotal' => $subtotal,
                    'discount' => $discount,
                    'tax' => $tax,
                    'total' => $total,
                    'items' => $normalized
                ], 201);
            } catch (Throwable $e) {
                if ($pdo->inTransaction()) $pdo->rollBack();
                throw $e;
            }
        }

        if ($action === 'product') {
            if (!in_array($user['role'], ['admin','superadmin'], true)) json_err('Administrator access required.', 403);

            $name = trim((string)($body['name'] ?? ''));
            if ($name === '') json_err('Product name is required.');
            $id = trim((string)($body['id'] ?? generateProductId()));
            $now = (int)(microtime(true) * 1000);

            $pdo->prepare('
                INSERT INTO products
                (id,name,price,old_price,stock,category,sizes,colors,images,description,featured,sale,seller_uid,created_at)
                VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)
            ')->execute([
                $id, $name, max(0,(float)($body['price'] ?? 0)),
                ($body['oldPrice'] ?? null) === '' ? null : ($body['oldPrice'] ?? null),
                max(0,(int)($body['stock'] ?? 0)),
                trim((string)($body['category'] ?? 'general')),
                json_encode($body['sizes'] ?? []),
                json_encode($body['colors'] ?? []),
                json_encode($body['images'] ?? []),
                trim((string)($body['desc'] ?? '')),
                !empty($body['featured']) ? 1 : 0,
                !empty($body['sale']) ? 1 : 0,
                $body['sellerUid'] ?? null,
                $now
            ]);
            json_ok(['id'=>$id], 201);
        }

        json_err('Unknown action.', 400);
    }

    if ($method === 'PATCH') {
        $body = read_json_body();
        $action = $body['action'] ?? 'stock';

        if ($action === 'role') {
            if ($user['role'] !== 'superadmin') json_err('Only a superadmin can change roles.', 403);
            $uid = trim((string)($body['uid'] ?? ''));
            $role = normalizeRole($body['role'] ?? 'customer');
            if (!$uid) json_err('User id is required.');
            if ($role === 'superadmin') json_err('A super admin cannot be added.', 403);
            $cur = $pdo->prepare('SELECT role FROM users WHERE firebase_uid=? OR CAST(id AS CHAR)=?');
            $cur->execute([$uid,$uid]);
            if ($cur->fetchColumn() === 'superadmin') json_err('The super admin cannot be changed.', 403);
            $stmt = $pdo->prepare('UPDATE users SET role=? WHERE firebase_uid=? OR CAST(id AS CHAR)=?');
            $stmt->execute([$role,$uid,$uid]);
            json_ok(['role'=>$role]);
        }

        if ($action === 'product') {
            if (!in_array($user['role'], ['admin','superadmin'], true)) json_err('Administrator access required.',403);
            $id = trim((string)($body['id'] ?? ''));
            if (!$id) json_err('Product id is required.');
            $allowed = ['name','price','old_price','stock','category','description','featured','sale'];
            $fields=[]; $params=[];
            foreach ($allowed as $field) {
                if (array_key_exists($field,$body)) {
                    $value=$body[$field];
                    if (in_array($field,['price','old_price'],true)) $value=$value === '' || $value === null ? null : max(0,(float)$value);
                    if (in_array($field,['stock','featured','sale'],true)) $value=in_array($field,['featured','sale'],true) ? (!empty($value)?1:0) : max(0,(int)$value);
                    $fields[]="`$field`=?"; $params[]=$value;
                }
            }
            if (!$fields) json_err('No product changes supplied.');
            $params[]=$id;
            $pdo->prepare('UPDATE products SET '.implode(',',$fields).' WHERE id=?')->execute($params);
            json_ok(['id'=>$id]);
        }

        $id = trim((string)($body['id'] ?? ''));
        if (!$id) json_err('Product id is required.');
        $stock = max(0,(int)($body['stock'] ?? 0));
        $pdo->prepare('UPDATE products SET stock=? WHERE id=?')->execute([$stock,$id]);
        json_ok(['id'=>$id,'stock'=>$stock]);
    }

    if ($method === 'DELETE') {
        if (!in_array($user['role'], ['admin','superadmin'], true)) json_err('Administrator access required.',403);
        $id = trim((string)($_GET['id'] ?? ''));
        if (!$id) json_err('Product id is required.');
        $pdo->prepare('DELETE FROM products WHERE id=?')->execute([$id]);
        json_ok(['deleted'=>$id]);
    }

    json_err('Method not allowed.',405);
} catch (Throwable $e) {
    json_err($e->getMessage(),500);
}

function normalizeRole($role): string {
    $r = strtolower(str_replace([' ','-'],'_',trim((string)$role)));
    return match($r) {
        'super_admin','superadmin' => 'superadmin',
        'admin' => 'admin',
        'staff' => 'staff',
        'seller' => 'seller',
        default => 'customer'
    };
}
