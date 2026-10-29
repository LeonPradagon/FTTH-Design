import { HttpException } from '@nestjs/common';

export function integerParameter(value: unknown, source: 'query' | 'path', name: string, defaultValue?: number): number {
  if (value === undefined && defaultValue !== undefined) return defaultValue;
  const input = typeof value === 'string' ? value.trim() : '';
  if (!/^[+-]?\d+$/.test(input) || !Number.isSafeInteger(Number(input))) {
    const missing = value === undefined;
    throw new HttpException({ detail: [{
      type: missing ? 'missing' : 'int_parsing',
      loc: [source, name],
      msg: missing ? 'Field required' : 'Input should be a valid integer, unable to parse string as an integer',
      ...(missing ? {} : { input: value }),
    }] }, 422);
  }
  return Number(input);
}
