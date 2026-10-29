import { ArgumentsHost, Catch, ExceptionFilter, HttpException, Logger } from '@nestjs/common';
import { HttpAdapterHost } from '@nestjs/core';

@Catch()
export class ApiExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger(ApiExceptionFilter.name);

  constructor(private readonly adapterHost: HttpAdapterHost) {}

  catch(exception: unknown, host: ArgumentsHost) {
    const { httpAdapter } = this.adapterHost;
    const context = host.switchToHttp();
    const response = context.getResponse();
    const status = exception instanceof HttpException ? exception.getStatus() : 500;
    let body: any;

    if (exception instanceof HttpException) {
      const payload = exception.getResponse();
      if (payload && typeof payload === 'object' && ('success' in payload || 'detail' in payload)) body = payload;
      else if (payload && typeof payload === 'object' && 'details' in payload) {
        const { message, details } = payload as any;
        body = { detail: { message: Array.isArray(message) ? message.join(', ') : message, details } };
      } else {
        const message = typeof payload === 'string' ? payload : (payload as any)?.message ?? 'Request failed';
        body = { detail: Array.isArray(message) ? message.join(', ') : message };
      }
    } else {
      this.logger.error(exception instanceof Error ? exception.stack : String(exception));
      body = { success: false, error: { code: 'INTERNAL_ERROR', message: 'An unexpected error occurred.' } };
    }

    httpAdapter.reply(response, body, status);
  }
}
