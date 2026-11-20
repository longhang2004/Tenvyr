-- T02 Review Service Domain Schema V1

-- Users table with authentication and role constraints
CREATE TABLE tenvyr_review.users (
    id UUID PRIMARY KEY,
    username VARCHAR(64) UNIQUE NOT NULL,
    password_hash VARCHAR(255) NOT NULL,
    role VARCHAR(16) NOT NULL,
    enabled BOOLEAN NOT NULL DEFAULT true,
    CONSTRAINT check_user_role CHECK (role IN ('SUBMITTER', 'REVIEWER')),
    CONSTRAINT check_username_format CHECK (username ~ '^[a-z0-9_.-]{1,64}$')
);

-- Fixed pipeline binding singleton
CREATE TABLE tenvyr_review.pipeline_bindings (
    version INTEGER PRIMARY KEY,
    pipeline_id UUID UNIQUE NOT NULL REFERENCES public.pipelines(id),
    definition_hash CHAR(64) NOT NULL,
    CONSTRAINT check_pipeline_version CHECK (version = 1)
);

-- Review requests table
CREATE TABLE tenvyr_review.requests (
    id UUID PRIMARY KEY,
    owner_id UUID NOT NULL REFERENCES tenvyr_review.users(id),
    idempotency_key UUID NOT NULL,
    request_hash CHAR(64) NOT NULL,
    title VARCHAR(160) NOT NULL,
    language VARCHAR(16) NOT NULL,
    code TEXT NOT NULL,
    execution_id UUID UNIQUE NOT NULL REFERENCES public.executions(id),
    created_at TIMESTAMPTZ NOT NULL,
    CONSTRAINT uq_requests_owner_idempotency UNIQUE (owner_id, idempotency_key),
    CONSTRAINT check_requests_code_bytes CHECK (octet_length(code) <= 65536),
    CONSTRAINT check_requests_language CHECK (language IN ('java', 'typescript', 'python'))
);

-- Review human verdicts / decisions
CREATE TABLE tenvyr_review.decisions (
    id UUID PRIMARY KEY,
    request_id UUID UNIQUE NOT NULL REFERENCES tenvyr_review.requests(id),
    actor_id UUID NOT NULL REFERENCES tenvyr_review.users(id),
    idempotency_key UUID NOT NULL,
    payload_hash CHAR(64) NOT NULL,
    action VARCHAR(16) NOT NULL,
    comment VARCHAR(2000),
    step_attempt_id UUID NOT NULL REFERENCES public.step_attempts(id),
    result_hash CHAR(64) NOT NULL,
    created_at TIMESTAMPTZ NOT NULL,
    CONSTRAINT uq_decisions_actor_idempotency UNIQUE (actor_id, idempotency_key),
    CONSTRAINT check_decision_action CHECK (action IN ('APPROVE', 'REQUEST_CHANGES'))
);

-- Immutable audit ledger
CREATE TABLE tenvyr_review.audit (
    id UUID PRIMARY KEY,
    request_id UUID NOT NULL REFERENCES tenvyr_review.requests(id),
    actor_id UUID NOT NULL REFERENCES tenvyr_review.users(id),
    action VARCHAR(16) NOT NULL,
    operation_key UUID NOT NULL,
    payload_hash CHAR(64) NOT NULL,
    created_at TIMESTAMPTZ NOT NULL,
    CONSTRAINT uq_audit_actor_action_op UNIQUE (actor_id, action, operation_key),
    CONSTRAINT check_audit_action CHECK (action IN ('SUBMIT', 'DECIDE', 'CANCEL'))
);

-- Performance indices specified in SPEC
CREATE INDEX idx_requests_owner_created_id
    ON tenvyr_review.requests (owner_id, created_at DESC, id DESC);

CREATE INDEX idx_requests_created_id
    ON tenvyr_review.requests (created_at DESC, id DESC);

CREATE INDEX idx_audit_request_created_id
    ON tenvyr_review.audit (request_id, created_at, id);
