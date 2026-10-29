import { Global, Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { DatabaseBootstrapService } from './database-bootstrap.service';
import { DatabaseService } from './database.service';

@Global()
@Module({
  imports: [ConfigModule],
  providers: [DatabaseService, DatabaseBootstrapService],
  exports: [DatabaseService],
})
export class DatabaseModule {}
