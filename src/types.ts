export type AIProvider = 'Google Gemini' | 'OpenAI';
export type AnalysisIntent = 'fix' | 'explain' | 'optimize';

export interface LLMConfig {
    provider: AIProvider;
    apiKey: string;
    modelName: string;
}

export interface FileChange {
    filePath: string;
    newContent: string;
}

export interface AIResponse {
    explanation: string;
    fixes: FileChange[];
}