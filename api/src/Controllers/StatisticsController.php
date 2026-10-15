<?php
namespace Tensai\Controllers;

use Psr\Http\Message\ServerRequestInterface as Request;
use Psr\Http\Message\ResponseInterface as Response;
use Tensai\{Db, Http};

class StatisticsController
{
    private const RANGES = ['1D' => 1, '1W' => 7, '1M' => 30, '1Y' => 365];

    public function statistics(Request $req, Response $res): Response
    {
        $u = $req->getAttribute('user');
        $range = strtoupper($req->getQueryParams()['range'] ?? '1M');
        $days = self::RANGES[$range] ?? 30;
        $bucket = $range === '1D' ? 'hour' : 'day';

        $accts = Db::all('SELECT id FROM accounts WHERE user_id = :u', [':u' => $u['id']]);
        $ids = array_column($accts, 'id');
        if (!$ids) return Http::json($res, ['range' => $range, 'bucket' => $bucket, 'points' => []]);

        $cutoff = date('c', time() - $days * 86400);
        $in = implode(',', array_fill(0, count($ids), '?'));
        $trunc = $bucket === 'hour' ? "date_trunc('hour', created_at)" : "date_trunc('day', created_at)";

        $rows = Db::all(
            "SELECT $trunc AS ts, SUM(CASE WHEN type='CREDIT' THEN amount ELSE -amount END) AS net
             FROM ledger_entries WHERE account_id IN ($in) AND created_at >= ?
             GROUP BY 1 ORDER BY 1",
            array_merge($ids, [$cutoff])
        );
        $prior = Db::one(
            "SELECT COALESCE(SUM(CASE WHEN type='CREDIT' THEN amount ELSE -amount END),0) AS total
             FROM ledger_entries WHERE account_id IN ($in) AND created_at < ?",
            array_merge($ids, [$cutoff])
        );
        $running = (float) $prior['total'];
        $points = array_map(function ($r) use (&$running) {
            $running += (float) $r['net'];
            return ['ts' => $r['ts'], 'net' => (float) $r['net'], 'balance' => round($running, 2)];
        }, $rows);

        return Http::json($res, ['range' => $range, 'bucket' => $bucket, 'cutoff' => $cutoff, 'points' => $points]);
    }
}
