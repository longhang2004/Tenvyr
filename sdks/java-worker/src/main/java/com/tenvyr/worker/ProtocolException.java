package com.tenvyr.worker;

final class ProtocolException extends RuntimeException {
  final int status;
  final String code;

  ProtocolException(int status, String code, String message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}
