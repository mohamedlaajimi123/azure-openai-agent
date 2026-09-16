import { Module } from '@nestjs/common';
import { AgentService } from './agent.service.js';
import { AgentController } from './agent.controller.js';

@Module({
  providers: [AgentService],
  controllers: [AgentController]
})
export class AgentModule {}
