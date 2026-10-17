<?php

class FirebaseBackup
{
    private array $cfg;
    private string $baseUrl;

    public function __construct()
    {
        $app = require __DIR__ . '/../config/config.php';
        $this->cfg = $app['firebase'];
        $this->baseUrl = rtrim($this->cfg['database_url'], '/') . '/';
    }

    public function isEnabled(): bool
    {
        return !empty($this->cfg['enabled']);
    }

    /** Mirror a record to Firebase (non-blocking best-effort). */
    public function set(string $path, array $data): void
    {
        if (!$this->isEnabled()) {
            return;
        }
        $this->request('PUT', $path, $data);
    }

    public function update(string $path, array $data): void
    {
        if (!$this->isEnabled()) {
            return;
        }
        $this->request('PATCH', $path, $data);
    }

    public function remove(string $path): void
    {
        if (!$this->isEnabled()) {
            return;
        }
        $this->request('DELETE', $path, null);
    }

    public function push(string $path, array $data): ?string
    {
        if (!$this->isEnabled()) {
            return null;
        }
        $result = $this->request('POST', $path, $data);
        if (is_array($result) && isset($result['name'])) {
            return $result['name'];
        }
        return null;
    }

    private function request(string $method, string $path, ?array $data)
    {
        $url = $this->baseUrl . ltrim($path, '/');
        if (!empty($this->cfg['auth_token'])) {
            $url .= (str_contains($url, '?') ? '&' : '?') . 'auth=' . urlencode($this->cfg['auth_token']);
        }

        $ch = curl_init($url);
        curl_setopt_array($ch, [
            CURLOPT_CUSTOMREQUEST  => $method,
            CURLOPT_RETURNTRANSFER => true,
            CURLOPT_TIMEOUT        => 5,
            CURLOPT_HTTPHEADER     => ['Content-Type: application/json'],
        ]);

        if ($data !== null && in_array($method, ['PUT', 'PATCH', 'POST'], true)) {
            curl_setopt($ch, CURLOPT_POSTFIELDS, json_encode($data));
        }

        $response = curl_exec($ch);
        $code = curl_getinfo($ch, CURLINFO_HTTP_CODE);
        curl_close($ch);

        if ($code >= 400 || $response === false) {
            error_log("[FirebaseBackup] {$method} {$path} failed HTTP {$code}");
            return null;
        }

        if ($response === '' || $response === 'null') {
            return null;
        }

        return json_decode($response, true);
    }
}

function firebase(): FirebaseBackup
{
    static $fb = null;
    if ($fb === null) {
        $fb = new FirebaseBackup();
    }
    return $fb;
}

function productToFirebase(array $row): array
{
    return [
        'id'          => $row['id'],
        'name'        => $row['name'],
        'price'       => (float) $row['price'],
        'oldPrice'    => $row['old_price'] !== null ? (float) $row['old_price'] : null,
        'stock'       => (int) $row['stock'],
        'category'    => $row['category'],
        'sizes'       => json_decode($row['sizes'] ?? '[]', true) ?: [],
        'colors'      => json_decode($row['colors'] ?? '[]', true) ?: [],
        'images'      => json_decode($row['images'] ?? '[]', true) ?: [],
        'desc'        => $row['description'] ?? '',
        'featured'    => (bool) $row['featured'],
        'sale'        => (bool) $row['sale'],
        'avgRating'   => (float) ($row['avg_rating'] ?? 0),
        'reviewCount' => (int) ($row['review_count'] ?? 0),
        'sellerUid'   => $row['seller_uid'],
        'supplier'    => $row['supplier'] ?? '',
        'supplierSku' => $row['supplier_sku'] ?? '',
        'supplierContact' => $row['supplier_contact'] ?? '',
        'deliveryLeadDays' => (int)($row['delivery_lead_days'] ?? 3),
        'deliveryStatus' => $row['delivery_status'] ?? 'ready',
        'deliveryDate' => $row['delivery_date'] !== null ? (int)$row['delivery_date'] : null,
        'inventoryLocation' => $row['inventory_location'] ?? 'Main warehouse',
        'reorderLevel' => (int)($row['reorder_level'] ?? 5),
        'vatRate' => (float)($row['vat_rate'] ?? 12),
        'vatType' => $row['vat_type'] ?? 'standard',
        'vatInclusive' => (bool)($row['vat_inclusive'] ?? 1),
        'priceExVat' => (float)($row['price_ex_vat'] ?? 0),
        'vatAmount' => (float)($row['vat_amount'] ?? 0),
        'createdAt'   => (int) $row['created_at'],
    ];
}

