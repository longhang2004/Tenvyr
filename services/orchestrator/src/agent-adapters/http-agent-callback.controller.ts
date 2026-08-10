import { ContractValidationError } from "@tenvyr/contracts";
import {
  BadRequestException,
  Controller,
  Headers,
  HttpCode,
  HttpStatus,
  InternalServerErrorException,
  Param,
  Post,
  Req,
  ServiceUnavailableException,
  UnauthorizedException,
} from "@nestjs/common";
import { AgentAdapterError } from "./agent-adapter.errors";
import { HttpAgentAdapter } from "./http-agent.adapter";

type RawBodyRequest = {
  rawBody?: Buffer;
  socket?: {
    remoteAddress?: string;
  };
};

@Controller("internal/agent-callbacks/http")
export class HttpAgentCallbackController {
  constructor(private readonly adapter: HttpAgentAdapter) {}

  @Post(":agent")
  @HttpCode(HttpStatus.NO_CONTENT)
  async handle(
    @Param("agent") agent: string,
    @Headers("x-agentweave-key-id") keyId: string | undefined,
    @Headers("x-agentweave-timestamp") timestamp: string | undefined,
    @Headers("x-agentweave-delivery-id") deliveryId: string | undefined,
    @Headers("x-agentweave-signature") signature: string | undefined,
    @Req() request: RawBodyRequest,
  ): Promise<void> {
    const remoteAddress = request.socket?.remoteAddress;
    if (!request.rawBody) throw new BadRequestException();

    try {
      await this.adapter.handleCallback({
        agent,
        keyId,
        timestamp,
        deliveryId,
        signature,
        rawBody: request.rawBody,
        remoteAddress,
      });
    } catch (error) {
      console.warn("HTTP callback rejected", {
        adapter: "http",
        agent,
        reason:
          error instanceof AgentAdapterError ? error.code : "CONTRACT_INVALID",
        deliveryId,
        keyId,
        remoteAddress,
      });

      if (error instanceof ContractValidationError)
        throw new BadRequestException();
      if (error instanceof AgentAdapterError) {
        if (error.code === "CALLBACK_UNAUTHORIZED")
          throw new UnauthorizedException();
        if (error.code === "CALLBACK_INVALID") throw new BadRequestException();
        if (error.code === "CALLBACK_AMBIGUOUS") throw new BadRequestException();
        if (error.code === "CALLBACK_HANDLER_UNAVAILABLE")
          throw new ServiceUnavailableException();
        if (error.code === "EVENT_HANDLER_FAILED")
          throw new ServiceUnavailableException();
      }
      throw new InternalServerErrorException();
    }
  }
}
