export type AIProvider = 'Google Gemini' | 'OpenAI';
export type AnalysisIntent = 'fix' | 'explain' | 'optimize';

export interface LLMConfig {
    provider: AIProvider;
    apiKey: string;
    modelName: string;
}