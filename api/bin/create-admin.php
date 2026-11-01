<?php
/**
 * Provision an administrator. Server-side CLI only — there is no HTTP route
 * that can grant the ADMIN role, and public registration always creates CUSTOMERs.
 *
 *   php bin/create-admin.php --email=ops.admin@yourbank.com --name="Ops Admin"
 *       Password: taken from the ADMIN_PASSWORD environment variable if set
 *       (min 12 chars), otherwise a strong random one is generated and printed ONCE.
 *   --promote   allow converting an EXISTING customer account into an admin
 *               (off by default: admins should be separate staff accounts).
 *   --enroll-mfa  (re)issue the admin's authenticator secret only, password untouched. Admin sign-in
 *               requires the code (VAPT-04); new admins are enrolled automatically.
 *
 * The password is stored only as a bcrypt hash; the action is written to audit_logs.
 */
require __DIR__ . '/../vendor/autoload.php';
if (is_file(__DIR__ . '/../.env')) \Dotenv\Dotenv::createImmutable(__DIR__ . '/..')->safeLoad();

use Tensai\{Db, Audit, Crypto, Totp, Passwords};

$o = getopt('', ['email:', 'name:', 'promote', 'enroll-mfa']);
$email = strtolower(trim((string) ($o['email'] ?? '')));
$name = trim((string) ($o['name'] ?? 'Administrator'));
if (!filter_var($email, FILTER_VALIDATE_EMAIL)) { fwrite(STDERR, "Usage: php bin/create-admin.php --email=<email> [--name=\"Full Name\"] [--promote] [--enroll-mfa]\n"); exit(2); }

/** Store a fresh TOTP secret (encrypted) and print the otpauth URI once, for the admin's authenticator app. */
function enroll(string $id, string $email): void
{
    $secret = Totp::newSecret();
    Db::run('UPDATE users SET totp_secret = :s, totp_last_step = NULL WHERE id = :id', [':s' => Crypto::encrypt($secret), ':id' => $id]);
    Audit::log(null, null, 'admin.mfa_enrolled', 'user', $id, ['via' => 'cli']);
    echo "[admin] authenticator secret (shown once; add it to the admin's authenticator app, then clear this terminal):\n";
    echo "        " . Totp::uri($secret, $email) . "\n";
}

if (isset($o['enroll-mfa'])) {
    $u = Db::one("SELECT id FROM users WHERE email = :e AND role = 'ADMIN'", [':e' => $email]);
    if (!$u) { fwrite(STDERR, "No admin account uses $email.\n"); exit(1); }
    enroll($u['id'], $email);
    exit(0);
}

$env = getenv('ADMIN_PASSWORD');
$generated = $env === false || $env === '';
$password = $generated ? rtrim(strtr(base64_encode(random_bytes(18)), '+/', '-_'), '=') : $env;
if (strlen($password) < 12) { fwrite(STDERR, "ADMIN_PASSWORD must be at least 12 characters.\n"); exit(2); }
$hash = password_hash($password, PASSWORD_BCRYPT, ['cost' => 12]);

$existing = Db::one('SELECT id, role FROM users WHERE email = :e', [':e' => $email]);
if ($existing) {
    if ($existing['role'] === 'ADMIN') {
        Db::run('UPDATE users SET password_hash = :h, updated_at = now() WHERE id = :id', [':h' => $hash, ':id' => $existing['id']]);
        Audit::log(null, null, 'admin.password_reset', 'user', $existing['id'], ['email' => $email, 'via' => 'cli']);
        $id = $existing['id']; $action = 'password reset';
    } elseif (isset($o['promote'])) {
        Db::run("UPDATE users SET role = 'ADMIN', password_hash = :h, updated_at = now() WHERE id = :id", [':h' => $hash, ':id' => $existing['id']]);
        Audit::log(null, null, 'admin.provisioned', 'user', $existing['id'], ['email' => $email, 'via' => 'cli', 'promoted' => true]);
        $id = $existing['id']; $action = 'promoted to ADMIN';
    } else {
        fwrite(STDERR, "A customer account already uses $email. Use a separate staff email, or pass --promote to convert it.\n");
        exit(1);
    }
} else {
    $row = Db::one("INSERT INTO users (email, name, password_hash, role) VALUES (:e, :n, :h, 'ADMIN') RETURNING id",
        [':e' => $email, ':n' => $name, ':h' => $hash]);
    Audit::log(null, null, 'admin.provisioned', 'user', $row['id'], ['email' => $email, 'via' => 'cli']);
    $id = $row['id']; $action = 'created';
}

echo "[admin] $email $action (id $id)\n";
if (!Db::one('SELECT totp_secret FROM users WHERE id = :id', [':id' => $id])['totpSecret']) enroll($id, $email);
if ($generated) echo "[admin] generated password (shown once, store it in your password manager): $password\n";
