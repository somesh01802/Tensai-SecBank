<?php
/**
 * One-time conversion of sensitive data at rest (VAPT-06, VAPT-20), after migration 0010 and with APP_DATA_KEY set:
 *   - card numbers (cards.full_number) and tax ids (users.pan, account_applications.pan, card_applications.pan) and
 *     card-application dates of birth are encrypted in place;
 *   - stored CVVs are removed (PCI DSS 3.3.2): the CVV is now derived on reveal from the card number.
 * Idempotent: already-encrypted values are skipped, so it can be re-run safely. Each table is converted in one
 * transaction and every value is decrypted again and compared before commit.
 *
 *   php bin/protect-data.php              convert (prints counts only, never values)
 *   php bin/protect-data.php --dry-run    count what would change
 *   php bin/protect-data.php --decrypt    reverse (rollback of 0010 only; CVVs are not restored)
 */
require __DIR__ . '/../vendor/autoload.php';
if (is_file(__DIR__ . '/../.env')) \Dotenv\Dotenv::createImmutable(__DIR__ . '/..')->safeLoad();

use Tensai\{Db, Crypto};

$o = getopt('', ['dry-run', 'decrypt']);
$dry = isset($o['dry-run']); $decrypt = isset($o['decrypt']);
Crypto::encrypt('self-test');   // fails fast when APP_DATA_KEY is missing or malformed

$targets = [['cards', 'id', 'full_number'], ['users', 'id', 'pan'], ['account_applications', 'id', 'pan'],
            ['card_applications', 'id', 'pan'], ['card_applications', 'id', 'dob']];
foreach ($targets as [$table, $pk, $col]) {
    $rows = Db::all("SELECT $pk AS k, $col AS v FROM $table WHERE $col IS NOT NULL AND $col <> ''");
    $todo = array_values(array_filter($rows, fn($r) => Crypto::isEncrypted($r['v']) === $decrypt));
    printf("%-22s %-12s %6d rows, %6d to %s\n", $table, $col, count($rows), count($todo), $decrypt ? 'decrypt' : 'encrypt');
    if ($dry || !$todo) continue;
    Db::tx(function (PDO $pdo) use ($todo, $table, $pk, $col, $decrypt) {
        $st = $pdo->prepare("UPDATE $table SET $col = ? WHERE $pk = ?");
        foreach ($todo as $r) {
            $new = $decrypt ? Crypto::decrypt($r['v']) : Crypto::encrypt($r['v']);
            if (!$decrypt && Crypto::decrypt($new) !== $r['v']) throw new RuntimeException("round-trip check failed in $table.$col");
            $st->execute([$new, $r['k']]);
        }
    });
}
if (!$decrypt) {
    $n = $dry ? (int) Db::one('SELECT count(*) AS n FROM cards WHERE cvv IS NOT NULL')['n'] : Db::run('UPDATE cards SET cvv = NULL WHERE cvv IS NOT NULL');
    printf("%-22s %-12s %6d stored CVVs %s\n", 'cards', 'cvv', $n, $dry ? 'would be removed' : 'removed');
}
echo $dry ? "[protect-data] dry run, nothing changed\n" : "[protect-data] done\n";
