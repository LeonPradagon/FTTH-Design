import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { ImportUploadSourceDto } from './import-upload-source.dto';

function transformDto(body: Record<string, unknown>) {
  return plainToInstance(ImportUploadSourceDto, body, {
    enableImplicitConversion: true,
  });
}

describe('ImportUploadSourceDto', () => {
  it('keeps multipart autoRoute=false as false with implicit conversion enabled', async () => {
    const dto = transformDto({ autoRoute: 'false' });

    await expect(validate(dto)).resolves.toHaveLength(0);
    expect(dto.autoRoute).toBe('false');
  });

  it('keeps omitted autoRoute undefined so callers can default to true', async () => {
    const dto = transformDto({});

    await expect(validate(dto)).resolves.toHaveLength(0);
    expect(dto.autoRoute).toBeUndefined();
  });
});
