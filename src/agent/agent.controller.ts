import { Controller, Post, Body } from '@nestjs/common';
import { AgentService } from './agent.service.js';

@Controller('agent')
export class AgentController {
  constructor(private readonly agentService: AgentService) {}

  @Post('chat')
  async chat(@Body('query') query: string) {
    const answer = await this.agentService.chat(query);
    return { query, answer };
  }
}