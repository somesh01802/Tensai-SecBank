<?php
namespace Tensai;

use Tensai\Controllers\AccountController;

/**
 * Nexus — Tensai SecBank's in-app assistant.
 * Server owns the LLM call; builds a sanitized, user-scoped snapshot first.
 * Falls back to a deterministic rule-based responder when ANTHROPIC_API_KEY is unset.
 */
class Chatbot
{
    private const MAX_HISTORY = 8;

    private const SYSTEM_PROMPT_TEMPLATE = <<<'PROMPT'
You are Nexus, Tensai SecBank's in-app AI banking assistant.

STYLE
- Sound warm, calm, confident. Answers stay concise (2-6 sentences).
- Use USD formatting ($ 100,000.00). No emojis in body text.
- When explaining how to do something inside the app, give clear step-by-step
  instructions naming the exact page, tab, button, and required fields
  from the "APP FLOWS" section below.

HARD RULES
1. Only answer questions about this app or the CURRENT user's own accounts,
   balances, loans, cards, bills, rewards, transfers, and history.
2. Never invent numbers. If a specific figure is not in the USER CONTEXT
   below, say you don't have that information rather than guessing.
3. Never execute financial transactions, close accounts, apply for loans,
   change MPINs, or share sensitive credentials. Guide the user to do those
   from the appropriate page.
4. Never reveal or infer the MPIN, password, full card number, CVV, or
   auth tokens. If asked, politely refuse and point to the eye-icon inside
   the Cards page for card reveal (that path is authorized in-app).
5. Only describe features that actually exist in APP FLOWS below. Do not
   invent additional flows.
6. If the user asks about another person's account or unrelated topics,
   politely decline and redirect to banking questions.

APP FLOWS (the ONLY features that exist inside this app)
- Apply for a card:
    Sidebar → Cards → New Debit Card or New Credit Card →
    pick a tier (Everyday / Lifestyle / Premium) → pick a specific product →
    fill Mobile Number, PAN (AAAAA9999A), Date of Birth → Submit application.
    A card is issued instantly and appears in the Cards page.
- Apply for a loan:
    Sidebar → Loans → pick a product (Home / Car / Personal / Education /
    Gold / Business) → Apply Now → set Amount + Tenure (months) → review the
    server-calculated EMI + Total Interest + Total Repayment → Apply Loan.
- Send money externally (to another bank):
    Sidebar → Transfer → Quick Fund Transfer tab → pick Bank, enter
    Account Number + Confirm Account Number, Account Holder Name, Amount,
    optional Remarks, choose Source account → Review → Transfer.
- Add a payee / beneficiary:
    Sidebar → Transfer → Add New Payee tab → pick Bank, enter Account Number +
    Confirm Account Number (must match), Account Holder Name, Nickname → Save.
    Payees appear in the Manage Payees tab.
- Move money between own accounts (internal transfer):
    Sidebar → Manage Account → Internal Transfer tab → pick From + To accounts
    (must differ) → Amount + optional Remarks → Review → Transfer.
- Receive money (demo deposit into primary account):
    Dashboard → Receive money button → Amount + optional Source + Remarks →
    Review → Credit account.
- Open a new account:
    Sidebar → Manage Account → Open Account tab → pick Savings / Salary /
    NRI / Business / Investment → fill Name, PAN, PIN code, Occupation,
    Mobile + type-specific fields → Apply Now. A 10-digit account number
    is generated on approval.
- Close an account:
    Sidebar → Manage Account → click the account → Close account button.
    Primary account cannot be closed. Non-zero balance must be moved first.
- Pay a bill:
    Sidebar → Bills → One-time tab → Pay now on the bill row. The primary
    account is debited via the ledger.
- Set up a recurring bill:
    Sidebar → Bills → Recurring tab → enter Biller, Category, Amount (or
    enable Auto-detect), Frequency, Source account, Next date, keep AutoPay
    enabled → Create.
- Schedule a transfer:
    Sidebar → Transfer → Schedule Transfer tab → pick Payee, Amount,
    optional Remarks, Date + Time, Frequency, Source account → Schedule.
- Enable investment AutoPay:
    Sidebar → Investments → click Set up AutoPay on a holding → pick
    Source account + Amount + Frequency + Next run at → Enable.
- Freeze or cancel a card:
    Sidebar → Cards → click Freeze on a card (or the trash icon to cancel).
- Reveal card number + CVV:
    Sidebar → Cards → click Reveal on the card. The user authorises the
    reveal themselves; Nexus never reveals it.
- Download a statement:
    Sidebar → Transactions → pick a date range (1 Day / 1 Week / 1 Month /
    Custom) → Download Statement (CSV).
- Change name / email:
    Sidebar → Settings → Profile section → Save changes.
- Change password:
    Sidebar → Settings → Change password section.
- Set / reset MPIN:
    MPIN is set once after registration. To reset, contact support.
- View rewards:
    Sidebar → Rewards. Complete tasks around the app to earn points.
- View / clear notifications:
    Top bar bell icon (right of the search bar).
- Mask / unmask balance:
    Dashboard → eye icon next to "Account balance".
- Change theme:
    Top bar sun/moon icon.

USER CONTEXT (sanitized snapshot from PostgreSQL — never fabricate figures)
{{CONTEXT_JSON}}
PROMPT;

