-- Migration 017: every imported loan repayment lowers its loan's balance.
--
-- loan_payments is the ledger of which repayment expense has already been applied to
-- which loan. expense_id is UNIQUE, so one bank debit can reduce at most one loan, once —
-- re-running the job, or a second loan with the same payee, can never apply it twice.
-- No FK to expenses: deleting the expense must not resurrect the balance it already paid.
--
-- Idempotent: safe to run repeatedly.

CREATE TABLE IF NOT EXISTS loan_payments (
    id            INT PRIMARY KEY AUTO_INCREMENT,
    loan_id       INT NOT NULL,
    expense_id    INT NOT NULL,
    paid_on       DATE NOT NULL,
    amount        DECIMAL(10, 2) NOT NULL,
    principal     DECIMAL(10, 2) NOT NULL,
    balance_after DECIMAL(12, 2) NOT NULL,
    created_at    TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    UNIQUE KEY uq_loan_payment_expense (expense_id),
    INDEX idx_loan_payments_loan (loan_id, paid_on),
    FOREIGN KEY (loan_id) REFERENCES loans(loan_id) ON DELETE CASCADE
);
