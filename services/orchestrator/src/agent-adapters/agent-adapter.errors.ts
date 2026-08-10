export type AgentAdapterErrorCode =
  | 'ADAPTER_NOT_STARTED'
  | 'DISPATCH_FAILED'
  | 'SERIALIZATION_FAILED'
  | 'RESULT_HANDLER_FAILED'
  | 'ADAPTER_START_FAILED'
  | 'ADAPTER_STOP_FAILED'
  | 'HTTP_CONFIGURATION_INVALID'
  | 'HTTP_AGENT_NOT_CONFIGURED'
  | 'HTTP_REQUEST_TIMEOUT'
  | 'HTTP_CONNECTION_FAILED'
  | 'HTTP_REJECTED'
  | 'HTTP_INVALID_RESPONSE'
  | 'HTTP_RESPONSE_TOO_LARGE'
  | 'HTTP_INVOCATION_MISMATCH'
  | 'CALLBACK_UNAUTHORIZED'
  | 'CALLBACK_INVALID'
  | 'CALLBACK_AMBIGUOUS'
  | 'CALLBACK_HANDLER_UNAVAILABLE'
  | 'EVENT_HANDLER_FAILED';

type AgentAdapterErrorOptions = {
  invocationId?: string;
  retryable: boolean;
  cause?: unknown;
  httpStatus?: number;
};

export class AgentAdapterError extends Error {
  readonly code: AgentAdapterErrorCode;
  readonly adapter: string;
  readonly invocationId?: string;
  readonly retryable: boolean;
  readonly cause?: unknown;
  readonly httpStatus?: number;

  constructor(code: AgentAdapterErrorCode, adapter: string, message: string, options: AgentAdapterErrorOptions) {
    super(message);
    this.name = 'AgentAdapterError';
    this.code = code;
    this.adapter = adapter;
    this.invocationId = options.invocationId;
    this.retryable = options.retryable;
    this.cause = options.cause;
    this.httpStatus = options.httpStatus;
  }
}