    public static function ask(string $userId, ?string $message, $history = []): array
    {
        if (!$message || trim($message) === '')
            return ['text' => 'Ask me anything about your Tensai SecBank account.', 'source' => 'guard'];
        if (strlen($message) > 2000)
            return ['text' => 'Please shorten your question (under 2000 characters).', 'source' => 'guard'];

        $ctx = self::buildUserContext($userId);

        if (!empty($_ENV['ANTHROPIC_API_KEY'] ?? getenv('ANTHROPIC_API_KEY'))) {
            try {
                $messages = self::shapeHistory($history);
                $messages[] = ['role' => 'user', 'content' => $message];
                $system = str_replace('{{CONTEXT_JSON}}',
                    substr(json_encode($ctx, JSON_PRETTY_PRINT | JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE), 0, 12000),
                    self::SYSTEM_PROMPT_TEMPLATE);
                $out = self::callClaude($system, $messages);
                return ['text' => $out, 'source' => 'llm'];
            } catch (\Throwable $e) {
                error_log('[chatbot] LLM call failed, falling back: ' . $e->getMessage());
            }
        }

        $ruled = self::tryRuleBasedAnswer($message, $ctx);
        if ($ruled !== null) return ['text' => $ruled, 'source' => 'rules'];

        return [
            'text' => "I'm running in offline mode right now. I can answer questions about your balance, cards, loans, bills, transfers, rewards, and how to use Tensai SecBank features. Try asking one of those.",
            'source' => 'rules-fallback',
        ];
    }

    private static function shapeHistory($history): array
    {
        if (!is_array($history)) return [];
        $trimmed = array_slice($history, -self::MAX_HISTORY);
        $out = [];
        foreach ($trimmed as $m) {
            if (is_array($m) && isset($m['content']) && is_string($m['content'])
                && in_array($m['role'] ?? '', ['user', 'assistant'], true)) {
                $out[] = ['role' => $m['role'], 'content' => substr((string) $m['content'], 0, 4000)];
            }
        }
        return $out;
    }

    private static function usd($v): string
    {
        return '$' . number_format((float) $v, 2, '.', ',');
    }

