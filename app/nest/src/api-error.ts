import { HttpException } from '@nestjs/common';

export const apiError = (code: string, message: string, status: number, details?: Record<string, unknown>) =>
  new HttpException({ success: false, error: { code, message, ...(details ? { details } : {}) } }, status);
