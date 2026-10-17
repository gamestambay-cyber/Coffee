<?php
require_once __DIR__ . '/bootstrap.php';

$method = $_SERVER['REQUEST_METHOD'];
$pdo = db();
$paths = firebase_paths();

try {
    switch ($method) {
        case 'GET':
            require_admin();
            $stmt = $pdo->query('SELECT * FROM users ORDER BY created_at DESC');
            json_ok(array_map('userToPublic', $stmt->fetchAll()));
            break;

        case 'PATCH':
            require_admin();
            $actor = current_user();
            $body = read_json_body();
            $uid = $body['uid'] ?? ($_GET['uid'] ?? null);
            $role = $body['role'] ?? null;

            if (!$uid || !$role || !in_array($role, ['customer','staff','seller','admin','superadmin'], true)) {
                json_err('User id and role required');
            }
            // There is exactly ONE super admin. It can never be assigned here.
            if ($role === 'superadmin') {
                json_err('A super admin cannot be added', 403);
            }

            $id = str_starts_with($uid, 'mysql_') ? (int) substr($uid, 6) : null;
            if (!$id) {
                $stmt = $pdo->prepare('SELECT id FROM users WHERE firebase_uid = ?');
                $stmt->execute([$uid]);
                $row = $stmt->fetch();
                $id = $row ? (int) $row['id'] : null;
            }

            if (!$id) {
                json_err('User not found', 404);
            }

            // Only superadmins may create/change superadmins. Admins may manage
            // staff, sellers and customers but cannot promote themselves or others to superadmin.
            if ($role === 'superadmin' && (($actor['role'] ?? '') !== 'superadmin')) {
                json_err('Only a superadmin can assign the superadmin role', 403);
            }
            $targetStmt = $pdo->prepare('SELECT role FROM users WHERE id = ?');
            $targetStmt->execute([$id]);
            $targetRole = $targetStmt->fetchColumn();
            if ($targetRole === 'superadmin') {
                json_err('The super admin cannot be changed', 403);
            }
            if (($actor['role'] ?? '') !== 'superadmin' && $targetRole === 'admin') {
                json_err('Only the super admin can change an admin', 403);
            }
            if (($actor['role'] ?? '') !== 'superadmin' && $role === 'admin') {
                json_err('Only the super admin can assign admins', 403);
            }

            $pdo->prepare('UPDATE users SET role = ? WHERE id = ?')->execute([$role, $id]);

            $stmt = $pdo->prepare('SELECT * FROM users WHERE id = ?');
            $stmt->execute([$id]);
            $row = $stmt->fetch();

            $fbUid = $row['firebase_uid'] ?: ('mysql_' . $row['id']);
            firebase()->update($paths['users'] . '/' . $fbUid, ['role' => $role]);

            json_ok(userToPublic($row));
            break;

        case 'DELETE':
            $user = require_auth();
            if (($user['role'] ?? '') === 'superadmin') {
                json_err('The super admin account cannot be deleted', 403);
            }
            $targetId = (int) ($user['id'] ?? 0);
            $pdo->prepare('DELETE FROM users WHERE id = ?')->execute([$targetId]);
            $fbUid = $user['uid'] ?? ('mysql_' . $targetId);
            firebase()->remove($paths['users'] . '/' . $fbUid);
            session_destroy();
            json_ok(['deleted' => true]);
            break;

        default:
            json_err('Method not allowed', 405);
    }
} catch (Throwable $e) {
    json_err($e->getMessage(), 500);
}
