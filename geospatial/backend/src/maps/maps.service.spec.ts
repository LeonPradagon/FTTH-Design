import { randomUUID } from 'crypto';
import { access, mkdir, rm, writeFile } from 'fs/promises';
import { join, resolve } from 'path';
import { NotFoundException } from '@nestjs/common';
import { maps } from '../database/schemas';
import { MapsService } from './maps.service';

function createServiceWithDeleteResult(deleteResult: unknown[]) {
  const returning = jest.fn().mockResolvedValue(deleteResult);
  const where = jest.fn().mockReturnValue({ returning });
  const deleteMock = jest.fn().mockReturnValue({ where });

  const service = new MapsService(
    {
      db: {
        delete: deleteMock,
      },
    } as never,
    {} as never,
    {} as never,
  );

  return {
    deleteMock,
    returning,
    service,
    where,
  };
}

describe('MapsService', () => {
  describe('deleteMapPackage', () => {
    it('deletes the map package row and removes the preserved uploaded source directory', async () => {
      const sourceDirectory = resolve(
        process.cwd(),
        '.data',
        'imported-map-sources',
        randomUUID(),
      );
      const storagePath = join(sourceDirectory, 'network.kml');
      await mkdir(sourceDirectory, { recursive: true });
      await writeFile(storagePath, '<kml />');

      const { deleteMock, service } = createServiceWithDeleteResult([
        {
          id: '79eb12ea-a900-4c2c-bc4f-30e81345fe25',
          name: 'Network',
          storagePath,
        },
      ]);

      const result = await service.deleteMapPackage(
        '79eb12ea-a900-4c2c-bc4f-30e81345fe25',
      );

      expect(deleteMock).toHaveBeenCalledWith(maps);
      expect(result).toEqual({
        success: true,
        deletedMapId: '79eb12ea-a900-4c2c-bc4f-30e81345fe25',
        deletedName: 'Network',
      });
      await expect(access(sourceDirectory)).rejects.toMatchObject({
        code: 'ENOENT',
      });
    });

    it('throws when the map package does not exist', async () => {
      const { service } = createServiceWithDeleteResult([]);

      await expect(
        service.deleteMapPackage('441a2454-47dc-4704-8860-65bdc0231560'),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('does not remove storage paths outside imported source storage', async () => {
      const sourceDirectory = resolve(
        process.cwd(),
        '.data',
        'manual-imports',
        randomUUID(),
      );
      const storagePath = join(sourceDirectory, 'bootstrap.kml');
      await mkdir(sourceDirectory, { recursive: true });
      await writeFile(storagePath, '<kml />');

      const { service } = createServiceWithDeleteResult([
        {
          id: '51ab1999-4adc-458c-a2b5-3a43d3e0b00c',
          name: 'Bootstrap',
          storagePath,
        },
      ]);

      await service.deleteMapPackage('51ab1999-4adc-458c-a2b5-3a43d3e0b00c');

      await expect(access(storagePath)).resolves.toBeUndefined();
      await rm(sourceDirectory, { force: true, recursive: true });
    });
  });
});