function productFromRow(array $row): array
{
    return [
        'id'          => $row['id'],
        'name'        => $row['name'],
        'price'       => (float) $row['price'],
        'oldPrice'    => $row['old_price'] !== null ? (float) $row['old_price'] : null,
        'stock'       => (int) $row['stock'],
        'category'    => $row['category'],
        'sizes'       => json_decode($row['sizes'] ?? '[]', true) ?: [],
        'colors'      => json_decode($row['colors'] ?? '[]', true) ?: [],
        'images'      => json_decode($row['images'] ?? '[]', true) ?: [],
        'desc'        => $row['description'] ?? '',
        'featured'    => (bool) $row['featured'],
        'sale'        => (bool) $row['sale'],
        'avgRating'   => (float) ($row['avg_rating'] ?? 0),
        'reviewCount' => (int) ($row['review_count'] ?? 0),
        'sellerUid'   => $row['seller_uid'],
        'supplier'    => $row['supplier'] ?? '',
        'supplierSku' => $row['supplier_sku'] ?? '',
        'supplierContact' => $row['supplier_contact'] ?? '',
        'deliveryLeadDays' => (int)($row['delivery_lead_days'] ?? 3),
        'deliveryStatus' => $row['delivery_status'] ?? 'ready',
        'deliveryDate' => $row['delivery_date'] !== null ? (int)$row['delivery_date'] : null,
        'inventoryLocation' => $row['inventory_location'] ?? 'Main warehouse',
        'reorderLevel' => (int)($row['reorder_level'] ?? 5),
        'vatRate' => (float)($row['vat_rate'] ?? 12),
        'vatType' => $row['vat_type'] ?? 'standard',
        'vatInclusive' => (bool)($row['vat_inclusive'] ?? 1),
        'priceExVat' => (float)($row['price_ex_vat'] ?? 0),
        'vatAmount' => (float)($row['vat_amount'] ?? 0),
        'createdAt'   => (int) $row['created_at'],
    ];
}

function userToPublic(array $row): array
{
    return [
        'id'            => (int) $row['id'],
        'uid'           => $row['firebase_uid'] ?: ('mysql_' . $row['id']),
        'username'      => $row['username'],
        'email'         => $row['email'],
        'phone'         => $row['phone'] ?? '',
        'role'          => $row['role'],
        'loyaltyPoints' => (int) ($row['loyalty_points'] ?? 0),
        'createdAt'     => (int) $row['created_at'],
    ];
}

function orderToFirebase(array $order): array
{
    return [
        'items'     => json_decode($order['items'], true),
        'total'     => (float) $order['total'],
        'sub'       => (float) $order['subtotal'],
        'payMethod' => $order['pay_method'],
        'shipping'  => json_decode($order['shipping'] ?? '{}', true),
        'vat'       => json_decode($order['vat'] ?? '{}', true) ?: [],
        'delivery'  => json_decode($order['delivery'] ?? '{}', true) ?: [],
        'status'    => $order['status'],
        'source'    => $order['source'] ?? 'web',
        'user'      => $order['firebase_uid'] ?: ('mysql_' . ($order['user_id'] ?? 'guest')),
        'email'     => $order['email'],
        'createdAt' => (int) $order['created_at'],
    ];
}

function generateOrderId(): string
{
    return 'ord_' . bin2hex(random_bytes(8));
}

function generateProductId(): string
{
    return 'mb' . substr((string) time(), -6) . random_int(10, 99);
}
