<?php
require_once __DIR__ . '/bootstrap.php';

$method = $_SERVER['REQUEST_METHOD'];
$pdo = db();
$paths = firebase_paths();

try {
    switch ($method) {
        case 'GET':
            handleGet($pdo);
            break;
        case 'POST':
            handlePost($pdo, $paths);
            break;
        case 'PUT':
        case 'PATCH':
            handleUpdate($pdo, $paths);
            break;
        case 'DELETE':
            handleDelete($pdo, $paths);
            break;
        default:
            json_err('Method not allowed', 405);
    }
} catch (Throwable $e) {
    json_err($e->getMessage(), 500);
}

function handleGet(PDO $pdo): void
{
    $id = $_GET['id'] ?? null;

    if ($id) {
        $stmt = $pdo->prepare('SELECT * FROM products WHERE id = ?');
        $stmt->execute([$id]);
        $row = $stmt->fetch();
        if (!$row) {
            json_err('Product not found', 404);
        }
        json_ok(productFromRow($row));
    }

    $stmt = $pdo->query('SELECT * FROM products ORDER BY featured DESC, created_at DESC');
    $products = array_map('productFromRow', $stmt->fetchAll());
    json_ok($products);
}

function handlePost(PDO $pdo, array $paths): void
{
    require_admin();
    $body = read_json_body();

    $id = $body['id'] ?? generateProductId();
    $now = (int) (microtime(true) * 1000);

    $stmt = $pdo->prepare('
        INSERT INTO products (id,name,price,old_price,stock,category,sizes,colors,images,description,featured,sale,seller_uid,supplier,supplier_sku,supplier_contact,delivery_lead_days,delivery_status,delivery_date,inventory_location,reorder_level,vat_rate,vat_type,vat_inclusive,price_ex_vat,vat_amount,created_at)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
    ');
    $stmt->execute([
        $id,
        $body['name'] ?? '',
        $body['price'] ?? 0,
        $body['oldPrice'] ?? null,
        $body['stock'] ?? 0,
        $body['category'] ?? 'new',
        json_encode($body['sizes'] ?? []),
        json_encode($body['colors'] ?? []),
        json_encode($body['images'] ?? []),
        $body['desc'] ?? '',
        !empty($body['featured']) ? 1 : 0,
        !empty($body['sale']) ? 1 : 0,
        $body['sellerUid'] ?? null,
        $body['supplier'] ?? '',
        $body['supplierSku'] ?? '',
        $body['supplierContact'] ?? '',
        max(0,(int)($body['deliveryLeadDays'] ?? 3)),
        $body['deliveryStatus'] ?? 'ready',
        !empty($body['deliveryDate']) ? (int)$body['deliveryDate'] : null,
        $body['inventoryLocation'] ?? 'Main warehouse',
        max(0,(int)($body['reorderLevel'] ?? 5)),
        max(0,(float)($body['vatRate'] ?? 12)),
        $body['vatType'] ?? 'standard',
        array_key_exists('vatInclusive',$body) ? (!empty($body['vatInclusive']) ? 1 : 0) : 1,
        max(0,(float)($body['priceExVat'] ?? 0)),
        max(0,(float)($body['vatAmount'] ?? 0)),
        $body['createdAt'] ?? $now,
    ]);

    $stmt = $pdo->prepare('SELECT * FROM products WHERE id = ?');
    $stmt->execute([$id]);
    $row = $stmt->fetch();

    firebase()->set($paths['products'] . '/' . $id, productToFirebase($row));

    json_ok(productFromRow($row), 201);
}

function handleUpdate(PDO $pdo, array $paths): void
{
    $user = require_auth();
    $body = read_json_body();
    $id = $_GET['id'] ?? ($body['id'] ?? null);
    if (!$id) {
        json_err('Product id required');
    }

    $stmt = $pdo->prepare('SELECT * FROM products WHERE id = ?');
    $stmt->execute([$id]);
    $existing = $stmt->fetch();
    if (!$existing) {
        json_err('Product not found', 404);
    }

    $role = $user['role'] ?? 'customer';
    if ($role !== 'admin' && $role !== 'seller') {
        json_err('Forbidden', 403);
    }

    $fields = [];
    $params = [];

    $map = [
        'name'      => 'name',
        'price'     => 'price',
        'oldPrice'  => 'old_price',
        'stock'     => 'stock',
        'category'  => 'category',
        'desc'      => 'description',
        'featured'  => 'featured',
        'sale'      => 'sale',
        'supplier' => 'supplier', 'supplierSku' => 'supplier_sku', 'supplierContact' => 'supplier_contact',
        'deliveryLeadDays' => 'delivery_lead_days', 'deliveryStatus' => 'delivery_status', 'deliveryDate' => 'delivery_date',
        'inventoryLocation' => 'inventory_location', 'reorderLevel' => 'reorder_level', 'vatRate' => 'vat_rate',
        'vatType' => 'vat_type', 'vatInclusive' => 'vat_inclusive', 'priceExVat' => 'price_ex_vat', 'vatAmount' => 'vat_amount',
    ];

    foreach ($map as $jsonKey => $col) {
        if (array_key_exists($jsonKey, $body)) {
            $val = $body[$jsonKey];
            if (in_array($col, ['featured', 'sale'], true)) {
                $val = $val ? 1 : 0;
            }
            $fields[] = "`{$col}` = ?";
            $params[] = $val;
        }
    }

    foreach (['sizes', 'colors', 'images'] as $jsonKey) {
        if (array_key_exists($jsonKey, $body)) {
            $fields[] = "`{$jsonKey}` = ?";
            $params[] = json_encode($body[$jsonKey]);
        }
    }

    if (isset($body['avgRating'], $body['reviewCount'])) {
        $fields[] = '`avg_rating` = ?';
        $params[] = $body['avgRating'];
        $fields[] = '`review_count` = ?';
        $params[] = $body['reviewCount'];
    }

    if (!$fields) {
        json_err('No fields to update');
    }

    $params[] = $id;
    $pdo->prepare('UPDATE products SET ' . implode(', ', $fields) . ' WHERE id = ?')->execute($params);

    $stmt = $pdo->prepare('SELECT * FROM products WHERE id = ?');
    $stmt->execute([$id]);
    $row = $stmt->fetch();

    firebase()->set($paths['products'] . '/' . $id, productToFirebase($row));

    json_ok(productFromRow($row));
}

function handleDelete(PDO $pdo, array $paths): void
{
    require_admin();
    $id = $_GET['id'] ?? null;
    if (!$id) {
        json_err('Product id required');
    }

    $pdo->prepare('DELETE FROM products WHERE id = ?')->execute([$id]);
    firebase()->remove($paths['products'] . '/' . $id);

    json_ok(['deleted' => $id]);
}
