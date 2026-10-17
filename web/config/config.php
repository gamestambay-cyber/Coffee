<?php
/**
 * Maple's Bean — Application Configuration
 * Edit database credentials for HeidiSQL / XAMPP / WAMP
 */

return [
    'db' => [
        'host'     => '127.0.0.1',
        'port'     => 3306,
        'name'     => 'maplesbean',
        'user'     => 'root',
        'pass'     => 'gago',
        'charset'  => 'utf8mb4',
    ],

    // Optional remote mirror — disabled by default for silent local operation
    'firebase' => [
        'enabled'      => false,
        'database_url' => 'https://hightype-3e77a-default-rtdb.firebaseio.com',
        // Optional: set auth token for server-side backup writes (Firebase Console → Project Settings → Service Accounts)
        'auth_token'   => '',
        'paths' => [
            'products' => 'mb_products',
            'orders'   => 'orders',
            'users'    => 'users',
            'reviews'  => 'reviews',
            'carts'    => 'carts',
            'sellers'  => 'sellers',
        ],
    ],

    'app' => [
        'name'       => "Maple's Bean",
        'session_name' => 'maplesbean_sess',
        'promo_code' => 'MAPLESBEAN10',
        'promo_off'  => 500,
    ],
];
