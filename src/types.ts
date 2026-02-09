export type AIProvider = 'Google Gemini' | 'OpenAI' | 'Claude';
export type AnalysisIntent = 'fix' | 'explain';

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