const assert = require('node:assert/strict');

module.exports = [{
    name: 'copilot service: plain-text completion preserves model JSON unchanged',
    async run() {
        const { CopilotService } = require('../../out/services/copilotService');
        const { AIProviderRegistry } = require('../../out/services/ai/AIProviderRegistry');
        const { AgentSkillsService } = require('../../out/services/agentSkillsService');
        const registry = AIProviderRegistry.getInstance();
        const originalComplete = registry.complete;
        const originalSkills = AgentSkillsService.buildSkillContextForPrompt;
        let received;
        registry.complete = async (user, options) => { received = { user, options }; return '{"gaps":["GET /pets"]}'; };
        AgentSkillsService.buildSkillContextForPrompt = async () => '';
        try {
            assert.equal(await CopilotService.completePlainText('Return JSON', 'coverage'), '{"gaps":["GET /pets"]}');
            assert.ok(!received.options.systemPrompt.includes('Return only the complete Karate feature'), received.options.systemPrompt);
            assert.ok(!received.user.includes('CURRENT KARATE FEATURE'), received.user);
        } finally {
            registry.complete = originalComplete;
            AgentSkillsService.buildSkillContextForPrompt = originalSkills;
        }
    }
}];