    /** Assemble a compact, secure user snapshot. Every field is safe to send to an LLM. */
    public static function buildUserContext(string $userId): array
    {
        $user = Db::one('SELECT name, email, mobile_number, created_at FROM users WHERE id = :u LIMIT 1', [':u' => $userId]) ?: [];
        $accounts = Db::all('SELECT * FROM accounts WHERE user_id = :u', [':u' => $userId]);
        $txs = Db::all('SELECT * FROM transactions ORDER BY created_at DESC LIMIT 10');
        $loans = Db::all('SELECT * FROM loan_applications WHERE user_id = :u', [':u' => $userId]);
        $cards = Db::all('SELECT * FROM cards WHERE user_id = :u', [':u' => $userId]);
        $bills = Db::all('SELECT * FROM bills WHERE user_id = :u', [':u' => $userId]);
        $autopays = Db::all('SELECT * FROM investment_autopay WHERE user_id = :u', [':u' => $userId]);
        $recBills = Db::all('SELECT * FROM recurring_bills WHERE user_id = :u', [':u' => $userId]);
        $rewardsRow = Db::one(
            'SELECT COALESCE(SUM(points_awarded),0) AS total_points, COUNT(*) AS completed_count
             FROM user_reward_tasks WHERE user_id = :u', [':u' => $userId]);

        $acctIds = array_column($accounts, 'id');
        $acctSet = array_flip($acctIds);
        $balances = $acctIds ? AccountController::balances($acctIds) : [];

        $sanitizedAccounts = array_map(fn($a) => [
            'id' => $a['id'], 'kind' => $a['kind'], 'displayName' => $a['displayName'],
            'accountNumber' => $a['accountNumber'] ? 'xxxxxx' . substr($a['accountNumber'], -4) : null,
            'status' => $a['status'], 'isPrimary' => $a['isPrimary'] === true,
            'balance' => $balances[$a['id']] ?? 0, 'currency' => $a['currency'], 'openedOn' => $a['createdAt'],
        ], $accounts);

        $sanitizedTxs = [];
        foreach ($txs as $t) {
            if (!isset($acctSet[$t['fromAccountId']]) && !isset($acctSet[$t['toAccountId']])) continue;
            $of = isset($acctSet[$t['fromAccountId']]); $ot = isset($acctSet[$t['toAccountId']]);
            $dir = ($of && !$ot) ? 'OUT' : ((!$of && $ot) ? 'IN'
                : (in_array($t['category'], ['WELCOME_BONUS', 'DEPOSIT'], true) ? 'IN' : 'OUT'));
            $sanitizedTxs[] = [
                'id' => substr($t['id'], 0, 8), 'amount' => (float) $t['amount'], 'direction' => $dir,
                'description' => $t['description'], 'category' => $t['category'],
                'status' => $t['status'], 'createdAt' => $t['createdAt'],
            ];
            if (count($sanitizedTxs) >= 8) break;
        }

        $sanitizedLoans = array_map(fn($l) => [
            'id' => substr($l['id'], 0, 8), 'productId' => $l['productId'],
            'principal' => (float) $l['principal'], 'interestRate' => (float) $l['interestRate'],
            'tenureMonths' => (int) $l['tenureMonths'], 'emi' => (float) $l['emi'],
            'totalInterest' => (float) $l['totalInterest'], 'totalRepayment' => (float) $l['totalRepayment'],
            'status' => $l['status'], 'appliedOn' => $l['createdAt'], 'closedOn' => $l['closedAt'] ?? null,
        ], $loans);

        $sanitizedCards = [];
        foreach ($cards as $c) {
            if (!empty($c['deletedAt'])) continue;
            $sanitizedCards[] = [
                'id' => substr($c['id'], 0, 8), 'type' => $c['type'], 'brand' => $c['brand'],
                'lastFour' => $c['lastFour'],
                'expiry' => str_pad((string) $c['expiryMonth'], 2, '0', STR_PAD_LEFT) . '/' . str_pad((string) $c['expiryYear'], 2, '0', STR_PAD_LEFT),
                'holderName' => $c['holderName'], 'isFrozen' => $c['isFrozen'] === true,
            ];
        }

        $sanitizedBills = array_map(fn($b) => [
            'id' => substr($b['id'], 0, 8), 'billerName' => $b['billerName'], 'category' => $b['category'],
            'amount' => (float) $b['amount'], 'dueDate' => $b['dueDate'], 'status' => $b['status'],
        ], $bills);

        $sanitizedAutopay = array_map(fn($a) => [
            'id' => substr($a['id'], 0, 8), 'investmentId' => substr($a['investmentId'], 0, 8),
            'amount' => (float) $a['amount'], 'frequency' => $a['frequency'],
            'nextRunAt' => $a['nextRunAt'], 'enabled' => $a['enabled'] === true,
        ], $autopays);

        $sanitizedRecBills = array_map(fn($r) => [
            'id' => substr($r['id'], 0, 8), 'billerName' => $r['billerName'], 'amount' => (float) $r['amount'],
            'frequency' => $r['frequency'], 'nextRunAt' => $r['nextRunAt'],
            'autopayEnabled' => $r['autopayEnabled'] === true, 'enabled' => $r['enabled'] === true,
        ], $recBills);

        $totalBalance = array_sum(array_column($sanitizedAccounts, 'balance'));
        $primary = null;
        foreach ($sanitizedAccounts as $a) if ($a['isPrimary']) { $primary = $a; break; }
        if (!$primary) $primary = $sanitizedAccounts[0] ?? null;

        return [
            'user' => [
                'name' => $user['name'] ?? null, 'email' => $user['email'] ?? null,
                'mobileMasked' => !empty($user['mobileNumber']) ? 'xxxxxx' . substr((string) $user['mobileNumber'], -4) : null,
                'memberSince' => $user['createdAt'] ?? null,
            ],
            'totals' => [
                'balance' => $totalBalance, 'currency' => 'USD',
                'accountCount' => count($sanitizedAccounts),
                'openLoanCount' => count(array_filter($sanitizedLoans, fn($l) => !in_array($l['status'], ['CLOSED', 'REJECTED'], true))),
                'activeCardCount' => count(array_filter($sanitizedCards, fn($c) => !$c['isFrozen'])),
                'unpaidBillCount' => count(array_filter($sanitizedBills, fn($b) => $b['status'] !== 'PAID')),
            ],
            'primaryAccount' => $primary,
            'accounts' => $sanitizedAccounts,
            'recentTransactions' => $sanitizedTxs,
            'loans' => $sanitizedLoans,
            'cards' => $sanitizedCards,
            'bills' => $sanitizedBills,
            'autopays' => $sanitizedAutopay,
            'recurringBills' => $sanitizedRecBills,
            'rewards' => [
                'totalPoints' => (float) ($rewardsRow['total_points'] ?? 0),
                'completedCount' => (int) ($rewardsRow['completed_count'] ?? 0),
            ],
            'appFeatures' => ['supportedActions' => [
                'Send money (Transfer > Quick Fund Transfer)',
                'Receive money (Dashboard > Receive Money)',
                'Move funds between own accounts (Manage Account > Internal Transfer)',
                'Apply for loans (Loans page)',
                'Apply for a new card (Cards page)',
                'Add payees & schedule transfers (Transfer page)',
                'Pay bills / set up recurring bills (Bills page)',
                'Investment AutoPay (Investments page)',
                'Download statement (Transactions > Download Statement)',
                'Change name/email or password (Settings)',
            ]],
        ];
    }

    private static function callClaude(string $system, array $messages): string
    {
        $apiKey = $_ENV['ANTHROPIC_API_KEY'] ?? getenv('ANTHROPIC_API_KEY');
        $model = $_ENV['ANTHROPIC_MODEL'] ?? getenv('ANTHROPIC_MODEL') ?: 'claude-haiku-4-5-20251001';
        $ch = curl_init('https://api.anthropic.com/v1/messages');
        curl_setopt_array($ch, [
            CURLOPT_RETURNTRANSFER => true,
            CURLOPT_POST => true,
            CURLOPT_TIMEOUT => 30,
            CURLOPT_HTTPHEADER => [
                'content-type: application/json',
                'x-api-key: ' . $apiKey,
                'anthropic-version: 2023-06-01',
            ],
            CURLOPT_POSTFIELDS => json_encode([
                'model' => $model, 'max_tokens' => 400, 'system' => $system, 'messages' => $messages,
            ]),
        ]);
        $body = curl_exec($ch);
        $status = curl_getinfo($ch, CURLINFO_RESPONSE_CODE);
        $err = curl_error($ch);
        curl_close($ch);
        if ($body === false) throw new \RuntimeException("Anthropic request failed: $err");
        if ($status < 200 || $status >= 300) throw new \RuntimeException("Anthropic API $status: " . substr((string) $body, 0, 200));
        $data = json_decode($body, true);
        $text = '';
        foreach ($data['content'] ?? [] as $c) if (($c['type'] ?? '') === 'text') $text .= ($text ? "\n" : '') . $c['text'];
        return trim($text) ?: '(no reply)';
    }

    /** Deterministic responder over the sanitized snapshot. Returns text or null. */
    private static function tryRuleBasedAnswer(string $userMessage, array $ctx): ?string
    {
        $q = mb_strtolower($userMessage);
        $has = fn(...$kws) => array_filter($kws, fn($k) => str_contains($q, $k)) !== [];
        $asksHow = $has('how', 'steps', 'guide', 'walk me', 'help me');

        if (preg_match('/^\s*(hi|hello|hey|namaste|yo|hola|hii+|hey there|good (morning|afternoon|evening))\b/i', $userMessage) && strlen($q) < 60) {
            $first = explode(' ', (string) ($ctx['user']['name'] ?? ''))[0] ?: 'there';
            return "Hi $first! I'm Nexus. I can walk you through anything in the app — applying for a card, sending money, adding a payee, setting up a loan — and answer questions about your own accounts, balances, cards, loans, bills, and rewards. What would you like to do?";
        }

        if ((($asksHow || $has('apply', 'get', 'start')) && $has('credit card', 'debit card'))
            || ($has('card') && $asksHow && $has('apply', 'get'))) {
            $type = $has('debit') ? 'Debit' : 'Credit';
            return "To apply for a $type Card:\n1. Open the sidebar → Cards.\n2. Click \"New $type Card\".\n3. Pick a tier: Everyday, Lifestyle, or Premium.\n4. Choose a specific product to see its benefits + annual fee.\n5. Fill in Mobile Number, PAN (AAAAA9999A format), and Date of Birth.\n6. Submit the application — your card is issued instantly and appears in Cards.\n\nYou can then reveal the number & CVV, freeze it, or cancel it from that page.";
        }

        if ($asksHow && $has('loan', 'borrow', 'emi')) {
            return "To apply for a loan:\n1. Sidebar → Loans.\n2. Pick a product (Home, Car, Personal, Education, Gold, or Business).\n3. Click \"Apply Now\".\n4. Enter Amount and Tenure (in months). Nexus/backend calculates EMI, Total Interest, and Total Repayment live.\n5. Review the repayment summary, then click \"Apply Loan\".\n\nYour application appears at the bottom of the Loans page. You can open any loan to see the schedule or close/cancel it.";
        }

        if ($asksHow && $has('schedule transfer', 'schedule a transfer', 'scheduled transfer', 'future transfer', 'recurring transfer')) {
            return "To schedule a transfer:\n1. Sidebar → Transfer → \"Schedule Transfer\" tab.\n2. Pick a Payee (add one first if needed).\n3. Enter Amount and optional Remarks.\n4. Pick Date and Time, Frequency, and Source account.\n5. Click \"Schedule\".\n\nThe backend scheduler runs it at the chosen time. You can pause or cancel it from the same page.";
        }

        if ($asksHow && $has('transfer money', 'send money', 'send funds', 'wire', 'transfer to')) {
            return "To send money to another bank:\n1. Sidebar → Transfer → \"Quick Fund Transfer\" tab.\n2. Pick a Bank.\n3. Enter Account Number, then Confirm Account Number (they must match).\n4. Enter Account Holder Name, Amount, and optional Remarks.\n5. Pick your Source account.\n6. Click \"Review\" → confirm → \"Transfer\".\n\nTip: to move money between your own Tensai SecBank accounts, use Manage Account → Internal Transfer instead.";
        }

        if ($asksHow && $has('payee', 'beneficiary')) {
            return "To add a payee:\n1. Sidebar → Transfer → \"Add New Payee\" tab.\n2. Pick the recipient's Bank.\n3. Enter Account Number and Confirm Account Number (must match).\n4. Enter Account Holder Name and a friendly Nickname.\n5. Click \"Save payee\".\n\nYou can view, activate/deactivate, or delete saved payees from the \"Manage Payees\" tab.";
        }

        if ($asksHow && $has('internal transfer', 'own account', 'between my account', 'move funds')) {
            return "To move funds between your own accounts:\n1. Sidebar → Manage Account → \"Internal Transfer\" tab.\n2. Pick From account and To account (they must differ).\n3. Enter Amount and optional Remarks.\n4. Click \"Review Transfer\" → \"Transfer\".\n\nThe debit and credit happen atomically inside a PostgreSQL transaction, so balances stay consistent.";
        }

        if ($asksHow && $has('receive money', 'deposit')) {
            return "To receive money (demo deposit into your primary account):\n1. Dashboard → click \"Receive money\".\n2. Enter Amount, optional Source and Remarks.\n3. Click \"Review\" → \"Credit account\".\n\nThe amount is credited to your primary account instantly and appears in Transactions.";
        }

        if ($asksHow && $has('open account', 'new account', 'add account', 'open a savings', 'open a salary', 'open a nri', 'open a business', 'open an investment', 'open savings', 'open salary', 'open nri', 'open business', 'open investment')) {
            return "To open a new account:\n1. Sidebar → Manage Account → \"Open Account\" tab.\n2. Pick a type: Savings, Salary, NRI, Business, or Investment.\n3. Fill Name, PAN, PIN code, Occupation, Mobile number, plus any type-specific fields.\n4. Click \"Apply Now\".\n\nThe account is approved instantly and a fresh 10-digit account number is generated.";
        }

        if ($asksHow && $has('close account', 'close my account', 'close an account', 'delete account', 'delete my account', 'cancel account', 'cancel my account', 'shut account', 'shut my account')) {
            return "To close an account:\n1. Sidebar → Manage Account → click the account card to open its details.\n2. Click \"Close account\".\n\nNote: your primary account can't be closed, and any non-zero balance must be moved out first (use Internal Transfer). The account keeps its history — status becomes CLOSED.";
        }

        if ($asksHow && $has('pay bill', 'pay a bill', 'bill payment')) {
            return "To pay a bill:\n1. Sidebar → Bills → \"One-time\" tab.\n2. On the bill row, click \"Pay now\". The primary account is debited via a real ledger transaction.\n\nFor repeating bills, use the \"Recurring\" tab to create one with AutoPay + optional auto-detect amount.";
        }

        if ($asksHow && ($has('recurring', 'auto pay', 'autopay') && $has('bill', 'utility'))) {
            return "To set up a recurring bill:\n1. Sidebar → Bills → \"Recurring\" tab.\n2. Enter Biller name, Category, and Amount (or tick \"Auto-detect amount\" to fetch it from the demo provider).\n3. Pick a Frequency, Source account, Next payment date/time.\n4. Keep \"Enable AutoPay\" ticked so the scheduler pays it for you.\n5. Click \"Create\".";
        }

        if ($asksHow && ($has('investment', 'sip') && $has('autopay', 'auto pay', 'recurring'))) {
            return "To enable AutoPay for an investment:\n1. Sidebar → Investments.\n2. Click \"Set up AutoPay\" on the holding you want.\n3. Pick a Source account, enter Amount, pick a Frequency and Next run at.\n4. Click \"Enable\".\n\nThe scheduler debits your source account on schedule and increases the holding's invested amount.";
        }

        if ($asksHow && ($has('freeze') && $has('card'))) {
            return "To freeze a card:\n1. Sidebar → Cards.\n2. On the card, click \"Freeze\".\n\nFrozen cards stop working for new charges instantly. Click \"Unfreeze\" to re-enable it, or the trash icon to cancel the card entirely.";
        }

        if ($asksHow && ($has('reveal') && $has('card'))) {
            return "To reveal your full card number and CVV:\n1. Sidebar → Cards.\n2. On the card, click the \"Reveal\" (eye) button.\n\nNexus itself never reveals card details — you authorise the reveal yourself, in-app, so it stays secure.";
        }

        if ($asksHow && ($has('statement', 'download') || $has('csv'))) {
            return "To download a statement:\n1. Sidebar → Transactions.\n2. Pick a date range: 1 Day, 1 Week, 1 Month, All time, or Custom (start + end date).\n3. Click \"Download Statement\".\n\nYou'll get a CSV built from the actual filtered transactions with Date, Reference, Description, Category, Debit, Credit, Balance, and Status.";
        }

        if ($asksHow && $has('change password', 'change my password', 'reset password', 'reset my password', 'update password', 'update my password', 'new password')) {
            return "To change your password:\n1. Sidebar → Settings.\n2. In the \"Change password\" card, enter your current password and a new one (at least 6 characters).\n3. Click \"Change password\".";
        }

        if ($asksHow && ($has('change name') || $has('update profile') || $has('change email'))) {
            return "To update your profile:\n1. Sidebar → Settings.\n2. Edit your Full name and/or Email in the Profile card.\n3. Click \"Save changes\".";
        }

        if ($asksHow && $has('mask') && $has('balance')) {
            return 'Your balance is masked by default on the Dashboard. Click the eye icon next to "Account balance:" to reveal it, and click again to mask it.';
        }

        if ($asksHow && $has('notification')) {
            return 'To read your notifications, click the bell icon at the top-right of the header. From the dropdown you can mark items read, mark all read, or open the full Notifications page.';
        }

        if ($asksHow && $has('dark mode', 'theme')) {
            return 'To toggle dark mode, click the sun/moon icon at the top of the header.';
        }

        if ($has('balance', 'how much', 'how much money', 'funds')) {
            $lines = ['Your total balance across ' . $ctx['totals']['accountCount'] . ' account(s) is ' . self::usd($ctx['totals']['balance']) . '.'];
            $primary = $ctx['primaryAccount'];
            if ($primary) $lines[] = 'Primary ' . ($primary['kind'] ?: 'Savings') . ' (' . ($primary['accountNumber'] ?: '…') . '): ' . self::usd($primary['balance']) . '.';
            return implode(' ', $lines);
        }

        if ($has('cvv', 'full card number', 'card number', 'full number', 'card secret')) {
            return 'For your safety I can never share your CVV or full card number. You can reveal them yourself inside Cards → tap the Reveal (eye) button on any card. That path is authorised in-app and stays private to you.';
        }

        if ($has('card')) {
            if (count($ctx['cards']) === 0) return "You don't have any active cards yet. You can apply for one from the Cards page.";
            $summary = implode(', ', array_map(fn($c) => ($c['type'] === 'CREDIT' ? 'Credit' : 'Debit') . ' card ending in ' . $c['lastFour'] . ($c['isFrozen'] ? ' (frozen)' : ''), $ctx['cards']));
            return 'You currently have ' . count($ctx['cards']) . ' card(s): ' . $summary . '.';
        }

        if ($has('loan')) {
            if (count($ctx['loans']) === 0) return "You don't have any loan applications yet. You can apply from the Loans page.";
            $active = array_values(array_filter($ctx['loans'], fn($l) => !in_array($l['status'], ['CLOSED', 'REJECTED'], true)));
            $l = $active[0] ?? $ctx['loans'][0];
            return 'You have ' . count($ctx['loans']) . ' loan application(s), ' . count($active) . ' still active. Latest: principal ' . self::usd($l['principal']) . ' at ' . $l['interestRate'] . '% p.a. for ' . $l['tenureMonths'] . ' months, monthly EMI ' . self::usd($l['emi']) . ', status ' . $l['status'] . '.';
        }

        if ($has('bill')) {
            $unpaid = array_values(array_filter($ctx['bills'], fn($b) => $b['status'] !== 'PAID'));
            if (count($unpaid) === 0) return "You're all caught up — no unpaid bills right now. Nicely done.";
            $totalDue = array_sum(array_column($unpaid, 'amount'));
            $next = $unpaid[0];
            return 'You have ' . count($unpaid) . ' unpaid bill(s) totalling ' . self::usd($totalDue) . '. Next one: ' . $next['billerName'] . ' for ' . self::usd($next['amount']) . '.';
        }

        if ($has('reward', 'point')) {
            return 'You have ' . $ctx['rewards']['totalPoints'] . ' reward points across ' . $ctx['rewards']['completedCount'] . ' completed tasks. Open Rewards to see what else you can earn.';
        }

        if ($has('last transaction', 'recent transaction', 'recent tx', 'last transfer')) {
            $t = $ctx['recentTransactions'][0] ?? null;
            if (!$t) return 'No transactions on your account yet.';
            return 'Your most recent transaction was ' . ($t['direction'] === 'IN' ? 'a credit' : 'a debit') . ' of ' . self::usd($t['amount']) . ($t['description'] ? ' — ' . $t['description'] : '') . ' on ' . date('n/j/Y', strtotime($t['createdAt'])) . '.';
        }

        if ($has('mpin', 'password') && $has('what is', "what's my", 'tell me', 'share', 'reveal', 'show me')) {
            return 'I can never share your MPIN or password — even to you. You can change your password from Settings → Change password. If you\'ve forgotten your MPIN, please contact support.';
        }

        if ($has('send money', 'transfer') && $has('how', 'help')) {
            return 'You can send money via Transfer → Quick Fund Transfer (external bank), or move funds between your own accounts via Manage Account → Internal Transfer. To save a recipient, use Transfer → Add New Payee.';
        }

        if ($has('receive')) {
            return 'Use Dashboard → Receive Money to record a deposit into your primary account. Enter the amount, an optional source and remarks, then confirm.';
        }

        if ($has('statement', 'download', 'csv')) {
            return 'Open Transactions, pick a date range (1 Day / 1 Week / 1 Month / Custom), then click Download Statement to save a CSV.';
        }

        if ($has('open account', 'new account')) {
            return 'Go to Manage Account → Open Account. You can choose Savings, Salary, NRI, Business, or Investment. Fill in your name, PAN, PIN code, occupation, and mobile, then Apply Now.';
        }

        if ($has('who', 'what') && $has('you', 'bot', 'assistant')) {
            return "I'm Tensai SecBank's in-app assistant. I can only help with questions about this app and your own accounts. Try asking about your balance, cards, loans, bills, or rewards.";
        }

        return null;
    }
}
