<?php
namespace Tensai;

use Slim\App;
use Psr\Http\Message\ServerRequestInterface as Request;
use Psr\Http\Message\ResponseInterface as Response;
use Tensai\Controllers\{
    AuthController, AccountController, TransactionController, BeneficiaryController,
    ProfileController, DashboardController, InvestmentController, CardController, BillController,
    NotificationController, AccountAppController, LoanController, AutopayController, CardAppController,
    PayeeController, TransferController, RecurringBillController, StatisticsController, RewardsController,
    ChatbotController, FeedbackController, AdminController
};

/**
 * Route table — mirrors the Node mount points exactly (same paths, verbs, shapes).
 * All protected routes carry the Auth middleware; initial-funds requires a system user.
 */
return function (App $app): void {
    $auth = new Auth();
    $system = new Auth(true);
    $admin = new Auth(false, 'ADMIN');

    $app->get('/', function (Request $q, Response $r) {
        $r->getBody()->write('Tensai SecBank API is up and running');
        return $r->withHeader('Content-Type', 'text/plain');
    });
    $app->get('/health', fn(Request $q, Response $r) => Http::json($r, ['status' => 'ok', 'service' => 'tensai-secbank']));

    $app->group('/api', function ($g) use ($auth, $system, $admin) {
        $ac = new AuthController();
        $acc = new AccountController();
        $tx = new TransactionController();
        $ben = new BeneficiaryController();
        $prof = new ProfileController();
        $dash = new DashboardController();
        $inv = new InvestmentController();
        $card = new CardController();
        $bill = new BillController();
        $notif = new NotificationController();
        $accApp = new AccountAppController();
        $loan = new LoanController();
        $autopay = new AutopayController();
        $cardApp = new CardAppController();
        $payee = new PayeeController();
        $transfer = new TransferController();
        $rec = new RecurringBillController();
        $stats = new StatisticsController();
        $rewards = new RewardsController();
        $chatbot = new ChatbotController();

        // ---- auth ----
        $g->post('/auth/register', [$ac, 'register']);
        $g->post('/auth/login', [$ac, 'login']);
        $g->post('/auth/logout', [$ac, 'logout']);
        $g->get('/auth/me', [$ac, 'me'])->add($auth);
        $g->get('/auth/mpin', [$ac, 'hasMpin'])->add($auth);
        $g->post('/auth/mpin', [$ac, 'setMpin'])->add($auth);
        $g->post('/auth/location', [$ac, 'location'])->add($auth);

        // ---- post-transaction feedback ----
        $fb = new FeedbackController();
        $g->post('/feedback', [$fb, 'submit'])->add($auth);

        // ---- admin (role enforced server-side; every call audited) ----
        $adm = new AdminController();
        $g->get('/admin/summary', [$adm, 'summary'])->add($admin);
        $g->get('/admin/customers', [$adm, 'customers'])->add($admin);
        $g->get('/admin/customers/{id}', [$adm, 'customer'])->add($admin);
        $g->get('/admin/transactions', [$adm, 'transactions'])->add($admin);
        $g->get('/admin/transactions/{id}', [$adm, 'transaction'])->add($admin);
        $g->get('/admin/feedback', [$adm, 'feedback'])->add($admin);
        $g->get('/admin/audit', [$adm, 'auditLog'])->add($admin);

        // ---- accounts ----
        $g->post('/accounts', [$acc, 'create'])->add($auth);
        $g->get('/accounts', [$acc, 'list'])->add($auth);
        $g->get('/accounts/balance/{id}', [$acc, 'balance'])->add($auth);
        $g->get('/accounts/{id}/detail', [$acc, 'detail'])->add($auth);
        $g->get('/accounts/{id}/ledger', [$acc, 'ledger'])->add($auth);
        $g->patch('/accounts/{id}', [$acc, 'rename'])->add($auth);
        $g->post('/accounts/{id}/close', [$acc, 'close'])->add($auth);

        // ---- transactions ----
        $g->get('/transactions/statement.csv', [$tx, 'statement'])->add($auth);
        $g->get('/transactions', [$tx, 'list'])->add($auth);
        $g->post('/transactions', [$tx, 'create'])->add($auth);
        $g->post('/transactions/receive', [$tx, 'receive'])->add($auth);
        $g->post('/transactions/system/initial-funds', [$tx, 'initialFunds'])->add($system);

        // ---- beneficiaries ----
        $g->get('/beneficiaries', [$ben, 'list'])->add($auth);
        $g->post('/beneficiaries', [$ben, 'create'])->add($auth);
        $g->delete('/beneficiaries/{id}', [$ben, 'delete'])->add($auth);

        // ---- profile ----
        $g->get('/profile', [$prof, 'get'])->add($auth);
        $g->patch('/profile', [$prof, 'update'])->add($auth);
        $g->post('/profile/change-password', [$prof, 'changePassword'])->add($auth);

        // ---- dashboard ----
        $g->get('/dashboard/summary', [$dash, 'summary'])->add($auth);

        // ---- investments ----
        $g->get('/investments', [$inv, 'list'])->add($auth);
        $g->post('/investments', [$inv, 'create'])->add($auth);
        $g->delete('/investments/{id}', [$inv, 'delete'])->add($auth);

        // ---- cards ----
        $g->get('/cards', [$card, 'list'])->add($auth);
        $g->post('/cards', [$card, 'create'])->add($auth);
        $g->post('/cards/{id}/freeze', [$card, 'freeze'])->add($auth);
        $g->delete('/cards/{id}', [$card, 'delete'])->add($auth);

        // ---- bills ----
        $g->get('/bills', [$bill, 'list'])->add($auth);
        $g->post('/bills', [$bill, 'create'])->add($auth);
        $g->post('/bills/{id}/pay', [$bill, 'pay'])->add($auth);
        $g->delete('/bills/{id}', [$bill, 'delete'])->add($auth);

        // ---- notifications ----
        $g->get('/notifications', [$notif, 'list'])->add($auth);
        $g->post('/notifications/{id}/read', [$notif, 'markRead'])->add($auth);
        $g->post('/notifications/read-all', [$notif, 'markAllRead'])->add($auth);

        // ---- account applications ----
        $g->get('/account-applications', [$accApp, 'list'])->add($auth);
        $g->post('/account-applications', [$accApp, 'apply'])->add($auth);

        // ---- loans ----
        $g->get('/loans/products', [$loan, 'listProducts'])->add($auth);
        $g->post('/loans/calculate', [$loan, 'calculate'])->add($auth);
        $g->post('/loans/apply', [$loan, 'apply'])->add($auth);
        $g->get('/loans/applications', [$loan, 'listApplications'])->add($auth);
        $g->get('/loans/applications/{id}', [$loan, 'detail'])->add($auth);
        $g->post('/loans/applications/{id}/close', [$loan, 'close'])->add($auth);

        // ---- investment autopay ----
        $g->get('/autopay', [$autopay, 'list'])->add($auth);
        $g->post('/autopay', [$autopay, 'create'])->add($auth);
        $g->post('/autopay/{id}/toggle', [$autopay, 'toggle'])->add($auth);
        $g->delete('/autopay/{id}', [$autopay, 'delete'])->add($auth);
        $g->get('/autopay/history', [$autopay, 'history'])->add($auth);

        // ---- cards (products + applications) ----
        $g->get('/card-products', [$cardApp, 'listProducts'])->add($auth);
        $g->post('/card-applications', [$cardApp, 'apply'])->add($auth);
        $g->get('/card-applications', [$cardApp, 'listApplications'])->add($auth);
        $g->get('/cards/{id}/reveal', [$cardApp, 'reveal'])->add($auth);

        // ---- payees ----
        $g->get('/payees/banks', [$payee, 'banks'])->add($auth);
        $g->get('/payees', [$payee, 'list'])->add($auth);
        $g->post('/payees', [$payee, 'create'])->add($auth);
        $g->patch('/payees/{id}', [$payee, 'update'])->add($auth);
        $g->delete('/payees/{id}', [$payee, 'delete'])->add($auth);

        // ---- transfers ----
        $g->post('/transfer/quick', [$transfer, 'quick'])->add($auth);
        $g->get('/transfer/scheduled', [$transfer, 'listScheduled'])->add($auth);
        $g->post('/transfer/scheduled', [$transfer, 'createScheduled'])->add($auth);
        $g->post('/transfer/scheduled/{id}/toggle', [$transfer, 'toggleScheduled'])->add($auth);
        $g->post('/transfer/scheduled/{id}/cancel', [$transfer, 'cancelScheduled'])->add($auth);

        // ---- recurring bills ----
        $g->get('/recurring-bills', [$rec, 'list'])->add($auth);
        $g->post('/recurring-bills', [$rec, 'create'])->add($auth);
        $g->post('/recurring-bills/auto-detect', [$rec, 'autoDetect'])->add($auth);
        $g->post('/recurring-bills/{id}/toggle', [$rec, 'toggle'])->add($auth);
        $g->delete('/recurring-bills/{id}', [$rec, 'delete'])->add($auth);
        $g->get('/recurring-bills/history', [$rec, 'history'])->add($auth);

        // ---- statistics ----
        $g->get('/statistics', [$stats, 'statistics'])->add($auth);

        // ---- rewards ----
        $g->get('/rewards', [$rewards, 'list'])->add($auth);
        $g->post('/rewards/event', [$rewards, 'event'])->add($auth);

        // ---- chatbot ----
        $g->post('/chatbot/message', [$chatbot, 'ask'])->add($auth);
    });
};
