import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { RegionsBootstrapService } from './regions-bootstrap.service';
import { RegionsController } from './regions.controller';
import { RegionsService } from './regions.service';

@Module({
  imports: [AuthModule],
  controllers: [RegionsController],
  providers: [RegionsBootstrapService, RegionsService],
  exports: [RegionsService],
})
export class RegionsModule {}
