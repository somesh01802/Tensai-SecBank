<?php
/**
 * Score an AI investigation against the ground-truth ledger (D9 AI Accountability).
 * The agent ends every root-cause answer with "CAUSE: service / component / fault type"; this compares
 * its first answer (top-1) and up to three answers (top-3) with the ledger entry of the scenario run.
 *
 *   php bin/score-rca.php --scenario=S1 --level=L2 --answer="CAUSE: payments-svc / payment_gw / latency" \
 *       [--answer="CAUSE: ..." (2nd, 3rd)] [--tth=95] [--tools=8] [--tokens=31000] [--approval=240]
 *
 * --scenario picks the latest ledger entry for that scenario. Matching ignores case and spacing, and treats
 * "payment_gw" and "payment_gateway" as the same component. Writes one document to bank-ai-scores.
 */
require __DIR__ . '/../vendor/autoload.php';
if (is_file(__DIR__ . '/../.env')) \Dotenv\Dotenv::createImmutable(__DIR__ . '/..')->safeLoad();

use Tensai\{Es, BankExport};

$o = getopt('', ['scenario:', 'level:', 'answer:', 'tth:', 'tools:', 'tokens:', 'approval:']);
$answers = array_slice((array) ($o['answer'] ?? []), 0, 3);
if (empty($o['scenario']) || !$answers) { fwrite(STDERR, "usage: see the header of this script\n"); exit(1); }
$s = strtoupper($o['scenario']);
if (!preg_match('/^S\d{1,2}$/', $s)) { fwrite(STDERR, "bad --scenario\n"); exit(1); }

$led = Es::esql('FROM ' . BankExport::LEDGER . " | WHERE scenario.id == \"$s\" | SORT started_at DESC | LIMIT 1 | KEEP cause.line, started_at")[0] ?? null;
if (!$led) { fwrite(STDERR, "no ledger entry for $s\n"); exit(1); }

$norm = fn(string $c) => preg_replace(['/^cause:\s*/', '/\s*\/\s*/', '/\s+/', '/payment_gateway/'], ['', '/', ' ', 'payment_gw'], strtolower(trim($c)));
$true = $norm($led['cause.line']);
$top = array_map($norm, $answers);
$doc = ['@timestamp' => gmdate('Y-m-d\TH:i:s\Z'), 'run' => ['id' => 'RUN-' . gmdate('YmdHis') . '-' . bin2hex(random_bytes(2))], 'scenario' => ['id' => $s],
    'agent' => ['level' => strtoupper($o['level'] ?? 'L2')],
    'cause' => ['true' => $led['cause.line'], 'top1' => $answers[0], 'top3' => $answers],
    'score' => ['top1_hit' => $top[0] === $true, 'top3_hit' => in_array($true, $top, true),
        'time_to_hypothesis_s' => isset($o['tth']) ? (float) $o['tth'] : null, 'tool_calls' => isset($o['tools']) ? (int) $o['tools'] : null,
        'tokens' => isset($o['tokens']) ? (int) $o['tokens'] : null, 'approval_latency_s' => isset($o['approval']) ? (float) $o['approval'] : null],
    'labels' => ['data_source' => 'scored']];
$f = Es::bulk(BankExport::AI_SCORES, [[$doc['run']['id'] . "-$s", $doc]], false, 'ES_BANK_API_KEY');
printf("%s %s: top-1 %s, top-3 %s%s\n", $s, $doc['agent']['level'], $doc['score']['top1_hit'] ? 'HIT' : 'miss', $doc['score']['top3_hit'] ? 'HIT' : 'miss', $f ? ' (write FAILED)' : '');
exit($f ? 1 : 0);
