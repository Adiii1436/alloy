import * as vscode from 'vscode';
import { GoogleGenerativeAI } from '@google/generative-ai';
import OpenAI from 'openai';
import { GlobalState } from '../globalState';
import { LLMConfig, AIProvider, AnalysisIntent } from '../types';

export async function getLLMConfig(): Promise<LLMConfig | null> {
    let provider = GlobalState.context.globalState.get<AIProvider>('selected_provider');
    if (!provider) {
        const choice = await vscode.window.showQuickPick(['Google Gemini', 'OpenAI'], { placeHolder: 'Select your AI Provider' });
        if (!choice) return null;
        provider = choice as AIProvider;
        await GlobalState.context.globalState.update('selected_provider', provider);
    }

    const keyStorageName = provider === 'Google Gemini' ? 'gemini_key' : 'openai_key';
    let apiKey = GlobalState.context.globalState.get<string>(keyStorageName);
    if (!apiKey) {
        apiKey = await vscode.window.showInputBox({ prompt: `Enter your ${provider} API Key`, password: true });
        if (!apiKey) return null;
        await GlobalState.context.globalState.update(keyStorageName, apiKey);
    }

    const modelStorageName = provider === 'Google Gemini' ? 'gemini_model' : 'openai_model';
    let modelName = GlobalState.context.globalState.get<string>(modelStorageName);
    if (!modelName) {
        const defaultModel = provider === 'Google Gemini' ? 'gemini-3-flash-preview' : 'gpt-4o';
        modelName = await vscode.window.showInputBox({ prompt: `Enter Model Name`, value: defaultModel });
        if (!modelName) return null;
        await GlobalState.context.globalState.update(modelStorageName, modelName);
    }
    return { provider, apiKey, modelName };
}

export async function callLlm(config: LLMConfig, contextData: string, intent: AnalysisIntent) {
    let taskInstruction = "";
    if (intent === 'fix') {
        taskInstruction = `1. Analyze Terminal Output/Files. 2. Identify root cause. 3. Generate FULL FIXED CODE.`;
    } else if (intent === 'optimize') {
        taskInstruction = `1. Analyze Current File. 2. Refactor for performance/security. 3. Generate FULL OPTIMIZED CODE.`;
    } else if (intent === 'explain') {
        taskInstruction = `1. Explain code structure/logic. 2. Focus on "Why" and "How".`;
    }

    const systemPrompt = `You are Alloy, an expert AI Pair Developer. TASK: ${taskInstruction} IMPORTANT: If generating code, output filename in <<<<FILEPATH>>>>. Output format must be strictly followed.`;
    const userPrompt = `DATA:\n${contextData}\n\nOUTPUT FORMAT:\n<<<<FILEPATH>>>>\n(Filename or "Unknown")\n<<<<EXPLANATION>>>>\n(Markdown)\n<<<<CODE>>>>\n(Full code content)`;

    let responseText = "";

    try {
        if (config.provider === 'Google Gemini') {
            const genAI = new GoogleGenerativeAI(config.apiKey);
            const model = genAI.getGenerativeModel({ model: config.modelName });
            const result = await model.generateContent(systemPrompt + "\n" + userPrompt);
            responseText = result.response.text();
        } else if (config.provider === 'OpenAI') {
            const openai = new OpenAI({ apiKey: config.apiKey });
            const completion = await openai.chat.completions.create({
                model: config.modelName,
                messages: [{ role: "system", content: systemPrompt }, { role: "user", content: userPrompt }],
                temperature: 0.1,
            });
            responseText = completion.choices[0].message.content || "";
        }
    } catch (e: any) {
        if (e.toString().includes('401') || e.toString().includes('invalid api key')) {
            GlobalState.context.globalState.update(config.provider === 'Google Gemini' ? 'gemini_key' : 'openai_key', undefined);
        }
        throw new Error(`${config.provider} API Failed: ${e.message}`);
    }

    return parseBlockResponse(responseText);
}

function parseBlockResponse(text: string) {
    const filePart = text.split('<<<<FILEPATH>>>>')[1];
    const explainPart = text.split('<<<<EXPLANATION>>>>')[1];
    const codePart = text.split('<<<<CODE>>>>')[1];

    let filePath = "Unknown";
    let explanation = "";
    let fixedCode = "";

    if (filePart) filePath = filePart.split('<<<<')[0].trim();
    if (explainPart) explanation = explainPart.split('<<<<')[0].trim();
    if (codePart) {
        fixedCode = codePart.split('<<<<')[0].trim();
        fixedCode = fixedCode.replace(/^```[a-z]*\n/i, '').replace(/\n```$/, '');
    }

    if (!explanation && !fixedCode) {
        if (text.trim().startsWith("```") || (text.includes("import ") && text.includes("class ") && !text.includes(" "))) {
            fixedCode = text.replace(/^```[a-z]*\n/i, '').replace(/\n```$/, '');
            explanation = "AI provided direct code fix.";
        } else {
            explanation = text;
        }
    } else if (!explanation && !codePart) {
        explanation = text;
    }
    if (!explanation) explanation = "No explanation provided.";

    return { filePath, explanation, fixedCode };
}