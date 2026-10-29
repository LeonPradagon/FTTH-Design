import { ServiceUnavailableException } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { DatabaseService } from '../database/database.service';
import { HealthService } from './health.service';

describe('HealthService', () => {
  it('returns an ok payload when PostGIS is enabled', async () => {
    const moduleRef = await Test.createTestingModule({
      providers: [
        HealthService,
        {
          provide: DatabaseService,
          useValue: {
            checkHealth: jest.fn().mockResolvedValue({
              status: 'up',
              database: 'geospatial_app',
              databaseVersion: 'PostgreSQL 16',
              postgisEnabled: true,
              postgisVersion: '3.4',
              checkedAt: '2026-03-31T00:00:00.000Z',
            }),
          },
        },
      ],
    }).compile();

    const service = moduleRef.get(HealthService);

    await expect(service.getHealth()).resolves.toMatchObject({
      status: 'ok',
      service: 'geospatial-backend',
      database: {
        postgisEnabled: true,
      },
    });
  });

  it('throws when PostGIS is missing', async () => {
    const moduleRef = await Test.createTestingModule({
      providers: [
        HealthService,
        {
          provide: DatabaseService,
          useValue: {
            checkHealth: jest.fn().mockResolvedValue({
              status: 'degraded',
              database: 'geospatial_app',
              databaseVersion: 'PostgreSQL 16',
              postgisEnabled: false,
              postgisVersion: null,
              checkedAt: '2026-03-31T00:00:00.000Z',
            }),
          },
        },
      ],
    }).compile();

    const service = moduleRef.get(HealthService);

    await expect(service.getHealth()).rejects.toBeInstanceOf(
      ServiceUnavailableException,
    );
  });
});
