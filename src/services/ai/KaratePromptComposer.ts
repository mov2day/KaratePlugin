import { AITask } from './AIProvider';
import { corePrompt } from '../../generation/ai/PromptBuilder';

export class KaratePromptComposer {
    static compose(prompt: string, task: AITask = 'general', systemPrompt?: string): { prompt: string; systemPrompt: string } {
        const core = corePrompt(task);
        // A system prompt produced by PromptBuilder already starts with the core; do not repeat it.
        const composed = !systemPrompt ? core : systemPrompt.startsWith(core) ? systemPrompt : `${core}\n${systemPrompt}`;
        return { systemPrompt: composed, prompt };
    }
}
