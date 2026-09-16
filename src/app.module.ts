import { Module } from '@nestjs/common';
import { AppController } from './app.controller.js';
import { AppService } from './app.service.js';
import { AzureModule } from './azure/azure.module.js';
import { AgentModule } from './agent/agent.module.js';
import { IngestModule } from './ingest/ingest.module.js';

@Module({
  imports: [AzureModule, AgentModule, IngestModule],
  controllers: [AppController],
  providers: [AppService],
})
export class AppModule {}
